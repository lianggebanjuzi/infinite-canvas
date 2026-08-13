# backend/api/gemini_compat.py
"""Gemini generateContent 与中转站兼容：宽高比枚举、文本中的图片 URL 提取。"""
import re

# Google Gemini image_config.aspect_ratio 枚举（不支持 Auto）
GEMINI_IMAGE_ASPECT_RATIOS = frozenset({
    '1:1', '4:3', '3:4', '16:9', '9:16',
    '1:4', '1:8', '2:3', '3:2', '4:1', '4:5', '5:4', '8:1', '21:9',
})

_RESOLUTION_TO_IMAGE_SIZE = {'1k': '1K', '2k': '2K', '4k': '4K'}

_IMAGE_URL_TAIL = re.compile(r'\.(jpe?g|png|webp|gif)(\?[^/]*)?$', re.IGNORECASE)
_URL_SCAN = re.compile(r'https?://[^\s<>"\'\)\]]+')


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


def extract_image_urls_from_text(text):
    """从纯文本里抽出可下载的图片链接（中转站常把图放在文本里）。"""
    if not isinstance(text, str) or not text.strip():
        return []
    out, seen = [], set()
    for u in _URL_SCAN.findall(text):
        u = u.rstrip('.,;:)]}>')
        if not _IMAGE_URL_TAIL.search(u):
            continue
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out
