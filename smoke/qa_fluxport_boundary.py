# smoke/qa_fluxport_boundary.py
"""FluxPort 边界补充冒烟（QA 独立补充，覆盖既有 smoke 未覆盖的边界）。

运行：C:\\Users\\zeng-rong\\AppData\\Local\\Programs\\Python\\Python312\\python.exe smoke\\qa_fluxport_boundary.py
覆盖：
  QB-1 _guess_video_ext：各 Content-Type / URL 后缀 / 兜底 mp4
  QB-2 _map_video_size 全组合边界（720p/1080p 全部映射 + 未命中 None）
  QB-3 _parse_expires_at：合法 ISO（含时区/Z）、非法、None
  QB-4 轮询 GET 不带 Idempotency-Key / Content-Type（幂等键只用于创建）
  QB-5 下载 requests.get 必须 stream=True（禁止整包 resp.content）
  QB-6 手动添加 chat 模型（未命中规则兜底 chat）被防污染守卫放行（无回归）
  QB-7 _resolve_chat_url 非 FluxPort 域原样拼接（加性零回归）
  QB-8 seconds 字符串 "15" → int；非法 seconds 忽略
  QB-9 _build_video_payload：size 为空串不传；referenceImages 非 data:image 过滤
"""
import json
import os
import sys
import tempfile
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.api.gemini_compat import resolve_chat_api_base
from backend.api.provider_api import ProviderAPI
from backend.api.unified_api import UnifiedAPIRouter, ModelType
from backend.api.video_api import VideoAPI

RESULTS = []


def check(name, cond, detail=''):
    RESULTS.append((name, bool(cond), detail))
    detail_s = json.dumps(detail, ensure_ascii=False) if not isinstance(detail, str) else detail
    print(('PASS' if cond else 'FAIL'), '-', name, ('| ' + detail_s if detail_s else ''))


def write_file(path, data):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=4)


def make_provider(providers_file):
    write_file(providers_file, {
        'providers': [{
            'id': 'provider_flux',
            'name': 'FluxPort',
            'short_name': 'flux',
            'type': 'openai',
            'enabled': True,
            'api_url': 'https://api.ai-media.vip/v1',
            'use_proxy': True,
            'keys': [{
                'id': 'key_main',
                'name': 'key1',
                'api_key': 'sk-test-not-real',
                'enabled': True,
                'models': [
                    {'id': 'grok-imagine-video-1.5-preview', 'name': 'grok-imagine-video-1.5-preview', 'type': 'video', 'enabled': True},
                    {'id': 'my-custom-chat', 'name': 'my-custom-chat', 'type': 'chat', 'enabled': True},
                ],
            }],
        }]
    })


def main():
    root = tempfile.mkdtemp(prefix='icv_fluxport_boundary_')
    try:
        providers_file = os.path.join(root, 'providers_data.json')
        make_provider(providers_file)
        pa = ProviderAPI(providers_file)
        unified = UnifiedAPIRouter(pa)
        video = VideoAPI(unified)

        # ═════════════ QB-1 _guess_video_ext ═════════════
        check('video/mp4 -> mp4', video._guess_video_ext('video/mp4') == 'mp4', video._guess_video_ext('video/mp4'))
        check('video/quicktime -> mov', video._guess_video_ext('video/quicktime') == 'mov')
        check('video/webm -> webm', video._guess_video_ext('video/webm') == 'webm')
        check('video/x-matroska -> mkv', video._guess_video_ext('video/x-matroska') == 'mkv')
        check('video/mpeg -> mpg', video._guess_video_ext('video/mpeg') == 'mpg')
        check('video/ogg -> ogv', video._guess_video_ext('video/ogg') == 'ogv')
        check('video/avi -> avi', video._guess_video_ext('video/avi') == 'avi')
        check('带参数 Content-Type 取子类型', video._guess_video_ext('video/mp4; codecs="avc1.64001f"') == 'mp4',
              video._guess_video_ext('video/mp4; codecs="avc1.64001f"'))
        check('octet-stream + URL .mov -> mov', video._guess_video_ext('application/octet-stream', 'https://x.com/a.mov?token=1') == 'mov')
        check('octet-stream + URL .mkv -> mkv', video._guess_video_ext('application/octet-stream', 'https://x.com/b.mkv') == 'mkv')
        check('无 Content-Type + 无后缀 -> mp4', video._guess_video_ext('', 'https://x.com/video?id=1') == 'mp4')
        check('text/html + URL 无后缀 -> mp4', video._guess_video_ext('text/html', 'https://x.com/video') == 'mp4')
        check('URL 后缀 mp4（Content-Type 无 video）', video._guess_video_ext('application/octet-stream', 'https://x.com/v.mp4') == 'mp4')

        # ═════════════ QB-2 _map_video_size 全组合 ═════════════
        expect_720 = {'16:9': '1280x720', '9:16': '720x1280', '1:1': '1024x1024', '4:3': '1152x864', '3:4': '864x1152'}
        expect_1080 = {'16:9': '1920x1080', '9:16': '1080x1920', '1:1': '1080x1080', '4:3': '1440x1080', '3:4': '1080x1440'}
        for ar, expected in expect_720.items():
            got = video._map_video_size('720p', ar)
            check(f'720p {ar} -> {expected}', got == expected, got)
        for ar, expected in expect_1080.items():
            got = video._map_video_size('1080p', ar)
            check(f'1080p {ar} -> {expected}', got == expected, got)
        check('大小写不敏感 720P/16:9', video._map_video_size('720P', '16:9') == '1280x720')
        check('resolution 空 -> None', video._map_video_size('', '16:9') is None)
        check('aspectRatio 空 -> None', video._map_video_size('720p', '') is None)
        check('未知比例 21:9 -> None', video._map_video_size('1080p', '21:9') is None)
        check('None/None -> None', video._map_video_size(None, None) is None)

        # ═════════════ QB-3 _parse_expires_at ═════════════
        import time as _t
        valid_ts = unified._parse_expires_at('2026-08-17T00:19:36+08:00')
        check('expires_at 带时区 ISO 解析为 epoch', isinstance(valid_ts, (int, float)) and valid_ts > 0, valid_ts)
        valid_z = unified._parse_expires_at('2026-08-17T00:19:36Z')
        check('expires_at Z 后缀解析为 epoch', isinstance(valid_z, (int, float)) and valid_z > 0, valid_z)
        check('expires_at 非法 -> None', unified._parse_expires_at('not-a-date') is None)
        check('expires_at None -> None', unified._parse_expires_at(None) is None)
        check('expires_at 空串 -> None', unified._parse_expires_at('') is None)

        # ═════════════ QB-4 轮询 GET 不带 Idempotency-Key / Content-Type ═════════════
        captured = {}

        class _FakeResp:
            def __init__(self, payload, status_code=200, url='https://x'):
                self.payload, self.status_code, self.url = payload, status_code, url
            def json(self):
                return self.payload
            @property
            def text(self):
                return json.dumps(self.payload)

        def fake_post(url, headers=None, json=None, timeout=None, proxies=None):
            captured['post_headers'] = headers
            return _FakeResp({'task_id': 'vtask_b1', 'status_url': '/v1/videos/vtask_b1', 'poll_after_ms': 2000}, 202, url)

        def fake_get(url, headers=None, stream=False, timeout=None, proxies=None):
            if not stream:
                captured['poll_headers'] = headers
                captured['poll_url'] = url
                return _FakeResp({'status': 'completed', 'output': {'video_url': 'https://cdn.example.com/v.mp4'}}, 200, url)
            captured['download_headers'] = headers
            captured['download_stream'] = stream
            class _SR:
                status_code = 200
                headers = {'Content-Type': 'video/mp4'}
                def iter_content(self, chunk_size=1024 * 1024):
                    yield b'X' * 64
            return _SR()

        with mock.patch('backend.api.video_api.requests.post', side_effect=fake_post), \
             mock.patch('backend.api.video_api.requests.get', side_effect=fake_get), \
             mock.patch('backend.api.video_api.time.sleep', return_value=None):
            video.generate_video('p', {'model': 'provider_flux:key_main:grok-imagine-video-1.5-preview'})

        ph = captured.get('poll_headers') or {}
        check('POST 带 Idempotency-Key', (captured.get('post_headers') or {}).get('Idempotency-Key', '').startswith('video-'))
        check('轮询 GET 不带 Idempotency-Key', 'Idempotency-Key' not in ph, str(ph.keys()))
        check('轮询 GET 不带 Content-Type', 'Content-Type' not in ph, str(ph.keys()))
        check('轮询 GET 保留 Authorization', ph.get('Authorization', '').startswith('Bearer '), str(ph.get('Authorization')))

        # ═════════════ QB-5 下载 stream=True（严禁整包 resp.content） ═════════════
        check('下载 requests.get stream=True', captured.get('download_stream') is True, str(captured.get('download_stream')))

        # ═════════════ QB-6 手动添加 chat 模型放行（防污染守卫无回归） ═════════════
        p, k, m = unified._resolve_chat_model('provider_flux:key_main:my-custom-chat')
        check('手动 chat 模型三段放行', p is not None and m is not None and m.type == ModelType.CHAT, str(m))
        p2, k2, m2 = unified._first_available_model(unified._load_providers(force=True), ModelType.CHAT)
        check('手动 chat 模型在 first_available 中优先于视频', m2 is not None and m2.id == 'my-custom-chat', str(m2))

        # ═════════════ QB-7 _resolve_chat_url 非 FluxPort 域原样（加性零回归） ═════════════
        check('非 FluxPort 带 /v1 -> 原样拼 chat/completions',
              unified._resolve_chat_url('https://api.openai.com/v1') == 'https://api.openai.com/v1/chat/completions',
              unified._resolve_chat_url('https://api.openai.com/v1'))
        check('非 FluxPort 裸域 -> 补 /v1/chat/completions',
              unified._resolve_chat_url('https://api.openai.com') == 'https://api.openai.com/v1/chat/completions',
              unified._resolve_chat_url('https://api.openai.com'))
        check('已带 chat/completions 不再拼接',
              unified._resolve_chat_url('https://api.uselg.top/v1/chat/completions') == 'https://api.uselg.top/v1/chat/completions')

        # ═════════════ QB-8 seconds 字符串 / 非法 seconds ═════════════
        p8 = video._build_video_payload('m', 'p', {'seconds': '15'})
        check('seconds 字符串 "15" -> int 15', p8.get('seconds') == 15 and isinstance(p8.get('seconds'), int), str(p8.get('seconds')))
        p8b = video._build_video_payload('m', 'p', {'seconds': 'abc'})
        check('非法 seconds 忽略（不传）', 'seconds' not in p8b, str(p8b))
        p8c = video._build_video_payload('m', 'p', {'seconds': 0})
        check('seconds=0 显式传 0', p8c.get('seconds') == 0, str(p8c.get('seconds')))

        # ═════════════ QB-9 payload 参考图/尺寸边界 ═════════════
        p9 = video._build_video_payload('m', 'p', {'size': '   '})
        check('size 空白串不传', 'size' not in p9, str(p9))
        p9b = video._build_video_payload('m', 'p', {'referenceImages': ['data:image/png;base64,QUJD', 'not-a-data-url', 123]})
        check('referenceImages 只保留 data:image', p9b.get('reference_images') == ['data:image/png;base64,QUJD'], str(p9b.get('reference_images')))
        p9c = video._build_video_payload('m', 'p', {'image_url': 'https://ok.example/a.jpg', 'startFrame': 'data:image/png;base64,QQ==', 'endFrame': None})
        check('image_url 透传 + 首尾帧缺尾不传', p9c.get('image_url') == 'https://ok.example/a.jpg'
              and 'start_frame' not in p9c and 'end_frame' not in p9c, str(p9c))

        # ═════════════ QB-10 域名方向不混用（视频媒体域 / 对话语言域） ═════════════
        check('视频创建 URL 走媒体域', video._resolve_video_url('https://api.uselg.top/v1') == 'https://api.ai-media.vip/v1/videos',
              video._resolve_video_url('https://api.uselg.top/v1'))
        check('对话 URL 走语言域', unified._resolve_chat_url('https://api.ai-media.vip/v1') == 'https://api.uselg.top/v1/chat/completions',
              unified._resolve_chat_url('https://api.ai-media.vip/v1'))
        check('resolve_chat_api_base 不误伤语言域', resolve_chat_api_base('https://api.uselg.top/v1') == 'https://api.uselg.top/v1')

        failed = [r for r in RESULTS if not r[1]]
        print(f"\n共 {len(RESULTS)} 项，失败 {len(failed)} 项")
        return 1 if failed else 0

    finally:
        import shutil
        shutil.rmtree(root, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
