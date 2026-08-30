# backend/api/model_rules.py
"""
模型识别规则公共模块（单一事实来源）

被以下模块共用，保证分类语义一致、规则不重复定义：
- provider_api.py：fetch_models 拉取模型时按类型分组（drawing / chat）
- unified_api.py ：_detect_model_type 请求路由时判定模型类型与 API 格式

依赖方向：本模块不依赖任何业务模块（纯常量 + 纯函数），
避免 provider_api <-> unified_api 之间的循环依赖。
"""
import json
import re
from typing import List, Tuple

# ─────────────────────────────────────────
# 模型类型常量（与 unified_api.ModelType 枚举值保持一致）
# ─────────────────────────────────────────
MODEL_TYPE_DRAWING = 'drawing'
MODEL_TYPE_CHAT    = 'chat'
MODEL_TYPE_VIDEO   = 'video'
MODEL_TYPE_AUDIO   = 'audio'

# ─────────────────────────────────────────
# 绘图模型显示名规则（关键字 -> 显示名称）
# 大小写不敏感，从上到下优先匹配第一条
# 用于拉取模型时给 drawing 模型起显示名（如 Nano Banana Pro）
# ─────────────────────────────────────────
DRAWING_MODEL_RULES: List[Tuple[str, str]] = [
    # Nano Banana Pro
    ('gemini-3-pro-image-preview', 'Nano Banana Pro'),
    # Nano Banana 2
    ('gemini-3.1-flash-image-preview', 'Nano Banana 2'),
]

# ─────────────────────────────────────────
# 绘图模型关键字规则（关键字 -> API 格式名）
# 格式名为字符串形式，与 unified_api.ApiFormat 枚举值一一对应
# ─────────────────────────────────────────
DRAWING_RULES: List[Tuple[str, str]] = [
    ('gemini',       'gemini_native'),
    ('nano-banana',  'gemini_native'),
    ('seedream',     'gemini_native'),
    ('dall-e',       'openai_image'),
    ('dall-e-',      'openai_image'),
    # 子串匹配：gpt-image / gpt-image-1 / gpt-image-2 等均命中本规则 -> openai_image
    ('gpt-image',    'openai_image'),
    # FluxPort 文档中的 Grok 图片模型同样走 OpenAI Images 协议。
    # 缺这条时 grok-imagine-image-* 会落入默认 chat 路由，根本不会请求图片端点。
    ('grok-imagine-image', 'openai_image'),
    ('dalle',        'openai_image'),
]

# ─────────────────────────────────────────
# 视频模型关键字规则（关键字 -> API 格式名）
# 格式名为字符串形式，与 unified_api.ApiFormat 枚举值一一对应
# FluxPort 手册第 5 节明确：视频模型一律 POST /v1/videos 全异步任务协议。
# 子串匹配为前缀自由匹配，对 /v1/models 返回的真实 id 低风险。
# ─────────────────────────────────────────
VIDEO_RULES: List[Tuple[str, str]] = [
    ('grok-imagine-video', 'fluxport_video'),
    ('veo',                'fluxport_video'),
    ('kling',              'fluxport_video'),
    ('runway',             'fluxport_video'),
    ('pika',               'fluxport_video'),
    ('sora',               'fluxport_video'),
    ('wan',                'fluxport_video'),
]

# ─────────────────────────────────────────
# 音频模型关键字规则（关键字 -> API 格式名）
# 4.2-B：当前没有任何已确认的真实音频供应商/协议，规则写成「可配置」：
#   1) 关键字覆盖常见音频能力命名；格式先归入 'fluxport_audio'（异步任务协议，
#      与视频同构，见 audio_api.AUDIO_ADAPTERS）；
#   2) 若某模型实为同步生成（OpenAI 兼容 /v1/audio/generations），把对应行改为
#      'openai_audio' 即可；unified_api._API_FORMAT_MAP 已登记两种格式。
#   3) 匹配顺序放在对话规则之后（音频规则在 detect_model_type 中最后判定）：
#      「gpt-4o-audio / whisper」这类含 audio 子串的对话模型必须优先命中 chat，
#      避免被误判为音频生成模型（能力门控在前端 getAudioModelCapabilities 仍为 available:false）。
# ─────────────────────────────────────────
AUDIO_RULES: List[Tuple[str, str]] = [
    ('music',          'fluxport_audio'),
    ('sound-effect',   'fluxport_audio'),
    ('sound_effect',   'fluxport_audio'),
    ('sfx',            'fluxport_audio'),
    ('tts',            'fluxport_audio'),
    ('text-to-speech', 'fluxport_audio'),
    ('text-to-audio',  'fluxport_audio'),
    ('audio-gen',      'fluxport_audio'),
]

# ─────────────────────────────────────────
# 对话模型关键字规则（关键字 -> API 格式名）
# ─────────────────────────────────────────
CHAT_RULES: List[Tuple[str, str]] = [
    ('gpt-',        'openai_chat'),
    ('claude-',     'openai_chat'),
    ('o1-',         'openai_chat'),
    ('o2-',         'openai_chat'),
    ('o3-',         'openai_chat'),
    ('o4-',         'openai_chat'),
    ('deepseek',    'openai_chat'),
    ('qwen',        'openai_chat'),
    ('yi-',         'openai_chat'),
    ('moonshot',    'openai_chat'),
    ('glm-',        'openai_chat'),
    ('gemini',      'openai_chat'),
    ('llama',       'openai_chat'),
    ('mistral',     'openai_chat'),
    ('qwq',         'openai_chat'),
    ('r1-',         'openai_chat'),
]


def detect_model_type(model_id: str) -> str:
    """
    根据模型 ID 关键字推断模型类型（纯函数，无副作用）。

    返回 MODEL_TYPE_DRAWING / MODEL_TYPE_VIDEO / MODEL_TYPE_AUDIO / MODEL_TYPE_CHAT
    （字符串，与 ModelType 枚举值一致）。
    匹配顺序：绘图规则 → 视频规则 → 对话规则 → 音频规则，兜底按对话模型处理
    （音频放最后：含 audio 子串的对话模型如 gpt-4o-audio 优先命中 chat）。
    """
    lower = (model_id or '').lower().strip()

    for kw, _fmt in DRAWING_RULES:
        if kw in lower:
            return MODEL_TYPE_DRAWING

    for kw, _fmt in VIDEO_RULES:
        if kw in lower:
            return MODEL_TYPE_VIDEO

    for kw, _fmt in CHAT_RULES:
        if kw in lower:
            return MODEL_TYPE_CHAT

    for kw, _fmt in AUDIO_RULES:
        if kw in lower:
            return MODEL_TYPE_AUDIO

    return MODEL_TYPE_CHAT


def detect_model_format_name(model_id: str) -> str:
    """
    根据模型 ID 关键字推断 API 格式名（纯函数，无副作用）。

    返回格式名字符串（对应 unified_api.ApiFormat 枚举值）：
    'openai_chat' / 'openai_image' / 'gemini_native' / 'fluxport_video' / 'fluxport_audio' / 'openai_audio'。
    命中绘图/视频/对话/音频规则时返回对应格式名；均未命中时返回 'openai_chat'。
    """
    lower = (model_id or '').lower().strip()

    for kw, fmt in DRAWING_RULES:
        if kw in lower:
            return fmt

    for kw, fmt in VIDEO_RULES:
        if kw in lower:
            return fmt

    for kw, fmt in CHAT_RULES:
        if kw in lower:
            return fmt

    for kw, fmt in AUDIO_RULES:
        if kw in lower:
            return fmt

    return 'openai_chat'


# ─────────────────────────────────────────
# 4.3-D 模型能力 schema：内置规则源 + 校验 + custom-declarative 白名单
#
# 原则（4.3 规范 §D1 + 4.0 总控 §3.4）：
# - 内置规则仍由后端维护（本文件为内置 schema 源）；用户 schema 存储于
#   capability_schemas.json（随设置备份、不含 Key），可覆盖内置规则。
# - custom-declarative 是声明式白名单，不是脚本执行器：只能描述 URL path、
#   字段映射、状态字段、结果字段白名单；禁止 eval、任意脚本、任意 Header 注入。
# - schema 缺字段/校验失败时不可保存为可运行模型。
# ─────────────────────────────────────────
REQUEST_ADAPTER_WHITELIST = ('openai-image', 'gemini-native', 'fluxport-video', 'custom-declarative')
MODEL_KIND_WHITELIST = ('chat', 'drawing', 'video', 'audio')
AUDIO_FORMAT_WHITELIST = ('mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a')
FIELD_MAPPING_KEYS = (
    'prompt', 'model', 'seconds', 'format', 'aspectRatio', 'resolution',
    'referenceImages', 'startFrame', 'endFrame', 'audio',
)
TASK_FIELD_KEYS = (
    'taskIdField', 'pollUrlField', 'statusField', 'completedValues',
    'failedValues', 'resultUrlFields', 'pollIntervalMs',
)
# 注入防护：任何疑似 header/eval/脚本/原型链字段一律拒绝
_INJECTION_WORDS = ('header', 'eval', 'exec', 'script', 'code', 'constructor', 'prototype', '__')
_SECRET_WORDS = ('api_key', 'apikey', 'authorization', 'token', 'secret', 'password')

_DOT_PATH_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_.\[\]]*$')
_RATIO_RE = re.compile(r'^\d+:\d+$')


def _is_ratio_like(value):
    return isinstance(value, str) and (_RATIO_RE.match(value) or value == 'Auto')


def _clean_identifier(value, label, errors):
    """校验字段名为合法标识符/点路径；返回清洗后的字符串或 None。"""
    if value is None:
        return None
    if not isinstance(value, str):
        errors.append(f'{label} 必须是字符串')
        return None
    text = value.strip()
    if not text:
        return None
    if len(text) > 200:
        errors.append(f'{label} 过长')
        return None
    if not _DOT_PATH_RE.match(text):
        errors.append(f'{label}「{text}」非法（仅允许字母/数字/下划线/点/中括号）')
        return None
    return text


def _clean_string_list(value, label, errors, max_len=20, item_max=200):
    if value is None:
        return []
    if not isinstance(value, list):
        errors.append(f'{label} 必须是字符串数组')
        return []
    result = []
    for item in value:
        if not isinstance(item, str):
            errors.append(f'{label} 含非字符串项')
            continue
        text = item.strip()
        if text and len(text) <= item_max and text not in result:
            result.append(text)
    if len(result) > max_len:
        errors.append(f'{label} 项数过多')
        return result[:max_len]
    return result


def validate_capability_schema(schema):
    """
    校验用户能力 schema。返回 (ok, errors)。
    errors 为空列表表示通过；任何缺失/非法字段都会进 errors（缺字段不可保存为可运行模型）。
    校验通过后调用方应使用 normalize_capability_schema 落盘清洗结果。
    """
    errors = []
    if not isinstance(schema, dict):
        return False, ['schema 必须是对象']

    # 敏感字段拒绝（备份/导出不含 Key 的第一道防线）
    blob_lower = json.dumps(schema, ensure_ascii=False).lower()
    for word in _SECRET_WORDS:
        if word in blob_lower:
            errors.append(f'schema 含被禁止的敏感字段「{word}」（API Key/Authorization 等不得写入 schema）')
            return False, errors

    model_id = schema.get('modelId')
    if not isinstance(model_id, str) or not model_id.strip():
        errors.append('modelId 不能为空')
    else:
        model_id = model_id.strip()
        if len(model_id) > 200:
            errors.append('modelId 过长（≤200 字符）')
        if any(ch.isspace() for ch in model_id):
            errors.append('modelId 不能包含空白字符')

    kinds = schema.get('kinds')
    if not isinstance(kinds, list) or not kinds:
        errors.append('kinds 至少选择一种能力类型')
    else:
        cleaned_kinds = []
        for kind in kinds:
            if kind not in MODEL_KIND_WHITELIST:
                errors.append(f'kinds 含非法类型「{kind}」（允许：{"/".join(MODEL_KIND_WHITELIST)}）')
            elif kind not in cleaned_kinds:
                cleaned_kinds.append(kind)

    adapter = schema.get('requestAdapter')
    if adapter not in REQUEST_ADAPTER_WHITELIST:
        errors.append(f'requestAdapter 不在白名单（允许：{"/".join(REQUEST_ADAPTER_WHITELIST)}）')

    image = schema.get('image')
    if image is not None:
        if not isinstance(image, dict):
            errors.append('image 必须是对象')
        else:
            ref = image.get('referenceImages')
            if ref is not None and (not isinstance(ref, int) or isinstance(ref, bool) or ref < 0):
                errors.append('image.referenceImages 必须是不小于 0 的整数')
            for key in ('maskEdit', 'angle'):
                value = image.get(key)
                if value is not None and not isinstance(value, bool):
                    errors.append(f'image.{key} 必须是布尔值')
            ratios = image.get('aspectRatios')
            if ratios is not None:
                if not isinstance(ratios, list) or not ratios or any(not _is_ratio_like(r) for r in ratios):
                    errors.append('image.aspectRatios 必须是形如 16:9 或 Auto 的字符串数组')

    video = schema.get('video')
    if video is not None:
        if not isinstance(video, dict):
            errors.append('video 必须是对象')
        else:
            for key in ('imageReference', 'startEndFrame', 'audioInput'):
                value = video.get(key)
                if value is not None and not isinstance(value, bool):
                    errors.append(f'video.{key} 必须是布尔值')
            seconds = video.get('seconds')
            if seconds is not None:
                if not isinstance(seconds, list) or not seconds or any(
                        not isinstance(n, (int, float)) or isinstance(n, bool) or n <= 0 or n > 120 for n in seconds):
                    errors.append('video.seconds 必须是 1–120 的数字数组')

    audio = schema.get('audio')
    if audio is not None:
        if not isinstance(audio, dict):
            errors.append('audio 必须是对象')
        else:
            duration = audio.get('duration')
            if duration is not None:
                if not isinstance(duration, list) or not duration or any(
                        not isinstance(n, (int, float)) or isinstance(n, bool) or n <= 0 or n > 600 for n in duration):
                    errors.append('audio.duration 必须是 1–600 的数字数组')
            formats = audio.get('formats')
            if formats is not None:
                if not isinstance(formats, list) or not formats or any(f not in AUDIO_FORMAT_WHITELIST for f in formats):
                    errors.append(f'audio.formats 必须是 {"/".join(AUDIO_FORMAT_WHITELIST)} 之一')

    if adapter == 'custom-declarative':
        _validate_custom_adapter(schema.get('adapter'), errors)

    return len(errors) == 0, errors


def _validate_custom_adapter(adapter, errors):
    """custom-declarative 白名单校验：URL path / 字段映射 / 状态字段 / 结果字段。"""
    if not isinstance(adapter, dict):
        errors.append('custom-declarative 必须提供 adapter 描述（URL path/字段映射/状态字段/结果字段白名单）')
        return

    url_path = adapter.get('urlPath')
    if not isinstance(url_path, str) or not url_path.strip():
        errors.append('adapter.urlPath 不能为空（相对 API base，如 /v1/video/generations）')
    else:
        url_path = url_path.strip()
        if not url_path.startswith('/'):
            errors.append('adapter.urlPath 必须以 / 开头（相对 API base）')
        if '..' in url_path or '//' in url_path or url_path.lower().startswith(('http://', 'https://')):
            errors.append('adapter.urlPath 只能填相对路径，禁止绝对 URL 或路径穿越')
        if len(url_path) > 500:
            errors.append('adapter.urlPath 过长')

    mapping = adapter.get('fieldMapping')
    if not isinstance(mapping, dict) or not mapping:
        errors.append('adapter.fieldMapping 不能为空（声明请求体字段映射）')
    else:
        non_empty_values = 0
        for key, value in mapping.items():
            if key not in FIELD_MAPPING_KEYS:
                errors.append(f'adapter.fieldMapping 含非法键「{key}」（仅允许：{"/".join(FIELD_MAPPING_KEYS)}）')
            if value is not None and not isinstance(value, str):
                errors.append(f'adapter.fieldMapping.{key} 必须是字符串')
            elif isinstance(value, str) and value.strip():
                non_empty_values += 1
                if not _DOT_PATH_RE.match(value.strip()):
                    errors.append(f'adapter.fieldMapping.{key}「{value}」非法（仅允许字母/数字/下划线/点/中括号）')
        if non_empty_values == 0:
            errors.append('adapter.fieldMapping 至少需要一个非空字段映射')

    task = adapter.get('task')
    if task is not None:
        if not isinstance(task, dict):
            errors.append('adapter.task 必须是对象')
        else:
            for key in task:
                if key not in TASK_FIELD_KEYS:
                    errors.append(f'adapter.task 含非法键「{key}」')
            _clean_identifier(task.get('taskIdField'), 'adapter.task.taskIdField', errors)
            _clean_identifier(task.get('pollUrlField'), 'adapter.task.pollUrlField', errors)
            _clean_identifier(task.get('statusField'), 'adapter.task.statusField', errors)
            _clean_string_list(task.get('completedValues'), 'adapter.task.completedValues', errors)
            _clean_string_list(task.get('failedValues'), 'adapter.task.failedValues', errors)
            _clean_string_list(task.get('resultUrlFields'), 'adapter.task.resultUrlFields', errors)
            interval = task.get('pollIntervalMs')
            if interval is not None and (not isinstance(interval, (int, float)) or isinstance(interval, bool) or interval < 100):
                errors.append('adapter.task.pollIntervalMs 必须是 ≥100 的毫秒数')

    _clean_string_list(adapter.get('syncResultUrlFields'), 'adapter.syncResultUrlFields', errors)

    # 注入防护：任何疑似 header/eval/脚本/原型链字段一律拒绝
    blob_lower = json.dumps(adapter, ensure_ascii=False).lower()
    for word in _INJECTION_WORDS:
        if word in blob_lower:
            errors.append(f'adapter 含被禁止的关键词「{word}」（禁止脚本 / 任意 Header / 原型链注入）')
            break


def normalize_capability_schema(schema):
    """
    把通过校验的 schema 清洗为可落盘的字典（只保留白名单字段，杜绝多余键）。
    调用方必须先跑 validate_capability_schema；本函数对非法输入做防御性忽略。
    """
    if not isinstance(schema, dict):
        return {}
    model_id = str(schema.get('modelId') or '').strip()
    kinds = [k for k in (schema.get('kinds') or []) if k in MODEL_KIND_WHITELIST]
    kinds = list(dict.fromkeys(kinds))
    adapter = schema.get('requestAdapter') if schema.get('requestAdapter') in REQUEST_ADAPTER_WHITELIST else 'openai-image'
    result = {
        'modelId': model_id,
        'kinds': kinds,
        'requestAdapter': adapter,
    }

    image = schema.get('image')
    if isinstance(image, dict):
        clean_image = {}
        ref = image.get('referenceImages')
        if isinstance(ref, int) and not isinstance(ref, bool) and ref >= 0:
            clean_image['referenceImages'] = ref
        for key in ('maskEdit', 'angle'):
            if isinstance(image.get(key), bool):
                clean_image[key] = image[key]
        ratios = image.get('aspectRatios')
        if isinstance(ratios, list) and ratios and all(_is_ratio_like(r) for r in ratios):
            clean_image['aspectRatios'] = [str(r) for r in ratios]
        if clean_image:
            result['image'] = clean_image

    video = schema.get('video')
    if isinstance(video, dict):
        clean_video = {}
        for key in ('imageReference', 'startEndFrame', 'audioInput'):
            if isinstance(video.get(key), bool):
                clean_video[key] = video[key]
        seconds = video.get('seconds')
        if isinstance(seconds, list) and seconds and all(
                isinstance(n, (int, float)) and not isinstance(n, bool) and 0 < n <= 120 for n in seconds):
            clean_video['seconds'] = [float(n) for n in seconds]
        if clean_video:
            result['video'] = clean_video

    audio = schema.get('audio')
    if isinstance(audio, dict):
        clean_audio = {}
        duration = audio.get('duration')
        if isinstance(duration, list) and duration and all(
                isinstance(n, (int, float)) and not isinstance(n, bool) and 0 < n <= 600 for n in duration):
            clean_audio['duration'] = [float(n) for n in duration]
        formats = audio.get('formats')
        if isinstance(formats, list) and formats and all(f in AUDIO_FORMAT_WHITELIST for f in formats):
            clean_audio['formats'] = [f for f in formats]
        if clean_audio:
            result['audio'] = clean_audio

    if adapter == 'custom-declarative':
        adapter_obj = schema.get('adapter')
        if isinstance(adapter_obj, dict):
            clean_adapter = {}
            url_path = str(adapter_obj.get('urlPath') or '').strip()
            if url_path.startswith('/') and '..' not in url_path and '//' not in url_path \
                    and not url_path.lower().startswith(('http://', 'https://')):
                clean_adapter['urlPath'] = url_path[:500]
            mapping = adapter_obj.get('fieldMapping')
            if isinstance(mapping, dict):
                clean_mapping = {}
                for key in FIELD_MAPPING_KEYS:
                    value = mapping.get(key)
                    if isinstance(value, str) and value.strip() and _DOT_PATH_RE.match(value.strip()):
                        clean_mapping[key] = value.strip()
                if clean_mapping:
                    clean_adapter['fieldMapping'] = clean_mapping
            task = adapter_obj.get('task')
            if isinstance(task, dict):
                clean_task = {}
                for key in ('taskIdField', 'pollUrlField', 'statusField'):
                    value = _clean_identifier(task.get(key), f'adapter.task.{key}', [])
                    if value:
                        clean_task[key] = value
                for key in ('completedValues', 'failedValues', 'resultUrlFields'):
                    value = _clean_string_list(task.get(key), f'adapter.task.{key}', [])
                    if value:
                        clean_task[key] = value
                interval = task.get('pollIntervalMs')
                if isinstance(interval, (int, float)) and not isinstance(interval, bool) and interval >= 100:
                    clean_task['pollIntervalMs'] = int(interval)
                if clean_task:
                    clean_adapter['task'] = clean_task
            sync_fields = _clean_string_list(adapter_obj.get('syncResultUrlFields'), 'adapter.syncResultUrlFields', [])
            if sync_fields:
                clean_adapter['syncResultUrlFields'] = sync_fields
            if clean_adapter:
                result['adapter'] = clean_adapter

    return result


def build_custom_adapter_preview(schema):
    """
    返回 custom-declarative 的请求结构预览（不发起网络请求）：
    展示 URL path、字段映射、状态字段、结果字段白名单。
    用于设置页「预览请求结构」与受限测试。
    """
    normalized = normalize_capability_schema(schema)
    adapter = normalized.get('adapter') or {}
    task = adapter.get('task') or {}
    return {
        'modelId': normalized.get('modelId', ''),
        'requestAdapter': 'custom-declarative',
        'urlPath': adapter.get('urlPath', ''),
        'fieldMapping': adapter.get('fieldMapping', {}),
        'task': {
            'taskIdField': task.get('taskIdField', ''),
            'pollUrlField': task.get('pollUrlField', ''),
            'statusField': task.get('statusField', 'status'),
            'completedValues': task.get('completedValues', ['completed']),
            'failedValues': task.get('failedValues', ['failed']),
            'resultUrlFields': task.get('resultUrlFields', []),
            'pollIntervalMs': task.get('pollIntervalMs', 2000),
        } if task else None,
        'syncResultUrlFields': adapter.get('syncResultUrlFields', []),
        'warnings': [
            '声明式白名单：仅描述 URL path / 字段映射 / 状态字段 / 结果字段。',
            '禁止 eval、任意脚本、任意 Header 注入；生成测试需单独确认费用。',
        ],
    }


# ─────────────────────────────────────────
# 内置 schema 源（与前端 model-config.ts 内置规则保持一致）
# 供后端能力门控/校验/预览使用；用户 schema 优先于内置。
# ─────────────────────────────────────────
BUILTIN_CAPABILITY_SPECS = [
    # 图片编辑（mask/referenceImages）
    {'modelId': 'gpt-image', 'kinds': ['drawing'], 'image': {'referenceImages': 1, 'maskEdit': True, 'angle': False}, 'requestAdapter': 'openai-image'},
    {'modelId': 'gemini-3-pro-image', 'kinds': ['drawing'], 'image': {'referenceImages': 1, 'maskEdit': True, 'angle': False}, 'requestAdapter': 'gemini-native'},
    {'modelId': 'gemini-3.1-flash-image', 'kinds': ['drawing'], 'image': {'referenceImages': 1, 'maskEdit': True, 'angle': False}, 'requestAdapter': 'gemini-native'},
    {'modelId': 'grok-imagine-image-edit', 'kinds': ['drawing'], 'image': {'referenceImages': 1, 'maskEdit': True, 'angle': False}, 'requestAdapter': 'openai-image'},
    {'modelId': 'seedream', 'kinds': ['drawing'], 'image': {'referenceImages': 1, 'maskEdit': False, 'angle': False}, 'requestAdapter': 'gemini-native'},
    # 绘图比例
    {'modelId': 'gemini-3-pro-image', 'kinds': ['drawing'], 'image': {'aspectRatios': ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', 'Auto']}, 'requestAdapter': 'gemini-native'},
    {'modelId': 'gemini-3.1-flash-image', 'kinds': ['drawing'], 'image': {'aspectRatios': ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '1:4', '4:1', '1:8', '8:1', 'Auto']}, 'requestAdapter': 'gemini-native'},
    {'modelId': 'gpt-image', 'kinds': ['drawing'], 'image': {'aspectRatios': ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', 'Auto']}, 'requestAdapter': 'openai-image'},
    {'modelId': 'grok-imagine-image', 'kinds': ['drawing'], 'image': {'aspectRatios': ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '1:4', '4:1', '1:8', '8:1', 'Auto']}, 'requestAdapter': 'openai-image'},
    # 视频
    {'modelId': 'grok-imagine-video', 'kinds': ['video'], 'video': {'imageReference': True, 'startEndFrame': False, 'audioInput': False, 'seconds': [5, 10]}, 'requestAdapter': 'fluxport-video'},
    {'modelId': 'veo', 'kinds': ['video'], 'video': {'imageReference': True, 'startEndFrame': True, 'audioInput': True, 'seconds': [4, 6, 8]}, 'requestAdapter': 'fluxport-video'},
    {'modelId': 'kling', 'kinds': ['video'], 'video': {'imageReference': True, 'startEndFrame': True, 'audioInput': False, 'seconds': [5, 10]}, 'requestAdapter': 'fluxport-video'},
    {'modelId': 'runway', 'kinds': ['video'], 'video': {'imageReference': True, 'startEndFrame': True, 'audioInput': False, 'seconds': [5, 10]}, 'requestAdapter': 'fluxport-video'},
    {'modelId': 'pika', 'kinds': ['video'], 'video': {'imageReference': True, 'startEndFrame': False, 'audioInput': False, 'seconds': [3, 5]}, 'requestAdapter': 'fluxport-video'},
    {'modelId': 'sora', 'kinds': ['video'], 'video': {'imageReference': True, 'startEndFrame': False, 'audioInput': True, 'seconds': [5, 10]}, 'requestAdapter': 'fluxport-video'},
    {'modelId': 'wan', 'kinds': ['video'], 'video': {'imageReference': True, 'startEndFrame': True, 'audioInput': False, 'seconds': [5, 10]}, 'requestAdapter': 'fluxport-video'},
]


def get_builtin_capability_spec(model_id):
    """
    返回匹配内置规则的 schema 字典（关键字包含匹配，与前端一致）；未命中返回 None。
    注意：一个模型可能命中多条（如 gemini-3-pro-image 同时命中图片编辑与比例），
    调用方按需合并；本函数仅提供关键字匹配的原始内置条目。
    """
    lower = (model_id or '').lower().strip()
    hits = []
    for spec in BUILTIN_CAPABILITY_SPECS:
        if spec['modelId'].lower() in lower:
            hits.append(spec)
    return hits or None
