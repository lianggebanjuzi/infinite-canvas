# smoke/test_fluxport_video.py
"""FluxPort 视频生成后端冒烟（T03）：创建→轮询→下载→落盘 全链路（mock，不依赖真实 Key）。

运行：C:\\Users\\zeng-rong\\AppData\\Local\\Programs\\Python\\Python312\\python.exe smoke\\test_fluxport_video.py
覆盖：
  T03-1 _resolve_video_url 媒体域 / 语言域→媒体域
  T03-2 _build_video_payload：seconds/duration 优先级、size 显式/映射、参考图 JSON 通道、首尾帧成对
  T03-3 _map_video_size 极简映射
  T03-4 _extract_video_url：output.* / 顶层 / assets[].signed_url / 相对路径拼 origin
  T03-5 generate_video 同步主链路：mock 202 回执 → 轮询 queued→completed → 下载落盘 → 成功契约
  T03-6 signed_url 失败 → /content 兜底下载
  T03-7 轮询 failed → UpstreamError
  T03-8 pending_confirmation 连续超限 → UpstreamError（mock sleep + 缩小上限）
  T03-9 generate_video_async + get_video_task_result：pending → done 中间态
真 Key 才能验的部分：真实创建/轮询/下载（标注为 REAL-KEY）。
"""
import json
import os
import sys
import tempfile
import time as real_time
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import backend.api.video_api as video_api_module
from backend.api.errors import AppError, UpstreamError
from backend.api.provider_api import ProviderAPI
from backend.api.unified_api import UnifiedAPIRouter
from backend.api.video_api import VideoAPI

RESULTS = []


def check(name, cond, detail=''):
    RESULTS.append((name, bool(cond), detail))
    detail_s = json.dumps(detail, ensure_ascii=False) if not isinstance(detail, str) else detail
    print(('PASS' if cond else 'FAIL'), '-', name, ('| ' + detail_s if detail_s else ''))


def write_file(path, data):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=4)


class _FakeResp:
    """模拟上游 JSON 响应"""
    def __init__(self, payload, status_code=200, url='https://api.ai-media.vip/v1/videos'):
        self.payload = payload
        self.status_code = status_code
        self.url = url

    def json(self):
        return self.payload

    @property
    def text(self):
        return json.dumps(self.payload, ensure_ascii=False)


class _FakeStreamResp:
    """模拟流式下载响应（视频分块）"""
    def __init__(self, payload=b'FAKE-VIDEO-DATA' * 64, status_code=200,
                 content_type='video/mp4', url='https://api.ai-media.vip/v1/videos/vtask_xxx/content'):
        self._payload = payload
        self.status_code = status_code
        self.headers = {'Content-Type': content_type}
        self.url = url

    def iter_content(self, chunk_size=1024 * 1024):
        for i in range(0, len(self._payload), chunk_size):
            yield self._payload[i:i + chunk_size]


def _make_provider(providers_file):
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
                ],
            }],
        }]
    })


def main():
    root = tempfile.mkdtemp(prefix='icv_fluxport_video_')
    try:
        providers_file = os.path.join(root, 'providers_data.json')
        _make_provider(providers_file)
        pa = ProviderAPI(providers_file)
        unified = UnifiedAPIRouter(pa)
        video = VideoAPI(unified)

        # ═════════════ T03-1 _resolve_video_url ═════════════
        check('_resolve_video_url 媒体域 -> /v1/videos',
              video._resolve_video_url('https://api.ai-media.vip/v1') == 'https://api.ai-media.vip/v1/videos',
              video._resolve_video_url('https://api.ai-media.vip/v1'))
        check('_resolve_video_url 语言域 -> 媒体域 /v1/videos',
              video._resolve_video_url('https://api.uselg.top/v1') == 'https://api.ai-media.vip/v1/videos',
              video._resolve_video_url('https://api.uselg.top/v1'))

        # ═════════════ T03-2 _build_video_payload ═════════════
        p = video._build_video_payload('grok-imagine-video-1.5-preview', '巨龙飞向城墙',
                                       {'seconds': 15, 'duration': 30, 'size': '1280x720'})
        check('payload 基础字段', p.get('model') == 'grok-imagine-video-1.5-preview' and p.get('prompt') == '巨龙飞向城墙', str(p))
        check('seconds 优先于 duration', p.get('seconds') == 15, str(p.get('seconds')))
        check('size 显式优先', p.get('size') == '1280x720', str(p.get('size')))

        p2 = video._build_video_payload('m', 'p', {'duration': 8})
        check('duration 兜底 seconds', p2.get('seconds') == 8 and 'duration' not in p2, str(p2))

        p3 = video._build_video_payload('m', 'p', {'resolution': '720p', 'aspectRatio': '16:9'})
        check('resolution+aspectRatio -> size 映射', p3.get('size') == '1280x720', str(p3))

        p4 = video._build_video_payload('m', 'p', {'resolution': '4k', 'aspectRatio': '16:9'})
        check('未知 resolution -> 不传 size', 'size' not in p4, str(p4))

        p5 = video._build_video_payload('m', 'p', {
            'image_url': 'https://example.com/ref.jpg',
            'referenceImages': ['data:image/png;base64,QUJD'],
            'startFrame': 'data:image/png;base64,RlJBTUU=',
            'endFrame': 'data:image/png;base64,RU5E',
            'audio': True,
        })
        check('image_url 透传', p5.get('image_url') == 'https://example.com/ref.jpg', str(p5))
        check('reference_images 透传', p5.get('reference_images') == ['data:image/png;base64,QUJD'], str(p5))
        check('start_frame/end_frame 成对透传', p5.get('start_frame') == 'data:image/png;base64,RlJBTUU='
              and p5.get('end_frame') == 'data:image/png;base64,RU5E', str(p5))
        check('audio 透传', p5.get('audio') is True, str(p5))

        p6 = video._build_video_payload('m', 'p', {'startFrame': 'data:image/png;base64,RlJBTUU='})
        check('首尾帧缺一半 -> 不传', 'start_frame' not in p6 and 'end_frame' not in p6, str(p6))

        p7 = video._build_video_payload('m', 'p', {'image_url': 'C:/local/path.png'})
        check('本地路径 image_url 不传', 'image_url' not in p7, str(p7))

        # ═════════════ T03-3 _map_video_size ═════════════
        check('720p 16:9 映射', video._map_video_size('720p', '16:9') == '1280x720', video._map_video_size('720p', '16:9'))
        check('1080p 9:16 映射', video._map_video_size('1080p', '9:16') == '1080x1920', video._map_video_size('1080p', '9:16'))
        check('未命中 -> None', video._map_video_size('1080p', '21:9') is None, str(video._map_video_size('1080p', '21:9')))
        check('未知 resolution -> None', video._map_video_size('2k', '16:9') is None, str(video._map_video_size('2k', '16:9')))

        # ═════════════ T03-4 _extract_video_url ═════════════
        origin = 'https://api.ai-media.vip'
        u1, k1 = video._extract_video_url({'output': {'video_url': 'https://cdn.example.com/v.mp4'}}, origin)
        check('output.video_url 绝对 -> url', u1 == 'https://cdn.example.com/v.mp4' and k1 == 'url', (u1, k1))
        u2, k2 = video._extract_video_url({'video_url': '/v1/videos/vtask_xxx/file.mp4'}, origin)
        check('顶层相对 -> 拼 origin + fileuri', u2 == 'https://api.ai-media.vip/v1/videos/vtask_xxx/file.mp4' and k2 == 'fileuri', (u2, k2))
        u3, k3 = video._extract_video_url({'assets': [{'signed_url': 'https://signed.example.com/v.mp4?token=x'}]}, origin)
        check('assets.signed_url -> url', u3 == 'https://signed.example.com/v.mp4?token=x' and k3 == 'url', (u3, k3))
        u4, k4 = video._extract_video_url({'assets': [{'url': '/assets/v.mp4'}]}, origin)
        check('assets.url 相对 -> 拼 origin + fileuri', u4 == 'https://api.ai-media.vip/assets/v.mp4' and k4 == 'fileuri', (u4, k4))
        u5, k5 = video._extract_video_url({'status': 'completed'}, origin)
        check('无视频地址 -> (None, None)', u5 is None and k5 is None, (u5, k5))

        # ═════════════ T03-5 generate_video 同步主链路 ═════════════
        create_receipt = {
            'task_id': 'vtask_abc123',
            'status': 'queued',
            'status_url': '/v1/videos/vtask_abc123',
            'poll_after_ms': 2000,
        }
        completed = {
            'task_id': 'vtask_abc123',
            'status': 'completed',
            'output': {'video_url': 'https://cdn.example.com/video.mp4'},
            'width': 1280,
            'height': 720,
            'duration': 15,
        }
        poll_state = {'n': 0}
        captured = {}

        def fake_post(url, headers=None, json=None, timeout=None, proxies=None):
            captured['post_url'] = url
            captured['post_headers'] = headers
            captured['post_json'] = json
            return _FakeResp(create_receipt, 202, url)

        def fake_get(url, headers=None, stream=False, timeout=None, proxies=None):
            if not stream:
                # 轮询：第一次 queued，第二次 completed
                poll_state['n'] += 1
                payload = completed if poll_state['n'] >= 2 else {'status': 'queued', 'poll_after_ms': 2000, 'task_id': 'vtask_abc123'}
                return _FakeResp(payload, 200, url)
            # 下载（signed_url）
            captured['download_url'] = url
            return _FakeStreamResp()

        with mock.patch('backend.api.video_api.requests.post', side_effect=fake_post), \
             mock.patch('backend.api.video_api.requests.get', side_effect=fake_get), \
             mock.patch('backend.api.video_api.time.sleep', return_value=None):
            result = video.generate_video(
                '巨龙飞向城墙',
                {'model': 'provider_flux:key_main:grok-imagine-video-1.5-preview', 'seconds': 15, 'size': '1280x720'},
            )

        check('POST 打到媒体域 /v1/videos', captured.get('post_url') == 'https://api.ai-media.vip/v1/videos', captured.get('post_url'))
        check('POST 带 Idempotency-Key', (captured.get('post_headers') or {}).get('Idempotency-Key', '').startswith('video-'),
              str((captured.get('post_headers') or {}).get('Idempotency-Key')))
        check('POST payload 正确', (captured.get('post_json') or {}).get('model') == 'grok-imagine-video-1.5-preview'
              and (captured.get('post_json') or {}).get('seconds') == 15, str(captured.get('post_json')))
        check('生成成功', result.get('success') is True, str(result))
        check('video_path 存在且落盘', result.get('video_path') and os.path.exists(result['video_path']), result.get('video_path'))
        check('video_url 为 file:///', (result.get('video_url') or '').startswith('file:///'), result.get('video_url'))
        check('saved_to_disk 为 false（未配置保存路径）', result.get('saved_to_disk') is False, str(result.get('saved_to_disk')))
        check('task_id 为上游任务 id', result.get('task_id') == 'vtask_abc123', str(result.get('task_id')))
        check('元数据透传', result.get('width') == 1280 and result.get('height') == 720 and result.get('duration') == 15,
              str((result.get('width'), result.get('height'), result.get('duration'))))
        check('size_bytes 与 mock 数据一致', result.get('size_bytes') == len(b'FAKE-VIDEO-DATA' * 64),
              str(result.get('size_bytes')))

        # ═════════════ T03-6 signed_url 失败 → /content 兜底 ═════════════
        poll_state2 = {'n': 0}
        captured2 = {}

        def fake_post2(url, headers=None, json=None, timeout=None, proxies=None):
            return _FakeResp(create_receipt, 202, url)

        def fake_get2(url, headers=None, stream=False, timeout=None, proxies=None):
            if not stream:
                poll_state2['n'] += 1
                payload = completed if poll_state2['n'] >= 2 else {'status': 'queued', 'poll_after_ms': 2000, 'task_id': 'vtask_abc123'}
                return _FakeResp(payload, 200, url)
            if 'cdn.example.com' in url:
                captured2['signed_failed'] = True
                return _FakeStreamResp(status_code=403, url=url)
            if '/content' in url:
                captured2['content_fallback'] = True
                return _FakeStreamResp(url=url)
            return _FakeStreamResp(url=url)

        with mock.patch('backend.api.video_api.requests.post', side_effect=fake_post2), \
             mock.patch('backend.api.video_api.requests.get', side_effect=fake_get2), \
             mock.patch('backend.api.video_api.time.sleep', return_value=None):
            result2 = video.generate_video('p', {'model': 'provider_flux:key_main:grok-imagine-video-1.5-preview'})

        check('signed_url 失败先发生', captured2.get('signed_failed') is True)
        check('/content 兜底被调用', captured2.get('content_fallback') is True)
        check('兜底后仍成功', result2.get('success') is True and bool(result2.get('video_path')), str(result2))

        # ═════════════ T03-7 轮询 failed → UpstreamError ═════════════
        def fake_post3(url, headers=None, json=None, timeout=None, proxies=None):
            return _FakeResp(create_receipt, 202, url)

        def fake_get3(url, headers=None, stream=False, timeout=None, proxies=None):
            if stream:
                return _FakeStreamResp()
            return _FakeResp({'status': 'failed', 'task_id': 'vtask_abc123', 'error': {'message': '素材违规'}}, 200, url)

        with mock.patch('backend.api.video_api.requests.post', side_effect=fake_post3), \
             mock.patch('backend.api.video_api.requests.get', side_effect=fake_get3), \
             mock.patch('backend.api.video_api.time.sleep', return_value=None):
            try:
                video.generate_video('p', {'model': 'provider_flux:key_main:grok-imagine-video-1.5-preview'})
                failed_ok = False
            except UpstreamError as e:
                failed_ok = ('failed' in str(e)) and ('素材违规' in str(e))
        check('轮询 failed -> UpstreamError 含上游错误', failed_ok)

        # ═════════════ T03-8 pending_confirmation 连续超限 → UpstreamError ═════════════
        def fake_post4(url, headers=None, json=None, timeout=None, proxies=None):
            return _FakeResp(create_receipt, 202, url)

        def fake_get4(url, headers=None, stream=False, timeout=None, proxies=None):
            if stream:
                return _FakeStreamResp()
            return _FakeResp({'status': 'pending_confirmation', 'task_id': 'vtask_abc123'}, 200, url)

        with mock.patch('backend.api.video_api.requests.post', side_effect=fake_post4), \
             mock.patch('backend.api.video_api.requests.get', side_effect=fake_get4), \
             mock.patch('backend.api.video_api.time.sleep', return_value=None), \
             mock.patch('backend.api.video_api._VIDEO_PENDING_LIMIT', 2):
            try:
                video.generate_video('p', {'model': 'provider_flux:key_main:grok-imagine-video-1.5-preview'})
                pending_ok = False
            except UpstreamError as e:
                pending_ok = 'pending_confirmation' in str(e)
        check('pending_confirmation 连续超限 -> UpstreamError', pending_ok)

        # ═════════════ T03-9 generate_video_async + get_video_task_result ═════════════
        poll_state3 = {'n': 0}
        with mock.patch('backend.api.video_api.requests.post', side_effect=fake_post), \
             mock.patch('backend.api.video_api.requests.get', side_effect=lambda url, headers=None, stream=False, timeout=None, proxies=None: (
                 _FakeStreamResp() if stream else (
                     _FakeResp(completed if (poll_state3.__setitem__('n', poll_state3['n'] + 1) or poll_state3['n']) >= 2
                               else {'status': 'queued', 'poll_after_ms': 2000, 'task_id': 'vtask_abc123'}, 200, url)
                 )
             )), \
             mock.patch('backend.api.video_api.time.sleep', return_value=None):
            async_res = video.generate_video_async('p', {'model': 'provider_flux:key_main:grok-imagine-video-1.5-preview'})

        check('generate_video_async 返回 task_id', async_res.get('success') is True and bool(async_res.get('task_id')),
              str(async_res))
        task_id = async_res['task_id']

        # 等待后台线程完成（video_api 内 sleep 已被 mock 为 no-op，线程很快结束；
        # 中间态 queued/processing 属正常，继续等待直到 done/not_found）
        done = None
        for _ in range(200):
            r = video.get_video_task_result(task_id)
            if r['status'] == 'done':
                done = r['result']
                break
            if r['status'] == 'not_found':
                done = {'status': 'not_found'}
                break
            real_time.sleep(0.02)
        check('get_video_task_result 到达 done', isinstance(done, dict) and done.get('success') is True, str(done)[:200])
        check('async 结果含 video_path', bool(done and done.get('video_path')), str(done and done.get('video_path')))
        r_nf = video.get_video_task_result('no_such_task')
        check('未知 task_id -> not_found', r_nf.get('status') == 'not_found', str(r_nf))

        # ═════════════ 真 Key 才可验（REAL-KEY 标注，仅提示不执行） ═════════════
        print('SKIP - REAL-KEY: 真实视频创建（POST /v1/videos + Idempotency-Key）')
        print('SKIP - REAL-KEY: 真实轮询到 completed + 下载落盘（短秒数小视频）')
        print('SKIP - REAL-KEY: 真实 429 / pending_confirmation 退避（日志验证）')

        failed = [r for r in RESULTS if not r[1]]
        print(f"\n共 {len(RESULTS)} 项，失败 {len(failed)} 项")
        return 1 if failed else 0

    finally:
        import shutil
        shutil.rmtree(root, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
