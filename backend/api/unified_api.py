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
import re

from urllib.parse import urlparse

from PIL import Image

from backend.api.errors import (
    AppError, APIKeyError, RateLimitError,
    UpstreamError, UpstreamTimeoutError, UnknownError,
    ValidationError, ModelNotSupportedError
)
from backend.api.image_api import make_thumbnail_data_url, make_thumbnail_data_url_from_file
from backend.api.gemini_compat import (
    extract_image_urls_from_text,
    nearest_aspect_ratio,
    normalize_gemini_aspect_ratio,
    normalize_gemini_image_size,
    resolve_chat_api_base,
    resolve_image_api_base,
)
from backend.api.model_rules import (
    detect_model_type as detect_model_type_str,
    detect_model_format_name,
)


# ─────────────────────────────────────────
# 图片扩展名推断（下载链路用）
# ─────────────────────────────────────────
_IMAGE_EXT_MAP = {
    'jpeg': 'jpg', 'jpg': 'jpg', 'png': 'png', 'webp': 'webp',
    'gif': 'gif', 'bmp': 'bmp', 'svg': 'svg', 'tiff': 'tiff',
}


def _guess_image_ext(content_type, content):
    """
    根据响应 Content-Type 与文件魔数推断图片扩展名（用于 data URL 的 mime 类型）。
    优先信任 Content-Type；缺失或非图片类型（如 application/octet-stream）时，
    用 PIL 读取魔数兜底；仍无法识别则默认 png。
    """
    ct = (content_type or '').lower()
    for key, ext in _IMAGE_EXT_MAP.items():
        if key in ct:
            return ext
    try:
        with Image.open(io.BytesIO(content)) as im:
            fmt = (im.format or '').lower()
            return _IMAGE_EXT_MAP.get(fmt, 'png')
    except Exception:
        return 'png'


def _repair_utf8_mojibake(text):
    """修复中转站将 UTF-8 字节错误按 Latin-1 返回时产生的中文乱码。

    仅在存在多个典型乱码标记、且修复后 CJK 字符明显增加时替换，避免改动正常文本。
    """
    if not isinstance(text, str):
        return text
    markers = 'ÃÂâäåæçèéêëïðñòó'
    if sum(text.count(char) for char in markers) < 2:
        return text
    try:
        repaired = text.encode('latin-1').decode('utf-8')
    except (UnicodeEncodeError, UnicodeDecodeError):
        return text
    cjk_before = sum('\u4e00' <= char <= '\u9fff' for char in text)
    cjk_after = sum('\u4e00' <= char <= '\u9fff' for char in repaired)
    return repaired if cjk_after >= cjk_before + 2 else text


# ─────────────────────────────────────────
# 全局任务存储（带线程锁保护）
# ─────────────────────────────────────────
_tasks = {}
_tasks_lock = threading.Lock()

# 单一 Key 同时跑太多媒体任务不仅容易触发上游排队/限流，也会把一次误连点变成多次扣费。
# 前端已有全局批次并发控制；这里再按「供应商 + Key」做最后一道保护。
_IMAGE_TASKS_PER_KEY = 2
_image_task_slots = {}
_image_task_slots_lock = threading.Lock()
# 图片模型可能在上游排队数分钟；本地轮询必须比前端的 8 分钟等待窗口至少同样长，
# 否则远端仍在生成时会被本地过早标记为超时。
_IMAGE_TASK_TIMEOUT_SECONDS = 8 * 60


class AcceptedImageTaskError(UpstreamError):
    """远端已确认接收图片任务后的失败。

    这类失败绝不能被外层当成「换 Key 再提交」：任务可能仍在远端继续运行，重投会
    产生重复图片和重复计费。把远端任务 ID 传到前端，用户也能在中转商后台定位任务。
    """

    def __init__(self, code, message, remote_task_id=''):
        self.remote_task_id = remote_task_id or ''
        suffix = f"（远端任务：{self.remote_task_id}）" if self.remote_task_id else ''
        super().__init__(code, f"{message}{suffix}")

    def to_dict(self):
        data = super().to_dict()
        if self.remote_task_id:
            data['remote_task_id'] = self.remote_task_id
        return data


def _image_task_slot(provider, key):
    """返回指定供应商 Key 的并发闸门；不以 API Key 明文作为内存索引或日志内容。"""
    slot_key = (str(provider.get('id') or ''), str(key.get('id') or ''))
    with _image_task_slots_lock:
        slot = _image_task_slots.get(slot_key)
        if slot is None:
            slot = threading.BoundedSemaphore(_IMAGE_TASKS_PER_KEY)
            _image_task_slots[slot_key] = slot
        return slot


# ─────────────────────────────────────────
# 枚举：模型类型
# ─────────────────────────────────────────
class ModelType(Enum):
    CHAT    = "chat"
    DRAWING = "drawing"
    VIDEO   = "video"


# ─────────────────────────────────────────
# 枚举：API 格式
# ─────────────────────────────────────────
class ApiFormat(Enum):
    OPENAI_CHAT   = "openai_chat"
    OPENAI_IMAGE = "openai_image"
    GEMINI_NATIVE = "gemini_native"
    FLUXPORT_VIDEO = "fluxport_video"


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
    'fluxport_video': ApiFormat.FLUXPORT_VIDEO,
}

# 分辨率后缀映射（用于 Gemini 图片模型）
_RES_SUFFIX = {'1k': '', '2k': '-2k', '4k': '-4k'}

# 分辨率到 imageSize 的映射
_RESOLUTION_MAP = {'1k': '1K', '2k': '2K', '4k': '4K'}

# ─────────────────────────────────────────
# OpenAI 图片（gpt-image-2）尺寸映射
# ─────────────────────────────────────────
# 来源：https://platform.openai.com/docs/guides/image-generation
# gpt-image-2 官方 size 约束：
#   - 最大边长 ≤ 3840px
#   - 两边均须为 16 的倍数
#   - 长短边比例 ≤ 3:1
#   - 总像素范围：655,360 ~ 8,294,400
# 官方 API 并无固定 size 白名单；任意符合上述约束的宽 x 高均可用。
# 以下是产品 UI 的 1K / 2K / 4K 档位映射：约 1MP / 4MP / 合法最大档，
# 每个尺寸均严格保持用户选择的比例。4K 档的输出像素大于 2560x1440，属官方
# 标记的实验性范围。
_OPENAI_ASPECT_TO_SIZE = {
    '1:1':  ('1024x1024', '2048x2048', '2880x2880'),
    '3:4':  ('864x1152', '1728x2304', '2448x3264'),
    '4:3':  ('1152x864', '2304x1728', '3264x2448'),
    '2:3':  ('832x1248', '1664x2496', '2336x3504'),
    '3:2':  ('1248x832', '2496x1664', '3504x2336'),
    '4:5':  ('896x1120', '1792x2240', '2560x3200'),
    '5:4':  ('1120x896', '2240x1792', '3200x2560'),
    '9:16': ('720x1280', '1440x2560', '2160x3840'),
    '16:9': ('1280x720', '2560x1440', '3840x2160'),
    '21:9': ('1568x672', '3136x1344', '3808x1632'),
}

# resolution -> 档位下标（0=1k 档，1=2k 档，2=4k 档）
_OPENAI_RESOLUTION_TIER = {'1k': 0, '2k': 1, '4k': 2}


# ─────────────────────────────────────────
# 核心类：UnifiedAPIRouter
# ─────────────────────────────────────────
class UnifiedAPIRouter:

    def __init__(self, provider_api, settings_api=None):
        self.provider_api = provider_api
        self.settings_api = settings_api  # 注入 SettingsAPI（读 image_save_path，P2 主生成链路落盘用）
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
            "model": "provider_id:key_id:model_id",  # 可选（旧两段 id 自动兼容），默认用第一个可用的 chat 模型
            "temperature": 0.7,
            "max_tokens": 2000
        }
        返回: {"success": True, "text": "..."} 或 {"success": False, "error": "..."}
        """
        options = options or {}

        candidates, unavailable_reason = self._chat_candidates(options.get('model'))
        if not candidates:
            raise AppError(503, unavailable_reason or "没有可用的对话模型，请先在设置中配置")

        failures = []
        for provider, key, model_entry in candidates:
            try:
                return self._chat_with_candidate(messages, options, provider, key, model_entry)
            except AppError as error:
                # 只在当前模型同名的候选间切换；避免把用户选择的 gpt-5.6-luna
                # 静默替换为其它模型。参数错误等本地问题也不应重复提交。
                if error.code not in (401, 402, 422, 429, 500, 502, 503, 504):
                    raise
                failures.append(error.message)

        reasons = '；'.join(dict.fromkeys(failures))
        model_id = candidates[0][2].id
        raise AppError(
            503,
            f"模型「{model_id}」已依次尝试 {len(candidates)} 组可用供应商/密钥，均无法完成对话"
            + (f"：{reasons}" if reasons else ""),
        )

    def _chat_with_candidate(self, messages, options, provider, key, model_entry):
        """向一个已验证的同名文本模型候选发请求；由 chat 负责候选切换。"""
        connection = self._get_connection(provider, key, ModelType.CHAT, model_entry.id)
        if not connection:
            raise AppError(503, "文本对话尚未填写 URL / API Key，请到设置中补充")

        api_url   = connection['api_url'].rstrip('/')
        api_key   = connection['api_key']
        use_proxy = provider.get('use_proxy', False)
        proxies   = None if use_proxy else {"http": None, "https": None, "all": None}
        url       = self._resolve_chat_url(api_url)
        headers   = {'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'}
        payload   = self._build_chat_payload(model_entry.id, messages, options)

        print(f"[UnifiedAPI] 对话请求 | provider={provider['name']} | model={model_entry.id} | url={url}")
        try:
            response = requests.post(
                # 文本/反推请求不设客户端超时：部分上游模型首包较慢，由用户主动取消或上游自行结束。
                url, headers=headers, json=payload, proxies=proxies
            )
            if response.status_code == 200:
                return self._parse_chat_response(response.json())
            self._handle_http_error(response)
        except requests.exceptions.Timeout:
            raise UpstreamTimeoutError()
        except requests.exceptions.ConnectionError:
            raise UpstreamError(503, "无法连接到服务器，请检查网络或代理设置")
        except AppError:
            raise
        except Exception as e:
            print(f"[UnifiedAPI] 对话异常: {e}")
            raise UnknownError(str(e))

    def chat_v2(self, user_input, options=None):
        """
        简化对话接口 - 自动组装 messages
        user_input: str - 用户输入
        options: {
            "metaPrompt": "系统提示词",  # 可选
            "model": "provider_id:key_id:model_id",  # 可选（旧两段 id 自动兼容）
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
                result = self.generate_image(prompt, options, _progress_task_id=task_id)
                with _tasks_lock:
                    _tasks[task_id] = {"status": "done", "result": result, "cleanup_scheduled": False}
                _ri = result.get('image_url') if isinstance(result, dict) else None
                _op = result.get('original_path') if isinstance(result, dict) else None
                print(
                    f"[UnifiedAPI] 任务 {task_id[:8]} 完成 | "
                    f"image_url={'有' if _ri else '空'}({len(str(_ri)) // 1024}KB) | "
                    f"original_path={'有' if _op else '无'}"
                )
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

    def edit_image_async(self, prompt, options=None):
        """统一 image-edit 入口；复用同一后台任务和受理后不得重投的状态机。"""
        options = dict(options or {})
        options['operation'] = 'image-edit'
        return self.generate_image_async(prompt, options)

    def generate_image(self, prompt, options=None, _progress_task_id=None):
        """
        统一图片生成接口（同步，阻塞等待结果）
        options: {
            "model": "provider_id:key_id:model_id",  # 可选（旧两段 id 自动兼容）
            "resolution": "1k"/"2k"/"4k",  # 默认 "1k"
            "aspectRatio": "Auto"/"1:1"/"16:9"/...,
            "count": 1,
            "referenceImages": ["data:image/..."]
        }
        返回: {"success": True, "image_url": "...", "images": [...]} 或 {"success": False, "error": "..."}
        """
        # 为一次用户操作固定幂等键。若提交前明确收到 401/402/429 并切到另一个 Key，
        # 仍是同一业务操作；若网络在提交阶段中断，也不会因新的请求 ID 轻易重复扣费。
        options = dict(options or {})
        options.setdefault('_image_operation_id', f"icv-img-{uuid.uuid4().hex}")

        if not prompt or not prompt.strip():
            raise ValidationError("提示词不能为空")

        candidates, unavailable_reason = self._drawing_candidates(options.get('model'))
        if not candidates:
            raise AppError(503, unavailable_reason or "没有可用的图片模型，请先在设置中配置")

        failures = []
        for provider, key, model_entry in candidates:
            try:
                return self._generate_image_with_candidate(
                    prompt, options, provider, key, model_entry, _progress_task_id
                )
            except AppError as error:
                # 一旦收到 202 + 远端 task_id，任务的唯一事实已在上游。后续轮询失败、
                # 上游失败或超时都只能报告该任务，绝不能换 Key 再提交一份。
                if isinstance(error, AcceptedImageTaskError):
                    raise

                # 只有明确与 Key 绑定、且尚未确认任务已创建的错误才允许切换候选 Key。
                # 5xx / 网络错误的提交状态不确定，自动重投可能重复扣费；422 是输入或模型
                # 不兼容，换 Key 也不会解决。
                if error.code not in (401, 402, 429):
                    raise
                failures.append(error.message)

        reasons = '；'.join(dict.fromkeys(failures))
        raise AppError(
            503,
            f"已依次尝试 {len(candidates)} 组可用图像密钥，均无法生成"
            + (f"：{reasons}" if reasons else ""),
        )

    def _generate_image_with_candidate(self, prompt, options, provider, key, model_entry,
                                       progress_task_id=None):
        """按 Key 限流后调用实际请求；等待发生在后台任务线程，不阻塞前端。"""
        slot = _image_task_slot(provider, key)
        if not slot.acquire(blocking=False):
            print(f"[UnifiedAPI] 图片任务排队 | provider={provider.get('name', '-')} | "
                  f"model={model_entry.id} | 单 Key 并发上限={_IMAGE_TASKS_PER_KEY}")
            slot.acquire()
        try:
            return self._generate_image_with_candidate_inner(
                prompt, options, provider, key, model_entry, progress_task_id
            )
        finally:
            slot.release()

    def _generate_image_with_candidate_inner(self, prompt, options, provider, key, model_entry,
                                             progress_task_id=None):
        """使用一个已验证的图像模型候选发起请求；由 generate_image 负责候选切换。"""

        connection = self._get_connection(provider, key, ModelType.DRAWING, model_entry.id)
        if not connection:
            raise AppError(503, "图像生成尚未填写 URL / API Key，请到设置中补充后再生成")

        api_url   = connection['api_url'].rstrip('/')
        api_key   = connection['api_key']
        use_proxy = provider.get('use_proxy', False)
        proxies   = None if use_proxy else {"http": None, "https": None, "all": None}

        url, request_body = self._build_image_request(api_url, model_entry, prompt, options)
        # 每次「重新生成」必须是独立抽卡：幂等键只防同一次网络重试被重复创建，
        # 而禁缓存头和请求 ID 用于阻止中转/CDN 按相同 prompt+参数复用上一轮图片。
        # 这些都只作用于 HTTP 元数据，不向 prompt 拼随机字符，避免污染生成语义与历史配方。
        request_id = options.get('_image_operation_id') or f"icv-img-{uuid.uuid4().hex}"
        idempotency_key = (
            (options or {}).get('idempotencyKey')
            or request_id
        )
        headers = {
            'Authorization':   f'Bearer {api_key}',
            'Idempotency-Key': idempotency_key,
            'X-Request-ID': request_id,
            'X-ICV-Force-Fresh': '1',
            'Cache-Control': 'no-cache, no-store, max-age=0',
            'Pragma': 'no-cache',
        }
        # multipart 的 Content-Type（含 boundary）必须由 requests 生成；JSON 才显式声明。
        if 'files' not in request_body:
            headers['Content-Type'] = 'application/json'

        print(
            f"[UnifiedAPI] 图片请求 | provider={provider['name']} | model={model_entry.id} | "
            f"format={model_entry.api_format.value} | fresh_request={request_id[:16]} | url={url}"
        )

        session = requests.Session()
        # requests 默认会读取 HTTP(S)_PROXY 等环境变量；当用户在供应商设置中选择
        # 「不使用代理」时，必须显式关闭，避免虚拟网卡软件留下的环境代理污染轮询。
        session.trust_env = bool(use_proxy)

        try:
            response = session.post(
                url, headers=headers, timeout=(10, 300), proxies=proxies, **request_body
            )

            if response.status_code == 200:
                result = self._parse_image_response(response.json(), model_entry.api_format)
                if result.get('success'):
                    result = self._save_images_to_local(result, proxies=proxies)
                return result
            elif response.status_code == 202:
                # FluxPort 等中转站对 Gemini 图片走「异步任务」模式：
                # POST generateContent 立即返回 202 + 任务对象，需按 poll_url 轮询直到出图。
                try:
                    task_data = response.json()
                except ValueError:
                    task_data = {}
                # status_url / poll_url 常为相对路径，必须拼到实际图片请求域名；
                # 使用 response.url（跟随重定向后的最终地址），避免因 302 跳转打到旧域名。
                origin = self._get_api_origin(response.url)
                result = self._poll_async_image_task(
                    task_data, origin, headers, proxies, session=session,
                    progress_task_id=progress_task_id,
                )
                if result.get('success'):
                    result = self._save_images_to_local(result, proxies=proxies)
                return result
            else:
                try:
                    self._handle_http_error(response)
                except ModelNotSupportedError as e:
                    # OpenAI 图片格式在本中转站不可用（实测 /v1/images/generations 返回 404）：
                    # 给出清晰提示，引导改用 Gemini 原生图片模型，而不是笼统的「模型不支持」
                    if model_entry.api_format == ApiFormat.OPENAI_IMAGE:
                        raise AppError(
                            422,
                            "该供应商分组不支持 OpenAI 图片格式（Images API 不可用/返回 404），"
                            "请改用 Gemini 原生图片模型（如 gemini-3-pro-image-preview / "
                            "gemini-3.1-flash-image-preview）"
                        )
                    raise
        except requests.exceptions.ConnectionError as e:
            print(f"[UnifiedAPI] 图片请求连接异常: {e!r}")
            raise UpstreamError(503, "图片请求未获确认，无法连接到服务器，请检查网络或代理设置")
        except requests.exceptions.Timeout:
            raise UpstreamTimeoutError()
        except AppError:
            # 保持既有 AppError 语义（401/429/5xx/轮询失败/超时等），
            # 避免被下方通用兜底转成 UnknownError 丢失错误码
            raise
        except Exception as e:
            print(f"[UnifiedAPI] 图片生成异常: {e}")
            raise UnknownError(str(e))
        finally:
            session.close()

    def get_task_result(self, task_id):
        """查询异步任务结果"""
        with _tasks_lock:
            task = _tasks.get(task_id)
            if not task:
                return {"status": "not_found"}
            if task["status"] == "pending":
                # 保持既有 pending 契约，同时返回仅供诊断/未来 UI 展示的远端任务信息。
                # 前端旧版本忽略额外字段，不会受影响。
                return {
                    "status": "pending",
                    "remote_task_id": task.get("remote_task_id"),
                    "remote_status": task.get("remote_status"),
                }

            result = task["result"]

            if not task.get("cleanup_scheduled"):
                task["cleanup_scheduled"] = True

                def delayed_delete():
                    # 600s 后才清理：前端单次查询超时 90s 且可能重试，30s 清理会与轮询产生竞态
                    # （done 响应传输卡住 → 前端重试时任务已被删 → 404「结果已过期」→ 假失败）。
                    time.sleep(600)
                    with _tasks_lock:
                        _tasks.pop(task_id, None)
                    print(f"[UnifiedAPI] 任务 {task_id[:8]} 已清理")

                threading.Thread(target=delayed_delete, daemon=True).start()

        return {"status": "done", "result": result}

    def _update_async_image_task(self, local_task_id, **changes):
        """为 pywebview 前端可轮询的本地任务补充远端媒体任务状态。"""
        if not local_task_id:
            return
        with _tasks_lock:
            task = _tasks.get(local_task_id)
            if task and task.get('status') == 'pending':
                task.update({key: value for key, value in changes.items() if value is not None})

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
        if m_type_str == ModelType.VIDEO.value:
            return ModelType.VIDEO, fmt
        return ModelType.CHAT, fmt

    def _resolve_chat_model(self, model_str=None):
        """
        解析对话模型（multi-key：三段 id provider:key:model）
        model_str: "provider_id:key_id:model_id" / 旧两段 "provider_id:model_id" / None
        返回: (provider_dict, key_dict, ModelEntry|None)
        解析优先级：
          三段精确（key 删除/停用 → AppError「模型所属 Key 已删除或停用，请重新选择模型」）
          → 两段回退（provider 各 enabled key 依次匹配同名模型，放宽为全部 enabled key）
          → 全量第一个可用 chat 模型 → (None, None, None)
        """
        providers = self._load_providers()
        parts = (model_str or '').split(':') if model_str else []

        # ── 三段 id：精确命中 key，用 key.api_key 出图/对话 ──
        if len(parts) >= 3:
            provider_id, key_id, model_id = parts[0], parts[1], ':'.join(parts[2:])
            for p in providers:
                if p.get('id') != provider_id or not p.get('enabled'):
                    continue
                keys = p.get('keys') or []
                key  = next((k for k in keys if k.get('id') == key_id), None)
                if key is None or not key.get('enabled', True):
                    raise AppError(503, "模型所属 Key 已删除或停用，请重新选择模型")
                for m in key.get('models', []):
                    if not m.get('enabled', True):
                        continue
                    if m.get('id') != model_id:
                        continue
                    m_type = m.get('type', '')
                    # 视频防污染守卫：旧数据中曾落入 chat 兜底的视频模型（如 grok-imagine-video-* 存成
                    # type='chat'）按实时规则拒绝，避免误发 /chat/completions；手动添加且未命中规则的
                    # chat 模型兜底 detect_model_type 返回 CHAT → 放行，无回归。
                    if m_type == 'chat':
                        if not self._is_chat_model(m['id']):
                            continue
                    elif not m_type:
                        if not self._is_chat_model(m['id']):
                            continue
                    else:
                        continue
                    return p, key, ModelEntry(
                        id=m['id'], name=m.get('name', m['id']),
                        type=ModelType.CHAT,
                        api_format=self._detect_api_format(m['id'], ModelType.CHAT),
                        enabled=m.get('enabled', True)
                    )
                # key 存在但模型已删除/停用：同样提示重选模型（旧节点引用失效）
                raise AppError(503, "模型所属 Key 已删除或停用，请重新选择模型")
            # provider 未找到/停用 → 回退全量第一个可用模型
            return self._first_available_model(providers, ModelType.CHAT)

        # ── 两段 id（旧项目/旧 localStorage）：provider 各 enabled key 依次匹配同名模型 ──
        if len(parts) == 2:
            provider_id, model_id = parts
            for p in providers:
                if p.get('id') != provider_id or not p.get('enabled'):
                    continue
                for key in p.get('keys') or []:
                    if not key.get('enabled', True):
                        continue
                    for m in key.get('models', []):
                        if not m.get('enabled', True):
                            continue
                        if m.get('id') != model_id:
                            continue
                        m_type = m.get('type', '')
                        # 视频防污染守卫（同上）
                        if m_type == 'chat':
                            if not self._is_chat_model(m['id']):
                                continue
                        elif not m_type:
                            if not self._is_chat_model(m['id']):
                                continue
                        else:
                            continue
                        return p, key, ModelEntry(
                            id=m['id'], name=m.get('name', m['id']),
                            type=ModelType.CHAT,
                            api_format=self._detect_api_format(m['id'], ModelType.CHAT),
                            enabled=m.get('enabled', True)
                        )
            # 未命中 → 回退全量第一个可用模型
            return self._first_available_model(providers, ModelType.CHAT)

        # ── 未指定/空 → 全量第一个可用模型 ──
        return self._first_available_model(providers, ModelType.CHAT)

    def _chat_candidates(self, model_str=None):
        """按首选路由优先、其它供应商/密钥中同名模型兜底的顺序返回文本候选。"""
        providers = self._load_providers()
        parts = (model_str or '').split(':') if model_str else []
        requested_model_id = (
            ':'.join(parts[2:]) if len(parts) >= 3
            else parts[1] if len(parts) == 2
            else parts[0] if len(parts) == 1
            else ''
        )
        preferred = (parts[0], parts[1]) if len(parts) >= 3 else (None, None)
        if not requested_model_id:
            provider, key, model = self._first_available_model(providers, ModelType.CHAT)
            if not provider or not model:
                return [], "没有启用并配置完整的对话模型，请先在设置中配置"
            requested_model_id = model.id
            preferred = (provider.get('id'), key.get('id'))

        candidates = []
        seen = set()
        found_model = False
        found_enabled_key = False

        def append_candidate(provider, key, model):
            candidate_id = (provider.get('id'), key.get('id'), model.get('id'))
            if candidate_id in seen:
                return
            if not self._get_connection(provider, key, ModelType.CHAT, model.get('id', '')):
                return
            seen.add(candidate_id)
            candidates.append((provider, key, ModelEntry(
                id=model['id'], name=model.get('name', model['id']),
                type=ModelType.CHAT,
                api_format=self._detect_api_format(model['id'], ModelType.CHAT),
                enabled=model.get('enabled', True),
            )))

        def scan(preferred_only=False):
            nonlocal found_model, found_enabled_key
            for provider in providers:
                for key in provider.get('keys') or []:
                    if preferred_only and (provider.get('id'), key.get('id')) != preferred:
                        continue
                    for model in key.get('models') or []:
                        if not model.get('enabled', True) or model.get('id') != requested_model_id:
                            continue
                        model_type = model.get('type', '')
                        is_chat = model_type == 'chat' or (
                            not model_type and self._is_chat_model(model.get('id', ''))
                        )
                        if not is_chat:
                            continue
                        found_model = True
                        if not provider.get('enabled') or not key.get('enabled', True):
                            continue
                        found_enabled_key = True
                        append_candidate(provider, key, model)

        if preferred[0]:
            scan(preferred_only=True)
        scan()
        if candidates:
            return candidates, ''
        if not found_model:
            return [], "所选对话模型已删除或未配置"
        if not found_enabled_key:
            return [], "所选对话模型的供应商或密钥已停用"
        return [], "所选对话模型尚未填写可用的 URL 或 API Key"

    def _drawing_candidates(self, model_str=None):
        """按首选路由优先、同名模型全局兜底的顺序返回可请求的图像候选。

        前端 value 仍是 ``provider:key:model``，但界面只显示模型名。某一把 Key
        失效时，不能因为路由 id 已固定就阻断其它供应商；这里保留首选顺序并收集
        所有配置了同一模型 ID 的可用连接，生成链路逐一尝试。
        """
        providers = self._load_providers()
        parts = (model_str or '').split(':') if model_str else []
        requested_model_id = (
            ':'.join(parts[2:]) if len(parts) >= 3
            else parts[1] if len(parts) == 2
            else parts[0] if len(parts) == 1
            else ''
        )
        preferred = (parts[0], parts[1]) if len(parts) >= 3 else (None, None)
        if not requested_model_id:
            provider, key, model = self._first_available_model(providers, ModelType.DRAWING)
            if not provider or not model:
                return [], "没有启用并配置完整的图片模型，请先在设置中配置"
            requested_model_id = model.id
            preferred = (provider.get('id'), key.get('id'))
        candidates = []
        seen = set()
        found_model = False
        found_enabled_key = False

        def append_candidate(provider, key, model):
            candidate_id = (provider.get('id'), key.get('id'), model.get('id'))
            if candidate_id in seen:
                return
            if not self._get_connection(provider, key, ModelType.DRAWING, model.get('id', '')):
                return
            seen.add(candidate_id)
            candidates.append((provider, key, ModelEntry(
                id=model['id'], name=model.get('name', model['id']),
                type=ModelType.DRAWING,
                api_format=self._detect_api_format(model['id'], ModelType.DRAWING),
                enabled=model.get('enabled', True),
            )))

        def scan(preferred_only=False):
            nonlocal found_model, found_enabled_key
            for provider in providers:
                for key in provider.get('keys') or []:
                    if preferred_only and (provider.get('id'), key.get('id')) != preferred:
                        continue
                    for model in key.get('models') or []:
                        if not model.get('enabled', True):
                            continue
                        model_type = model.get('type', '')
                        is_drawing = model_type == 'drawing' or (
                            not model_type and not self._is_chat_model(model.get('id', ''))
                        )
                        if not is_drawing:
                            continue
                        if requested_model_id and model.get('id') != requested_model_id:
                            continue
                        found_model = True
                        if not provider.get('enabled') or not key.get('enabled', True):
                            continue
                        found_enabled_key = True
                        append_candidate(provider, key, model)

        # 首先尊重节点当前选择；随后才找其它供应商/密钥中同名的模型。
        if preferred[0]:
            scan(preferred_only=True)
        scan()
        if candidates:
            return candidates, ''
        if requested_model_id and not found_model:
            return [], "所选图像模型已删除或未配置"
        if requested_model_id and not found_enabled_key:
            return [], "所选图像模型的供应商或密钥已停用"
        if requested_model_id:
            return [], "所选图像模型尚未填写可用的 URL 或 API Key"
        return [], "没有启用并配置完整的图片模型，请先在设置中配置"

    def _resolve_drawing_model(self, model_str=None):
        """解析图片生成模型（multi-key：与 _resolve_chat_model 同构）"""
        providers = self._load_providers()
        parts = (model_str or '').split(':') if model_str else []

        # ── 三段 id：精确命中 key，用 key.api_key 出图 ──
        if len(parts) >= 3:
            provider_id, key_id, model_id = parts[0], parts[1], ':'.join(parts[2:])
            for p in providers:
                if p.get('id') != provider_id or not p.get('enabled'):
                    continue
                keys = p.get('keys') or []
                key  = next((k for k in keys if k.get('id') == key_id), None)
                if key is None or not key.get('enabled', True):
                    raise AppError(503, "模型所属 Key 已删除或停用，请重新选择模型")
                for m in key.get('models', []):
                    if not m.get('enabled', True):
                        continue
                    if m.get('id') != model_id:
                        continue
                    m_type = m.get('type', '')
                    if m_type == 'drawing' or (not m_type and not self._is_chat_model(m['id'])):
                        return p, key, ModelEntry(
                            id=m['id'], name=m.get('name', m['id']),
                            type=ModelType.DRAWING,
                            api_format=self._detect_api_format(m['id'], ModelType.DRAWING),
                            enabled=m.get('enabled', True)
                        )
                # key 存在但模型已删除/停用：同样提示重选模型（旧节点引用失效）
                raise AppError(503, "模型所属 Key 已删除或停用，请重新选择模型")
            # provider 未找到/停用 → 回退全量第一个可用模型
            return self._first_available_model(providers, ModelType.DRAWING)

        # ── 两段 id（旧项目/旧 localStorage）：provider 各 enabled key 依次匹配同名模型 ──
        if len(parts) == 2:
            provider_id, model_id = parts
            for p in providers:
                if p.get('id') != provider_id or not p.get('enabled'):
                    continue
                for key in p.get('keys') or []:
                    if not key.get('enabled', True):
                        continue
                    for m in key.get('models', []):
                        if not m.get('enabled', True):
                            continue
                        if m.get('id') != model_id:
                            continue
                        m_type = m.get('type', '')
                        if m_type == 'drawing' or (not m_type and not self._is_chat_model(m['id'])):
                            return p, key, ModelEntry(
                                id=m['id'], name=m.get('name', m['id']),
                                type=ModelType.DRAWING,
                                api_format=self._detect_api_format(m['id'], ModelType.DRAWING),
                                enabled=m.get('enabled', True)
                            )
            # 未命中 → 回退全量第一个可用模型
            return self._first_available_model(providers, ModelType.DRAWING)

        # ── 未指定/空 → 全量第一个可用模型 ──
        return self._first_available_model(providers, ModelType.DRAWING)

    def _resolve_video_model(self, model_str=None):
        """解析视频生成模型（multi-key：与 _resolve_drawing_model 同构）。

        model_str: "provider_id:key_id:model_id" / 旧两段 "provider_id:model_id" / None
        返回: (provider_dict, key_dict, ModelEntry|None)
        匹配条件：m_type == 'video'，或未存 type 但实时规则判定为视频模型（旧数据兼容）。
        """
        providers = self._load_providers()
        parts = (model_str or '').split(':') if model_str else []

        # ── 三段 id：精确命中 key，用 key.api_key 出视频 ──
        if len(parts) >= 3:
            provider_id, key_id, model_id = parts[0], parts[1], ':'.join(parts[2:])
            for p in providers:
                if p.get('id') != provider_id or not p.get('enabled'):
                    continue
                keys = p.get('keys') or []
                key  = next((k for k in keys if k.get('id') == key_id), None)
                if key is None or not key.get('enabled', True):
                    raise AppError(503, "模型所属 Key 已删除或停用，请重新选择模型")
                for m in key.get('models', []):
                    if not m.get('enabled', True):
                        continue
                    if m.get('id') != model_id:
                        continue
                    m_type = m.get('type', '')
                    if m_type == 'video' or (
                        not m_type and self._detect_model_type(m['id'])[0] == ModelType.VIDEO
                    ):
                        return p, key, ModelEntry(
                            id=m['id'], name=m.get('name', m['id']),
                            type=ModelType.VIDEO,
                            api_format=self._detect_api_format(m['id'], ModelType.VIDEO),
                            enabled=m.get('enabled', True)
                        )
                # key 存在但模型已删除/停用：同样提示重选模型（旧节点引用失效）
                raise AppError(503, "模型所属 Key 已删除或停用，请重新选择模型")
            # provider 未找到/停用 → 回退全量第一个可用视频模型
            return self._first_available_model(providers, ModelType.VIDEO)

        # ── 两段 id（旧项目/旧 localStorage）：provider 各 enabled key 依次匹配同名模型 ──
        if len(parts) == 2:
            provider_id, model_id = parts
            for p in providers:
                if p.get('id') != provider_id or not p.get('enabled'):
                    continue
                for key in p.get('keys') or []:
                    if not key.get('enabled', True):
                        continue
                    for m in key.get('models', []):
                        if not m.get('enabled', True):
                            continue
                        if m.get('id') != model_id:
                            continue
                        m_type = m.get('type', '')
                        if m_type == 'video' or (
                            not m_type and self._detect_model_type(m['id'])[0] == ModelType.VIDEO
                        ):
                            return p, key, ModelEntry(
                                id=m['id'], name=m.get('name', m['id']),
                                type=ModelType.VIDEO,
                                api_format=self._detect_api_format(m['id'], ModelType.VIDEO),
                                enabled=m.get('enabled', True)
                            )
            # 未命中 → 回退全量第一个可用视频模型
            return self._first_available_model(providers, ModelType.VIDEO)

        # ── 未指定/空 → 全量第一个可用视频模型 ──
        return self._first_available_model(providers, ModelType.VIDEO)

    def _first_available_model(self, providers, model_type):
        """
        全量第一个可用模型（enabled provider + api_url 非空 → enabled key + api_key 非空
        → enabled 同型模型）。绘图/对话同构，返回 (provider_dict, key_dict, ModelEntry|None)。
        """
        for p in providers:
            if not p.get('enabled'):
                continue
            for key in p.get('keys') or []:
                if not key.get('enabled', True):
                    continue
                for m in key.get('models', []):
                    if not m.get('enabled', True):
                        continue
                    m_type = m.get('type', '')
                    if model_type == ModelType.CHAT:
                        # 视频防污染守卫：旧数据里曾以 type='chat' 落盘的视频模型按实时规则拒绝，
                        # 避免误发 /chat/completions（手动添加的 chat 模型兜底 detect 仍为 chat → 放行）
                        if m_type == 'chat':
                            is_match = self._is_chat_model(m['id'])
                        elif not m_type:
                            is_match = self._is_chat_model(m['id'])
                        else:
                            is_match = False
                    elif model_type == ModelType.VIDEO:
                        is_match = (
                            m_type == 'video'
                            or (not m_type and self._detect_model_type(m['id'])[0] == ModelType.VIDEO)
                        )
                    else:
                        is_match = (m_type == 'drawing' or (not m_type and not self._is_chat_model(m['id'])))
                    if not is_match:
                        continue
                    if not self._get_connection(p, key, model_type, m['id']):
                        continue
                    return p, key, ModelEntry(
                        id=m['id'], name=m.get('name', m['id']),
                        type=model_type,
                        api_format=self._detect_api_format(m['id'], model_type),
                        enabled=m.get('enabled', True)
                    )
        return None, None, None

    def _get_connection(self, provider, key, model_type, model_id=''):
        """返回模型连接；Key 按能力类型隔离，旧 key.api_key 仅经同类型 channel 兼容。"""
        kind = model_type.value
        # URL 保持原设置：文本优先 text_api_url，图像/视频走 api_url。
        api_url = (
            provider.get('text_api_url') or provider.get('api_url') or ''
            if model_type == ModelType.CHAT else provider.get('api_url') or ''
        ).strip()
        model = next((m for m in key.get('models', []) if m.get('id') == model_id), {})
        global_keys = provider.get('global_keys') or {}
        channel = (key.get('channels') or {}).get(kind) or {}
        channel_key = channel.get('api_key') if channel.get('enabled') is not False else ''
        api_key = str(
            model.get('api_key') or global_keys.get(kind) or channel_key or ''
        ).strip()
        return {'api_url': api_url, 'api_key': api_key} if api_url and api_key else None

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
        """解析对话请求 URL（FluxPort 媒体域先归一到语言域，再按 OpenAI Chat Completions 拼接）"""
        base = resolve_chat_api_base(api_url).rstrip('/')
        if base.endswith('/chat/completions'):
            return base
        if base.endswith('/v1'):
            return f"{base}/chat/completions"
        return f"{base}/v1/chat/completions"

    def _resolve_image_url(self, api_url, model_id, api_format, operation='generations'):
        """
        解析图片请求 URL。
        FluxPort 的语言域名 api.uselg.top 先映射到图片直连域名 api.ai-media.vip，
        再剥离 api_url 已带的 /v1、/v1beta 路径段（避免双重前缀），最后按格式拼接：
          - GEMINI_NATIVE  -> {origin}/v1beta/models/{model_id}:generateContent
          - OPENAI_IMAGE   -> {origin}/v1/images/generations 或 /edits
        """
        base = resolve_image_api_base(api_url)
        if api_format == ApiFormat.GEMINI_NATIVE:
            model_id = self._apply_resolution_suffix(model_id)
            return f"{base}/v1beta/models/{model_id}:generateContent"
        elif api_format == ApiFormat.OPENAI_IMAGE:
            if operation not in ('generations', 'edits'):
                raise ValueError(f"未知 OpenAI 图片操作: {operation}")
            return f"{base}/v1/images/{operation}"

        raise ModelNotSupportedError(model_id)

    def _apply_resolution_suffix(self, model_id):
        """给 Gemini 图片模型应用分辨率后缀（由调用方在 options 中指定）"""
        return model_id

    # ─────────────────────────────────────────
    # 内部方法：Payload 构建
    # ─────────────────────────────────────────
    def _build_chat_payload(self, model_id, messages, options):
        """构建对话请求 payload（显式 stream:false，对齐 FluxPort 手册示例，防御默认开流通道）"""
        payload = {
            "model":    model_id,
            "messages": messages,
            "stream":   False,
        }

        temp = options.get('temperature')
        if temp is not None:
            payload['temperature'] = float(temp)

        max_tokens = options.get('max_tokens')
        if max_tokens is not None:
            payload['max_tokens'] = int(max_tokens)

        return payload

    def _build_image_request(self, api_url, model_entry, prompt, options):
        """构建图片请求，返回 (url, requests.post 的 body kwargs)。"""
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
        mask_image = options.get('maskImage')
        if options.get('operation') == 'image-edit' and isinstance(mask_image, str) and mask_image.startswith('data:image'):
            mime_type = mask_image.split(';')[0].split(':')[1]
            parts.append({"inlineData": {"mimeType": mime_type, "data": mask_image.split(',', 1)[1]}})

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
        return url, {'json': payload}

    def _map_openai_image_size(self, resolution='1k', aspect_ratio='Auto'):
        """
        把 UI 的 resolution + aspectRatio 映射为 OpenAI size 字符串（宽x高）。
        映射规则：
          - aspectRatio 优先，resolution 决定约 1MP / 4MP / 合法最大档
          - 映射尺寸保持所选比例，并满足 gpt-image-2 的官方 size 约束
          - Auto / 未知 aspectRatio -> 官方 `auto`，由模型选择尺寸
          - 未知 resolution -> 按 1k 处理
        返回 OpenAI 合法 size（见 _OPENAI_ASPECT_TO_SIZE）。
        """
        res = str(resolution or '1k').strip().lower()
        tier = _OPENAI_RESOLUTION_TIER.get(res, 0)
        ar = str(aspect_ratio or 'Auto').strip().lower()
        sizes = _OPENAI_ASPECT_TO_SIZE.get(ar)
        if sizes is None:
            return 'auto'
        return sizes[tier]

    @staticmethod
    def _is_valid_openai_image_size(size):
        """校验 gpt-image-2 的官方 size 参数（或官方 auto）。"""
        if not isinstance(size, str):
            return False
        normalized = size.strip().lower()
        if normalized == 'auto':
            return True
        match = re.fullmatch(r'(\d+)x(\d+)', normalized)
        if not match:
            return False
        width, height = (int(match.group(1)), int(match.group(2)))
        long_edge, short_edge = max(width, height), min(width, height)
        return (
            long_edge <= 3840
            and width % 16 == 0
            and height % 16 == 0
            and short_edge > 0
            and long_edge <= short_edge * 3
            and 655_360 <= width * height <= 8_294_400
        )

    def _parse_data_url_image(self, data_url):
        """
        解析 data:image/*;base64,... 参考图，返回 (mime, base64_data)；
        任何解析/校验失败返回 None（调用方忽略并打日志，不阻断文生图）。
        """
        try:
            if not isinstance(data_url, str) or not data_url.startswith('data:image'):
                return None
            header, sep, encoded = data_url.partition(',')
            if not sep or not encoded:
                return None
            mime = header[5:].split(';')[0].strip() or 'image/png'
            # validate=True 严格校验 base64 字符集，非法数据直接判失败
            b64lib.b64decode(encoded, validate=True)
            return mime, encoded
        except Exception:
            return None

    def _build_openai_image_payload(self, api_url, model_id, prompt, options):
        """构建 OpenAI 图片（gpt-image / dall-e 系）payload"""
        model_lower = model_id.lower()
        is_gpt_image_2 = 'gpt-image-2' in model_lower
        image_origin = resolve_image_api_base(api_url)
        image_host = (urlparse(image_origin).hostname or '').lower()
        is_fluxport_media = image_host == 'api.ai-media.vip'
        is_official_openai = image_host == 'api.openai.com'

        # 参考图必须走 OpenAI Images edits 的 multipart 协议；文档示例明确不接受
        # generations JSON 里的自定义 image 字段。无参考图时走 generations JSON。
        reference_inputs = [
            img for img in options.get('referenceImages', [])
            if isinstance(img, str) and img.startswith('data:image')
        ]
        ref_images = []
        for img_data in reference_inputs:
            parsed = self._parse_data_url_image(img_data)
            if parsed is None:
                print("[UnifiedAPI] OpenAI 图片参考图解析失败，已忽略该图（不阻断文生图）")
                continue
            mime, data = parsed
            ref_images.append((mime, data))

        # GPT Image 2 的 size 是官方开放尺寸参数。只有直连官方端点才发送
        # size=auto；当前 FluxPort 中转会将 auto 静默降级为 1024x1024，故改为显式
        # 尺寸：优先参考图比例，无参考图则使用产品默认 3:4，始终保留用户所选分辨率档位。
        size = options.get('size')
        if is_gpt_image_2:
            use_auto_size = isinstance(size, str) and size.strip().lower() == 'auto'
            if not self._is_valid_openai_image_size(size) or (use_auto_size and not is_official_openai):
                requested_aspect = str(options.get('aspectRatio', 'Auto') or 'Auto').strip()
                if requested_aspect.lower() == 'auto' and not is_official_openai:
                    inferred_aspect = self._infer_aspect_from_ref(reference_inputs[0]) if reference_inputs else None
                    requested_aspect = inferred_aspect if inferred_aspect in _OPENAI_ASPECT_TO_SIZE else '3:4'
                size = self._map_openai_image_size(
                    options.get('resolution', '1k'),
                    requested_aspect,
                )
            else:
                size = size.strip().lower()
        else:
            if not self._is_valid_openai_image_size(size) or size.strip().lower() == 'auto':
                size = self._map_openai_image_size(
                    options.get('resolution', '1k'),
                    options.get('aspectRatio', 'Auto'),
                )
                if size == 'auto':
                    size = '1024x1024'
            else:
                size = size.strip().lower()
        n = options.get('count', 1)
        print(f"[UnifiedAPI] OpenAI 图片尺寸 | model={model_id} | host={image_host} | size={size}")
        # FluxPort 的 Grok 文档将文生图与编辑模型明确分开，提前给出可行动的错误，
        # 不把 quality 模型误送到 /images/edits 后再返回难懂的 4xx。
        if 'grok-imagine-image' in model_lower:
            is_edit_model = 'edit' in model_lower
            if ref_images and not is_edit_model:
                raise ValidationError('Grok 带参考图编辑请改用 grok-imagine-image-edit 模型')
            if not ref_images and is_edit_model:
                raise ValidationError('grok-imagine-image-edit 需要至少一张参考图；文生图请改用 grok-imagine-image-quality')
        mask_input = options.get('maskImage') if options.get('operation') == 'image-edit' else None
        parsed_mask = self._parse_data_url_image(mask_input) if isinstance(mask_input, str) else None
        if ref_images:
            files = [
                ('image', (f'reference-{index}.{mime.split("/")[-1]}', b64lib.b64decode(data), mime))
                for index, (mime, data) in enumerate(ref_images, start=1)
            ]
            form_data = {
                'model': model_id,
                'prompt': prompt,
                'n': str(n),
                'size': size,
            }
            if parsed_mask is not None:
                mask_mime, mask_data = parsed_mask
                files.append(('mask', (f'mask.{mask_mime.split("/")[-1]}', b64lib.b64decode(mask_data), mask_mime)))
            if is_fluxport_media:
                # 避免同步回包把大 base64 穿过 pywebview；服务端若有兼容策略会自行改写。
                form_data.update({'response_format': 'url', 'async': 'true'})
            url = self._resolve_image_url(api_url, model_id, ApiFormat.OPENAI_IMAGE, 'edits')
            return url, {'data': form_data, 'files': files}

        payload = {
            'model': model_id,
            'prompt': prompt,
            'n': n,
            'size': size,
        }
        if is_fluxport_media:
            # FluxPort 图片直连接口推荐异步任务；响应仍可能是同步 200，调用方兼容两种。
            # 平台可能按 Key/分组改写 response_format；客户端仍兼容 b64_json 与 url。
            payload.update({'async': True, 'response_format': 'url'})
        url = self._resolve_image_url(api_url, model_id, ApiFormat.OPENAI_IMAGE)
        return url, {'json': payload}

    # ─────────────────────────────────────────
    # 内部方法：异步任务轮询（HTTP 202 -> 轮询出图）
    # ─────────────────────────────────────────
    def _get_api_origin(self, api_url):
        """
        从 api_url 提取 origin（scheme://host[:port]）。
        api_url 可能带 /v1 路径（如 https://api.ai-media.vip/v1），需剥掉路径只留 origin。
        """
        parsed = urlparse(api_url)
        if parsed.scheme and parsed.netloc:
            return f"{parsed.scheme}://{parsed.netloc}"
        return api_url.rstrip('/')

    def _join_origin_path(self, origin, path):
        """把相对路径拼到 origin 上，保证 origin 与 path 之间只保留一个斜杠"""
        origin = origin.rstrip('/')
        path = path if path.startswith('/') else '/' + path
        return origin + path

    def _parse_expires_at(self, expires_at):
        """
        解析任务 expires_at 时间戳（如 2026-08-17T00:19:36+08:00），返回 epoch 秒；
        解析失败返回 None（调用方回退到固定 120s 超时上限）。
        """
        if not isinstance(expires_at, str) or not expires_at.strip():
            return None
        try:
            from datetime import datetime
            dt = datetime.fromisoformat(expires_at.strip().replace('Z', '+00:00'))
            return dt.timestamp()
        except Exception:
            return None

    def _extract_task_error(self, data):
        """从异步任务响应中提取人类可读的错误信息"""
        if not isinstance(data, dict):
            return "未知错误"
        error = data.get('error')
        if isinstance(error, dict):
            return error.get('message') or str(error)
        if error:
            return str(error)
        error_code = data.get('error_code')
        if error_code:
            return f"error_code={error_code}"
        return "未知错误"

    def _extract_async_image_urls(self, result, origin):
        """
        从异步任务完成响应中提取图片 URL 列表。
        返回 (images, kind)：
          - kind='url'    ：完整可直链 URL（assets[].signed_url / data[].url 绝对地址），
                            无需鉴权即可下载
          - kind='fileuri'：相对路径资源（assets[].url|download_url 相对、fileData.fileUri），
                            已拼 origin，需带 Authorization 下载
          - kind='base64' ：data:image/...;base64, 直接可用（Gemini 原生 inlineData）
          - 未出图返回 ([], None)
        """
        if not isinstance(result, dict):
            return [], None

        # 1) assets[]：FluxPort 异步任务资产清单
        #    优先 signed_url（6 小时临时 HTTPS 直链，免 Authorization）；
        #    缺失时用 url / download_url（相对路径拼 origin，需带 API Key 下载）
        assets = result.get('assets')
        if isinstance(assets, list):
            signed_images = []
            authed_images = []
            for asset in assets:
                if not isinstance(asset, dict):
                    continue
                signed = asset.get('signed_url')
                if isinstance(signed, str) and signed.strip():
                    signed = signed.strip()
                    signed_images.append(
                        signed if signed.startswith(('http://', 'https://'))
                        else self._join_origin_path(origin, signed)
                    )
                    continue
                raw = asset.get('url') or asset.get('download_url')
                if isinstance(raw, str) and raw.strip():
                    raw = raw.strip()
                    authed_images.append(
                        raw if raw.startswith(('http://', 'https://'))
                        else self._join_origin_path(origin, raw)
                    )
            if signed_images:
                return signed_images, 'url'
            if authed_images:
                return authed_images, 'fileuri'

        # 2) data[]（OpenAI DALL-E 风格 / 部分中转站完整 URL）
        data = result.get('data')
        if isinstance(data, list):
            url_images = []
            authed_images = []
            for item in data:
                if not isinstance(item, dict):
                    continue
                raw = item.get('url')
                if not raw:
                    continue
                raw = str(raw).strip()
                if raw.startswith(('http://', 'https://')):
                    url_images.append(raw)
                else:
                    authed_images.append(self._join_origin_path(origin, raw))
            if url_images:
                return url_images, 'url'
            if authed_images:
                return authed_images, 'fileuri'

        # 3) candidates[].content.parts[]：
        #    inlineData（Gemini 原生 base64，兼容 camelCase / snake_case）
        #    fileData.fileUri（相对路径，需拼 origin 带鉴权下载）
        candidates = result.get('candidates')
        if isinstance(candidates, list):
            base64_images = []
            file_images = []
            for candidate in candidates:
                if not isinstance(candidate, dict):
                    continue
                content = candidate.get('content')
                parts = content.get('parts') if isinstance(content, dict) else None
                if not isinstance(parts, list):
                    continue
                for part in parts:
                    if not isinstance(part, dict):
                        continue
                    inline = part.get('inlineData') or part.get('inline_data')
                    if isinstance(inline, dict):
                        b64_data = inline.get('data') or inline.get('base64')
                        if b64_data:
                            mime = (
                                inline.get('mimeType')
                                or inline.get('mime_type')
                                or 'image/png'
                            )
                            base64_images.append(f"data:{mime};base64,{b64_data}")
                            continue
                    file_data = part.get('fileData') or part.get('file_data')
                    if isinstance(file_data, dict):
                        file_uri = file_data.get('fileUri')
                        if not file_uri:
                            continue
                        file_uri = str(file_uri).strip()
                        if file_uri.startswith(('http://', 'https://')):
                            file_images.append(file_uri)
                        else:
                            file_images.append(self._join_origin_path(origin, file_uri))
            if base64_images:
                return base64_images, 'base64'
            if file_images:
                return file_images, 'fileuri'

        return [], None

    def _download_image_to_file(self, url, headers=None, proxies=None, save_dir='', label='图片'):
        """流式下载原图到本地，返回正斜杠绝对路径。

        不把 4K 原图塞进 base64 字符串：这既会额外占用约 33% 内存，也会让后续
        pywebview 桥接不得不等待一个根本不会展示给用户的大 payload。fileUri 可
        传 headers 下载；签名/公开 URL 则不传 headers。
        """
        file_path = None
        started_at = time.perf_counter()
        total_bytes = 0
        try:
            resp = requests.get(
                url,
                headers=headers,
                timeout=(10, 120),
                proxies=proxies,
                stream=True,
            )
            if resp.status_code != 200:
                print(f"[UnifiedAPI] {label}下载失败: HTTP {resp.status_code} | {url[:80]}")
                return None

            content_type = resp.headers.get('Content-Type', 'image/png')
            ext = _guess_image_ext(content_type, b'')
            directory = self._get_save_dir(save_dir)
            file_path = os.path.join(directory, self._make_filename(ext))
            chunks = getattr(resp, 'iter_content', None)
            iterator = chunks(chunk_size=256 * 1024) if callable(chunks) else (resp.content,)
            with open(file_path, 'wb') as f:
                for chunk in iterator:
                    if not chunk:
                        continue
                    f.write(chunk)
                    total_bytes += len(chunk)

            elapsed = time.perf_counter() - started_at
            normalized = file_path.replace('\\', '/')
            print(f"[UnifiedAPI] {label}已落盘 | {total_bytes / 1024 / 1024:.1f}MB | {elapsed:.1f}s | {normalized}")
            return normalized
        except Exception as e:
            print(f"[UnifiedAPI] {label}下载异常: {e}")
            if file_path:
                try:
                    os.remove(file_path)
                except OSError:
                    pass
            return None

    def _poll_async_image_task(self, task_data, origin, headers, proxies, session=None,
                               progress_task_id=None):
        """
        轮询 FluxPort 风格异步图片任务（HTTP 202 -> 任务对象 -> 轮询直到出图）。
        优先使用 status_url（?view=summary 轻量接口，不拉大 base64），
        缺失时回退 poll_url / result_url。
        返回 {"success": True, "image_url": ..., "images": [...]}。
        已接受任务后的失败统一抛 AcceptedImageTaskError，阻止外层错误地换 Key 重投。
        """
        if not isinstance(task_data, dict):
            task_data = {}

        # 确定轮询 URL：status_url（轻量 summary，推荐）-> poll_url -> result_url -> 拼 task_id
        poll_url = (
            task_data.get('status_url')
            or task_data.get('poll_url')
            or task_data.get('result_url')
            or ''
        )
        task_id = task_data.get('task_id') or task_data.get('id') or ''
        self._update_async_image_task(
            progress_task_id,
            remote_task_id=task_id or None,
            remote_status='accepted',
        )
        if not poll_url and task_id:
            poll_url = f"/v1/images/tasks/{task_id}?view=summary"
        if not poll_url:
            raise AcceptedImageTaskError(
                502,
                "远端任务已接受，但响应缺少状态查询地址，无法确认结果",
                task_id,
            )
        if not poll_url.startswith(('http://', 'https://')):
            poll_url = self._join_origin_path(origin, poll_url)

        # 轮询间隔：poll_after_ms（默认 2000ms），下限 2s（文档要求，防打爆轻量接口）
        poll_after_ms = task_data.get('poll_after_ms')
        try:
            poll_interval = float(poll_after_ms) / 1000.0 if poll_after_ms else 2.0
        except (TypeError, ValueError):
            poll_interval = 2.0
        poll_interval = max(2.0, poll_interval)

        # 总超时上限：默认 8 分钟（图片任务可能排队较久）；
        # 若有 expires_at 且剩余时间更短，则以 expires_at + 60s 缓冲为上限。
        timeout_limit = float(_IMAGE_TASK_TIMEOUT_SECONDS)
        expires_ts = self._parse_expires_at(task_data.get('expires_at'))
        if expires_ts is not None:
            remaining = expires_ts - time.time()
            if remaining > 0:
                timeout_limit = min(timeout_limit, remaining + 60.0)
        deadline = time.time() + timeout_limit

        print(f"[UnifiedAPI] 异步任务已接受(202) | task_id={task_id or '-'} | poll_url={poll_url} | "
              f"间隔={poll_interval:.1f}s | 超时={timeout_limit:.0f}s")

        consecutive_failures = 0  # 429 / 网络错误连续计数，用于逐步退避
        soft_state_count = 0      # uncertain / client_disconnected 连续计数，避免无限挂起
        http = session or requests.Session()

        while time.time() < deadline:
            try:
                resp = http.get(poll_url, headers=headers, timeout=(10, 60), proxies=proxies)
            except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
                # 网络错误：退避重试（5-10s），不立即判失败
                consecutive_failures += 1
                wait = min(poll_interval * (2 ** min(consecutive_failures, 3)), 10.0)
                print(
                    f"[UnifiedAPI] 异步任务轮询网络异常({type(e).__name__}: {e!r}) | "
                    f"task_id={task_id or '-'} | {wait:.1f}s 后重试"
                )
                time.sleep(wait)
                continue

            if resp.status_code == 429:
                # 限流：退避重试
                consecutive_failures += 1
                wait = min(poll_interval * (2 ** min(consecutive_failures, 3)), 10.0)
                print(f"[UnifiedAPI] 异步任务轮询 429 限流，{wait:.1f}s 后退避重试")
                time.sleep(wait)
                continue

            if resp.status_code != 200:
                try:
                    self._handle_http_error(resp)
                except AppError as error:
                    raise AcceptedImageTaskError(
                        error.code,
                        f"远端任务状态查询失败：{error.message}",
                        task_id,
                    )

            consecutive_failures = 0

            try:
                data = resp.json()
            except ValueError:
                print("[UnifiedAPI] 异步任务轮询响应非 JSON，稍后重试...")
                time.sleep(poll_interval)
                continue

            # 平台允许每次状态响应调整建议轮询间隔，仍遵守至少 2 秒的下限。
            next_poll_after = data.get('poll_after_ms') if isinstance(data, dict) else None
            try:
                if next_poll_after is not None:
                    poll_interval = max(2.0, float(next_poll_after) / 1000.0)
            except (TypeError, ValueError):
                pass

            status = data.get('status') if isinstance(data, dict) else None
            status_l = str(status).strip().lower() if status is not None else ''
            self._update_async_image_task(
                progress_task_id,
                remote_task_id=task_id or None,
                remote_status=status_l or 'querying',
            )

            # 终态失败：failed / error / canceled / cancelled / paused / timeout
            if status_l in ('failed', 'error', 'canceled', 'cancelled', 'paused', 'timeout'):
                raise AcceptedImageTaskError(
                    502,
                    f"远端图片任务{status_l}：{self._extract_task_error(data)}",
                    task_id,
                )

            # 软失败态：uncertain / client_disconnected —— 先查原任务，勿盲目重发；
            # 连续出现多次仍未恢复则按错误提示退出（避免无限挂起）
            if status_l in ('uncertain', 'client_disconnected'):
                soft_state_count += 1
                print(f"[UnifiedAPI] 异步任务状态 {status_l}（第 {soft_state_count} 次），"
                      f"继续查询原任务... {self._extract_task_error(data)}")
                if soft_state_count >= 6:
                    raise AcceptedImageTaskError(
                        502,
                        f"远端图片任务持续处于 {status_l} 状态，结果不确定：{self._extract_task_error(data)}",
                        task_id,
                    )
                time.sleep(poll_interval)
                continue
            soft_state_count = 0

            # 显式 error 字段
            if isinstance(data, dict) and (data.get('error') or data.get('error_code')):
                raise AcceptedImageTaskError(
                    502,
                    f"远端图片任务错误：{self._extract_task_error(data)}",
                    task_id,
                )

            # 提取图片（assets[] / data[] / candidates[]）
            images, kind = self._extract_async_image_urls(data, origin)
            if images:
                print(f"[UnifiedAPI] 异步任务完成 | task_id={task_id or '-'} | 图片 {len(images)} 张 | kind={kind}")
                if kind == 'fileuri':
                    # fileUri / 相对 url：受保护资源，带 Authorization 直接流式落盘。
                    # 后续 _save_images_to_local 从文件生成缩略图，避免 4K base64 往返。
                    local_paths = [
                        path for path in (
                            self._download_image_to_file(u, headers=headers, proxies=proxies, label='异步任务原图')
                            for u in images
                        )
                        if path
                    ]
                    if not local_paths:
                        raise UpstreamError(
                            502,
                            "异步任务图片下载失败（需鉴权的资源无法获取），请检查 API 密钥或稍后重试"
                        )
                    images = [f"file:///{path}" for path in local_paths]
                # kind == 'url'：signed_url / 绝对直链，无需鉴权（_save_images_to_local 流式下载）
                # kind == 'base64'：data URL 直接可用
                return {
                    "success":   True,
                    "image_url": images[0],
                    "images":    images,
                    "remote_task_id": task_id or None,
                }

            # 完成态但没有图片 -> 数据异常（图片任务完成态是 success，不是 completed）
            if status_l == 'success':
                raise AcceptedImageTaskError(
                    502,
                    f"远端图片任务标记为 success，但响应中未找到图片数据：{self._extract_task_error(data)}",
                    task_id,
                )

            time.sleep(poll_interval)

        raise AcceptedImageTaskError(
            504,
            "远端图片任务已提交，但 5 分钟内无法确认结果；请稍后在中转商后台查询",
            task_id,
        )

    # ─────────────────────────────────────────
    # 内部方法：响应解析
    # ─────────────────────────────────────────
    def _parse_chat_response(self, result):
        """解析对话响应"""
        try:
            message = result['choices'][0]['message']
            content = message.get('content')

            if isinstance(content, str):
                return {"success": True, "text": _repair_utf8_mojibake(content)}

            if isinstance(content, list):
                texts = [
                    part.get('text', '')
                    for part in content
                    if isinstance(part, dict) and part.get('type') == 'text'
                ]
                return {"success": True, "text": _repair_utf8_mojibake('\n'.join(texts))}

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
    # 内部方法：图片本地保存（返回缩略图 + 原图路径引用，图片性能优化）
    # ─────────────────────────────────────────
    def _save_images_to_local(self, parsed, save_dir='', proxies=None):
        """
        主链路后处理：原图落盘 + 缩略图生成 + 路径收集（图片性能优化）。
        - 逐图流程：归一原始图（base64 data URL / http URL → 下载转 base64）→ 原图落盘收集 original_path
          → 生成 JPEG q85 / 最长边 1024px 缩略图 data URL → 展示图（image_url/images）切换为缩略图。
        - 返回结构（新）：thumbnail/thumbnails（data URL）、original_path/original_paths（绝对路径，正斜杠）、
          original_url/original_urls（file:// 引用，仅信息性，禁止直接用于渲染）、
          width/height（原图真实像素，PIL im.size；多图时另有 widths/heights，均可能为 None）。
        - 双轨回退：逐图缩略图失败 → 该图 image 保留原 base64、original_* 对应项置 None（不阻断）；
          http 下载失败 → 保持原 URL（沿用旧语义）。
        - saved_to_disk: bool —— 是否写入用户配置目录（tempfile 兜底为 false，前端据此提示不阻断）。
        """
        configured_dir = self._configured_image_save_dir()
        # 本次保存目标：显式传入目录优先；否则用户配置目录；都无 → 内部 _get_save_dir 回退 tempfile（saved_to_disk=false）
        target = save_dir if (save_dir and os.path.isdir(save_dir)) else configured_dir
        saved_to_disk = bool(target)

        thumbnails = []
        original_paths = []
        original_urls = []
        widths = []
        heights = []

        def process(img):
            # 展示图策略（治本：done 响应不携带大 payload / 不可访问 URL——大 base64 跨 pywebview
            # 桥接传输慢且可能被截断，导致「后端已完成、前端无图」）。
            #   - 缩略图生成成功 → display=缩略图 data URL（小，桥接传输轻量）；
            #   - 缩略图失败但有 original_path → display=None（不回退大 base64），前端按路径经
            #     load_local_image 取图兜底（前端契约：success 且 image_url/original_path 任一即可）；
            #   - http 直链下载失败 → 保留原 URL 作展示（公开直链可渲染；沿用旧语义，不静默丢图）；
            #   - 缩略图失败且无 original_path → 回退原 base64（唯一可展示途径；罕见）。
            display = None
            thumb = None
            orig_path = None
            orig_url = None
            orig_w = None
            orig_h = None

            original_data_url = img if isinstance(img, str) else None
            local_path = None
            if isinstance(img, str) and img.startswith('file:///'):
                # fileUri 已在异步链路鉴权并流式保存；直接从文件生成缩略图，勿再读成大 base64。
                candidate = img[len('file:///'):]
                if os.path.isfile(candidate):
                    local_path = candidate.replace('\\', '/')
                else:
                    print(f"[UnifiedAPI] 本地原图不存在: {candidate}")
                    original_data_url = None
            elif isinstance(img, str) and img.startswith('http'):
                # 签名 URL / 公开直链同样直接流式落盘。此前这里会先转成整张图的 base64，
                # 对 4K 图造成额外编码、解码和内存峰值，且延迟前端拿到缩略图。
                local_path = self._download_image_to_file(img, proxies=proxies, save_dir=save_dir, label='原图')
                if not local_path:
                    display = img  # 公开直链下载失败仍让前端自行尝试加载
                    original_data_url = None

            if local_path:
                orig_path = local_path
                orig_url = f"file:///{local_path}"
                thumb = make_thumbnail_data_url_from_file(local_path)
                if thumb:
                    display = thumb
                try:
                    with Image.open(local_path) as im:
                        orig_w, orig_h = im.size
                except Exception:
                    pass

            if not local_path and isinstance(original_data_url, str) and original_data_url.startswith('data:image'):
                # 原图落盘（失败不影响返回；缩略图仍可基于 bytes 生成）
                file_path = self._save_base64_to_dir(original_data_url, save_dir)
                if file_path:
                    orig_path = file_path  # 绝对路径，正斜杠（_save_base64_to_dir 已 replace('\\','/')）
                    orig_url = f"file:///{file_path}"
                # 生成缩略图 data URL（JPEG q85 / 最长边 1024px）
                try:
                    _, data = original_data_url.split(',', 1)
                    image_bytes = b64lib.b64decode(data)
                except Exception:
                    image_bytes = None
                thumb = make_thumbnail_data_url(image_bytes) if image_bytes else None
                if thumb:
                    display = thumb
                elif not orig_path:
                    # 兜底：缩略图失败且原图未落盘 → 回退原 base64（唯一可展示途径；罕见）
                    display = original_data_url
                # 缩略图失败但有 original_path：display 保持 None（不回退大 base64），前端按路径取图
                # 原图真实像素（PIL im.size；必须原图尺寸，缩略图不算）
                if image_bytes:
                    try:
                        with Image.open(io.BytesIO(image_bytes)) as im:
                            orig_w, orig_h = im.size
                    except Exception:
                        pass

            thumbnails.append(thumb)
            original_paths.append(orig_path)
            original_urls.append(orig_url)
            widths.append(orig_w)
            heights.append(orig_h)
            return display

        if parsed.get('images'):
            processed = [process(u) for u in parsed['images']]
            parsed['images'] = processed
            parsed['thumbnails'] = thumbnails
            parsed['original_paths'] = original_paths
            parsed['original_urls'] = original_urls
            parsed['image_url'] = (
                processed[0] if processed
                else parsed.get('image_url')
            )
            parsed['thumbnail'] = thumbnails[0] if thumbnails else None
            parsed['original_path'] = original_paths[0] if original_paths else None
            parsed['original_url'] = original_urls[0] if original_urls else None
            parsed['widths'] = widths
            parsed['heights'] = heights
            parsed['width'] = widths[0] if widths else None
            parsed['height'] = heights[0] if heights else None
        elif parsed.get('image_url'):
            single = process(parsed['image_url'])
            parsed['image_url'] = single
            parsed['thumbnail'] = thumbnails[0] if thumbnails else None
            parsed['original_path'] = original_paths[0] if original_paths else None
            parsed['original_url'] = original_urls[0] if original_urls else None
            parsed['width'] = widths[0] if widths else None
            parsed['height'] = heights[0] if heights else None
        parsed['saved_to_disk'] = saved_to_disk
        return parsed

    def _configured_image_save_dir(self):
        """读取用户配置的图片保存目录；未配置/读取失败返回 None（P2 主生成链路落盘用）"""
        if self.settings_api is None:
            return None
        try:
            settings = self.settings_api.load_settings() or {}
            path = (settings.get('image_save_path') or '').strip()
            return path or None
        except Exception:
            return None

    def _get_save_dir(self, save_dir=''):
        """解析图片落盘目录（P2）：
        显式传入且存在 → 用之；否则读 settings.image_save_path（makedirs 兜底创建）；
        仅配置缺失/非法才回退 tempfile（保证 base64 仍可用）。
        """
        if save_dir and os.path.isdir(save_dir):
            return save_dir
        configured = self._configured_image_save_dir()
        if configured:
            try:
                os.makedirs(configured, exist_ok=True)
                if os.path.isdir(configured):
                    return configured
            except Exception:
                pass
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

    def _download_url_to_base64(self, url, proxies=None):
        """
        将 URL 图片下载并转换为 base64 data URL 格式
        确保中转站返回的 URL 图片也能以 base64 格式返回给前端
        """
        try:
            print(f"[UnifiedAPI] 下载签名图片 | url={url[:120]}")
            resp = requests.get(url, timeout=(10, 30), proxies=proxies)
            if resp.status_code != 200:
                return None

            content_type = resp.headers.get('Content-Type', 'image/png')
            ext = _guess_image_ext(content_type, resp.content)

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

        # FluxPort 等中转站对部分 Key 分组不支持 OpenAI 图片格式（实测 /v1/images/generations 返回 404）
        if 'images api is not supported' in error_msg.lower():
            raise AppError(
                response.status_code,
                "该供应商分组不支持 OpenAI 图片格式（Images API 不可用），"
                "请改用 Gemini 原生图片模型（如 gemini-3-pro-image-preview / "
                "gemini-3.1-flash-image-preview）"
            )
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
