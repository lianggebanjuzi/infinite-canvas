# -*- coding: utf-8 -*-
"""
QA 独立验证：FluxPort 图片链路兼容（Infinite Canvas 2.0 本地验收）
================================================================
重点验证：
1. FluxPort 语言域名自动映射到官方图片直连域名
2. /v1/v1beta 双重前缀归一
3. 202 异步任务优先 status_url summary
4. assets[].signed_url / url / download_url 解析
5. success / failed / uncertain 状态处理
6. 200 同步路径回归
"""
import base64
import io
import os
import re
import sys
import unittest.mock as mock
from datetime import datetime, timedelta, timezone

# 项目根目录：从本脚本位置推导（兼容任意盘符，本机为 G 盘）
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from PIL import Image

from backend.api import unified_api
from backend.api.unified_api import UnifiedAPIRouter, ApiFormat
from backend.api.errors import AppError, UpstreamError, UpstreamTimeoutError
from backend.api.gemini_compat import (
    extract_image_urls_from_text,
    resolve_image_api_base,
    strip_api_version_suffix,
)

# 极小合法 PNG
_buf = io.BytesIO()
Image.new('RGB', (2, 2), (255, 0, 0)).save(_buf, format='PNG')
PNG_BYTES = _buf.getvalue()
PNG_B64 = base64.b64encode(PNG_BYTES).decode('ascii')

# 供应商是语言地址，图片应映射到直连域名
PROVIDER_API_URL = "https://api.uselg.top/v1"
IMAGE_ORIGIN = "https://api.ai-media.vip"

TASK_202 = {
    "status": "queued",
    "poll_after_ms": 500,
    "status_url": "/v1/images/tasks/imgtask_xxx?view=summary",
    "result_url": "/v1/images/tasks/imgtask_xxx",
    "task_id": "imgtask_xxx",
}

PUBLIC_URL = "https://media.ai-media.vip/public-assets/xxx.jpg"
SIGNED_URL = "https://media.ai-media.vip/v1/images/tasks/imgtask_xxx/assets/signed.jpg"


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


def make_router(api_url=PROVIDER_API_URL):
    provider = {
        'id': 'flux', 'name': 'flux', 'api_url': api_url,
        'api_key': 'test-key-123', 'enabled': True, 'use_proxy': True,
        'models': [{
            'id': 'gemini-3-pro-image-preview', 'name': 'Gemini Image',
            'type': 'drawing', 'enabled': True,
        }],
    }

    class FakeProviderAPI:
        def load_providers(self):
            return {'providers': [provider]}

    return UnifiedAPIRouter(FakeProviderAPI())


def _run_with(patchers, router):
    import contextlib
    with contextlib.ExitStack() as stack:
        for p in patchers:
            stack.enter_context(p)
        return router.generate_image(
            'a cute cat',
            {'model': 'flux:gemini-3-pro-image-preview', 'resolution': '1k'},
        )


# T01 编译导入
def t01_compile_and_import():
    import py_compile
    py_compile.compile(os.path.join(PROJECT_ROOT, 'backend', 'api', 'unified_api.py'), doraise=True)
    py_compile.compile(os.path.join(PROJECT_ROOT, 'backend', 'api', 'gemini_compat.py'), doraise=True)


# T02 归一工具函数
def t02_helpers_strip_version_and_resolve_base():
    assert strip_api_version_suffix('https://api.ai-media.vip') == 'https://api.ai-media.vip'
    assert strip_api_version_suffix('https://api.ai-media.vip/v1') == 'https://api.ai-media.vip'
    assert strip_api_version_suffix('https://api.ai-media.vip/v1beta') == 'https://api.ai-media.vip'
    assert strip_api_version_suffix('') == ''

    assert resolve_image_api_base(PROVIDER_API_URL) == 'https://api.ai-media.vip'
    assert resolve_image_api_base('https://api.uselg.top') == 'https://api.ai-media.vip'
    assert resolve_image_api_base('https://other.example.com/v1') == 'https://other.example.com'
    assert resolve_image_api_base('https://other.example.com') == 'https://other.example.com'


# T03 直连域名映射到 URL
def t03_resolve_image_url_maps_flux_host():
    router = make_router()
    url = router._resolve_image_url(PROVIDER_API_URL, 'gemini-3-pro-image-preview', ApiFormat.GEMINI_NATIVE)
    assert url == 'https://api.ai-media.vip/v1beta/models/gemini-3-pro-image-preview:generateContent', url

    url_openai = router._resolve_image_url(PROVIDER_API_URL, 'gpt-image-2', ApiFormat.OPENAI_IMAGE)
    assert url_openai == 'https://api.ai-media.vip/v1/images/generations', url_openai


# T04 202 轮询使用实际请求 URL 的 origin
def t04_post_uses_mapped_url_and_poll_origin_matches():
    router = make_router()
    seen_post_url = []
    seen_poll_url = []

    poll_responses = [
        MockResp(200, {"status": "queued"}),
        MockResp(200, {"status": "success", "assets": [{"signed_url": SIGNED_URL}]}),
    ]

    def fake_post(url, *a, **k):
        seen_post_url.append(url)
        # 真实 requests 会回填 response.url（最终请求地址），轮询 origin 依赖它
        return MockResp(202, TASK_202, url=url)

    def fake_get(url, *a, **k):
        seen_poll_url.append(url)
        if 'signed' in url:
            return MockResp(200, content=PNG_BYTES, headers={'Content-Type': 'image/jpeg'})
        return poll_responses.pop(0)

    res = _run_with([
        mock.patch.object(unified_api.requests, 'post', side_effect=fake_post),
        mock.patch.object(unified_api.requests, 'get', side_effect=fake_get),
        mock.patch.object(router, '_save_base64_to_dir', lambda data_url, save_dir='': None),
    ], router)

    assert res['success'] is True
    assert seen_post_url[0] == 'https://api.ai-media.vip/v1beta/models/gemini-3-pro-image-preview:generateContent'
    # 现在优先使用相对 status_url，拼到实际请求域名
    assert seen_poll_url[0] == IMAGE_ORIGIN + '/v1/images/tasks/imgtask_xxx?view=summary', seen_poll_url[0]


# T05 assets 解析优先 signed_url
def t05_assets_signed_url_success():
    router = make_router()
    poll_responses = [
        MockResp(200, {"status": "queued"}),
        MockResp(200, {"status": "success", "assets": [{"signed_url": SIGNED_URL}]}),
    ]
    seen_poll = []

    def fake_get(url, *a, **kwargs):
        seen_poll.append(url)
        if 'signed' in url:
            # 模拟 signed_url 返回可直接使用的公开链接
            return MockResp(200, json_data=None, content=PNG_BYTES, headers={'Content-Type': 'image/png'})
        return poll_responses.pop(0)

    res = _run_with([
        mock.patch.object(unified_api.requests, 'post', side_effect=lambda *a, **k: MockResp(
            202, TASK_202, url=IMAGE_ORIGIN + '/v1beta/models/gemini-3-pro-image-preview:generateContent'
        )),
        mock.patch.object(unified_api.requests, 'get', side_effect=fake_get),
        # signed_url 下载失败时，当前链路允许直接回传绝对 URL
        mock.patch.object(router, '_download_url_to_base64', lambda url: None),
    ], router)

    assert res['success'] is True
    assert res['image_url'] == SIGNED_URL
    # signed_url 是免鉴权直链，直接回传，无需再下载
    assert seen_poll[1] == IMAGE_ORIGIN + '/v1/images/tasks/imgtask_xxx?view=summary', seen_poll[1]
    assert not any('signed' in u for u in seen_poll)


# T06 assets url/download_url 走鉴权下载
def t06_assets_authed_download_success():
    router = make_router()
    poll_responses = [
        MockResp(200, {"status": "queued"}),
        MockResp(200, {"status": "success", "assets": [{"url": "/v1/images/tasks/imgtask_xxx/assets/aaa.png"}]}),
    ]

    def fake_get(url, *a, **kwargs):
        if '/assets/' in url:
            assert 'Authorization' in (kwargs.get('headers') or {})
            return MockResp(200, content=PNG_BYTES, headers={'Content-Type': 'image/png'})
        return poll_responses.pop(0)

    res = _run_with([
        mock.patch.object(unified_api.requests, 'post', side_effect=lambda *a, **k: MockResp(202, TASK_202)),
        mock.patch.object(unified_api.requests, 'get', side_effect=fake_get),
        mock.patch.object(router, '_save_base64_to_dir', lambda data_url, save_dir='': None),
    ], router)

    assert res['success'] is True
    assert PNG_B64 in res['image_url']


# T07 success 无图应报错
def t07_success_without_assets_raises():
    router = make_router()
    poll_responses = [
        MockResp(200, {"status": "success", "assets": []}),
    ]

    try:
        _run_with([
            mock.patch.object(unified_api.requests, 'post', side_effect=lambda *a, **k: MockResp(202, TASK_202)),
            mock.patch.object(unified_api.requests, 'get', side_effect=lambda url, *a, **k: poll_responses.pop(0)),
        ], router)
        raise AssertionError('expected error')
    except UpstreamError as e:
        assert 'success' in str(e.message)


# T08 failed/uncertain 处理
def t08_failed_and_uncertain_handling():
    router = make_router()

    # failed -> UpstreamError
    try:
        _run_with([
            mock.patch.object(unified_api.requests, 'post', side_effect=lambda *a, **k: MockResp(202, TASK_202)),
            mock.patch.object(unified_api.requests, 'get', side_effect=lambda *a, **k: MockResp(200, {"status": "failed", "error": "boom"})),
        ], router)
        raise AssertionError('expected error')
    except UpstreamError as e:
        assert e.code == 502

    # uncertain 6 次 -> UpstreamError
    router2 = make_router()
    try:
        import time as real_time
        fake = FakeTime(real_time.time())
        _run_with([
            mock.patch.object(unified_api, 'time', fake),
            mock.patch.object(unified_api.requests, 'post', side_effect=lambda *a, **k: MockResp(202, TASK_202)),
            mock.patch.object(unified_api.requests, 'get', side_effect=lambda *a, **k: MockResp(200, {"status": "uncertain"})),
        ], router2)
        raise AssertionError('expected error')
    except UpstreamError as e:
        assert 'uncertain' in str(e.message)


# T09 200 同步回归
def t09_sync_200_inline_data_regression():
    router = make_router()
    res = _run_with([
        mock.patch.object(unified_api.requests, 'post', side_effect=lambda *a, **k: MockResp(
            200, {"candidates": [{"content": {"parts": [{"inlineData": {"mimeType": "image/png", "data": PNG_B64}}]}}]}
        )),
        mock.patch.object(unified_api.requests, 'get', side_effect=lambda *a, **k: MockResp(200)),
        mock.patch.object(router, '_save_base64_to_dir', lambda data_url, save_dir='': None),
    ], router)

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
    print(f'FluxPort v2 QA 验收 | 总用例 {len(rows)} | 通过 {passed} | 失败 {failed}')
    print('=' * 100)
    print(f'{"用例":<8}{"结果":<6}失败详情')
    print('-' * 100)
    for n, status, detail in rows:
        print(f'{n:<10}{status:<6}{detail}')
    print('=' * 100)
    if failed:
        print('结论: FAIL')
        sys.exit(1)
    print('结论: PASS')


if __name__ == '__main__':
    main()
