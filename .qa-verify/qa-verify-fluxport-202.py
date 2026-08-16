# -*- coding: utf-8 -*-
"""
QA 独立验证：FluxPort HTTP 202 异步任务轮询（backend/api/unified_api.py）
========================================================================
被验对象（工程师修改）：
  1. generate_image 新增 202 分支 -> _poll_async_image_task -> _save_images_to_local
  2. except 链新增 `except AppError: raise`（防 UpstreamError/Timeout 被兜底转 UnknownError）
  3. 新私有方法：_get_api_origin / _join_origin_path / _parse_expires_at /
     _extract_task_error / _extract_async_image_urls / _download_authed_image_to_base64 /
     _poll_async_image_task
  4. 回归：_parse_image_response / extract_image_urls_from_text / _save_images_to_local

本脚本为独立验证：全部期望值依据 PRD / 真实协议（主理人实测）/ 既有行为推导，
不采信工程师自检。仅 mock requests，不改业务代码。

运行方式：
  cd "G:/Infinite Canvas/Infinite Canvas 2.0"
  .venv/Scripts/python.exe .qa-verify/qa-verify-fluxport-202.py
"""
import base64
import io
import os
import re
import sys
import time as real_time
import unittest.mock as mock
from datetime import datetime, timedelta, timezone

PROJECT_ROOT = r"G:\Infinite Canvas\Infinite Canvas 2.0"
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from PIL import Image

from backend.api import unified_api
from backend.api.unified_api import UnifiedAPIRouter, ApiFormat
from backend.api.errors import (
    AppError, UpstreamError, UpstreamTimeoutError, UnknownError,
)
from backend.api.gemini_compat import extract_image_urls_from_text

# ─────────────────────────────────────────
# 极小合法 PNG（下载 mock 用）
# ─────────────────────────────────────────
_buf = io.BytesIO()
Image.new('RGB', (2, 2), (255, 0, 0)).save(_buf, format='PNG')
PNG_BYTES = _buf.getvalue()
PNG_B64 = base64.b64encode(PNG_BYTES).decode('ascii')

ORIGIN = "https://api.ai-media.vip"
API_URL = f"{ORIGIN}/v1"
PUBLIC_URL = "https://media.ai-media.vip/v1/images/public-assets/xxx.jpg"
FILE_URI = "/v1/images/tasks/imgtask_xxx/assets/xxx.png"
TASK_202 = {
    "status": "queued", "poll_after_ms": 500,
    "poll_url": "/v1/images/tasks/imgtask_xxx",
    "result_url": "/v1/images/tasks/imgtask_xxx",
    "task_id": "imgtask_xxx",
}


class MockResp:
    def __init__(self, status_code=200, json_data=None, text='', content=b'', headers=None):
        self.status_code = status_code
        self._json_data = json_data
        self.text = text
        self.content = content
        self.headers = headers if headers is not None else {'Content-Type': 'image/png'}
        self.url = ''

    def json(self):
        if self._json_data is None:
            raise ValueError('No JSON body')
        return self._json_data


class FakeTime:
    """假时钟：time() 返回推进中的 now；sleep() 直接推进，不真实等待。"""
    def __init__(self, start):
        self._now = start

    def time(self):
        return self._now

    def sleep(self, s):
        self._now += s


# ─────────────────────────────────────────
# 被测对象装配（Fake provider，model 命中 Gemini drawing 规则）
# ─────────────────────────────────────────
def make_router(api_url=API_URL):
    provider = {
        'id': 'fluxport', 'name': 'FluxPort', 'api_url': api_url,
        'api_key': 'test-key-123', 'enabled': True, 'use_proxy': True,
        'models': [{
            'id': 'gemini-3.1-flash-image-preview', 'name': 'Nano Banana 2',
            'type': 'drawing', 'enabled': True,
        }],
    }

    class FakeProviderAPI:
        def load_providers(self):
            return {'providers': [provider]}

    return UnifiedAPIRouter(FakeProviderAPI())


def _run_with(patchers, router):
    """进入 mock 上下文后执行 generate_image（202 全链路）。"""
    import contextlib
    with contextlib.ExitStack() as stack:
        for p in patchers:
            stack.enter_context(p)
        return router.generate_image(
            'a cute cat',
            {'model': 'fluxport:gemini-3.1-flash-image-preview', 'resolution': '1k'},
        )


# ─────────────────────────────────────────
# 用例 1：语法 / 导入
# ─────────────────────────────────────────
def t01_compile_and_import():
    import py_compile
    src = os.path.join(PROJECT_ROOT, 'backend', 'api', 'unified_api.py')
    py_compile.compile(src, doraise=True)          # 语法检查
    import backend.api.unified_api as m2           # 再次导入（模块已缓存，验证无 import 异常）
    assert hasattr(m2, 'UnifiedAPIRouter')


# ─────────────────────────────────────────
# 用例 2：辅助函数单测
# ─────────────────────────────────────────
def t02_get_api_origin():
    r = make_router()
    assert r._get_api_origin("https://api.ai-media.vip/v1") == ORIGIN
    assert r._get_api_origin("https://api.ai-media.vip:8443/v1beta") == "https://api.ai-media.vip:8443"
    assert r._get_api_origin("https://api.ai-media.vip") == ORIGIN
    assert r._get_api_origin("https://api.ai-media.vip/") == ORIGIN


def t03_join_origin_path():
    r = make_router()
    assert r._join_origin_path(ORIGIN, "/v1/images/tasks/xx") == f"{ORIGIN}/v1/images/tasks/xx"
    assert r._join_origin_path(ORIGIN + "/", "v1/images/tasks/xx") == f"{ORIGIN}/v1/images/tasks/xx"
    assert r._join_origin_path(ORIGIN, "v1/images/tasks/xx") == f"{ORIGIN}/v1/images/tasks/xx"


def t04_parse_expires_at():
    r = make_router()
    expected_8 = datetime(2026, 8, 17, 0, 19, 36, tzinfo=timezone(timedelta(hours=8))).timestamp()
    got = r._parse_expires_at("2026-08-17T00:19:36+08:00")
    assert got is not None and abs(got - expected_8) < 1e-3, f"got={got}"

    expected_z = datetime(2026, 8, 17, 0, 19, 36, tzinfo=timezone.utc).timestamp()
    got_z = r._parse_expires_at("2026-08-17T00:19:36Z")
    assert got_z is not None and abs(got_z - expected_z) < 1e-3, f"got_z={got_z}"

    assert r._parse_expires_at("not-a-date") is None
    assert r._parse_expires_at("") is None
    assert r._parse_expires_at(None) is None
    assert r._parse_expires_at(123456) is None


def t05_extract_async_urls_data_url_priority():
    r = make_router()
    res = {
        "data": [{"url": PUBLIC_URL}],
        "candidates": [{"content": {"parts": [{"fileData": {"fileUri": FILE_URI}}]}}],
    }
    images, kind = r._extract_async_image_urls(res, ORIGIN)
    assert kind == 'url', kind
    assert images == [PUBLIC_URL], images


def t06_extract_async_urls_fileuri_only():
    r = make_router()
    res = {"candidates": [{"content": {"parts": [{"fileData": {"fileUri": FILE_URI, "mimeType": "image/png"}}]}}]}
    images, kind = r._extract_async_image_urls(res, ORIGIN)
    assert kind == 'fileuri', kind
    assert images == [f"{ORIGIN}{FILE_URI}"], images


def t07_extract_async_urls_none():
    r = make_router()
    images, kind = r._extract_async_image_urls({"status": "queued"}, ORIGIN)
    assert images == [] and kind is None
    images, kind = r._extract_async_image_urls("not-a-dict", ORIGIN)
    assert images == [] and kind is None


# ─────────────────────────────────────────
# 用例 3：202 全链路
# ─────────────────────────────────────────
def t08_202_full_chain_data_url():
    """POST 202 -> 轮询 queued -> completed(data[].url) -> 下载成功 -> base64 返回。"""
    router = make_router()
    poll_responses = [
        MockResp(200, {"status": "queued", "task_id": "imgtask_xxx"}),
        MockResp(200, {"data": [{"url": PUBLIC_URL}]}),
    ]
    res = _run_with([
        mock.patch.object(unified_api.requests, 'post', side_effect=lambda *a, **k: MockResp(202, TASK_202)),
        mock.patch.object(unified_api.requests, 'get', side_effect=lambda url, *a, **k: (
            MockResp(200, content=PNG_BYTES, headers={'Content-Type': 'image/jpeg'})
            if 'public-assets' in url else poll_responses.pop(0)
        )),
        mock.patch.object(router, '_save_base64_to_dir', lambda data_url, save_dir='': None),
    ], router)
    assert res['success'] is True, res
    assert res['image_url'].startswith('data:image/'), res['image_url']
    assert PNG_B64 in res['image_url'], '应返回下载图片的 base64 内容'
    assert len(res['images']) == 1


def t09_202_full_chain_data_url_download_fail_direct_pass():
    """data[].url 下载失败时 URL 直通（不因下载失败丢图）。"""
    router = make_router()
    poll_responses = [
        MockResp(200, {"status": "queued"}),
        MockResp(200, {"data": [{"url": PUBLIC_URL}]}),
    ]
    res = _run_with([
        mock.patch.object(unified_api.requests, 'post', side_effect=lambda *a, **k: MockResp(202, TASK_202)),
        mock.patch.object(unified_api.requests, 'get', side_effect=lambda url, *a, **k: poll_responses.pop(0)),
        mock.patch.object(router, '_download_url_to_base64', lambda url: None),
    ], router)
    assert res['success'] is True, res
    assert res['image_url'] == PUBLIC_URL, res['image_url']


def t10_202_full_chain_fileuri():
    """POST 202 -> 轮询 candidates/fileData.fileUri -> 带 Authorization 下载 -> base64 返回。"""
    router = make_router()
    auth_headers_seen = []
    poll_responses = [
        MockResp(200, {"status": "queued"}),
        MockResp(200, {"candidates": [{"content": {"parts": [{"fileData": {"fileUri": FILE_URI, "mimeType": "image/png"}}], "role": "model"}, "finishReason": "STOP"}]}),
    ]

    def fake_get(url, *args, **kwargs):
        if '/assets/' in url:
            auth_headers_seen.append(kwargs.get('headers'))
            return MockResp(200, content=PNG_BYTES, headers={'Content-Type': 'image/png'})
        return poll_responses.pop(0)

    res = _run_with([
        mock.patch.object(unified_api.requests, 'post', side_effect=lambda *a, **k: MockResp(202, TASK_202)),
        mock.patch.object(unified_api.requests, 'get', side_effect=fake_get),
        mock.patch.object(router, '_save_base64_to_dir', lambda data_url, save_dir='': None),
    ], router)
    assert res['success'] is True, res
    assert res['image_url'].startswith('data:image/png;base64,'), res['image_url']
    assert PNG_B64 in res['image_url'], 'fileUri 下载内容应转 base64'
    assert auth_headers_seen, 'fileUri 资源必须发起下载请求'
    h = auth_headers_seen[0] or {}
    assert 'Authorization' in h and str(h['Authorization']).startswith('Bearer '), f"下载请求应带 Bearer 鉴权, headers={h}"


def t11_200_sync_path_no_regression():
    """POST 200（旧同步路径）行为与修复前一致：inlineData base64 直通。"""
    router = make_router()
    res = _run_with([
        mock.patch.object(unified_api.requests, 'post', side_effect=lambda *a, **k: MockResp(
            200, {"candidates": [{"content": {"parts": [{"inlineData": {"mimeType": "image/png", "data": PNG_B64}}]}}]}
        )),
        mock.patch.object(unified_api.requests, 'get', side_effect=lambda *a, **k: MockResp(200)),
        mock.patch.object(router, '_save_base64_to_dir', lambda data_url, save_dir='': None),
    ], router)
    assert res['success'] is True, res
    assert res['image_url'] == f"data:image/png;base64,{PNG_B64}", res['image_url']


# ─────────────────────────────────────────
# 用例 4：失败 / 异常路径
# ─────────────────────────────────────────
def _expect_app_error(fn, err_type, code, msg_contains=''):
    try:
        fn()
    except err_type as e:
        assert e.code == code, f"code={e.code} expected={code}"
        if msg_contains:
            assert msg_contains in str(e.message), f"message={e.message!r} 不含 {msg_contains!r}"
        return e
    except AppError as e:
        raise AssertionError(f"期望 {err_type.__name__}({code})，实际 {type(e).__name__}({e.code}): {e}")
    raise AssertionError(f"期望抛出 {err_type.__name__}({code})，实际未抛异常")


def t12_poll_status_failed_upstream502():
    router = make_router()
    poll_responses = [MockResp(200, {"status": "failed", "error": {"message": "quota exceeded"}})]
    e = _expect_app_error(
        lambda: _run_with([
            mock.patch.object(unified_api.requests, 'post', side_effect=lambda *a, **k: MockResp(202, TASK_202)),
            mock.patch.object(unified_api.requests, 'get', side_effect=lambda url, *a, **k: poll_responses.pop(0)),
        ], router),
        UpstreamError, 502, 'quota exceeded',
    )
    assert not isinstance(e, UnknownError), '不得被兜底转成 UnknownError'


def t13_poll_error_field_upstream502():
    router = make_router()
    poll_responses = [MockResp(200, {"status": "queued", "error": "boom"})]
    e = _expect_app_error(
        lambda: _run_with([
            mock.patch.object(unified_api.requests, 'post', side_effect=lambda *a, **k: MockResp(202, TASK_202)),
            mock.patch.object(unified_api.requests, 'get', side_effect=lambda url, *a, **k: poll_responses.pop(0)),
        ], router),
        UpstreamError, 502, 'boom',
    )
    assert not isinstance(e, UnknownError), '不得被兜底转成 UnknownError'


def t14_poll_timeout_upstream_timeout():
    """永远 queued -> UpstreamTimeoutError，且不真实等待（fake time 推进）。"""
    router = make_router()
    poll_responses = [MockResp(200, {"status": "queued"})] * 100000
    fake_time = FakeTime(real_time.time())
    e = _expect_app_error(
        lambda: _run_with([
            mock.patch.object(unified_api, 'time', fake_time),
            mock.patch.object(unified_api.requests, 'post', side_effect=lambda *a, **k: MockResp(202, TASK_202)),
            mock.patch.object(unified_api.requests, 'get', side_effect=lambda url, *a, **k: poll_responses.pop(0)),
        ], router),
        UpstreamTimeoutError, 504,
    )
    assert not isinstance(e, UnknownError), '不得被兜底转成 UnknownError'


def t15_202_invalid_json_reasonable_error():
    router = make_router()
    e = _expect_app_error(
        lambda: _run_with([
            mock.patch.object(unified_api.requests, 'post', side_effect=lambda *a, **k: MockResp(202)),  # json() 抛 ValueError
        ], router),
        UpstreamError, 502, 'poll_url',
    )


def t16_missing_poll_url_reasonable_error():
    router = make_router()
    task = {"status": "queued"}  # 无 poll_url/result_url/task_id
    e = _expect_app_error(
        lambda: _run_with([
            mock.patch.object(unified_api.requests, 'post', side_effect=lambda *a, **k: MockResp(202, task)),
        ], router),
        UpstreamError, 502, 'poll_url',
    )


def t17_poll_connection_error_upstream503():
    router = make_router()
    # 直接引用 unified_api.requests 的 ConnectionError 类
    conn_err = unified_api.requests.exceptions.ConnectionError
    e = _expect_app_error(
        lambda: _run_with([
            mock.patch.object(unified_api.requests, 'post', side_effect=lambda *a, **k: MockResp(202, TASK_202)),
            mock.patch.object(unified_api.requests, 'get', side_effect=lambda url, *a, **k: (_ for _ in ()).throw(conn_err('boom'))),
        ], router),
        UpstreamError, 503,
    )
    assert not isinstance(e, UnknownError), '不得被兜底转成 UnknownError'


def t18_poll_non200_handle_http_error():
    """轮询 GET 返回 500 -> 复用 _handle_http_error -> UpstreamError(500)。"""
    router = make_router()
    poll_responses = [MockResp(500, {"error": {"message": "internal error"}})]
    e = _expect_app_error(
        lambda: _run_with([
            mock.patch.object(unified_api.requests, 'post', side_effect=lambda *a, **k: MockResp(202, TASK_202)),
            mock.patch.object(unified_api.requests, 'get', side_effect=lambda url, *a, **k: poll_responses.pop(0)),
        ], router),
        UpstreamError, 500, 'internal error',
    )


# ─────────────────────────────────────────
# 用例 5：既有功能回归
# ─────────────────────────────────────────
def t19_regression_extract_image_urls_from_text():
    # visionary.beer 无扩展名 URL + 中文全角标点剥离（上轮修复，本轮不得回归）
    text = ("生成完成！https://visionary.beer/api/generations/51fc6b8d-0649-4973-8b3e-c1c5def15a2b/image"
            "?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJwdXJwb3NlIjoib3BlbmFwaS1nZW5lcmF0aW9uLWltYWdlIn0.abc"
            "，点击查看。")
    urls = extract_image_urls_from_text(text)
    assert urls == [
        "https://visionary.beer/api/generations/51fc6b8d-0649-4973-8b3e-c1c5def15a2b/image"
        "?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJwdXJwb3NlIjoib3BlbmFwaS1nZW5lcmF0aW9uLWltYWdlIn0.abc"
    ], urls
    # 常规扩展名 URL + 中文句号
    assert extract_image_urls_from_text("看这里 https://x.com/a.png。") == ["https://x.com/a.png"]
    assert extract_image_urls_from_text("无图片") == []


def t20_regression_parse_gemini_text_url():
    router = make_router()
    result = {"candidates": [{"content": {"parts": [{"text": "图已生成 https://visionary.beer/api/generations/x/image?token=abc"}]}}]}
    parsed = router._parse_image_response(result, ApiFormat.GEMINI_NATIVE)
    assert parsed.get('success') is True, parsed
    assert parsed['image_url'] == "https://visionary.beer/api/generations/x/image?token=abc", parsed


def t21_regression_save_images_to_local_data_url():
    router = make_router()
    parsed = {"success": True, "image_url": "data:image/png;base64,AAAA", "images": ["data:image/png;base64,AAAA"]}
    with mock.patch.object(router, '_save_base64_to_dir', lambda data_url, save_dir='': None):
        out = router._save_images_to_local(parsed)
    assert out['image_url'] == "data:image/png;base64,AAAA"
    assert out['images'] == ["data:image/png;base64,AAAA"]


def t22_regression_save_images_to_local_http_url():
    router = make_router()
    parsed = {"success": True, "image_url": "http://x.com/a.png", "images": ["http://x.com/a.png"]}
    with mock.patch.object(router, '_download_url_to_base64', lambda url: "data:image/png;base64,BBBB"), \
         mock.patch.object(router, '_save_base64_to_dir', lambda data_url, save_dir='': None):
        out = router._save_images_to_local(parsed)
    assert out['images'] == ["data:image/png;base64,BBBB"]
    assert out['image_url'] == "data:image/png;base64,BBBB"


def t23_regression_save_images_to_local_http_download_fail_keep_url():
    router = make_router()
    parsed = {"success": True, "image_url": "http://x.com/a.png", "images": ["http://x.com/a.png"]}
    with mock.patch.object(router, '_download_url_to_base64', lambda url: None):
        out = router._save_images_to_local(parsed)
    assert out['images'] == ["http://x.com/a.png"]
    assert out['image_url'] == "http://x.com/a.png"


# ─────────────────────────────────────────
# 用例 6：补充探针（poll_url 取值链 / expires_at 超时上限）
# ─────────────────────────────────────────
def t24_poll_result_url_fallback():
    """缺 poll_url 但有 result_url -> 用 result_url 轮询。"""
    router = make_router()
    task = dict(TASK_202)
    task.pop('poll_url')
    seen, poll_responses = [], [
        MockResp(200, {"status": "queued"}),
        MockResp(200, {"data": [{"url": PUBLIC_URL}]}),
    ]
    res = _run_with([
        mock.patch.object(unified_api.requests, 'post', side_effect=lambda *a, **k: MockResp(202, task)),
        mock.patch.object(unified_api.requests, 'get', side_effect=lambda url, *a, **k: (seen.append(url), poll_responses.pop(0))[1]),
        mock.patch.object(router, '_download_url_to_base64', lambda url: None),
    ], router)
    assert res['success'] is True, res
    assert seen[0] == f"{ORIGIN}/v1/images/tasks/imgtask_xxx", seen


def t25_poll_task_id_fallback():
    """缺 poll_url/result_url 但有 task_id -> 拼 /v1/images/tasks/{task_id} 轮询。"""
    router = make_router()
    task = {"status": "queued", "task_id": "imgtask_yyy", "poll_after_ms": 500}
    seen, poll_responses = [], [
        MockResp(200, {"status": "queued"}),
        MockResp(200, {"data": [{"url": PUBLIC_URL}]}),
    ]
    res = _run_with([
        mock.patch.object(unified_api.requests, 'post', side_effect=lambda *a, **k: MockResp(202, task)),
        mock.patch.object(unified_api.requests, 'get', side_effect=lambda url, *a, **k: (seen.append(url), poll_responses.pop(0))[1]),
        mock.patch.object(router, '_download_url_to_base64', lambda url: None),
    ], router)
    assert res['success'] is True, res
    assert seen[0] == f"{ORIGIN}/v1/images/tasks/imgtask_yyy", seen


def t26_poll_absolute_poll_url():
    """poll_url 为绝对 URL -> 原样使用，不拼 origin。"""
    router = make_router()
    task = dict(TASK_202)
    task['poll_url'] = "https://api.ai-media.vip/v1/images/tasks/abs_xxx"
    seen, poll_responses = [], [
        MockResp(200, {"status": "queued"}),
        MockResp(200, {"data": [{"url": PUBLIC_URL}]}),
    ]
    res = _run_with([
        mock.patch.object(unified_api.requests, 'post', side_effect=lambda *a, **k: MockResp(202, task)),
        mock.patch.object(unified_api.requests, 'get', side_effect=lambda url, *a, **k: (seen.append(url), poll_responses.pop(0))[1]),
        mock.patch.object(router, '_download_url_to_base64', lambda url: None),
    ], router)
    assert res['success'] is True, res
    assert seen[0] == "https://api.ai-media.vip/v1/images/tasks/abs_xxx", seen


def t27_expires_at_caps_timeout():
    """expires_at 剩余 ~2s 时，总超时上限应被压到 ~2s（而非固定 120s）。"""
    router = make_router()
    task = dict(TASK_202)
    task['expires_at'] = (datetime.now(timezone(timedelta(hours=8))) + timedelta(seconds=2)).isoformat()
    fake_time = FakeTime(real_time.time())
    poll_responses = [MockResp(200, {"status": "queued"})] * 100000
    start = fake_time.time()
    e = _expect_app_error(
        lambda: _run_with([
            mock.patch.object(unified_api, 'time', fake_time),
            mock.patch.object(unified_api.requests, 'post', side_effect=lambda *a, **k: MockResp(202, task)),
            mock.patch.object(unified_api.requests, 'get', side_effect=lambda url, *a, **k: poll_responses.pop(0)),
        ], router),
        UpstreamTimeoutError, 504,
    )
    elapsed = fake_time.time() - start
    assert elapsed < 10, f"expires_at 应把超时上限压到 ~2s，实际推进 {elapsed:.1f}s"


# ─────────────────────────────────────────
# 执行器 + 结果表
# ─────────────────────────────────────────
def main():
    names = sorted(n for n in globals() if re.match(r'^t\d+_', n) and callable(globals()[n]))
    rows = []
    passed = failed = 0
    for n in names:
        try:
            globals()[n]()
            rows.append((n, 'PASS', ''))
            passed += 1
        except Exception as e:
            rows.append((n, 'FAIL', f'{type(e).__name__}: {e}'))
            failed += 1

    print('=' * 100)
    print(f'FluxPort HTTP 202 异步轮询 QA 独立验证 | 总用例 {len(rows)} | 通过 {passed} | 失败 {failed}')
    print('=' * 100)
    print(f'{"用例":<8}{"结果":<6}失败详情')
    print('-' * 100)
    for n, status, detail in rows:
        print(f'{n:<10}{status:<6}{detail}')
    print('=' * 100)
    if failed:
        print('结论: FAIL — 存在失败用例，详见上表')
        sys.exit(1)
    print('结论: PASS — 全部通过')


if __name__ == '__main__':
    main()
