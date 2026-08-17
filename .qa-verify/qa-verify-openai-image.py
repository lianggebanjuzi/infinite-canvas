# -*- coding: utf-8 -*-
"""
QA 独立验证：OpenAI 图片格式（gpt-image 系）链路（Infinite Canvas 2.0 本地验收）
============================================================================
重点验证：
1. 模型规则：gpt-image-* / dall-e-* 识别为 openai_image + drawing
2. resolution + aspectRatio -> size 映射全表
3. options.size 显式传入优先（向后兼容）
4. 参考图 data URL -> payload image 字段（含解析失败防御，不阻断文生图）
5. OpenAI 格式 202 异步轮询全链路（/v1/images/generations + assets.signed_url）
6. OpenAI 200 同步解析（data[].url / b64_json）+ Gemini inlineData 兼容兜底
"""
import base64
import io
import os
import re
import sys
import unittest.mock as mock

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from PIL import Image

from backend.api import unified_api
from backend.api.unified_api import UnifiedAPIRouter, ApiFormat, ModelEntry, ModelType
from backend.api.model_rules import detect_model_type, detect_model_format_name
from backend.api.errors import UpstreamError

# 极小合法 PNG
_buf = io.BytesIO()
Image.new('RGB', (2, 2), (255, 0, 0)).save(_buf, format='PNG')
PNG_BYTES = _buf.getvalue()
PNG_B64 = base64.b64encode(PNG_BYTES).decode('ascii')
PNG_DATA_URL = f"data:image/png;base64,{PNG_B64}"

# OpenAI 图片直连域名（FluxPort 语言域名 api.uselg.top 映射后的直连地址）
IMAGE_ORIGIN = "https://api.ai-media.vip"
PROVIDER_API_URL = "https://api.ai-media.vip/v1"

SIGNED_URL = "https://media.ai-media.vip/v1/images/tasks/imgtask_openai/assets/signed.jpg"

TASK_202 = {
    "status": "queued",
    "poll_after_ms": 500,
    "status_url": "/v1/images/tasks/imgtask_openai?view=summary",
    "result_url": "/v1/images/tasks/imgtask_openai",
    "task_id": "imgtask_openai",
}


class MockResp:
    def __init__(self, status_code=200, json_data=None, text='', content=b'', headers=None, url=''):
        self.status_code = status_code
        self._json_data = json_data
        self.text = text
        self.content = content
        self.headers = headers if headers is not None else {'Content-Type': 'image/png'}
        self.url = url

    def json(self):
        if self._json_data is None:
            raise ValueError('No JSON body')
        return self._json_data


class FakeTime:
    def __init__(self, start):
        self._now = start

    def time(self):
        return self._now

    def sleep(self, s):
        self._now += s


def make_openai_router(api_url=PROVIDER_API_URL):
    provider = {
        'id': 'flux', 'name': 'flux', 'api_url': api_url,
        'api_key': 'test-key-123', 'enabled': True, 'use_proxy': True,
        'models': [{
            'id': 'gpt-image-2', 'name': 'GPT Image 2',
            'type': 'drawing', 'enabled': True,
        }],
    }

    class FakeProviderAPI:
        def load_providers(self):
            return {'providers': [provider]}

    return UnifiedAPIRouter(FakeProviderAPI())


def build_openai_payload(router, options):
    """构造 OpenAI 图片请求，返回 (url, payload)"""
    model_entry = ModelEntry(
        id='gpt-image-2', name='GPT Image 2',
        type=ModelType.DRAWING, api_format=ApiFormat.OPENAI_IMAGE,
    )
    return router._build_image_request(PROVIDER_API_URL, model_entry, 'a test prompt', options)


def _run_generate(router, json_data):
    """以给定 200 JSON 响应跑通 generate_image 同步链路"""
    import time as real_time
    fake = FakeTime(real_time.time())
    with mock.patch.object(unified_api, 'time', fake), \
         mock.patch.object(unified_api.requests, 'post', side_effect=lambda *a, **k: MockResp(200, json_data)), \
         mock.patch.object(unified_api.requests, 'get', side_effect=lambda *a, **k: MockResp(200, content=PNG_BYTES)), \
         mock.patch.object(router, '_download_url_to_base64', lambda url: None), \
         mock.patch.object(router, '_save_base64_to_dir', lambda data_url, save_dir='': None):
        return router.generate_image('a test prompt', {'model': 'flux:gpt-image-2'})


# T01 编译导入
def t01_compile_and_import():
    import py_compile
    py_compile.compile(os.path.join(PROJECT_ROOT, 'backend', 'api', 'unified_api.py'), doraise=True)
    py_compile.compile(os.path.join(PROJECT_ROOT, 'backend', 'api', 'model_rules.py'), doraise=True)


# T02 模型规则：gpt-image 系 / dall-e 系 -> openai_image + drawing
def t02_model_rules_openai_image_mapping():
    for mid in ('gpt-image', 'gpt-image-1', 'gpt-image-2', 'dall-e-3', 'dall-e-2'):
        assert detect_model_type(mid) == 'drawing', mid
        assert detect_model_format_name(mid) == 'openai_image', mid
    # 对话模型不受影响（gpt-4o 等仍为 openai_chat）
    assert detect_model_format_name('gpt-4o') == 'openai_chat'


# T03 size 映射全表（aspectRatio x resolution）
def t03_size_mapping_full_table():
    router = make_openai_router()
    cases = [
        # (aspectRatio, resolution, expected)
        ('Auto', '1k', '1024x1024'),
        ('Auto', '2k', '1024x1024'),
        ('Auto', '4k', '1024x1024'),
        ('1:1', '1k', '1024x1024'),
        ('1:1', '2k', '1024x1024'),
        ('1:1', '4k', '1024x1024'),
        ('3:4', '1k', '1024x1536'),
        ('3:4', '2k', '1024x1792'),
        ('3:4', '4k', '1024x1792'),
        ('4:3', '1k', '1536x1024'),
        ('4:3', '2k', '1792x1024'),
        ('4:3', '4k', '1792x1024'),
        ('16:9', '1k', '1536x1024'),
        ('16:9', '2k', '1792x1024'),
        ('16:9', '4k', '1792x1024'),
        ('9:16', '1k', '1024x1536'),
        ('9:16', '2k', '1024x1792'),
        ('9:16', '4k', '1024x1792'),
        # 非法 resolution -> 按 1k 档；非法/空 aspectRatio -> 正方形
        ('16:9', '8k', '1536x1024'),
        ('21:9', '2k', '1024x1024'),
        ('', '2k', '1024x1024'),
        (None, '2k', '1024x1024'),
    ]
    for ar, res, expected in cases:
        _, payload = build_openai_payload(router, {'resolution': res, 'aspectRatio': ar})
        assert payload['size'] == expected, f"aspect={ar!r} res={res!r} -> {payload['size']} != {expected}"


# T04 显式 options.size 优先（向后兼容）
def t04_explicit_size_priority():
    router = make_openai_router()
    _, payload = build_openai_payload(router, {
        'size': '1024x1792', 'resolution': '1k', 'aspectRatio': '1:1',
    })
    assert payload['size'] == '1024x1792'
    # 显式非法 size -> 回退到 resolution+aspectRatio 映射
    _, payload2 = build_openai_payload(router, {
        'size': '999x999', 'resolution': '2k', 'aspectRatio': '16:9',
    })
    assert payload2['size'] == '1792x1024'
    # 新增合法尺寸集也接受显式传入
    _, payload3 = build_openai_payload(router, {'size': '1536x1024'})
    assert payload3['size'] == '1536x1024'


# T05 默认值
def t05_size_default_square():
    router = make_openai_router()
    url, payload = build_openai_payload(router, {})
    assert payload['size'] == '1024x1024'
    assert payload['model'] == 'gpt-image-2'
    assert payload['n'] == 1
    assert 'image' not in payload
    # 直连域名 + OpenAI 图片端点
    assert url == IMAGE_ORIGIN + '/v1/images/generations', url


# T06 参考图 data URL -> payload image 字段
def t06_reference_images_payload():
    router = make_openai_router()
    _, payload = build_openai_payload(router, {
        'referenceImages': [PNG_DATA_URL],
    })
    assert payload['image'] == [{'mimeType': 'image/png', 'data': PNG_B64}]
    # 多图
    _, payload2 = build_openai_payload(router, {
        'referenceImages': [PNG_DATA_URL, PNG_DATA_URL],
    })
    assert len(payload2['image']) == 2


# T07 参考图解析失败防御：非法项忽略，不阻断文生图
def t07_reference_images_invalid_ignored():
    router = make_openai_router()
    _, payload = build_openai_payload(router, {
        'referenceImages': [
            'data:image/png;base64,###invalid###',  # 非法 base64
            'not-a-data-url',                        # 非 data URL
            'http://example.com/x.png',              # 非 data URL
            PNG_DATA_URL,                            # 合法
        ],
    })
    # 合法项保留，非法项忽略
    assert payload['image'] == [{'mimeType': 'image/png', 'data': PNG_B64}]
    # 全部非法时直接不带 image 字段，文生图照常
    _, payload2 = build_openai_payload(router, {
        'referenceImages': ['data:image/png;base64,###invalid###'],
    })
    assert 'image' not in payload2
    assert payload2['prompt'] == 'a test prompt'
    assert payload2['size'] == '1024x1024'


# T08 OpenAI 202 异步轮询全链路（OpenAI 格式 URL + assets.signed_url）
def t08_openai_202_polling_chain():
    router = make_openai_router()
    seen_post = []
    seen_poll = []
    poll_responses = [
        MockResp(200, {"status": "queued"}),
        MockResp(200, {"status": "success", "assets": [{"signed_url": SIGNED_URL}]}),
    ]

    def fake_post(url, *a, **k):
        seen_post.append((url, k.get('json') or {}, k.get('headers') or {}))
        return MockResp(202, TASK_202, url=url)

    def fake_get(url, *a, **k):
        seen_poll.append(url)
        return poll_responses.pop(0)

    import time as real_time
    fake = FakeTime(real_time.time())
    with mock.patch.object(unified_api, 'time', fake), \
         mock.patch.object(unified_api.requests, 'post', side_effect=fake_post), \
         mock.patch.object(unified_api.requests, 'get', side_effect=fake_get), \
         mock.patch.object(router, '_download_url_to_base64', lambda url: None):
        res = router.generate_image(
            '高级感咖啡杯产品图，白色背景',
            {'model': 'flux:gpt-image-2', 'resolution': '2k', 'aspectRatio': '16:9'},
        )

    assert res['success'] is True
    post_url, payload, headers = seen_post[0]
    # 直连域名 + OpenAI 图片端点 + 幂等键
    assert post_url == IMAGE_ORIGIN + '/v1/images/generations', post_url
    assert 'Idempotency-Key' in headers
    assert payload['model'] == 'gpt-image-2'
    assert payload['size'] == '1792x1024'
    assert payload['n'] == 1
    # 轮询走 status_url summary，拼到实际请求域名
    assert seen_poll[0] == IMAGE_ORIGIN + '/v1/images/tasks/imgtask_openai?view=summary', seen_poll[0]
    # signed_url 直链直接回传，无需再下载
    assert res['image_url'] == SIGNED_URL
    assert res['images'] == [SIGNED_URL]
    assert not any('signed' in u for u in seen_poll)


# T09 OpenAI 200 同步解析（data[].url / b64_json）
def t09_openai_sync_200_url_and_b64():
    router = make_openai_router()
    # 200 同步 data[].url
    res = _run_generate(router, {"data": [{"url": SIGNED_URL}]})
    assert res['success'] is True
    assert res['image_url'] == SIGNED_URL

    # 200 同步 data[].b64_json
    res2 = _run_generate(router, {"data": [{"b64_json": PNG_B64, "mime_type": "image/png"}]})
    assert res2['success'] is True
    assert res2['image_url'] == f"data:image/png;base64,{PNG_B64}"


# T10 200 同步 inlineData 兼容兜底（中转站可能用 Gemini 格式返回）
def t10_sync_200_inline_data_fallback():
    router = make_openai_router()
    res = _run_generate(router, {
        "candidates": [{"content": {"parts": [
            {"inlineData": {"mimeType": "image/png", "data": PNG_B64}},
        ]}}],
    })
    assert res['success'] is True
    assert res['image_url'] == f"data:image/png;base64,{PNG_B64}"


def main():
    names = sorted(n for n in globals() if re.match(r'^t\d+_', n) and callable(globals()[n]))
    passed = failed = 0
    rows = []
    for n in names:
        try:
            globals()[n]()
            rows.append((n, 'PASS', ''))
            passed += 1
        except Exception as e:
            rows.append((n, 'FAIL', f'{type(e).__name__}: {e}'))
            failed += 1

    print('=' * 100)
    print(f'OpenAI Image QA 验收 | 总用例 {len(rows)} | 通过 {passed} | 失败 {failed}')
    print('=' * 100)
    print(f'{"用例":<10}{"结果":<6}失败详情')
    print('-' * 100)
    for n, status, detail in rows:
        print(f'{n:<12}{status:<6}{detail}')
    print('=' * 100)
    if failed:
        print('结论: FAIL')
        sys.exit(1)
    print('结论: PASS')


if __name__ == '__main__':
    main()
