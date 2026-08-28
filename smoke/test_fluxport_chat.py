# smoke/test_fluxport_chat.py
"""FluxPort 文本反推打通冒烟（T02）：chat 域名归一 + 模型拉取分类 + chat_v2 组装/解析 + 视频防污染守卫。

运行：C:\\Users\\zeng-rong\\AppData\\Local\\Programs\\Python\\Python312\\python.exe smoke\\test_fluxport_chat.py
覆盖（不依赖真实 Key）：
  T02-1 resolve_chat_api_base 双向/反向域名归一（媒体域→语言域；语言域/其它域原样）
  T02-2 fetch_models 媒体域配置 → 请求打到语言域 /models；返回 drawing/chat/video 三态分类
  T02-3 _resolve_chat_url 媒体域配置 → 语言域 /v1/chat/completions
  T02-4 chat_v2 反推：mock POST → payload stream=false + 多模态 images + 响应 text 解析
  T02-5 视频防污染守卫：旧数据 type='chat' 的视频模型不被对话选中；_resolve_video_model 三段可命中
真 Key 才能验的部分：真实 /models 拉取、真实 chat_v2 反推（标注为 REAL-KEY）。
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


RESULTS = []


def check(name, cond, detail=''):
    RESULTS.append((name, bool(cond), detail))
    print(('PASS' if cond else 'FAIL'), '-', name, ('| ' + detail if detail else ''))


def write_file(path, data):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=4)


class _FakeResp:
    """模拟上游 HTTP 响应"""
    def __init__(self, payload, status_code=200, url='https://api.uselg.top/v1/models'):
        self.payload = payload
        self.status_code = status_code
        self.url = url

    def json(self):
        return self.payload

    @property
    def text(self):
        return json.dumps(self.payload, ensure_ascii=False)


def _make_provider(providers_file):
    """构造含 FluxPort 供应商（媒体域配置）的 providers_data.json"""
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
                    {'id': 'gpt-5.4', 'name': 'gpt-5.4', 'type': 'chat', 'enabled': True},
                    {'id': 'grok-imagine-video-1.5-preview', 'name': 'grok-imagine-video-1.5-preview', 'type': 'video', 'enabled': True},
                    {'id': 'gemini-3-pro-image-preview', 'name': 'Nano Banana Pro', 'type': 'drawing', 'enabled': True},
                ],
            }],
        }]
    })


def main():
    root = tempfile.mkdtemp(prefix='icv_fluxport_chat_')
    try:
        providers_file = os.path.join(root, 'providers_data.json')

        # ═════════════ T02-1 resolve_chat_api_base 域名归一 ═════════════
        check('媒体域 -> 语言域', resolve_chat_api_base('https://api.ai-media.vip/v1') == 'https://api.uselg.top/v1',
              resolve_chat_api_base('https://api.ai-media.vip/v1'))
        check('媒体域(裸) -> 语言域', resolve_chat_api_base('https://api.ai-media.vip') == 'https://api.uselg.top/v1',
              resolve_chat_api_base('https://api.ai-media.vip'))
        check('语言域原样', resolve_chat_api_base('https://api.uselg.top/v1') == 'https://api.uselg.top/v1',
              resolve_chat_api_base('https://api.uselg.top/v1'))
        check('其它域原样', resolve_chat_api_base('https://other.example/v1') == 'https://other.example/v1',
              resolve_chat_api_base('https://other.example/v1'))
        check('空串原样', resolve_chat_api_base('') == '', resolve_chat_api_base(''))

        _make_provider(providers_file)
        pa = ProviderAPI(providers_file)
        unified = UnifiedAPIRouter(pa)

        # ═════════════ T02-2 fetch_models：媒体域配置 → 语言域 /models；三态分类 ═════════════
        models_payload = {
            'data': [
                {'id': 'gpt-5.4'},
                {'id': 'grok-imagine-video-1.5-preview'},
                {'id': 'grok-imagine-video-2-preview'},
                {'id': 'gemini-3-pro-image-preview'},
            ]
        }
        captured = {}

        def fake_get(url, headers=None, timeout=None):
            captured['url'] = url
            return _FakeResp(models_payload, 200, url)

        with mock.patch('backend.api.provider_api.requests.get', side_effect=fake_get):
            res = pa.fetch_models('https://api.ai-media.vip/v1', 'sk-test-not-real')

        check('fetch_models 成功', res.get('status') == 'success', str(res.get('status')))
        check('fetch_models 请求打到语言域 /models',
              captured.get('url') == 'https://api.uselg.top/v1/models', captured.get('url'))
        models = res.get('models', [])
        chat_ids = [m['id'] for m in models if m.get('type') == 'chat']
        video_ids = [m['id'] for m in models if m.get('type') == 'video']
        drawing_ids = [m['id'] for m in models if m.get('type') == 'drawing']
        check('fetch_models 含 chat 模型 gpt-5.4', 'gpt-5.4' in chat_ids, str(chat_ids))
        check('fetch_models 含 video 模型（2 个）',
              'grok-imagine-video-1.5-preview' in video_ids and 'grok-imagine-video-2-preview' in video_ids,
              str(video_ids))
        check('fetch_models 含 drawing 模型', 'gemini-3-pro-image-preview' in drawing_ids, str(drawing_ids))
        check('video 模型 type 未被改写成 drawing', all(m.get('type') == 'video' for m in models if 'video' in m['id']),
              str([(m['id'], m.get('type')) for m in models if 'video' in m['id']]))

        # ═════════════ T02-3 _resolve_chat_url 媒体域 → 语言域 ═════════════
        chat_url = unified._resolve_chat_url('https://api.ai-media.vip/v1')
        check('_resolve_chat_url 媒体域 -> 语言域 chat/completions',
              chat_url == 'https://api.uselg.top/v1/chat/completions', chat_url)

        # ═════════════ T02-4 chat_v2 反推（mock POST） ═════════════
        chat_response = {
            'choices': [{
                'message': {'role': 'assistant', 'content': '画面描述：一只猫在窗台上看日落。'}
            }]
        }
        captured_post = {}

        def fake_post(url, headers=None, json=None, timeout=None, proxies=None):
            captured_post['url'] = url
            captured_post['json'] = json
            return _FakeResp(chat_response, 200, url)

        with mock.patch('backend.api.unified_api.requests.post', side_effect=fake_post):
            result = unified.chat_v2(
                '用一句话描述这张图',
                {'model': 'provider_flux:key_main:gpt-5.4',
                 'images': ['data:image/png;base64,aGVsbG8=']}
            )

        check('chat_v2 成功', result.get('success') is True, str(result))
        check('chat_v2 返回 text', '猫' in (result.get('text') or ''), result.get('text'))
        check('chat_v2 请求打到语言域', captured_post.get('url') == 'https://api.uselg.top/v1/chat/completions',
              captured_post.get('url'))
        payload = captured_post.get('json') or {}
        check('chat_v2 payload.model 正确', payload.get('model') == 'gpt-5.4', str(payload.get('model')))
        check('chat_v2 payload 显式 stream=false', payload.get('stream') is False, str(payload.get('stream')))
        content = payload.get('messages', [])[-1].get('content', [])
        check('chat_v2 多模态 images 组装', isinstance(content, list) and len(content) == 2
              and content[0].get('type') == 'image_url', str(content))

        # ═════════════ T02-5 视频防污染守卫 + _resolve_video_model ═════════════
        # 旧数据：视频模型曾被存成 type='chat'（grok-imagine-video-* 曾落入 chat 兜底）
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
                        # 被污染的历史数据：视频模型 type='chat'
                        {'id': 'grok-imagine-video-1.5-preview', 'name': 'grok-imagine-video-1.5-preview', 'type': 'chat', 'enabled': True},
                    ],
                }],
            }]
        })
        unified._providers_cache = []  # 强制重读

        # 对话守卫：三段精确指定视频模型（旧数据存成 chat）→ 拒绝（防误发 /chat/completions）
        try:
            unified._resolve_chat_model('provider_flux:key_main:grok-imagine-video-1.5-preview')
            guard_ok = False
        except Exception:
            guard_ok = True
        check('_resolve_chat_model 三段拒绝旧视频模型', guard_ok)

        # 对话守卫：_first_available_model(CHAT) 跳过 type='chat' 的视频模型
        p_chat, k_chat, m_chat = unified._first_available_model(unified._load_providers(force=True), ModelType.CHAT)
        check('_first_available_model(CHAT) 跳过污染视频模型', m_chat is None,
              str(m_chat))

        # 设计约定：污染数据在视频侧同样不被选中（三段精确要求 type='video' 或未存 type 且实时规则命中），
        # 用户重拉模型后自愈 —— 因此 _resolve_video_model 对 type='chat' 的旧数据应拒绝而非误选。
        try:
            unified._resolve_video_model('provider_flux:key_main:grok-imagine-video-1.5-preview')
            video_polluted_ok = False
        except Exception:
            video_polluted_ok = True
        check('_resolve_video_model 拒绝污染旧数据（type=chat）', video_polluted_ok)

        # 修复后（重拉模型写入 type='video'）：_resolve_video_model 三段可命中
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
        unified._providers_cache = []  # 强制重读
        p_video, k_video, m_video = unified._resolve_video_model('provider_flux:key_main:grok-imagine-video-1.5-preview')
        check('_resolve_video_model 三段命中（type=video）', p_video is not None and m_video is not None
              and m_video.type == ModelType.VIDEO, str(m_video))
        # 修复后：该视频模型也不应再被对话选中
        try:
            unified._resolve_chat_model('provider_flux:key_main:grok-imagine-video-1.5-preview')
            guard_ok2 = False
        except Exception:
            guard_ok2 = True
        check('_resolve_chat_model 修复后仍拒绝视频模型（type=video）', guard_ok2)

        # ═════════════ 真 Key 才可验（REAL-KEY 标注，仅提示不执行） ═════════════
        print('SKIP - REAL-KEY: 真实 /models 拉取（媒体域 → 语言域返回 gpt-5.4 + 视频模型）')
        print('SKIP - REAL-KEY: 真实 chat_v2 反推（runTextGen 上游 data:image → text）')

        failed = [r for r in RESULTS if not r[1]]
        print(f"\n共 {len(RESULTS)} 项，失败 {len(failed)} 项")
        return 1 if failed else 0

    finally:
        import shutil
        shutil.rmtree(root, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
