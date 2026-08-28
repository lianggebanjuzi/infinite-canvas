# smoke/test_incremental3.py
"""incremental-3 后端冒烟测试（T01：资产索引落点/降级/迁移 + 设置路径校验 + 生成落盘 saved_to_disk）。

运行：.venv\\Scripts\\python.exe smoke\\test_incremental3.py
覆盖（对应 AC-3/AC-4 后端侧）：
  1. 未配置图片保存路径 → _assets_path 降级 fallback_dir/assets.json，永不返回 None；
     save_assets 返回 {success, degraded:true, message 人话}，文件已落盘（A1/A2）
  2. 配置后 → 落点 <image_save_path>/assets.json，save_assets 不降级（A1/A3）
  3. load_assets 读盘顺序（图片目录 → fallback）+ 旧位置 <项目名>.assets.json 迁移合并
     （主索引优先、按 key 去重、写回主索引、删旧文件）（A4）
  4. save_settings 路径 strip+abspath 归一（P6）、非目录报错（P4）、空路径允许（未配置）
  5. unified _get_save_dir 配置/未配置 + _save_images_to_local 返回 saved_to_disk（P2/P3 后端）
"""
import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.api.project_api import ProjectAPI
from backend.api.settings_api import SettingsAPI
from backend.api.unified_api import UnifiedAPIRouter


class _FakeProvider:
    """UnifiedAPIRouter 只在本测试中用到 _get_save_dir/_save_images_to_local，provider 可为空壳"""


RESULTS = []


def check(name, cond, detail=''):
    RESULTS.append((name, bool(cond), detail))
    print(('PASS' if cond else 'FAIL'), '-', name, ('| ' + detail if detail else ''))


def main():
    root = tempfile.mkdtemp(prefix='icv_smoke3_')
    try:
        settings_file = os.path.join(root, 'settings.json')
        prompts_file = os.path.join(root, 'prompts_library.json')
        settings_api = SettingsAPI(settings_file, prompts_file)
        fallback = os.path.join(root, 'appdata')
        os.makedirs(fallback, exist_ok=True)
        pa = ProjectAPI(settings_api=settings_api, fallback_dir=fallback)

        # ── 1. 未配置：落点 = fallback_dir/assets.json；save 降级 degraded=true ──
        ap = pa._assets_path()
        check('未配置路径时 _assets_path 永不 None 且 = fallback/assets.json',
              ap == os.path.join(fallback, 'assets.json'), ap)
        res = pa.save_assets([{'key': 'abc', 'adopted': True, 'locked': True}])
        check('未配置路径 save_assets 返回 success+degraded+人话 message',
              res.get('status') == 'success' and res.get('degraded') is True
              and '配置图片保存路径' in (res.get('message') or ''),
              str(res))
        check('降级文件已落盘且 version=2', os.path.exists(ap)
              and json.load(open(ap, encoding='utf-8')).get('version') == 2)

        # ── 2. 配置后：落点 = <image_save_path>/assets.json；save 不降级 ──
        save_dir = os.path.join(root, 'imgout')
        r_set = settings_api.save_settings({'image_save_path': save_dir})
        check('save_settings 成功（自动创建目录）', r_set.get('status') == 'success', str(r_set))
        ap2 = pa._assets_path()
        check('配置后 _assets_path = <save_dir>/assets.json',
              ap2 == os.path.join(save_dir, 'assets.json'), ap2)
        res2 = pa.save_assets([{'key': 'def', 'adopted': True}])
        check('配置后 save_assets 不降级', res2.get('status') == 'success' and not res2.get('degraded'), str(res2))
        check('配置后文件落在 save_dir', os.path.exists(os.path.join(save_dir, 'assets.json')))

        # ── 3. 读盘顺序 + 旧项目迁移（A4） ──
        proj_dir = os.path.join(root, 'project')
        os.makedirs(proj_dir, exist_ok=True)
        proj_path = os.path.join(proj_dir, '花园.icproj')
        pa.current_project_path = proj_path
        legacy = os.path.join(proj_dir, '花园.assets.json')
        json.dump({'version': 2, 'records': [{'key': 'key1', 'adopted': True, 'nodeId': 'main'}]},
                  open(ap2, 'w', encoding='utf-8'))
        json.dump({'records': [
            {'key': 'key1', 'adopted': False, 'nodeId': 'legacy'},
            {'key': 'key2', 'adopted': True, 'nodeId': 'legacy2'},
        ]}, open(legacy, 'w', encoding='utf-8'))
        ld = pa.load_assets()
        keys = {r['key'] for r in ld.get('records', [])}
        check('迁移合并含 key1+key2', ld.get('status') == 'success' and keys == {'key1', 'key2'}, str(keys))
        by = {r['key']: r for r in ld.get('records', [])}
        check('主索引优先（key1 保留主索引记录）', by.get('key1', {}).get('nodeId') == 'main', str(by.get('key1')))
        check('合并后旧文件已删除', not os.path.exists(legacy))
        merged = json.load(open(ap2, encoding='utf-8'))
        check('合并结果写回主索引', {r['key'] for r in merged['records']} == {'key1', 'key2'})

        # 主索引缺失 → 读 fallback（读盘顺序回退 + 收敛写回主索引 + 删 fallback 文件）
        os.remove(ap2)
        json.dump({'version': 2, 'records': [{'key': 'fb', 'adopted': True}]},
                  open(os.path.join(fallback, 'assets.json'), 'w', encoding='utf-8'))
        ld2 = pa.load_assets()
        check('读盘顺序回退 fallback', ld2.get('records', [])[0]['key'] == 'fb', str(ld2))
        check('回退读取后写回主索引', os.path.exists(ap2)
              and json.load(open(ap2, encoding='utf-8'))['records'][0]['key'] == 'fb')
        check('回退读取后删除 fallback 文件', not os.path.exists(os.path.join(fallback, 'assets.json')))

        # ── 4. save_settings 路径归一 + 校验（P4/P6） ──
        r1 = settings_api.save_settings({'image_save_path': '  ' + save_dir + '  '})
        check('路径 strip + abspath 归一',
              r1.get('status') == 'success'
              and settings_api.load_settings().get('image_save_path') == os.path.abspath(save_dir))
        bad_file = os.path.join(root, 'not_a_dir.txt')
        with open(bad_file, 'w', encoding='utf-8') as f:
            f.write('x')
        r2 = settings_api.save_settings({'image_save_path': bad_file})
        check('非目录报错人话', r2.get('status') == 'error' and '目录' in (r2.get('message') or ''), str(r2))
        r3 = settings_api.save_settings({'image_save_path': ''})
        check('空路径允许（= 未配置）', r3.get('status') == 'success'
              and settings_api.load_settings().get('image_save_path') == '')

        # ── 5. unified _get_save_dir + saved_to_disk（P2/P3 后端） ──
        ua = UnifiedAPIRouter(_FakeProvider(), settings_api=settings_api)
        d1 = ua._get_save_dir()
        check('未配置 _get_save_dir = tempdir', d1 == tempfile.gettempdir(), d1)
        settings_api.save_settings({'image_save_path': save_dir})
        d2 = ua._get_save_dir()
        check('配置后 _get_save_dir = save_dir', d2 == os.path.abspath(save_dir), d2)
        out1 = ua._save_images_to_local({'success': True, 'image_url': 'data:image/png;base64,iVBORw0KGgo='})
        check('配置后 saved_to_disk=True', out1.get('saved_to_disk') is True, str(out1.get('saved_to_disk')))
        settings_api.save_settings({'image_save_path': ''})
        out2 = ua._save_images_to_local({'success': True, 'image_url': 'data:image/png;base64,iVBORw0KGgo='})
        check('未配置 saved_to_disk=False', out2.get('saved_to_disk') is False, str(out2.get('saved_to_disk')))

        failed = [r for r in RESULTS if not r[1]]
        print(f'\n总计 {len(RESULTS)} 项，失败 {len(failed)} 项')
        return 1 if failed else 0
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
