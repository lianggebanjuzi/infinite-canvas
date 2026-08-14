# backend/api/unified_api.py
"""
统一 API 路由层
兼容 APIQik 风格的中转供应商，自动识别模型类型和 API 格式
"""
from enum import Enum
from dataclasses import dataclass, field
from typing import Optional

import requests
import json
import uuid
import time
import threading
import tempfile
import base64 as b64lib
import io
import os

from PIL import Image

from backend.api.errors import (
    AppError, APIKeyError, RateLimitError,
    UpstreamError, UpstreamTimeoutError, UnknownError,
    ValidationError, ModelNotSupportedError
)
from backend.api.gemini_compat import (
    extract_image_urls_from_text,
    nearest_aspect_ratio,
    normalize_gemini_aspect_ratio,
    normalize_gemini_image_size,
)
from backend.api.model_rules import (
    detect_model_type as detect_model_type_str,
    detect_model_format_name,
)


# ─────────────────────────────────────────
# 全局任务存储（带线程锁保护）
# ─────────────────────────────────────────
_tasks = {}
_tasks_lock = threading.Lock()


# ─────────────────────────────────────────
# 枚举：模型类型
# ─────────────────────────────────────────
class ModelType(Enum):
    CHAT    = "chat"
    DRAWING = "drawing"


# ─────────────────────────────────────────
# 枚举：API 格式
# ─────────────────────────────────────────
class ApiFormat(Enum):
    OPENAI_CHAT   = "openai_chat"
    OPENAI_IMAGE = "openai_image"
    GEMINI_NATIVE = "gemini_native"


# ─────────────────────────────────────────
# 数据类：模型条目
# ─────────────────────────────────────────
@dataclass
class ModelEntry:
    id:           str
    name:         str
    type:         ModelType
    api_format:   ApiFormat
    enabled:      bool = True


# ─────────────────────────────────────────
# 数据类：供应商配置
# ─────────────────────────────────────────
@dataclass
class ProviderConfig:
    id:        str
    name:      str
    api_url:   str
    api_key:   str
    enabled:   bool
    models:    list = field(default_factory=list)


# ─────────────────────────────────────────
# 模型识别规则
# 分类规则（关键字 -> API 格式）统一收敛到公共模块 model_rules，
# 与 provider_api.fetch_models 共用同一份规则，避免重复定义导致语义漂移。
# 本文件仅保留「格式名 -> ApiFormat 枚举」的本地映射。
# ─────────────────────────────────────────
_API_FORMAT_MAP = {
    'openai_chat':   ApiFormat.OPENAI_CHAT,
    'openai_image':  ApiFormat.OPENAI_IMAGE,
    'gemini_native': ApiFormat.GEMINI_NATIVE,
}

# 分辨率后缀映射（用于 Gemini 图片模型）
_RES_SUFFIX = {'1k': '', '2k': '-2k', '4k': '-4k'}

# 分辨率到 imageSize 的映射
_RESOLUTION_MAP = {'1k': '1K', '2k': '2K', '4k': '4K'}


# ─────────────────────────────────────────
# 核心类：UnifiedAPIRouter
# ─────────────────────────────────────────
class UnifiedAPIRouter:

    def __init__(self, provider_api):
        self.provider_api = provider_api
        self._providers_cache = []
        self._cache_time = 0
        self._cache_ttl = 30

    # ─────────────────────────────────────────
    # 公开接口：对话
    # ─────────────────────────────────────────
    def chat(self, messages, options=None):
        """
        统一对话接口
        messages: [{"role": "system"/"user"/"assistant", "content": "..."}]
        options: {
            "model": "provider_id:model_id",  # 可选，默认用第一个可用的 chat 模型
            "temperature": 0.7,
            "max_tokens": 2000
        }
        返回: {"success": True, "text": "..."} 或 {"success": False, "error": "..."}
        """
        options = options or {}

        provider, model_entry = self._resolve_chat_model(options.get('model'))
        if not provider:
            raise AppError(503, "没有可用的对话模型，请先在设置中配置")

        if not (provider.get('api_url') or '').strip() or not (provider.get('api_key') or '').strip():
            raise AppError(503, f"供应商「{provider.get('name', '')}」尚未填写 API 地址或密钥，请到设置中补充")

        api_url   = provider['api_url'].rstrip('/')
        api_key   = provider['api_key']
        use_proxy = provider.get('use_proxy', True)
        proxies   = None if use_proxy else {"http": None, "https": None}

        url     = self._resolve_chat_url(api_url)
        headers = {
            'Authorization': f'Bearer {api_key}',
            'Content-Type':  'application/json'
        }
        payload = self._build_chat_payload(model_entry.id, messages, options)

        print(f"[UnifiedAPI] 对话请求 | provider={provider['name']} | model={model_entry.id} | url={url}")

        try:
            response = requests.post(
                url, headers=headers, json=payload, timeout=120, proxies=proxies
            )
            if response.status_code == 200:
                return self._parse_chat_response(response.json())
            else:
                self._handle_http_error(response)
        except requests.exceptions.Timeout:
            raise UpstreamTimeoutError()
        except requests.exceptions.ConnectionError:
            raise UpstreamError(503, "无法连接到服务器，请检查网络或代理设置")
        except Exception as e:
            print(f"[UnifiedAPI] 对话异常: {e}")
            raise UnknownError(str(e))

    def chat_v2(self, user_input, options=None):
        """
        简化对话接口 - 自动组装 messages
        user_input: str - 用户输入
        options: {
            "metaPrompt": "系统提示词",  # 可选
            "model": "provider_id:model_id",  # 可选
            "images": ["data:image/..."]  # 可选，多模态图片
        }
        """
        options = options or {}

        if not user_input or not user_input.strip():
            raise ValidationError("用户输入不能为空")

        messages = []

        if options.get('metaPrompt'):
            messages.append({
                "role":    "system",
                "content": options['metaPrompt'].strip()
            })

        images = [
            img for img in options.get('images', [])
            if isinstance(img, str) and img.startswith('data:image')
        ]

        if images:
            content_parts = [{"type": "image_url", "image_url": {"url": img}} for img in images]
            content_parts.append({"type": "text", "text": user_input.strip()})
            messages.append({"role": "user", "content": content_parts})
            print(f"[UnifiedAPI] 多模态对话，图片数: {len(images)}")
        else:
            messages.append({"role": "user", "content": user_input.strip()})

        return self.chat(messages, options)

    # ─────────────────────────────────────────
    # 公开接口：图片生成（同步 + 异步）
    # ─────────────────────────────────────────
    def generate_image_async(self, prompt, options=None):
        """统一图片生成接口（异步，立即返回 task_id）"""
        options = options or {}
        task_id = str(uuid.uuid4())
        with _tasks_lock:
            _tasks[task_id] = {"status": "pending"}

        def run():
            try:
                result = self.generate_image(prompt, options)
                with _tasks_lock:
                    _tasks[task_id] = {"status": "done", "result": result, "cleanup_scheduled": False}
                print(f"[UnifiedAPI] 任务 {task_id[:8]} 完成")
            except AppError as e:
                with _tasks_lock:
                    _tasks[task_id] = {"status": "done", "result": e.to_dict(), "cleanup_scheduled": False}
            except Exception as e:
                import traceback
                traceback.print_exc()
                with _tasks_lock:
                    _tasks[task_id] = {
                        "status": "done",
                        "result": {"success": False, "error": str(e)},
                        "cleanup_scheduled": False
                    }

        threading.Thread(target=run, daemon=True).start()
        print(f"[UnifiedAPI] 异步任务 {task_id[:8]} 已启动")
        return {"success": True, "task_id": task_id}

    def generate_image(self, prompt, options=None):
        """
        统一图片生成接口（同步，阻塞等待结果）
        options: {
            "model": "provider_id:model_id",  # 可选
            "resolution": "1k"/"2k"/"4k",  # 默认 "1k"
            "aspectRatio": "Auto"/"1:1"/"16:9"/...,
            "count": 1,
            "referenceImages": ["data:image/..."]
        }
        返回: {"success": True, "image_url": "...", "images": [...]} 或 {"success": False, "error": "..."}
        """
        options = options or {}

        if not prompt or not prompt.strip():
            raise ValidationError("提示词不能为空")

        provider, model_entry = self._resolve_drawing_model(options.get('model'))
        if not provider:
            raise AppError(503, "没有可用的图片模型，请先在设置中配置")

        if not (provider.get('api_url') or '').strip() or not (provider.get('api_key') or '').strip():
            raise AppError(503, f"供应商「{provider.get('name', '')}」尚未填写 API 地址或密钥，请到设置中补充后再生成")

        api_url   = provider['api_url'].rstrip('/')
        api_key   = provider['api_key']
        use_proxy = provider.get('use_proxy', True)
        proxies   = None if use_proxy else {"http": None, "https": None}

        url, payload = self._build_image_request(api_url, model_entry, prompt, options)
        headers = {
            'Content-Type':  'application/json',
            'Authorization': f'Bearer {api_key}'
        }

        print(f"[UnifiedAPI] 图片请求 | provider={provider['name']} | model={model_entry.id} | format={model_entry.api_format.value} | url={url}")

        try:
            response = requests.post(
                url, headers=headers, json=payload, timeout=300, proxies=proxies
            )

            if response.status_code == 200:
                result = self._parse_image_response(response.json(), model_entry.api_format)
                if result.get('success'):
                    result = self._save_images_to_local(result)
                return result
            else:
                self._handle_http_error(response)
        except requests.exceptions.ConnectionError:
            raise UpstreamError(503, "无法连接到服务器，请检查网络或代理设置")
        except requests.exceptions.Timeout:
            raise UpstreamTimeoutError()
        except Exception as e:
            print(f"[UnifiedAPI] 图片生成异常: {e}")
            raise UnknownError(str(e))

    def get_task_result(self, task_id):
        """查询异步任务结果"""
        with _tasks_lock:
            task = _tasks.get(task_id)
            if not task:
                return {"status": "not_found"}
            if task["status"] == "pending":
                return {"status": "pending"}

            result = task["result"]

            if not task.get("cleanup_scheduled"):
                task["cleanup_scheduled"] = True

                def delayed_delete():
                    time.sleep(30)
                    with _tasks_lock:
                        _tasks.pop(task_id, None)
                    print(f"[UnifiedAPI] 任务 {task_id[:8]} 已清理")

                threading.Thread(target=delayed_delete, daemon=True).start()

        return {"status": "done", "result": result}

    # ─────────────────────────────────────────
    # 内部方法：模型解析
    # ─────────────────────────────────────────
    def _load_providers(self, force=False):
        """加载供应商配置（带缓存）"""
        now = time.time()
        if force or not self._providers_cache or (now - self._cache_time) > self._cache_ttl:
            data = self.provider_api.load_providers()
            self._providers_cache = data.get('providers', [])
            self._cache_time = now
        return self._providers_cache

    def _detect_model_type(self, model_id):
        """
        根据模型 ID 关键字推断模型类型和 API 格式
        分类规则复用公共模块 model_rules（与 provider_api.fetch_models 语义一致）
        返回: (ModelType, ApiFormat)
        """
        m_type_str  = detect_model_type_str(model_id)
        fmt_name    = detect_model_format_name(model_id)
        fmt         = _API_FORMAT_MAP.get(fmt_name, ApiFormat.OPENAI_CHAT)

        if m_type_str == ModelType.DRAWING.value:
            return ModelType.DRAWING, fmt
        return ModelType.CHAT, fmt

    def _resolve_chat_model(self, model_str=None):
        """
        解析对话模型
        model_str: "provider_id:model_id" 或 None
        返回: (provider_dict, ModelEntry)
        """
        providers = self._load_providers()
        provider_id, model_id = None, None

        if model_str and ':' in model_str:
            provider_id, model_id = model_str.split(':', 1)

        if provider_id:
            for p in providers:
                if p.get('id') != provider_id or not p.get('enabled'):
                    continue
                for m in p.get('models', []):
                    if not m.get('enabled', True):
                        continue
                    # 优先匹配用户指定的 model_id
                    if model_id and m['id'] != model_id:
                        continue
                    m_type = m.get('type', '')
                    if m_type == 'chat' or (not m_type and self._is_chat_model(m['id'])):
                        return p, ModelEntry(
                            id=m['id'], name=m.get('name', m['id']),
                            type=ModelType.CHAT,
                            api_format=self._detect_api_format(m['id'], ModelType.CHAT),
                            enabled=m.get('enabled', True)
                        )

        # 未指定 provider 或未找到指定模型时，回退到第一个可用的 chat 模型
        for p in providers:
            if not (p.get('enabled') and p.get('api_key') and p.get('api_url')):
                continue
            for m in p.get('models', []):
                if not m.get('enabled', True):
                    continue
                m_type = m.get('type', '')
                if m_type == 'chat' or (not m_type and self._is_chat_model(m['id'])):
                    return p, ModelEntry(
                        id=m['id'], name=m.get('name', m['id']),
                        type=ModelType.CHAT,
                        api_format=self._detect_api_format(m['id'], ModelType.CHAT),
                        enabled=m.get('enabled', True)
                    )

        return None, None

    def _resolve_drawing_model(self, model_str=None):
        """解析图片生成模型"""
        providers = self._load_providers()
        provider_id, model_id = None, None

        if model_str and ':' in model_str:
            provider_id, model_id = model_str.split(':', 1)

        if provider_id:
            for p in providers:
                if p.get('id') != provider_id or not p.get('enabled'):
                    continue
                for m in p.get('models', []):
                    if not m.get('enabled', True):
                        continue
                    # 优先匹配用户指定的 model_id
                    if model_id and m['id'] != model_id:
                        continue
                    m_type = m.get('type', '')
                    if m_type == 'drawing' or (not m_type and not self._is_chat_model(m['id'])):
                        return p, ModelEntry(
                            id=m['id'], name=m.get('name', m['id']),
                            type=ModelType.DRAWING,
                            api_format=self._detect_api_format(m['id'], ModelType.DRAWING),
                            enabled=m.get('enabled', True)
                        )

        for p in providers:
            if not (p.get('enabled') and p.get('api_key') and p.get('api_url')):
                continue
            for m in p.get('models', []):
                if not m.get('enabled', True):
                    continue
                m_type = m.get('type', '')
                if m_type == 'drawing' or (not m_type and not self._is_chat_model(m['id'])):
                    return p, ModelEntry(
                        id=m['id'], name=m.get('name', m['id']),
                        type=ModelType.DRAWING,
                        api_format=self._detect_api_format(m['id'], ModelType.DRAWING),
                        enabled=m.get('enabled', True)
                    )

        return None, None

    def _is_chat_model(self, model_id):
        m_type, _ = self._detect_model_type(model_id)
        return m_type == ModelType.CHAT

    def _detect_api_format(self, model_id, default_type):
        """根据模型 ID 检测 API 格式，未匹配时返回 default_type"""
        m_type, fmt = self._detect_model_type(model_id)
        # 如果检测到的类型与期望的 default_type 一致，或者未匹配到规则，使用 default_type
        if m_type == ModelType.CHAT and default_type == ModelType.DRAWING:
            # 模型被识别为 chat，但期望是 drawing，说明没有匹配到绘图规则
            # 根据 default_type 返回对应的默认格式
            return ApiFormat.OPENAI_IMAGE
        return fmt

    # ─────────────────────────────────────────
    # 内部方法：URL 解析
    # ─────────────────────────────────────────
    def _resolve_chat_url(self, api_url):
        """解析对话请求 URL"""
        base = api_url.rstrip('/')
        if base.endswith('/chat/completions'):
            return base
        if base.endswith('/v1'):
            return f"{base}/chat/completions"
        return f"{base}/v1/chat/completions"

    def _resolve_image_url(self, api_url, model_id, api_format):
        """解析图片请求 URL"""
        if api_format == ApiFormat.GEMINI_NATIVE:
            model_id = self._apply_resolution_suffix(model_id)
            return f"{api_url}/v1beta/models/{model_id}:generateContent"
        elif api_format == ApiFormat.OPENAI_IMAGE:
            return f"{api_url}/v1/images/generations"

        raise ModelNotSupportedError(model_id)

    def _apply_resolution_suffix(self, model_id):
        """给 Gemini 图片模型应用分辨率后缀（由调用方在 options 中指定）"""
        return model_id

    # ─────────────────────────────────────────
    # 内部方法：Payload 构建
    # ─────────────────────────────────────────
    def _build_chat_payload(self, model_id, messages, options):
        """构建对话请求 payload"""
        payload = {
            "model":    model_id,
            "messages": messages
        }

        temp = options.get('temperature')
        if temp is not None:
            payload['temperature'] = float(temp)

        max_tokens = options.get('max_tokens')
        if max_tokens is not None:
            payload['max_tokens'] = int(max_tokens)

        return payload

    def _build_image_request(self, api_url, model_entry, prompt, options):
        """构建图片请求，返回 (url, payload)"""
        fmt = model_entry.api_format
        model_id = model_entry.id

        if fmt == ApiFormat.GEMINI_NATIVE:
            return self._build_gemini_payload(api_url, model_id, prompt, options)
        elif fmt == ApiFormat.OPENAI_IMAGE:
            return self._build_openai_image_payload(api_url, model_id, prompt, options)

        raise ModelNotSupportedError(model_id)

    def _infer_aspect_from_ref(self, data_url):
        """
        从参考图 data URL 解码出宽高，映射到 Gemini 支持的最近宽高比。
        任何异常（无有效图片、解码失败等）都返回 None。
        """
        try:
            if not isinstance(data_url, str) or ',' not in data_url:
                return None
            encoded = data_url.split(',', 1)[1]
            raw = b64lib.b64decode(encoded)
            with Image.open(io.BytesIO(raw)) as im:
                width, height = im.size
            return nearest_aspect_ratio(width, height)
        except Exception:
            return None

    def _build_gemini_payload(self, api_url, model_id, prompt, options):
        """构建 Gemini 原生格式 payload"""
        parts = []

        ref_images = [
            img for img in options.get('referenceImages', [])
            if isinstance(img, str) and img.startswith('data:image')
        ]
        for img_data in ref_images:
            mime_type = img_data.split(';')[0].split(':')[1]
            base64_data = img_data.split(',')[1]
            parts.append({"inlineData": {"mimeType": mime_type, "data": base64_data}})

        parts.append({"text": prompt})

        resolution = (options.get('resolution', '1k') or '1k').lower()
        if resolution not in _RESOLUTION_MAP:
            resolution = '1k'
        image_size = normalize_gemini_image_size(_RESOLUTION_MAP.get(resolution, '1K'))

        aspect_ratio = normalize_gemini_aspect_ratio(options.get('aspectRatio', 'Auto'))

        if aspect_ratio is None and ref_images:
            aspect_ratio = self._infer_aspect_from_ref(ref_images[0])

        image_config = {"imageSize": image_size}
        if aspect_ratio is not None:
            image_config["aspectRatio"] = aspect_ratio

        gen_config = {
            "responseModalities": ["IMAGE"],
            "imageConfig": image_config,
        }

        topP = options.get('topP')
        if topP is not None:
            try:
                topP_val = float(topP)
                if 0.0 <= topP_val <= 1.0:
                    gen_config['topP'] = topP_val
            except (ValueError, TypeError):
                pass

        payload = {
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": gen_config,
        }

        url = self._resolve_image_url(api_url, model_id, ApiFormat.GEMINI_NATIVE)
        return url, payload

    def _build_openai_image_payload(self, api_url, model_id, prompt, options):
        """构建 OpenAI DALL-E 格式 payload"""
        size = options.get('size', '1024x1024')
        n    = options.get('count', 1)

        valid_sizes = {
            '1024x1024': '1024x1024',
            '1024x1792': '1024x1792',
            '1792x1024': '1792x1024',
        }
        if size not in valid_sizes:
            size = '1024x1024'

        payload = {
            "model":  model_id,
            "prompt": prompt,
            "n":      n,
            "size":   size
        }

        url = self._resolve_image_url(api_url, model_id, ApiFormat.OPENAI_IMAGE)
        return url, payload

    # ─────────────────────────────────────────
    # 内部方法：响应解析
    # ─────────────────────────────────────────
    def _parse_chat_response(self, result):
        """解析对话响应"""
        try:
            message = result['choices'][0]['message']
            content = message.get('content')

            if isinstance(content, str):
                return {"success": True, "text": content}

            if isinstance(content, list):
                texts = [
                    part.get('text', '')
                    for part in content
                    if isinstance(part, dict) and part.get('type') == 'text'
                ]
                return {"success": True, "text": '\n'.join(texts)}

            return {"success": False, "error": "API 返回格式错误"}

        except (KeyError, IndexError) as e:
            print(f"[UnifiedAPI] 对话响应解析失败: {e}")
            return {"success": False, "error": "API 返回格式错误"}

    def _parse_image_response(self, result, api_format):
        """解析图片响应，自动识别格式 + 兼容中转站格式"""
        # 优先按指定格式解析
        if api_format == ApiFormat.GEMINI_NATIVE:
            parsed = self._parse_gemini_response(result)
            if parsed.get('success'):
                return parsed

        elif api_format == ApiFormat.OPENAI_IMAGE:
            parsed = self._parse_openai_image_response(result)
            if parsed.get('success'):
                return parsed

        # 中转站兼容性兜底：混合尝试各种格式
        print(f"[UnifiedAPI] 尝试中转站兼容格式解析...")

        # 兜底1: 尝试 OpenAI DALL-E 格式（b64_json / url 混合格式）
        dalle_parsed = self._parse_openai_image_response(result)
        if dalle_parsed.get('success'):
            print(f"[UnifiedAPI] 中转站兼容: DALL-E 格式解析成功")
            return dalle_parsed

        # 兜底2: 尝试 Gemini candidates 格式（部分中转站可能直接返回 candidates）
        gemini_parsed = self._parse_gemini_response(result)
        if gemini_parsed.get('success'):
            print(f"[UnifiedAPI] 中转站兼容: Gemini 格式解析成功")
            return gemini_parsed

        # 兜底3: 尝试从 result 直接提取 base64 字段（中转站常见格式）
        direct_parsed = self._try_extract_direct_base64(result)
        if direct_parsed:
            return direct_parsed

        return {"success": False, "error": "API 返回格式错误"}

    def _parse_gemini_response(self, result):
        """解析 Gemini 原生格式响应"""
        try:
            images    = []
            text_parts = []

            if 'candidates' in result and len(result['candidates']) > 0:
                candidate = result['candidates'][0]
                if 'content' in candidate and 'parts' in candidate['content']:
                    for part in candidate['content']['parts']:
                        # 兼容 snake_case（官方）和 camelCase（部分中转站）
                        inline_data = part.get('inline_data') or part.get('inlineData')
                        if inline_data:
                            base64_data = inline_data.get('data', '')
                            mime_type   = inline_data.get('mime_type') or inline_data.get('mimeType', 'image/png')
                            images.append(f"data:{mime_type};base64,{base64_data}")
                        elif 'text' in part:
                            text_parts.append(part.get('text', ''))

            if not images:
                seen_u = set()
                for t in text_parts:
                    for u in extract_image_urls_from_text(t):
                        if u not in seen_u:
                            seen_u.add(u)
                            images.append(u)
                if images:
                    print(f"[UnifiedAPI] 从 Gemini 文本中解析到 {len(images)} 个图片 URL")

            if images:
                print(f"[UnifiedAPI] Gemini 图片解析成功，共 {len(images)} 张")
                return {
                    "success":   True,
                    "image_url": images[0],
                    "images":    images,
                    "text":      ' '.join(text_parts).strip()
                }
            else:
                combined_text = ' '.join(text_parts).strip()
                if combined_text:
                    print(f"[UnifiedAPI] AI 仅返回文本，无图片: {combined_text[:200]}")
                return {"success": False, "error": "only_text"}

        except (KeyError, IndexError) as e:
            print(f"[UnifiedAPI] Gemini 响应解析异常: {e}")
            return {"success": False, "error": "API 返回格式错误"}

    def _parse_openai_image_response(self, result):
        """解析 OpenAI DALL-E 格式响应"""
        try:
            if 'data' in result and len(result['data']) > 0:
                images = []
                for item in result['data']:
                    # 优先使用 base64 格式
                    if item.get('b64_json'):
                        mime = item.get('mime_type', 'image/png')
                        images.append(f"data:{mime};base64,{item['b64_json']}")
                    elif item.get('url'):
                        images.append(item['url'])

                if images:
                    print(f"[UnifiedAPI] DALL-E 图片解析成功，共 {len(images)} 张")
                    return {
                        "success":   True,
                        "image_url": images[0],
                        "images":    images
                    }

            return {"success": False, "error": "API 返回格式错误"}

        except Exception as e:
            print(f"[UnifiedAPI] DALL-E 响应解析异常: {e}")
            return {"success": False, "error": "API 返回格式错误"}

    def _try_extract_direct_base64(self, result):
        """
        中转站兼容：直接从响应中提取 base64 字段
        常见格式：
          - {"b64_json": "..."}           （DALL-E 格式）
          - {"base64": "..."}             （部分中转站直接返回）
          - {"image": "..."}              （部分中转站直接返回）
          - {"choices": [{"message": {"content": "data:image/...;base64,..."}}]}  （OpenAI chat 格式）
        """
        # 兜底1: 直接 b64_json
        if isinstance(result, dict):
            if result.get('b64_json'):
                images = [f"data:image/png;base64,{result['b64_json']}"]
                print(f"[UnifiedAPI] 中转站兼容: 直接 b64_json 提取成功")
                return {"success": True, "image_url": images[0], "images": images}

            # 兜底2: 直接 base64 字段
            if result.get('base64'):
                images = [f"data:image/png;base64,{result['base64']}"]
                print(f"[UnifiedAPI] 中转站兼容: 直接 base64 提取成功")
                return {"success": True, "image_url": images[0], "images": images}

            # 兜底3: 直接 image 字段
            if result.get('image'):
                img_data = result['image']
                if isinstance(img_data, str):
                    if not img_data.startswith('data:'):
                        img_data = f"data:image/png;base64,{img_data}"
                    images = [img_data]
                    print(f"[UnifiedAPI] 中转站兼容: 直接 image 字段提取成功")
                    return {"success": True, "image_url": images[0], "images": images}

            # 兜底4: choices -> message -> content 中包含 data:image/...;base64, 格式（OpenAI chat 图片生成格式）
            choices = result.get('choices', [])
            if choices and isinstance(choices, list):
                for choice in choices:
                    msg = choice.get('message', {})
                    content = msg.get('content')
                    if not content:
                        continue
                    # content 是字符串，可能包含 base64 图片
                    if isinstance(content, str):
                        extracted = self._extract_base64_from_text(content)
                        if extracted:
                            print(f"[UnifiedAPI] 中转站兼容: choices content 提取成功")
                            return {"success": True, "image_url": extracted[0], "images": extracted}
                        url_imgs = extract_image_urls_from_text(content)
                        if url_imgs:
                            print(f"[UnifiedAPI] 中转站兼容: choices content 图片 URL 提取成功")
                            return {"success": True, "image_url": url_imgs[0], "images": url_imgs}
                    # content 是数组（多模态格式）
                    elif isinstance(content, list):
                        for part in content:
                            if part.get('type') == 'image_url':
                                img_url = part.get('image_url', {})
                                if isinstance(img_url, str):
                                    extracted = self._extract_base64_from_text(img_url)
                                    if extracted:
                                        print(f"[UnifiedAPI] 中转站兼容: choices array image_url 提取成功")
                                        return {"success": True, "image_url": extracted[0], "images": extracted}
                                    url_imgs = extract_image_urls_from_text(img_url)
                                    if url_imgs:
                                        return {"success": True, "image_url": url_imgs[0], "images": url_imgs}
                                    if img_url.strip().lower().startswith(('http://', 'https://')):
                                        return {"success": True, "image_url": img_url.strip(), "images": [img_url.strip()]}
                                elif isinstance(img_url, dict):
                                    url_str = img_url.get('url', '') or ''
                                    extracted = self._extract_base64_from_text(url_str)
                                    if extracted:
                                        print(f"[UnifiedAPI] 中转站兼容: choices array image_url.url 提取成功")
                                        return {"success": True, "image_url": extracted[0], "images": extracted}
                                    url_imgs = extract_image_urls_from_text(url_str)
                                    if url_imgs:
                                        return {"success": True, "image_url": url_imgs[0], "images": url_imgs}
                                    if url_str.strip().lower().startswith(('http://', 'https://')):
                                        u = url_str.strip()
                                        return {"success": True, "image_url": u, "images": [u]}

            # 兜底5: 尝试从 data 数组中提取 base64
            data = result.get('data', [])
            if isinstance(data, list):
                for item in data:
                    if item.get('b64_json'):
                        mime = item.get('mime_type', 'image/png')
                        images = [f"data:{mime};base64,{item['b64_json']}"]
                        print(f"[UnifiedAPI] 中转站兼容: data.b64_json 提取成功")
                        return {"success": True, "image_url": images[0], "images": images}

        return None

    def _extract_base64_from_text(self, text):
        """
        从文本中提取所有 data:image/...;base64,... 格式的图片
        返回图片列表，如果提取失败返回 None
        """
        if not isinstance(text, str):
            return None
        import re
        # 匹配 data:image/xxx;base64,xxxxx 格式
        pattern = r'data:image/[^;]+;base64,[A-Za-z0-9+/=\s]+'
        matches = re.findall(pattern, text)
        if matches:
            # 清理空白字符
            images = [m.strip() for m in matches]
            print(f"[UnifiedAPI] 从文本中提取到 {len(images)} 张 base64 图片")
            return images

        # 尝试直接作为 base64 字符串处理（增加长度和格式校验以减少误判）
        # 真实图片的 base64 通常远大于 1000 字符
        if len(text) > 1000:
            try:
                # 尝试解码验证是否为有效 base64
                import base64 as b64lib
                decoded = b64lib.b64decode(text)
                # 检查解码后的数据是否像图片（PNG/JPEG/GIF 的魔数）
                if (decoded[:8] == b'\x89PNG\r\n\x1a\n' or  # PNG
                    decoded[:2] == b'\xff\xd8' or            # JPEG
                    decoded[:4] == b'GIF8' or                # GIF
                    decoded[:4] == b'RIFF'):                 # WebP
                    return [f"data:image/png;base64,{text}"]
            except Exception:
                pass

        return None

    # ─────────────────────────────────────────
    # 内部方法：图片本地保存（保留 base64 格式返回给前端）
    # ─────────────────────────────────────────
    def _save_images_to_local(self, parsed, save_dir=''):
        """
        将图片保存到本地做持久化，但始终保留 base64 格式返回给前端。
        - base64 → 解码保存，前端仍收到原始 base64
        - URL    → 下载保存后转换为 base64 返回给前端
        """

        def process(img):
            if not isinstance(img, str):
                return img

            if img.startswith('data:image'):
                # 保留原始 base64，同时保存到磁盘
                file_path = self._save_base64_to_dir(img, save_dir)
                if file_path:
                    print(f"[UnifiedAPI] base64 图片已保存: {file_path}")
                return img

            elif img.startswith('http'):
                # 下载并转换为 base64，确保前端始终收到 base64 格式
                base64_data = self._download_url_to_base64(img)
                if base64_data:
                    # 下载后也保存一份到本地
                    file_path = self._save_base64_to_dir(base64_data, save_dir)
                    if file_path:
                        print(f"[UnifiedAPI] URL 图片已下载保存: {file_path}")
                    return base64_data
                return img

            return img

        if parsed.get('images'):
            parsed['images'] = [process(u) for u in parsed['images']]
        if parsed.get('image_url'):
            parsed['image_url'] = (
                parsed['images'][0] if parsed.get('images')
                else parsed['image_url']
            )
        return parsed

    def _get_save_dir(self, save_dir=''):
        if save_dir and os.path.isdir(save_dir):
            return save_dir
        return tempfile.gettempdir()

    def _make_filename(self, ext='png'):
        from datetime import datetime
        ts = datetime.now().strftime('%Y%m%d_%H%M%S_%f')
        return f"unified_image_{ts}.{ext}"

    def _save_base64_to_dir(self, data_url, save_dir=''):
        try:
            header, data = data_url.split(',', 1)
            ext = 'png'
            if 'jpeg' in header or 'jpg' in header:
                ext = 'jpg'
            elif 'webp' in header:
                ext = 'webp'

            img_bytes = b64lib.b64decode(data)
            directory = self._get_save_dir(save_dir)
            file_path = os.path.join(directory, self._make_filename(ext))

            with open(file_path, 'wb') as f:
                f.write(img_bytes)

            print(f"[UnifiedAPI] base64 图片已保存: {file_path}")
            return file_path.replace('\\', '/')
        except Exception as e:
            print(f"[UnifiedAPI] base64 保存失败: {e}")
            return None

    def _download_url_to_dir(self, url, save_dir=''):
        try:
            resp = requests.get(url, timeout=60)
            if resp.status_code != 200:
                return None

            content_type = resp.headers.get('Content-Type', 'image/png')
            ext = 'png'
            if 'jpeg' in content_type or 'jpg' in content_type:
                ext = 'jpg'
            elif 'webp' in content_type:
                ext = 'webp'
            elif 'gif' in content_type:
                ext = 'gif'
            elif 'bmp' in content_type:
                ext = 'bmp'
            elif 'svg' in content_type:
                ext = 'svg'
            elif 'tiff' in content_type:
                ext = 'tiff'

            directory = self._get_save_dir(save_dir)
            file_path = os.path.join(directory, self._make_filename(ext))

            with open(file_path, 'wb') as f:
                f.write(resp.content)

            print(f"[UnifiedAPI] URL 图片已保存: {file_path}")
            return file_path.replace('\\', '/')
        except Exception as e:
            print(f"[UnifiedAPI] URL 下载保存失败: {e}")
            return None

    def _download_url_to_base64(self, url):
        """
        将 URL 图片下载并转换为 base64 data URL 格式
        确保中转站返回的 URL 图片也能以 base64 格式返回给前端
        """
        try:
            resp = requests.get(url, timeout=60)
            if resp.status_code != 200:
                return None

            content_type = resp.headers.get('Content-Type', 'image/png')
            ext = 'png'
            if 'jpeg' in content_type or 'jpg' in content_type:
                ext = 'jpg'
            elif 'webp' in content_type:
                ext = 'webp'
            elif 'gif' in content_type:
                ext = 'gif'
            elif 'bmp' in content_type:
                ext = 'bmp'
            elif 'svg' in content_type:
                ext = 'svg'
            elif 'tiff' in content_type:
                ext = 'tiff'

            base64_data = b64lib.b64encode(resp.content).decode('utf-8')
            data_url = f"data:image/{ext};base64,{base64_data}"
            print(f"[UnifiedAPI] URL 图片已转换为 base64: {url[:60]}... ({len(base64_data) / 1024:.0f} KB)")
            return data_url
        except Exception as e:
            print(f"[UnifiedAPI] URL 转 base64 失败: {e}")
            return None

    # ─────────────────────────────────────────
    # 内部方法：错误处理
    # ─────────────────────────────────────────
    def _handle_http_error(self, response):
        """将 HTTP 错误映射为 AppError 子类"""
        try:
            error_data = response.json()
            if 'error' in error_data:
                error_info = error_data['error']
                error_msg = (
                    error_info.get('message', str(error_info))
                    if isinstance(error_info, dict)
                    else str(error_info)
                )
            else:
                error_msg = response.text
        except Exception:
            error_msg = response.text

        print(f"[UnifiedAPI] HTTP {response.status_code}: {error_msg[:200]}")

        if 'not supported' in error_msg.lower() or 'not found' in error_msg.lower():
            raise ModelNotSupportedError()
        elif response.status_code == 401:
            raise APIKeyError()
        elif response.status_code == 429:
            raise RateLimitError()
        elif response.status_code == 504:
            raise UpstreamTimeoutError()
        elif response.status_code >= 500:
            raise UpstreamError(response.status_code, error_msg)
        else:
            raise AppError(response.status_code, f"HTTP {response.status_code}: {error_msg}")
