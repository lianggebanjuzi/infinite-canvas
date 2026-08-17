# backend/api/model_rules.py
"""
模型识别规则公共模块（单一事实来源）

被以下模块共用，保证分类语义一致、规则不重复定义：
- provider_api.py：fetch_models 拉取模型时按类型分组（drawing / chat）
- unified_api.py ：_detect_model_type 请求路由时判定模型类型与 API 格式

依赖方向：本模块不依赖任何业务模块（纯常量 + 纯函数），
避免 provider_api <-> unified_api 之间的循环依赖。
"""
from typing import List, Tuple

# ─────────────────────────────────────────
# 模型类型常量（与 unified_api.ModelType 枚举值保持一致）
# ─────────────────────────────────────────
MODEL_TYPE_DRAWING = 'drawing'
MODEL_TYPE_CHAT    = 'chat'

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
    ('dalle',        'openai_image'),
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

    返回 MODEL_TYPE_DRAWING 或 MODEL_TYPE_CHAT（字符串，与 ModelType 枚举值一致）。
    先匹配绘图规则，再匹配对话规则，兜底按对话模型处理（与 unified_api 既有行为一致）。
    """
    lower = (model_id or '').lower().strip()

    for kw, _fmt in DRAWING_RULES:
        if kw in lower:
            return MODEL_TYPE_DRAWING

    for kw, _fmt in CHAT_RULES:
        if kw in lower:
            return MODEL_TYPE_CHAT

    return MODEL_TYPE_CHAT


def detect_model_format_name(model_id: str) -> str:
    """
    根据模型 ID 关键字推断 API 格式名（纯函数，无副作用）。

    返回格式名字符串（对应 unified_api.ApiFormat 枚举值）：
    'openai_chat' / 'openai_image' / 'gemini_native'。
    命中绘图/对话规则时返回对应格式名；均未命中时返回 'openai_chat'。
    """
    lower = (model_id or '').lower().strip()

    for kw, fmt in DRAWING_RULES:
        if kw in lower:
            return fmt

    for kw, fmt in CHAT_RULES:
        if kw in lower:
            return fmt

    return 'openai_chat'
