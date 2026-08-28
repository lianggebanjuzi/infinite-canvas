"""GPT Image 2 尺寸映射烟测：无需 API Key 或网络。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.api.unified_api import UnifiedAPIRouter


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print(f"[PASS] {message}")


router = UnifiedAPIRouter(provider_api=None)

expected_sizes = {
    ('1:1', '1k'): '1024x1024',
    ('3:4', '1k'): '864x1152',
    ('3:4', '4k'): '2448x3264',
    ('4:3', '1k'): '1152x864',
    ('9:16', '2k'): '1440x2560',
    ('16:9', '2k'): '2560x1440',
    ('21:9', '4k'): '3808x1632',
    ('Auto', '2k'): 'auto',
}

for (aspect_ratio, resolution), expected in expected_sizes.items():
    actual = router._map_openai_image_size(resolution, aspect_ratio)
    check(actual == expected, f'{aspect_ratio} · {resolution} -> {expected}')
    check(
        UnifiedAPIRouter._is_valid_openai_image_size(actual),
        f'{actual} 符合 GPT Image 2 官方 size 约束',
    )

for invalid in ('512x2048', '256x2048', '1024x1025', '4096x1024', '1024x1024'):
    expected = invalid == '1024x1024'
    check(
        UnifiedAPIRouter._is_valid_openai_image_size(invalid) == expected,
        f'{invalid} 校验结果符合预期',
    )

_, request = router._build_openai_image_payload(
    'https://api.openai.com/v1', 'gpt-image-2', 'test',
    {'aspectRatio': 'Auto', 'resolution': '4k'},
)
check(request['json']['size'] == 'auto', 'GPT Image 2 的 Auto 透传为官方 size=auto')

_, proxy_request = router._build_openai_image_payload(
    'https://api.ai-media.vip/v1', 'gpt-image-2', 'test',
    {'aspectRatio': 'Auto', 'resolution': '4k'},
)
check(proxy_request['json']['size'] == '2448x3264', '中转站的 Auto 显式映射为 3:4 · 4K，避免静默降级为 1:1 · 1K')

_, legacy_request = router._build_openai_image_payload(
    'https://api.openai.com/v1', 'dall-e-3', 'test',
    {'aspectRatio': 'Auto', 'resolution': '4k'},
)
check(legacy_request['json']['size'] == '1024x1024', '旧 OpenAI 图片模型不接收 GPT Image 2 专属 auto')
