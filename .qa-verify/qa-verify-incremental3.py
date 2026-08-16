# .qa-verify/qa-verify-incremental3.py
"""QA 独立验证（fresh eyes）：incremental-3 T01 后端（AC-3/AC-4 后端侧）。

与工程师自测 smoke/test_incremental3.py 独立编写，覆盖更多边界：
  - AC-3：落点解耦/降级/读盘顺序/旧位置迁移/「配置后收敛」/v1 旧格式/损坏文件/重复 key/legacy==main 守卫
  - AC-4：settings_api strip+abspath 归一/自动建目录/非目录报错/写探针/空串允许/其它字段保留
        + unified _get_save_dir 三级优先级 + _save_images_to_local saved_to_disk 标记 + 实际落盘位置

运行：.venv\\Scripts\\python.exe .qa-verify\\qa-verify-incremental3.py
"""
import json
import os
import shutil
import stat
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.api.project_api import ProjectAPI
from backend.api.settings_api import SettingsAPI
from backend.api.unified_api import UnifiedAPIRouter

RESULTS = []


def check(name, cond, detail=''):
    RESULTS.append((name, bool(cond), detail))
    print(('PASS' if cond else 'FAIL'), '-', name, ('| ' + detail if detail else ''))


class _FakeProvider:
    pass


def make_env():
    root = tempfile.mkdtemp(prefix='icv_qa3_')
    settings_file = os.path.join(root, 'settings.json')
    prompts_file = os.path.join(root, 'prompts_library.json')
    sa = SettingsAPI(settings_file, prompts_file)
    fallback = os.path.join(root, 'appdata')
    os.makedirs(fallback, exist_ok=True)
    pa = ProjectAPI(settings_api=sa, fallback_dir=fallback)
    return root, sa, fallback, pa


def main():
    root, sa, fallback, pa = make_env()
    try:
        # ══════════════ AC-3 · 资产索引落点解耦 ══════════════
        # 1) 未配置：永不 None、降级 degraded、人话 message、文件落 fallback
        ap = pa._assets_path()
        check('AC3-1 未配置 _assets_path = fallback/assets.json 且非 None', ap == os.path.join(fallback, 'assets.json'), ap)
        r = pa.save_assets([{'key': 'k1', 'adopted': True, 'locked': True}])
        check('AC3-2 未配置 save_assets success+degraded+人话', r.get('status') == 'success' and r.get('degraded') is True
              and '请先在设置中配置图片保存路径' in (r.get('message') or ''), str(r))
        check('AC3-3 降级文件已落盘 version=2', os.path.exists(ap)
              and json.load(open(ap, encoding='utf-8')).get('version') == 2)
        # 不存在任何 no_path 字样
        check('AC3-4 响应不含 no_path 开发话术', 'no_path' not in json.dumps(r, ensure_ascii=False))

        # 2) settings_api=None 时（未注入）同样降级可写（A2 兜底）
        pa2 = ProjectAPI(settings_api=None, fallback_dir=fallback)
        r2 = pa2.save_assets([{'key': 'k2'}])
        check('AC3-5 settings_api=None 时 save 仍 success+degraded', r2.get('status') == 'success' and r2.get('degraded') is True, str(r2))
        # 3) fallback_dir=None 时兜底 expanduser('~')
        pa3 = ProjectAPI(settings_api=None, fallback_dir=None)
        check('AC3-6 fallback_dir=None → expanduser("~")/assets.json', pa3._assets_path() == os.path.join(os.path.expanduser('~'), 'assets.json'), pa3._assets_path())

        # 4) 配置后：落点切到图片保存目录、不降级、文件落在 save_dir
        save_dir = os.path.join(root, 'imgout')
        r_set = sa.save_settings({'image_save_path': save_dir})
        check('AC3-7 save_settings 自动创建目录', r_set.get('status') == 'success', str(r_set))
        ap2 = pa._assets_path()
        check('AC3-8 配置后 _assets_path = <save_dir>/assets.json', ap2 == os.path.join(save_dir, 'assets.json'), ap2)
        r3 = pa.save_assets([{'key': 'k3', 'adopted': True}])
        check('AC3-9 配置后 save 不降级', r3.get('status') == 'success' and not r3.get('degraded'), str(r3))
        check('AC3-10 配置后文件落在 save_dir', os.path.exists(os.path.join(save_dir, 'assets.json')))

        # 5) 读盘顺序：图片目录 → fallback；都不存在 → empty
        ld = pa.load_assets()
        check('AC3-11 主索引存在直接读主索引', ld.get('status') == 'success'
              and {x['key'] for x in ld.get('records', [])} == {'k3'}, str(ld))

        # 6) 配置后「APP_DIR 有降级期文件」收敛：主索引缺失 + fallback 有 → 读 fallback、写回主索引、删 fallback
        os.remove(ap2)
        json.dump({'version': 2, 'records': [{'key': 'fb1', 'adopted': True}]},
                  open(os.path.join(fallback, 'assets.json'), 'w', encoding='utf-8'))
        ld2 = pa.load_assets()
        check('AC3-12 主索引缺失回退读 fallback', ld2.get('status') == 'success'
              and {x['key'] for x in ld2.get('records', [])} == {'fb1'}, str(ld2))
        check('AC3-13 回退读后写回主索引', os.path.exists(ap2)
              and json.load(open(ap2, encoding='utf-8'))['records'][0]['key'] == 'fb1')
        check('AC3-14 回退读后删除 fallback 文件', not os.path.exists(os.path.join(fallback, 'assets.json')))

        # 7) 旧位置迁移（A4）：主索引优先、按 key 去重、写回主索引、删旧文件
        proj_dir = os.path.join(root, 'project')
        os.makedirs(proj_dir, exist_ok=True)
        proj_path = os.path.join(proj_dir, '花园.icproj')
        pa.current_project_path = proj_path
        legacy = os.path.join(proj_dir, '花园.assets.json')
        # 主索引两条（含 v2 新字段 imageUrl/projectName）
        json.dump({'version': 2, 'records': [
            {'key': 'keyA', 'adopted': True, 'nodeId': 'main', 'imageUrl': 'data:image/png;base64,AAA',
             'projectName': ['项目甲'], 'locked': True, 'tags': [], 'category': '成图', 'updatedAt': 1},
            {'key': 'keyB', 'adopted': True, 'nodeId': 'mainB', 'imageUrl': 'data:image/png;base64,BBB',
             'projectName': [], 'locked': False, 'tags': [], 'category': '成图', 'updatedAt': 2},
        ]}, open(ap2, 'w', encoding='utf-8'))
        # 旧文件 v1 顶层数组格式 + 旧记录缺 imageUrl/projectName（incremental-2 兼容）
        json.dump([
            {'key': 'keyA', 'adopted': False, 'nodeId': 'legacyA'},
            {'key': 'keyC', 'adopted': True, 'nodeId': 'legacyC', 'tags': ['花']},
            {'key': 'keyC', 'adopted': True, 'nodeId': 'legacyC2'},
        ], open(legacy, 'w', encoding='utf-8'))
        ld3 = pa.load_assets()
        recs = {x['key']: x for x in ld3.get('records', [])}
        check('AC3-15 迁移合并 keyA+keyB+keyC', ld3.get('status') == 'success' and set(recs) == {'keyA', 'keyB', 'keyC'}, str(set(recs)))
        check('AC3-16 主索引优先（keyA 保留主记录 nodeId=main）', recs.get('keyA', {}).get('nodeId') == 'main')
        check('AC3-17 旧 v1 记录合并后仍含旧字段（keyC 的 tags 保留）', recs.get('keyC', {}).get('tags') == ['花'], str(recs.get('keyC')))
        check('AC3-18 旧文件已删除', not os.path.exists(legacy))
        check('AC3-19 合并结果写回主索引(version=2)', json.load(open(ap2, encoding='utf-8')).get('version') == 2
              and {x['key'] for x in json.load(open(ap2, encoding='utf-8'))['records']} == {'keyA', 'keyB', 'keyC'})

        # 8) 迁移后重读：主索引已含全部 → 无 legacy 也无回退 → 正常返回（幂等）
        ld4 = pa.load_assets()
        check('AC3-20 迁移后重读幂等（3 条都在）', ld4.get('status') == 'success'
              and {x['key'] for x in ld4.get('records', [])} == {'keyA', 'keyB', 'keyC'})

        # 9) 无任何索引文件 → empty
        os.remove(ap2)
        ld5 = pa.load_assets()
        check('AC3-21 无任何索引 → empty', ld5.get('status') == 'empty', str(ld5))

        # 10) 主索引损坏（非 JSON）→ 容错空数组 → empty
        with open(ap2, 'w', encoding='utf-8') as f:
            f.write('{{{bad json')
        ld6 = pa.load_assets()
        check('AC3-22 主索引损坏 → empty 不崩溃', ld6.get('status') == 'empty', str(ld6))

        # 11) save_assets 非 list 记录 → 写空数组不崩溃
        r4 = pa.save_assets(None)
        check('AC3-23 save_assets(None) → success 且 records=[]', r4.get('status') == 'success'
              and json.load(open(ap2, encoding='utf-8'))['records'] == [], str(r4))

        # 12) legacy==main 守卫：项目文件恰好叫 assets.icproj 且 fallback 目录 = 项目目录
        pa_cfg = ProjectAPI(settings_api=sa, fallback_dir=proj_dir)
        sa.save_settings({'image_save_path': ''})  # 未配置 → main = proj_dir/assets.json
        pa_cfg.current_project_path = os.path.join(proj_dir, 'assets.icproj')  # legacy 也 = proj_dir/assets.json
        json.dump({'version': 2, 'records': [{'key': 'guard', 'adopted': True}]}, open(os.path.join(proj_dir, 'assets.json'), 'w', encoding='utf-8'))
        ldg = pa_cfg.load_assets()
        check('AC3-24 legacy==main 守卫：不重复读、返回主索引', ldg.get('status') == 'success'
              and {x['key'] for x in ldg.get('records', [])} == {'guard'}, str(ldg))

        # ══════════════ AC-4 · 设置路径校验 ══════════════
        # 13) strip + abspath 归一（P6）
        sa.save_settings({'image_save_path': '  ' + save_dir + '  '})
        check('AC4-1 strip+abspath 归一', sa.load_settings().get('image_save_path') == os.path.abspath(save_dir))
        # 14) 非目录报错（P4，人话）
        bad_file = os.path.join(root, 'file.txt')
        with open(bad_file, 'w', encoding='utf-8') as f:
            f.write('x')
        r_bad = sa.save_settings({'image_save_path': bad_file})
        check('AC4-2 非目录报错且含人话', r_bad.get('status') == 'error' and '目录' in (r_bad.get('message') or ''), str(r_bad))
        # 15) 空串 = 未配置允许（P3 语义）
        r_empty = sa.save_settings({'image_save_path': ''})
        check('AC4-3 空串允许（= 未配置）', r_empty.get('status') == 'success'
              and sa.load_settings().get('image_save_path') == '', str(r_empty))
        # 16) None → 归一为 ''
        sa.save_settings({'image_save_path': None})
        check('AC4-4 None → 空串', sa.load_settings().get('image_save_path') == '')
        # 17) 写探针：让探针路径被目录占位 → open(probe,'w') 抛 IsADirectoryError → 报「目录不可写」人话
        #     （Windows 目录只读属性不可靠，不用于模拟；用探针路径冲突可稳定触发写探针失败分支）
        ro_dir = os.path.join(root, 'probe_blocked')
        os.makedirs(os.path.join(ro_dir, '.icv_write_probe'), exist_ok=True)
        r_ro = sa.save_settings({'image_save_path': ro_dir})
        check('AC4-5 写探针失败报「不可写」人话', r_ro.get('status') == 'error' and '不可写' in (r_ro.get('message') or ''), str(r_ro))
        # 18) 其它字段保留（保存非 image_save_path 字段不丢）
        sa.save_settings({'default_project_path': 'C:/x', 'image_save_path': ''})
        ld_s = sa.load_settings()
        check('AC4-6 其它字段保留', ld_s.get('default_project_path') == 'C:/x', str(ld_s))

        # ══════════════ AC-4 · unified 生成落盘 + saved_to_disk ══════════════
        ua = UnifiedAPIRouter(_FakeProvider(), settings_api=sa)
        # 19) _get_save_dir 三级：显式目录 → 配置目录 → tempfile
        sa.save_settings({'image_save_path': ''})
        check('AC4-7 未配置 _get_save_dir = tempdir', ua._get_save_dir() == tempfile.gettempdir())
        exp_dir = os.path.join(root, 'explicit')
        os.makedirs(exp_dir, exist_ok=True)
        check('AC4-8 显式存在目录优先', ua._get_save_dir(exp_dir) == exp_dir)
        sa.save_settings({'image_save_path': save_dir})
        check('AC4-9 配置后 _get_save_dir = save_dir', ua._get_save_dir() == os.path.abspath(save_dir))
        # 显式目录仍优先于配置目录
        check('AC4-10 显式目录 > 配置目录', ua._get_save_dir(exp_dir) == exp_dir)

        # 20) _save_images_to_local：配置 → saved_to_disk=True + 实际落盘配置目录
        sa.save_settings({'image_save_path': save_dir})
        before = set(os.listdir(save_dir))
        out1 = ua._save_images_to_local({'success': True, 'image_url': 'data:image/png;base64,iVBORw0KGgo=', 'images': ['data:image/png;base64,iVBORw0KGgo=']})
        after = set(os.listdir(save_dir))
        check('AC4-11 配置后 saved_to_disk=True', out1.get('saved_to_disk') is True, str(out1.get('saved_to_disk')))
        check('AC4-12 配置后文件实际写入 save_dir', len(after - before) >= 1, str(after - before))
        check('AC4-13 image_url 仍保留 base64 原样', out1.get('image_url', '').startswith('data:image/png;base64,'), str(out1.get('image_url', '')[:40]))

        # 21) 未配置 → saved_to_disk=False + 仍写 tempfile（base64 可用，P3 不阻断）
        #     注意：生产链路 _parse_* 恒返回 images 数组，故需带 images 才会触发落盘（与生产一致）
        sa.save_settings({'image_save_path': ''})
        tmp_before = set(os.listdir(tempfile.gettempdir()))
        out2 = ua._save_images_to_local({'success': True, 'image_url': 'data:image/png;base64,iVBORw0KGgo=', 'images': ['data:image/png;base64,iVBORw0KGgo=']})
        tmp_after = set(os.listdir(tempfile.gettempdir()))
        check('AC4-14 未配置 saved_to_disk=False', out2.get('saved_to_disk') is False, str(out2.get('saved_to_disk')))
        new_in_tmp = tmp_after - tmp_before
        check('AC4-15 未配置仍写 tempfile（不丢图）', len(new_in_tmp) >= 1 and any('unified_image_' in n for n in new_in_tmp), str(list(new_in_tmp)[:3]))
        # 清理 tempfile 测试残留
        for n in new_in_tmp:
            try:
                os.remove(os.path.join(tempfile.gettempdir(), n))
            except OSError:
                pass

        # 22) 显式 save_dir 传入且存在 → saved_to_disk=True（优先级）
        sa.save_settings({'image_save_path': ''})
        out3 = ua._save_images_to_local({'success': True, 'image_url': 'data:image/png;base64,iVBORw0KGgo='}, save_dir=exp_dir)
        check('AC4-16 显式目录 → saved_to_disk=True', out3.get('saved_to_disk') is True, str(out3.get('saved_to_disk')))
        # 23) 显式 save_dir 不存在且未配置 → saved_to_disk=False
        out4 = ua._save_images_to_local({'success': True, 'image_url': 'data:image/png;base64,iVBORw0KGgo='}, save_dir=os.path.join(root, 'nope'))
        check('AC4-17 显式目录不存在+未配置 → saved_to_disk=False', out4.get('saved_to_disk') is False, str(out4.get('saved_to_disk')))
        # 24) 非法 base64 不崩溃
        out5 = ua._save_images_to_local({'success': True, 'image_url': 'data:image/png;base64,!!notbase64!!'})
        check('AC4-18 非法 base64 不崩溃且保留原值', out5.get('image_url') == 'data:image/png;base64,!!notbase64!!', str(out5.get('image_url', '')[:30]))

        failed = [r for r in RESULTS if not r[1]]
        print(f'\n总计 {len(RESULTS)} 项，失败 {len(failed)} 项')
        return 1 if failed else 0
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
