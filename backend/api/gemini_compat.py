# backend/api/gemini_compat.py
"""Gemini generateContent 与中转站兼容：宽高比枚举、文本中的图片 URL 提取、URL 版本前缀归一化。"""
import re
from urllib.parse import urlparse

# Google Gemini image_config.aspect_ratio 枚举（不支持 Auto）
GEMINI_IMAGE_ASPECT_RATIOS = frozenset({
    '1:1', '4:3', '3:4', '16:9', '9:16',
    '1:4', '1:8', '2:3', '3:2', '4:1', '4:5', '5:4', '8:1', '21:9',
})

_RESOLUTION_TO_IMAGE_SIZE = {'1k': '1K', '2k': '2K', '4k': '4K'}

# 规则一：URL 以图片扩展名结尾（兼容旧中转站，行为保持不变）
_IMAGE_URL_TAIL = re.compile(r'\.(jpe?g|png|webp|gif)(\?[^/]*)?$', re.IGNORECASE)

# 规则二：URL 路径含图片服务特征（visionary.beer 等返回「无扩展名」图片 URL）
# 例：https://visionary.beer/api/generations/{uuid}/image?token={JWT}
#   - 路径含 /generations/ 或 /generation/ 段
#   - 或路径末段为 /image、/images（后跟查询串/锚点或直接结束）
_IMAGE_GENERATION_PATH = re.compile(r'/(?:api/)?generations?/', re.IGNORECASE)
_IMAGE_ENDPOINT_TAIL = re.compile(r'/(?:image|images)(?=[?#]|$)', re.IGNORECASE)

# 扫描 URL 时直接排除中文全角标点，避免把 URL 后面的「，点击查看。」之类误并入
# （token 为 base64url 字符集 A-Za-z0-9-_，不会被误截断）
_URL_SCAN = re.compile(r'https?://[^\s<>"\'\)\]。，、；：！？）】》」』…]+')

# URL 尾部兜底剥离的标点（ASCII + 中文全角；注意不含 base64url 的 - _ 字符）
_TRAILING_PUNCT = '.,;:!?)]}>' + '。，、；：！？）】》」』…'


def normalize_gemini_aspect_ratio(val):
    """
    UI 可选 Auto；发往 API 时：
      - Auto / 空 / None → 不传 aspectRatio，让模型自己决定比例
      - 合法枚举 → 原样下发
      - 非法值 → 不传
    返回 None 表示跳过该字段。
    """
    if val is None:
        return None
    s = str(val).strip()
    if not s or s.lower() == 'auto':
        return None
    if s in GEMINI_IMAGE_ASPECT_RATIOS:
        return s
    return None


def nearest_aspect_ratio(width, height):
    """
    把像素宽高映射到 Gemini 支持的最近宽高比（宽/高）。
    返回形如 '3:4' 的字符串；宽或高非法（非正数/非数字）时返回 None。
    """
    try:
        target = float(width) / float(height)
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    if target <= 0:
        return None

    best = None
    best_diff = None
    for ar in GEMINI_IMAGE_ASPECT_RATIOS:
        a, b = ar.split(':')
        try:
            val = int(a) / int(b)
        except (ValueError, ZeroDivisionError):
            continue
        diff = abs(val - target)
        if best_diff is None or diff < best_diff:
            best_diff = diff
            best = ar
    return best


def normalize_gemini_image_size(val):
    """确保 imageSize 为 1K / 2K / 4K（大写）。"""
    if val is None:
        return '1K'
    s = str(val).strip()
    up = s.upper()
    if up in ('1K', '2K', '4K'):
        return up
    low = s.lower()
    return _RESOLUTION_TO_IMAGE_SIZE.get(low, '1K')


def resolve_image_api_base(api_url):
    """
    解析图片请求基址，并为 FluxPort 切换到官方图片直连域名。

    FluxPort 的语言地址 ``api.uselg.top`` 经过 Cloudflare，不适合图片长请求；
    官方文档要求图片改走 ``https://api.ai-media.vip``。其他供应商域名原样保留。
    随后由 :func:`strip_api_version_suffix` 统一剥离 /v1 或 /v1beta。
    """
    raw = (api_url or '').strip()
    if not raw:
        return raw
    parsed = urlparse(raw)
    if parsed.hostname and parsed.hostname.lower() == 'api.uselg.top':
        return 'https://api.ai-media.vip'
    return strip_api_version_suffix(raw)


def resolve_chat_api_base(api_url):
    """
    chat / 模型列表域归一（resolve_image_api_base 的反向）：
    FluxPort 媒体域 api.ai-media.vip → 语言域 https://api.uselg.top/v1（对话与 /models 必须走语言域）。
    其它域名原样返回（保留原 api_url，含 /v1 路径段；由调用方按需剥离/拼接）。
    """
    raw = (api_url or '').strip()
    if not raw:
        return raw
    parsed = urlparse(raw)
    if parsed.hostname and parsed.hostname.lower() == 'api.ai-media.vip':
        return 'https://api.uselg.top/v1'
    return raw.rstrip('/')


def strip_api_version_suffix(api_url):
    """
    去掉 api_url 末尾的 /v1beta 或 /v1 路径段（最长优先，避免 /v1beta 被 /v1 误伤），
    用于拼接 /v1beta/models/{model}:generateContent 或 /v1/images/generations 时
    不产生 /v1/v1beta/ 或 /v1/v1/ 双重前缀。

    兼容三种供应商配置：
      - 裸域名：      https://api.ai-media.vip          -> https://api.ai-media.vip
      - 带 /v1：      https://api.ai-media.vip/v1       -> https://api.ai-media.vip
      - 带 /v1beta：  https://api.ai-media.vip/v1beta   -> https://api.ai-media.vip
    """
    base = (api_url or '').strip().rstrip('/')
    if not base:
        return base
    lowered = base.lower()
    if lowered.endswith('/v1beta'):
        return base[: -len('/v1beta')]
    if lowered.endswith('/v1'):
        return base[: -len('/v1')]
    return base


def _is_image_candidate(url):
    """判断 URL 是否可视为图片资源：扩展名规则或图片服务路径规则命中其一即可。"""
    if not url:
        return False
    if _IMAGE_URL_TAIL.search(url):
        return True
    if _IMAGE_GENERATION_PATH.search(url):
        return True
    if _IMAGE_ENDPOINT_TAIL.search(url):
        return True
    return False


def extract_image_urls_from_text(text):
    """
    从纯文本里抽出可下载的图片链接（中转站常把图放在文本里）。

    兼容两类 URL：
      1. 传统带图片扩展名：https://.../a.png?x=1
      2. 无扩展名的图片服务 URL：https://.../api/generations/{id}/image?token=...
    """
    if not isinstance(text, str) or not text.strip():
        return []
    out, seen = [], set()
    for u in _URL_SCAN.findall(text):
        u = u.rstrip(_TRAILING_PUNCT)
        if not _is_image_candidate(u):
            continue
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out
