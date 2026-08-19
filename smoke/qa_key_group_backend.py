# smoke/qa_key_group_backend.py
"""QA 独立验证：供应商级模型组改造（commit 4fd152b）后端路由不受影响。

前端把同一供应商的模型组复制到全部 enabled key 的 models[]（禁用 key 保留旧 models），
数据模型不变、unified_api.py 零改动。本测试用「共享模型组数据排布」的临时 providers 文件
验证后端三段/两段解析路由行为与改造前一致，且绝不触碰真实 providers_data.json（只用 tempfile）。

运行：python smoke/qa_key_group_backend.py
覆盖：
  B1 三段 id 精确命中指定 key（同名模型分属多 key，各自路由正确）
  B2 三段 id 命中 disabled key → AppError「模型所属 Key 已删除或停用」
  B3 三段 id 模型不存在/已停用 → AppError
  B4 两段 id 回退遍历全部 enabled key 匹配同名模型（跳过 disabled key）
  B5 两段 id 命中 disabled key 中的模型 → 不可达（回退失败 → 第一个可用模型 / AppError）
  B6 chat / drawing 同构（_resolve_chat_model / _resolve_drawing_model）
  B7 未知 provider / 未知模型 → 回退第一个可用模型（不抛错）
"""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.api.provider_api import ProviderAPI
from backend.api.unified_api import UnifiedAPIRouter
from backend.api.errors import AppError

RESULTS = []


def check(name, cond, detail=''):
    RESULTS.append((name, bool(cond), detail))
    print(('PASS' if cond else 'FAIL'), '-', name, ('| ' + detail if detail else ''))


def write_file(path, data):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=4)


def shared_provider():
    """共享模型组数据排布：3 个 key 持有一份相同的模型组（模拟前端同步后的结果）"""
    return {
        'id': 'provider_1',
        'name': 'Test',
        'short_name': 'T',
        'type': 'openai',
        'enabled': True,
        'api_url': 'https://api.example.com/v1',
        'use_proxy': True,
        'keys': [
            {
                'id': 'key_a', 'name': 'A', 'api_key': 'sk-a', 'enabled': True,
                'models': [
                    {'id': 'gemini-3-pro-image-preview', 'name': 'Nano Banana Pro', 'type': 'drawing', 'enabled': True},
                    {'id': 'gpt-4o-mini', 'name': 'gpt-4o-mini', 'type': 'chat', 'enabled': True},
                ],
            },
            {
                'id': 'key_b', 'name': 'B', 'api_key': 'sk-b', 'enabled': True,
                'models': [
                    {'id': 'gemini-3-pro-image-preview', 'name': 'Nano Banana Pro', 'type': 'drawing', 'enabled': True},
                    {'id': 'gpt-4o-mini', 'name': 'gpt-4o-mini', 'type': 'chat', 'enabled': True},
                ],
            },
            {
                'id': 'key_c', 'name': 'C', 'api_key': 'sk-c', 'enabled': False,
                'models': [
                    {'id': 'gemini-3-pro-image-preview', 'name': 'Nano Banana Pro', 'type': 'drawing', 'enabled': True},
                    {'id': 'gpt-4o-mini', 'name': 'gpt-4o-mini', 'type': 'chat', 'enabled': True},
                ],
            },
        ],
    }


def main():
    with tempfile.TemporaryDirectory() as tmp:
        prov_file = os.path.join(tmp, 'providers_data.json')
        write_file(prov_file, {'providers': [shared_provider()]})

        router = UnifiedAPIRouter(ProviderAPI(prov_file))

        # B1 三段精确命中（chat 与 drawing）
        p, k, me = router._resolve_chat_model('provider_1:key_a:gpt-4o-mini')
        check('B1a 三段 chat 精确命中 key_a', p['id'] == 'provider_1' and k['id'] == 'key_a' and me.id == 'gpt-4o-mini',
              f'key={k and k["id"]} model={me and me.id}')
        p, k, me = router._resolve_chat_model('provider_1:key_b:gpt-4o-mini')
        check('B1b 三段 chat 精确命中 key_b', p['id'] == 'provider_1' and k['id'] == 'key_b' and me.id == 'gpt-4o-mini',
              f'key={k and k["id"]} model={me and me.id}')
        p, k, me = router._resolve_drawing_model('provider_1:key_a:gemini-3-pro-image-preview')
        check('B1c 三段 drawing 精确命中 key_a', k and k['id'] == 'key_a' and me.id == 'gemini-3-pro-image-preview',
              f'key={k and k["id"]} model={me and me.id}')

        # B2 三段命中 disabled key → AppError
        try:
            router._resolve_chat_model('provider_1:key_c:gpt-4o-mini')
            check('B2 disabled key 三段命中被拒绝', False, '未抛 AppError')
        except AppError as e:
            check('B2 disabled key 三段命中被拒绝', 'Key 已删除或停用' in str(e), str(e))

        # B3 三段命中不存在模型 → AppError
        try:
            router._resolve_drawing_model('provider_1:key_a:nonexistent-model')
            check('B3 三段未知模型被拒绝', False, '未抛 AppError')
        except AppError as e:
            check('B3 三段未知模型被拒绝', 'Key 已删除或停用' in str(e), str(e))

        # B4 两段回退遍历全部 enabled key
        p, k, me = router._resolve_chat_model('provider_1:gpt-4o-mini')
        check('B4a 两段 chat 回退命中 enabled key', k and k['enabled'] is not False and me.id == 'gpt-4o-mini',
              f'key={k and k["id"]} model={me and me.id}')
        p, k, me = router._resolve_drawing_model('provider_1:gemini-3-pro-image-preview')
        check('B4b 两段 drawing 回退命中 enabled key', k and k['enabled'] is not False and me.id == 'gemini-3-pro-image-preview',
              f'key={k and k["id"]} model={me and me.id}')

        # B5 两段回退跳过 disabled key：key_c 的模型名在 enabled key 中不存在 → 回退第一个可用模型
        only_c_provider = {
            'id': 'provider_2', 'name': 'OnlyC', 'short_name': 'OC', 'type': 'openai', 'enabled': True,
            'api_url': 'https://c.example.com/v1', 'use_proxy': True,
            'keys': [
                {'id': 'key_c', 'name': 'C', 'api_key': 'sk-c', 'enabled': False,
                 'models': [{'id': 'only-in-c', 'name': 'only-in-c', 'type': 'drawing', 'enabled': True}]},
            ],
        }
        write_file(prov_file, {'providers': [shared_provider(), only_c_provider]})
        router._providers_cache = []  # 强制重载
        p, k, me = router._resolve_drawing_model('provider_2:only-in-c')
        check('B5 disabled key 中模型经两段回退不可达', k is None or k['enabled'] is not False,
              f'key={k and k["id"]} model={me and me.id}')

        # B6 未知 provider / 未知模型 → 回退第一个可用模型（不抛错）
        p, k, me = router._resolve_drawing_model('provider_999:nonexistent')
        check('B6 未知 provider 回退不抛错', me is not None, f'model={me and me.id}')
        p, k, me = router._resolve_drawing_model('provider_1:nonexistent')
        check('B6b 未知模型两段回退不抛错', me is not None, f'model={me and me.id}')

        # B7 未指定模型 → 第一个可用模型
        p, k, me = router._resolve_drawing_model(None)
        check('B7 未指定模型回退第一个可用 drawing', me is not None, f'model={me and me.id}')

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
