# smoke/qa_dual_url.py
"""QA 独立验证：供应商「双 URL」功能（图片/视频 URL 与文本对话 URL 分开配置）。

运行：py -3.12 smoke/qa_dual_url.py   （或 python smoke/qa_dual_url.py）
覆盖（全部 monkeypatch 隔离真实网络，绝不打真实 API）：
  A  chat() URL 三态解析：text_api_url 空回退 api_url / 媒体域归一语言域 / 语言域原样 / 全路径 / 尾斜杠
  B  校验逻辑：只填 text_api_url 放行 / 双空报「尚未填写 API 地址或密钥」/ 缺密钥报错 / 空白串视为空
  C  图片链路不受影响：generate_image 请求 URL 仍走 api_url（媒体域），不引用 text_api_url；
     video_api.py / image_api.py / main.py 全仓无 text_api_url 引用（静态断言）
  D  旧数据兼容：无 text_api_url 字段的 provider 加载/对话正常；ProviderAPI 保存/加载回环保留 text_api_url
  E  风险探测：只填 text_api_url（api_url 空）且未显式指定模型 → _first_available_model 回退行为
"""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import backend.api.unified_api as unified_mod
from backend.api.provider_api import ProviderAPI
from backend.api.unified_api import UnifiedAPIRouter
from backend.api.errors import AppError, UpstreamError

RESULTS = []


def check(name, cond, detail=''):
    RESULTS.append((name, bool(cond), detail))
    print(('PASS' if cond else 'FAIL'), '-', name, ('| ' + detail if detail else ''))


def write_file(path, data):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=4)


class FakeResp:
    def __init__(self, status_code, payload=None):
        self.status_code = status_code
        self._payload = payload or {}

    def json(self):
        return self._payload


def make_provider(**over):
    """构造一个带 chat+drawing 模型的 provider（默认 api_url 媒体域）"""
    p = {
        'id': 'provider_1',
        'name': 'Test',
        'short_name': 'T',
        'type': 'openai',
        'enabled': True,
        'api_url': 'https://api.ai-media.vip/v1',
        'use_proxy': True,
        'keys': [
            {
                'id': 'key_a', 'name': 'A', 'api_key': 'sk-a', 'enabled': True,
                'models': [
                    {'id': 'gemini-3-pro-image-preview', 'name': 'Nano Banana Pro', 'type': 'drawing', 'enabled': True},
                    {'id': 'gpt-4o-mini', 'name': 'gpt-4o-mini', 'type': 'chat', 'enabled': True},
                ],
            },
        ],
    }
    p.update(over)
    return p


def chat_with_capture(router, provider, options=None):
    """monkeypatch requests.post 捕获 URL，返回 (chat_result, url)；AppError 直接抛出"""
    captured = {}

    def fake_post(url, **kwargs):
        captured['url'] = url
        return FakeResp(200, {'choices': [{'message': {'content': 'hi'}}]})

    orig = unified_mod.requests.post
    unified_mod.requests.post = fake_post
    try:
        result = router.chat([{'role': 'user', 'content': 'hi'}], options)
        return result, captured.get('url')
    finally:
        unified_mod.requests.post = orig


def main():
    with tempfile.TemporaryDirectory() as tmp:
        prov_file = os.path.join(tmp, 'providers_data.json')

        # ═══════════ A. chat() URL 三态 ═══════════
        # A1: text_api_url 空 + api_url=媒体域 → 归一语言域
        write_file(prov_file, {'providers': [make_provider(api_url='https://api.ai-media.vip/v1')]})
        router = UnifiedAPIRouter(ProviderAPI(prov_file))
        _, url = chat_with_capture(router, make_provider(), {'model': 'provider_1:key_a:gpt-4o-mini'})
        check('A1 text空+api媒体域 → 语言域 chat URL',
              url == 'https://api.uselg.top/v1/chat/completions', f'got={url}')

        # A2: text_api_url=媒体域 → 归一语言域
        write_file(prov_file, {'providers': [make_provider(text_api_url='https://api.ai-media.vip/v1')]})
        router = UnifiedAPIRouter(ProviderAPI(prov_file))
        _, url = chat_with_capture(router, make_provider(), {'model': 'provider_1:key_a:gpt-4o-mini'})
        check('A2 text=媒体域 → 归一语言域',
              url == 'https://api.uselg.top/v1/chat/completions', f'got={url}')

        # A3: text_api_url=语言域 → 原样
        write_file(prov_file, {'providers': [make_provider(text_api_url='https://api.uselg.top/v1')]})
        router = UnifiedAPIRouter(ProviderAPI(prov_file))
        _, url = chat_with_capture(router, make_provider(), {'model': 'provider_1:key_a:gpt-4o-mini'})
        check('A3 text=语言域 → 原样',
              url == 'https://api.uselg.top/v1/chat/completions', f'got={url}')

        # A4: text_api_url 已带 /chat/completions 全路径 → 原样不重复拼接
        write_file(prov_file, {'providers': [make_provider(text_api_url='https://api.uselg.top/v1/chat/completions')]})
        router = UnifiedAPIRouter(ProviderAPI(prov_file))
        _, url = chat_with_capture(router, make_provider(), {'model': 'provider_1:key_a:gpt-4o-mini'})
        check('A4 text=全路径 chat/completions → 原样',
              url == 'https://api.uselg.top/v1/chat/completions', f'got={url}')

        # A5: text_api_url 裸语言域（无 /v1）→ 自动补 /v1/chat/completions
        write_file(prov_file, {'providers': [make_provider(text_api_url='https://api.uselg.top')]})
        router = UnifiedAPIRouter(ProviderAPI(prov_file))
        _, url = chat_with_capture(router, make_provider(), {'model': 'provider_1:key_a:gpt-4o-mini'})
        check('A5 text=裸域 → 补 /v1/chat/completions',
              url == 'https://api.uselg.top/v1/chat/completions', f'got={url}')

        # A6: text_api_url 尾斜杠 → rstrip('/') 后正常
        write_file(prov_file, {'providers': [make_provider(text_api_url='https://api.uselg.top/v1/')]})
        router = UnifiedAPIRouter(ProviderAPI(prov_file))
        _, url = chat_with_capture(router, make_provider(), {'model': 'provider_1:key_a:gpt-4o-mini'})
        check('A6 text=尾斜杠 → 归一',
              url == 'https://api.uselg.top/v1/chat/completions', f'got={url}')

        # ═══════════ B. 校验逻辑 ═══════════
        # B1: 只填 text_api_url（api_url 空）→ 对话放行
        write_file(prov_file, {'providers': [make_provider(api_url='', text_api_url='https://api.uselg.top/v1')]})
        router = UnifiedAPIRouter(ProviderAPI(prov_file))
        result, url = chat_with_capture(router, make_provider(), {'model': 'provider_1:key_a:gpt-4o-mini'})
        check('B1 只填 text_api_url → 放行且 URL 走 text',
              result.get('success') is True and url == 'https://api.uselg.top/v1/chat/completions',
              f'result={result} url={url}')

        # B2: 两个都空 → 报「尚未填写 API 地址或密钥」
        write_file(prov_file, {'providers': [make_provider(api_url='', text_api_url='')]})
        router = UnifiedAPIRouter(ProviderAPI(prov_file))
        try:
            chat_with_capture(router, make_provider(), {'model': 'provider_1:key_a:gpt-4o-mini'})
            check('B2 双空 URL → 拒绝', False, '未抛 AppError')
        except AppError as e:
            check('B2 双空 URL → 拒绝', '尚未填写 API 地址或密钥' in str(e), str(e))

        # B3: text_api_url 空白串（'   '）+ api_url 空 → 拒绝（空白视为空）
        write_file(prov_file, {'providers': [make_provider(api_url='', text_api_url='   ')]})
        router = UnifiedAPIRouter(ProviderAPI(prov_file))
        try:
            chat_with_capture(router, make_provider(), {'model': 'provider_1:key_a:gpt-4o-mini'})
            check('B3 空白 text_api_url → 拒绝', False, '未抛 AppError')
        except AppError as e:
            check('B3 空白 text_api_url → 拒绝', '尚未填写 API 地址或密钥' in str(e), str(e))

        # B4: 缺密钥 → 报错（改 keys[0].api_key 为空）
        no_key_provider = make_provider(text_api_url='https://api.uselg.top/v1')
        no_key_provider['keys'][0]['api_key'] = ''
        write_file(prov_file, {'providers': [no_key_provider]})
        router = UnifiedAPIRouter(ProviderAPI(prov_file))
        try:
            chat_with_capture(router, make_provider(), {'model': 'provider_1:key_a:gpt-4o-mini'})
            check('B4 缺密钥 → 拒绝', False, '未抛 AppError')
        except AppError as e:
            check('B4 缺密钥 → 拒绝', '尚未填写 API 地址或密钥' in str(e), str(e))

        # ═══════════ C. 图片链路不受影响 ═══════════
        # C1: text_api_url 设为语言域，api_url=媒体域 → generate_image 请求 URL 仍走媒体域
        write_file(prov_file, {
            'providers': [make_provider(text_api_url='https://api.uselg.top/v1')]
        })
        router = UnifiedAPIRouter(ProviderAPI(prov_file))
        captured = {}

        def fake_img_post(url, **kwargs):
            captured['url'] = url
            raise unified_mod.requests.exceptions.ConnectionError('fake network down')

        orig = unified_mod.requests.post
        unified_mod.requests.post = fake_img_post
        try:
            try:
                router.generate_image('a cat', {'model': 'provider_1:key_a:gemini-3-pro-image-preview'})
                check('C1 图片请求 URL 走 api_url', False, '未抛 UpstreamError（fake 网络未触发）')
            except UpstreamError:
                img_url = captured.get('url', '')
                check('C1 图片请求 URL 走 api_url（媒体域，非 text 语言域）',
                      'api.ai-media.vip' in img_url and 'api.uselg.top' not in img_url,
                      f'img_url={img_url}')
        finally:
            unified_mod.requests.post = orig

        # C2: 静态断言——video_api.py / image_api.py / main.py 无 text_api_url 引用
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        offenders = []
        for rel in ['backend/api/video_api.py', 'backend/api/image_api.py', 'main.py']:
            p = os.path.join(root, rel)
            with open(p, 'r', encoding='utf-8') as f:
                if 'text_api_url' in f.read():
                    offenders.append(rel)
        check('C2 图片/视频链路无 text_api_url 引用', not offenders,
              f'offenders={offenders}' if offenders else 'video_api/image_api/main 均无引用')

        # ═══════════ D. 旧数据兼容 ═══════════
        # D1: 无 text_api_url 字段的 provider 加载/对话正常（走 api_url）
        legacy = make_provider()  # 不含 text_api_url
        legacy.pop('text_api_url', None)
        write_file(prov_file, {'providers': [legacy]})
        router = UnifiedAPIRouter(ProviderAPI(prov_file))
        result, url = chat_with_capture(router, legacy, {'model': 'provider_1:key_a:gpt-4o-mini'})
        check('D1 无 text_api_url 旧数据对话正常', result.get('success') is True, f'url={url}')

        # D2: ProviderAPI save/load 回环保留 text_api_url（新字段不丢）
        api = ProviderAPI(prov_file)
        prov = make_provider(text_api_url='https://api.uselg.top/v1')
        write_file(prov_file, {'providers': [prov]})
        loaded = api.load_providers()['providers'][0]
        check('D2a 加载保留 text_api_url', loaded.get('text_api_url') == 'https://api.uselg.top/v1',
              f'got={loaded.get("text_api_url")!r}')
        api.update_provider('provider_1', {'text_api_url': 'https://api.uselg.top/v2'})
        loaded2 = api.load_providers()['providers'][0]
        check('D2b update_provider 写 text_api_url 落盘', loaded2.get('text_api_url') == 'https://api.uselg.top/v2',
              f'got={loaded2.get("text_api_url")!r}')
        # 空串保存不报错
        api.update_provider('provider_1', {'text_api_url': ''})
        loaded3 = api.load_providers()['providers'][0]
        check('D2c 空 text_api_url 保存不报错且保留空串', loaded3.get('text_api_url') == '',
              f'got={loaded3.get("text_api_url")!r}')

        # ═══════════ E. 风险探测：只填 text_api_url + 未显式指定模型 ═══════════
        write_file(prov_file, {'providers': [make_provider(api_url='', text_api_url='https://api.uselg.top/v1')]})
        router = UnifiedAPIRouter(ProviderAPI(prov_file))
        try:
            chat_with_capture(router, make_provider(), {})  # model=None → _first_available_model
            check('E1 只填 text_api_url + 未指定模型 → 可用', True, '（意外放行）')
        except AppError as e:
            check('E1 只填 text_api_url + 未指定模型 → 提示', '没有可用的对话模型' in str(e), str(e))

    total = len(RESULTS)
    ok = sum(1 for _, c, _ in RESULTS if c)
    print(f'\n════════ 汇总 ════════')
    print(f'通过 {ok} · 失败 {total - ok}')
    failed = [n for n, c, _ in RESULTS if not c]
    if failed:
        print('失败项：' + ', '.join(failed))
        sys.exit(1)


if __name__ == '__main__':
    main()
