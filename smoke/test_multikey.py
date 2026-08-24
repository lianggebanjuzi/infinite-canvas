# smoke/test_multikey.py
"""multi-key 后端冒烟测试（T01 归一化/CRUD + T02 三段/两段解析 + 按 key 出图参数断言）。

运行：C:\\Users\\17998\\AppData\\Local\\Programs\\Python\\Python312\\python.exe smoke\\test_multikey.py
覆盖：
  T01 读时归一化（旧 api_key/models → keys[0]）、写时剥离顶层冗余、add_provider 建空 key1、
      add_key/delete_key/update_key、update_provider 兼容 api_key→keys[0]、
      remove_model(provider_id, key_id, model_id)、add_chat_model key_id 缺省/旧签名
  T02 三段精确解析、key 删除/停用报错「模型所属 Key 已删除或停用，请重新选择模型」、
      两段回退（全部 enabled key 依次匹配）、回退第一个可用模型、停用 key 模型不可达、
      chat/drawing 同构、按 key 出图/对话的 Authorization 断言
"""
import json
import os
import shutil
import sys
import tempfile
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.api.provider_api import ProviderAPI
from backend.api.unified_api import UnifiedAPIRouter, ModelType
from backend.api.errors import AppError


RESULTS = []


def check(name, cond, detail=''):
    RESULTS.append((name, bool(cond), detail))
    print(('PASS' if cond else 'FAIL'), '-', name, ('| ' + detail if detail else ''))


def write_file(path, data):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=4)


def read_file(path):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


class _FakeResp:
    """模拟上游 HTTP 响应：Gemini 图片成功 / chat 成功"""
    def __init__(self, payload, status_code=200):
        self.payload = payload
        self.status_code = status_code
        self.url = 'https://api.ai-media.vip/v1beta/models/x:generateContent'

    def json(self):
        return self.payload

    @property
    def text(self):
        return json.dumps(self.payload)


def main():
    root = tempfile.mkdtemp(prefix='icv_multikey_')
    try:
        providers_file = os.path.join(root, 'providers_data.json')

        # ═════════════ T01 数据层 ═════════════

        # ── T01-1 读时归一化：旧结构（顶层 api_key/models）→ keys[0] ──
        legacy = {
            'providers': [{
                'id': 'provider_aaa',
                'name': 'FluxPort',
                'short_name': 'flux',
                'type': 'openai',
                'enabled': True,
                'api_key': 'sk-legacy',
                'api_url': 'https://api.ai-media.vip',
                'models': [{'id': 'gemini-3-pro-image-preview', 'name': 'Nano Banana Pro', 'type': 'drawing', 'enabled': True}],
                'use_proxy': True,
            }]
        }
        write_file(providers_file, legacy)
        pa = ProviderAPI(providers_file)
        data = pa.load_providers()
        p0 = data['providers'][0]
        check('旧结构 load 后生成 keys[0]', isinstance(p0.get('keys'), list) and len(p0['keys']) == 1, str(p0.get('keys')))
        k0 = p0['keys'][0]
        check('keys[0] 迁移 api_key', k0.get('api_key') == 'sk-legacy', str(k0.get('api_key')))
        check('keys[0] 迁移 models', len(k0.get('models', [])) == 1 and k0['models'][0]['id'] == 'gemini-3-pro-image-preview')
        check('keys[0] 补全 id/name/enabled', bool(k0.get('id')) and bool(k0.get('name')) and k0.get('enabled') is True)

        # ── T01-2 写时剥离顶层冗余字段（迁移后不保留 api_key/models） ──
        pa.save_providers({'providers': data['providers']})
        p_saved = read_file(providers_file)['providers'][0]
        check('save 后无顶层 api_key', 'api_key' not in p_saved, str(p_saved.keys()))
        check('save 后无顶层 models', 'models' not in p_saved, str(p_saved.keys()))
        check('save 后保留 keys', isinstance(p_saved.get('keys'), list) and len(p_saved['keys']) == 1)

        # ── T01-3 add_provider 自动创建空 key1 ──
        res_add = pa.add_provider('新供应商', 'openai', 'newp')
        check('add_provider 成功', res_add.get('status') == 'success', str(res_add))
        p_new = res_add['provider']
        check('add_provider 初始 keys=[空 key1]', len(p_new.get('keys', [])) == 1
              and p_new['keys'][0]['name'] == 'key1'
              and p_new['keys'][0]['api_key'] == ''
              and p_new['keys'][0]['models'] == [])

        # ── T01-4 add_key：key_${uuid} + 默认名 keyN（最小空号，删除后复用） ──
        rk1 = pa.add_key('provider_aaa')
        check('add_key 成功', rk1.get('status') == 'success', str(rk1))
        check('key id 为 key_ 前缀', (rk1.get('key_id') or '').startswith('key_'), rk1.get('key_id'))
        # 迁移 key 名为 short_name（flux），故最小空号是 key1
        check('默认名 keyN（最小空号 key1）', rk1.get('key', {}).get('name') == 'key1', str(rk1.get('key')))
        rk2 = pa.add_key('provider_aaa', '绘图A组')
        check('add_key 自定义名', rk2.get('key', {}).get('name') == '绘图A组', str(rk2.get('key')))
        # 删除 key1 后最小空号复用
        keys_now = pa.load_providers()['providers'][0]['keys']
        key_del = next(k for k in keys_now if k.get('name') == 'key1')
        pa.delete_key('provider_aaa', key_del['id'])
        rk3 = pa.add_key('provider_aaa')
        check('删除后复用最小空号 key1', rk3.get('key', {}).get('name') == 'key1', str(rk3.get('key')))

        # ── T01-5 delete_key / update_key ──
        keys_now = pa.load_providers()['providers'][0]['keys']
        key_a = next(k for k in keys_now if k.get('name') == '绘图A组')
        rd = pa.delete_key('provider_aaa', key_a['id'])
        check('delete_key 成功', rd.get('status') == 'success', str(rd))
        check('delete_key 后 keys 不含该 key', all(k.get('id') != key_a['id'] for k in rd.get('keys', [])), str(rd.get('keys')))
        key1 = next(k for k in rd.get('keys', []) if k.get('name') == 'key1')
        ru = pa.update_key('provider_aaa', key1['id'], {'name': '主Key', 'enabled': False, 'api_key': 'sk-new'})
        check('update_key 成功', ru.get('status') == 'success', str(ru))
        k_after = next(k for k in ru.get('keys', []) if k.get('id') == key1['id'])
        check('update_key 字段生效', k_after.get('name') == '主Key' and k_after.get('enabled') is False and k_after.get('api_key') == 'sk-new', str(k_after))
        check('delete_key 不存在报错', pa.delete_key('provider_aaa', 'key_NOPE').get('status') == 'error')

        # ── T01-6 update_provider 兼容 api_key → keys[0]（无顶层冗余） ──
        pa.update_key('provider_aaa', key1['id'], {'enabled': True, 'api_key': 'sk-old'})
        pa.update_provider('provider_aaa', {'api_key': 'sk-top'})
        p_after = pa.load_providers()['providers'][0]
        check('update_provider({api_key}) 落到 keys[0]', p_after['keys'][0]['api_key'] == 'sk-top', str(p_after['keys'][0]))

        # ── T01-7 remove_model(provider_id, key_id, model_id) 只删指定 key 的模型 ──
        pa.update_key('provider_aaa', key1['id'], {'models': [
            {'id': 'm-dup', 'name': 'M', 'type': 'drawing', 'enabled': True},
        ]})
        k_b = pa.add_key('provider_aaa', 'B组')['key']
        pa.update_key('provider_aaa', k_b['id'], {'models': [
            {'id': 'm-dup', 'name': 'M', 'type': 'drawing', 'enabled': True},
        ]})
        rr = pa.remove_model('provider_aaa', key1['id'], 'm-dup')
        check('remove_model 成功', rr.get('status') == 'success', str(rr))
        p_final = pa.load_providers()['providers'][0]
        k1_final = next(k for k in p_final['keys'] if k.get('id') == key1['id'])
        kb_final = next(k for k in p_final['keys'] if k.get('id') == k_b['id'])
        check('remove_model 只删指定 key 的模型', len(k1_final['models']) == 0 and len(kb_final['models']) == 1, str(p_final['keys']))
        check('remove_model key 不存在报错', pa.remove_model('provider_aaa', 'key_NOPE', 'm-dup').get('status') == 'error')

        # ── T01-8 add_chat_model：key_id 缺省 → keys[0]；旧签名位置兼容 ──
        rac = pa.add_chat_model('provider_aaa', None, 'gpt-4o', 'GPT-4o')
        check('add_chat_model key_id=None 落到 keys[0]', rac.get('status') == 'success', str(rac))
        k0_chat = pa.load_providers()['providers'][0]['keys'][0]
        check('chat 模型加在 keys[0]', any(m['id'] == 'gpt-4o' for m in k0_chat['models']), str(k0_chat['models']))
        rac2 = pa.add_chat_model('provider_aaa', 'claude-3-5-sonnet', 'Claude 3.5')  # 旧签名 add_chat_model(pid, model_id, model_name)
        check('add_chat_model 旧签名兼容', rac2.get('status') == 'success', str(rac2))
        rac3 = pa.add_chat_model('provider_aaa', k_b['id'], 'claude-3-5-sonnet', 'Claude 3.5')
        check('add_chat_model 指定 key', rac3.get('status') == 'success', str(rac3))
        kb_models = next(k for k in pa.load_providers()['providers'][0]['keys'] if k.get('id') == k_b['id'])['models']
        check('add_chat_model 指定 key 落点正确', any(m['id'] == 'claude-3-5-sonnet' for m in kb_models), str(kb_models))

        # ═════════════ T02 后端解析 + 按 key 出图 ═════════════

        # 准备干净数据：provider_bbb 两个 enabled key（同名绘图模型 X）+ 一个停用 key
        providers_new = {
            'providers': [
                {
                    'id': 'provider_bbb', 'name': 'Flux', 'short_name': 'flux',
                    'type': 'openai', 'enabled': True, 'api_url': 'https://api.ai-media.vip',
                    'use_proxy': True,
                    'keys': [
                        {'id': 'key_A', 'name': '绘图A组', 'api_key': 'sk-A', 'enabled': True,
                         'models': [
                             {'id': 'gemini-3-pro-image-preview', 'name': 'Nano Banana Pro', 'type': 'drawing', 'enabled': True},
                             {'id': 'gpt-4o', 'name': 'GPT-4o', 'type': 'chat', 'enabled': True},
                         ]},
                        {'id': 'key_B', 'name': '绘图B组', 'api_key': 'sk-B', 'enabled': True,
                         'models': [
                             {'id': 'gemini-3-pro-image-preview', 'name': 'Nano Banana Pro', 'type': 'drawing', 'enabled': True},
                         ]},
                        {'id': 'key_OFF', 'name': '停用组', 'api_key': 'sk-OFF', 'enabled': False,
                         'models': [
                             {'id': 'gemini-3.1-flash-image-preview', 'name': 'Nano Banana 2', 'type': 'drawing', 'enabled': True},
                         ]},
                    ],
                },
            ]
        }
        write_file(providers_file, providers_new)
        ua = UnifiedAPIRouter(ProviderAPI(providers_file))

        # ── 类型隔离：图像请求不得回退到同一账户的对话通用 Key ──
        isolated_provider = {
            'api_url': 'https://api.example.com/v1',
            'global_keys': {'chat': 'sk-chat-only', 'drawing': '', 'video': ''},
        }
        isolated_key = {
            'api_key': 'sk-chat-only',
            'channels': {'drawing': {'enabled': True, 'api_key': ''}},
            'models': [{'id': 'gpt-image-2', 'type': 'drawing', 'enabled': True}],
        }
        isolated = ua._get_connection(isolated_provider, isolated_key, ModelType.DRAWING, 'gpt-image-2')
        check('图像模型不回退到对话通用 Key', isolated is None, str(isolated))
        isolated_provider['global_keys']['drawing'] = 'sk-drawing-global'
        isolated = ua._get_connection(isolated_provider, isolated_key, ModelType.DRAWING, 'gpt-image-2')
        check('图像模型使用图像全局 Key', isolated and isolated.get('api_key') == 'sk-drawing-global', str(isolated))
        isolated_key['models'][0]['api_key'] = 'sk-drawing-dedicated'
        isolated = ua._get_connection(isolated_provider, isolated_key, ModelType.DRAWING, 'gpt-image-2')
        check('图像专用 Key 优先于图像全局 Key', isolated and isolated.get('api_key') == 'sk-drawing-dedicated', str(isolated))

        # ── 三段精确：返回 (provider, key, entry) 且 key 正确 ──
        provider, key, entry = ua._resolve_drawing_model('provider_bbb:key_A:gemini-3-pro-image-preview')
        check('三段精确：provider 命中', provider and provider['id'] == 'provider_bbb', str(provider))
        check('三段精确：key 命中 key_A', key and key['id'] == 'key_A', str(key and key['id']))
        check('三段精确：entry 命中', entry and entry.id == 'gemini-3-pro-image-preview', str(entry))

        # ── 三段 key 删除/停用 → AppError「模型所属 Key 已删除或停用，请重新选择模型」 ──
        try:
            ua._resolve_drawing_model('provider_bbb:key_NOPE:gemini-3-pro-image-preview')
            check('三段 key 不存在 → 抛错', False, '未抛错')
        except AppError as e:
            check('三段 key 不存在 → 抛错文案', 'Key 已删除或停用' in str(e), str(e))
        try:
            ua._resolve_drawing_model('provider_bbb:key_OFF:gemini-3.1-flash-image-preview')
            check('三段 key 停用 → 抛错', False, '未抛错')
        except AppError as e:
            check('三段 key 停用 → 抛错文案', 'Key 已删除或停用' in str(e), str(e))

        # ── 两段回退：provider 全部 enabled key 依次匹配同名模型（放宽非只第一个） ──
        provider, key, entry = ua._resolve_drawing_model('provider_bbb:gemini-3-pro-image-preview')
        check('两段回退：provider 命中', provider and provider['id'] == 'provider_bbb', str(provider))
        check('两段回退：命中第一个 enabled key（key_A）', key and key['id'] == 'key_A', str(key and key['id']))

        # ── 两段未命中 → 回退全量第一个可用模型 ──
        provider, key, entry = ua._resolve_drawing_model('provider_bbb:no-such-model')
        check('两段未命中 → 回退第一个可用模型', provider and key and entry and entry.id == 'gemini-3-pro-image-preview', str(entry and entry.id))

        # ── 空/None → 第一个可用模型 ──
        provider, key, entry = ua._resolve_drawing_model(None)
        check('空 id → 第一个可用模型（key_A）', provider and key and key['id'] == 'key_A', str(key and key['id']))

        # ── 停用 key 的模型不进两段回退/回退池 ──
        provider, key, entry = ua._resolve_drawing_model('provider_bbb:gemini-3.1-flash-image-preview')
        check('停用 key 模型不可达（不命中 key_OFF）', key is None or key.get('id') != 'key_OFF', str(key and key.get('id')))

        # ── chat 与 drawing 同构 ──
        provider, key, entry = ua._resolve_chat_model('provider_bbb:key_A:gpt-4o')
        check('chat 三段精确', provider and key and key['id'] == 'key_A' and entry and entry.id == 'gpt-4o', str(entry))
        provider, key, entry = ua._resolve_chat_model('provider_bbb:gpt-4o')
        check('chat 两段回退命中 key_A', key and key['id'] == 'key_A', str(key and key['id']))

        # ── 按 key 出图：generate_image 用 key['api_key'] 调上游 ──
        captured = {}
        def fake_image_post(url, headers=None, json=None, timeout=None, proxies=None, **kw):
            captured['url'] = url
            captured['auth'] = (headers or {}).get('Authorization')
            captured['payload_model'] = (json or {}).get('model') if isinstance(json, dict) else None
            return _FakeResp({'candidates': [{'content': {'parts': [{'inlineData': {'mimeType': 'image/png', 'data': 'iVBORw0KGgo='}}]}}]})

        with mock.patch('backend.api.unified_api.requests.post', side_effect=fake_image_post):
            res = ua.generate_image('一只猫', {'model': 'provider_bbb:key_B:gemini-3-pro-image-preview', 'resolution': '1k', 'aspectRatio': '1:1'})
            check('generate_image 三段 key_B 成功', res.get('success') is True, str(res))
            check('出图 Authorization = Bearer sk-B（按 key_B 路由）', captured.get('auth') == 'Bearer sk-B', str(captured.get('auth')))

        with mock.patch('backend.api.unified_api.requests.post', side_effect=fake_image_post):
            res2 = ua.generate_image('一只猫', {'model': 'provider_bbb:key_A:gemini-3-pro-image-preview', 'resolution': '1k', 'aspectRatio': '1:1'})
            check('generate_image 三段 key_A 成功', res2.get('success') is True, str(res2))
            check('出图 Authorization = Bearer sk-A（按 key_A 路由）', captured.get('auth') == 'Bearer sk-A', str(captured.get('auth')))

        # 两段旧 id 出图 → 落到第一个 enabled key（key_A）
        with mock.patch('backend.api.unified_api.requests.post', side_effect=fake_image_post):
            res3 = ua.generate_image('一只猫', {'model': 'provider_bbb:gemini-3-pro-image-preview', 'resolution': '1k', 'aspectRatio': '1:1'})
            check('两段旧 id 出图成功', res3.get('success') is True, str(res3))
            check('两段旧 id → Authorization = Bearer sk-A', captured.get('auth') == 'Bearer sk-A', str(captured.get('auth')))

        # ── chat 按 key 路由：chat() 用 key.api_key ──
        def fake_chat_post(url, headers=None, json=None, timeout=None, proxies=None, **kw):
            captured['auth'] = (headers or {}).get('Authorization')
            captured['payload_model'] = (json or {}).get('model') if isinstance(json, dict) else None
            return _FakeResp({'choices': [{'message': {'content': '你好'}}]})

        with mock.patch('backend.api.unified_api.requests.post', side_effect=fake_chat_post):
            rchat = ua.chat([{'role': 'user', 'content': '你好'}], {'model': 'provider_bbb:key_A:gpt-4o'})
            check('chat 成功', rchat.get('success') is True, str(rchat))
            check('chat Authorization = Bearer sk-A（按 key_A 路由）', captured.get('auth') == 'Bearer sk-A', str(captured.get('auth')))
            check('chat payload model = gpt-4o', captured.get('payload_model') == 'gpt-4o', str(captured.get('payload_model')))

        # ═════════════ T04 回归：label 简化 / 重名去重数据前提 + 后端 keys[] 零改动 ═════════════

        # 前端 fetchImageModels 按 `${p.id}:${m.id}` 去重、label 去 key 名 —— 后端只负责提供 keys[] 结构。
        # 此处断言：① 同名绘图模型存在于多个 enabled key（去重有真实场景）；② keys[] 结构与三段解析零改动。
        providers_t04 = pa.load_providers()['providers']
        p_bbb = next(p for p in providers_t04 if p['id'] == 'provider_bbb')
        dup_keys = [
            k for k in p_bbb.get('keys', [])
            if k.get('enabled') is not False
            and any(m.get('id') == 'gemini-3-pro-image-preview' for m in k.get('models', []))
        ]
        check('T04 去重前提：同名绘图模型存在于多个 enabled key（跨 key 重名）', len(dup_keys) >= 2,
              str([k.get('id') for k in dup_keys]))
        check('T04 keys[] 结构零改动（load_providers 仍为 keys 数组，每 key 含 api_key/models）',
              all(isinstance(k, dict) and 'api_key' in k and isinstance(k.get('models'), list)
                  for p in providers_t04 for k in p.get('keys', [])),
              str([k.get('id') for p in providers_t04 for k in p.get('keys', [])]))
        check('T04 三段解析零改动（provider:key:model 精确命中）',
              bool(ua._resolve_drawing_model('provider_bbb:key_A:gemini-3-pro-image-preview')[2]),
              str(ua._resolve_drawing_model('provider_bbb:key_A:gemini-3-pro-image-preview')[2]))
        check('T04 前端去重键 = ${p.id}:${m.id}（同 provider 同名模型共享键）',
              'provider_bbb:gemini-3-pro-image-preview' == f"{p_bbb['id']}:gemini-3-pro-image-preview",
              f"{p_bbb['id']}:gemini-3-pro-image-preview")

        failed = [r for r in RESULTS if not r[1]]
        print(f'\n总计 {len(RESULTS)} 项，失败 {len(failed)} 项')
        return 1 if failed else 0
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
