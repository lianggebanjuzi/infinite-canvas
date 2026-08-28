# backend/api/project_api.py
"""
项目文件管理 API
负责项目的保存、加载、另存为等操作
"""

import json
import os
import threading
from tkinter import filedialog

from backend.api.utils import atomic_write_json, append_json_line, get_tk_root


class ProjectAPI:
    """项目文件管理类"""

    def __init__(self, settings_api=None, fallback_dir=None):
        self.current_project_path = None  # 当前项目文件路径
        self.settings_api = settings_api  # 注入 SettingsAPI（读 image_save_path 推导资产索引落点；可为 None）
        self.fallback_dir = fallback_dir  # 降级目录（未配置图片保存路径时资产索引写这里；main.py 传 APP_DIR）
        self.lock = threading.Lock()      # 保存互斥兜底（防御性；pywebview js_api 本就在 GUI 线程串行）

    def save_project(self, data, path=None):
        """保存项目文件（原子落盘：.tmp + fsync + os.replace）"""
        print(f"正在保存项目... 路径: {path}")
        try:
            with self.lock:
                if path:
                    # 指定路径保存
                    save_path = path
                elif self.current_project_path:
                    # 保存到当前项目路径
                    save_path = self.current_project_path
                else:
                    # 没有路径，需要另存为
                    return {"status": "need_save_as"}

                atomic_write_json(save_path, data)
                self.current_project_path = save_path
                return {"status": "success", "message": "保存成功", "path": save_path}
        except Exception as e:
            print(f"保存项目失败: {e}")
            return {"status": "error", "message": str(e)}

    def save_project_as(self, data):
        """另存为项目文件"""
        try:
            root = get_tk_root()
            save_path = filedialog.asksaveasfilename(
                title='另存为',
                initialdir=os.path.expanduser('~'),
                initialfile='untitled.icproj',
                defaultextension='.icproj',
                filetypes=[('Infinite Canvas Project', '*.icproj')]
            )
            root.destroy()

            if save_path:
                # 确保扩展名
                if not save_path.endswith('.icproj'):
                    save_path += '.icproj'

                with self.lock:
                    atomic_write_json(save_path, data)
                    self.current_project_path = save_path
                return {"status": "success", "message": "保存成功", "path": save_path}

            return {"status": "cancelled"}
        except Exception as e:
            print(f"另存为失败: {e}")
            return {"status": "error", "message": str(e)}

    def open_project_dialog(self):
        """打开项目文件对话框"""
        try:
            root = get_tk_root()
            file_path = filedialog.askopenfilename(
                title='打开项目',
                initialdir=os.path.expanduser('~'),
                filetypes=[('Infinite Canvas Project', '*.icproj')]
            )
            root.destroy()

            if file_path:
                return self.load_project(file_path)

            return {"status": "cancelled"}
        except Exception as e:
            print(f"打开项目失败: {e}")
            return {"status": "error", "message": str(e)}

    def load_project(self, file_path):
        """加载项目文件"""
        print(f"正在加载项目: {file_path}")
        try:
            if not os.path.exists(file_path):
                return {"status": "error", "message": "文件不存在"}

            with open(file_path, 'r', encoding='utf-8') as f:
                data = json.load(f)

            self.current_project_path = file_path
            self.cleanup_orphan_tmp_files()
            return {"status": "success", "data": data, "path": file_path}
        except Exception as e:
            print(f"加载项目失败: {e}")
            return {"status": "error", "message": str(e)}

    def get_current_project_path(self):
        """获取当前项目路径"""
        return {"path": self.current_project_path}

    def reveal_project_in_folder(self, file_path):
        """仅打开项目所在目录；不改写或删除任何文件。"""
        try:
            if not isinstance(file_path, str) or not os.path.exists(file_path):
                return {"status": "error", "message": "项目文件不存在"}
            if not hasattr(os, 'startfile'):
                return {"status": "error", "message": "当前系统不支持打开文件夹"}
            os.startfile(os.path.dirname(os.path.abspath(file_path)))
            return {"status": "success"}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    def _workflows_path(self):
        """全局工作流库落点；与项目、历史和资产分开，未保存项目也可使用。"""
        fallback = self.fallback_dir or os.path.expanduser('~')
        return os.path.join(fallback, 'workflows.json')

    def load_workflows(self):
        """读取全局工作流库。文件不存在或个别记录损坏时按空库/跳过处理。"""
        try:
            path = self._workflows_path()
            if not os.path.exists(path):
                return {"status": "empty", "workflows": []}
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            workflows = data.get('workflows', []) if isinstance(data, dict) else []
            return {"status": "success", "workflows": [w for w in workflows if isinstance(w, dict)]}
        except Exception as e:
            print(f"读取工作流库失败: {e}")
            return {"status": "error", "message": str(e), "workflows": []}

    def save_workflows(self, workflows):
        """原子保存全局工作流库。前端已经剥离项目结果、历史和本地图片路径。"""
        try:
            path = self._workflows_path()
            directory = os.path.dirname(path)
            if directory:
                os.makedirs(directory, exist_ok=True)
            with self.lock:
                atomic_write_json(path, {
                    "version": 1,
                    "workflows": workflows if isinstance(workflows, list) else []
                })
            return {"status": "success"}
        except Exception as e:
            print(f"保存工作流库失败: {e}")
            return {"status": "error", "message": str(e)}

    def _history_path(self):
        """推导 history.jsonl 落点（逻辑集中在此一处，便于未来迁移到「项目目录/」布局）。

        与 .icproj 同目录的兄弟文件 <项目名>.history.jsonl；无路径返回 None。
        """
        if not self.current_project_path:
            return None
        base = self.current_project_path
        if base.endswith('.icproj'):
            base = base[:-len('.icproj')]
        return base + '.history.jsonl'

    def append_history(self, entry):
        """追加一条 trace 到 history.jsonl（后端单行 append，保证多行互不破坏）"""
        try:
            history_path = self._history_path()
            if not history_path:
                return {"status": "error", "message": "no_path"}
            with self.lock:
                append_json_line(history_path, entry)
            return {"status": "success"}
        except Exception as e:
            print(f"追加历史失败: {e}")
            return {"status": "error", "message": str(e)}

    def load_history(self):
        """读取 history.jsonl；文件不存在返回 empty；逐行容错（坏行跳过）"""
        try:
            history_path = self._history_path()
            if not history_path or not os.path.exists(history_path):
                return {"status": "empty"}
            entries = []
            with open(history_path, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entries.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue  # 坏行跳过，不影响其它行
            return {"status": "success", "entries": entries}
        except Exception as e:
            print(f"读取历史失败: {e}")
            return {"status": "error", "message": str(e)}

    def _assets_path(self):
        """资产索引主落点（A1：不再依赖 current_project_path，未保存项目也可写）。

        读盘/写盘双级解析：用户配置了图片保存目录 → `<保存目录>/assets.json`；
        未配置 → 降级 `fallback_dir/assets.json`（与 settings.json 同处，可写）。
        **永不返回 None**（根因修复：旧实现未保存项目返回 None → no_path 报错）。
        """
        configured = self._configured_image_save_dir()
        if configured:
            return os.path.join(configured, 'assets.json')
        fallback = self.fallback_dir or os.path.expanduser('~')
        return os.path.join(fallback, 'assets.json')

    def _configured_image_save_dir(self):
        """读取用户配置的图片保存目录；未配置/读取失败返回 None"""
        if self.settings_api is None:
            return None
        try:
            settings = self.settings_api.load_settings() or {}
            path = (settings.get('image_save_path') or '').strip()
            return path or None
        except Exception:
            return None

    def _legacy_assets_path(self):
        """旧项目迁移落点（A4）：项目文件同目录 `<项目名>.assets.json`（incremental-2 布局）；无项目路径返回 None"""
        if not self.current_project_path:
            return None
        base = self.current_project_path
        if base.endswith('.icproj'):
            base = base[:-len('.icproj')]
        return base + '.assets.json'

    def _read_records(self, path):
        """读取资产索引文件的 records 列表；文件缺失/损坏返回 []（容错，兼容 version 1/2 两种格式）"""
        try:
            if not path or not os.path.exists(path):
                return []
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, list):
                # version 1 旧格式：顶层即记录数组
                return [r for r in data if isinstance(r, dict)]
            if isinstance(data, dict) and isinstance(data.get('records'), list):
                # version 2 新格式：{"version": 2, "records": [...]}
                return [r for r in data['records'] if isinstance(r, dict)]
            return []
        except Exception as e:
            print(f"读取资产索引失败({path}): {e}")
            return []

    def _merge_records(self, main, legacy):
        """按 key 合并两条记录列表：主索引优先，仅补主索引缺失的 key（A4 迁移，幂等去重）"""
        by_key = {}
        for r in main:
            key = r.get('key')
            if key:
                by_key[key] = r
        for r in legacy:
            key = r.get('key')
            if key and key not in by_key:
                by_key[key] = r
        return list(by_key.values())

    def save_assets(self, records):
        """保存可变资产索引到主落点（<图片保存目录>/assets.json；未配置降级 fallback_dir/assets.json，原子写）。

        返回（接口契约）：
        - {status:'success'} 正常落盘到用户配置目录
        - {status:'success', degraded:true, message:'请先在设置中配置图片保存路径'} 降级落盘（A2：数据已保存但提示配置路径）
        - {status:'error', message} IO 失败（人话）
        """
        try:
            assets_path = self._assets_path()
            directory = os.path.dirname(assets_path)
            if directory:
                os.makedirs(directory, exist_ok=True)
            with self.lock:
                atomic_write_json(assets_path, {
                    "version": 2,
                    "records": records if isinstance(records, list) else []
                })
            if not self._configured_image_save_dir():
                # 降级：数据已写入 fallback_dir，但路径未配置 → 人话提示（不得出现 no_path 等开发话术）
                return {"status": "success", "degraded": True, "message": "请先在设置中配置图片保存路径"}
            return {"status": "success"}
        except Exception as e:
            print(f"保存资产索引失败: {e}")
            return {"status": "error", "message": str(e)}

    def load_assets(self):
        """读取资产索引（A3/A4）：
        主索引读盘顺序 = 图片保存目录 → fallback_dir（找第一个存在的文件；都不存在 → empty）。
        旧项目迁移：current_project_path 存在且旧位置 `<项目名>.assets.json` 有数据 → 按 key 合并
        （主索引优先，仅补缺失 key）→ 合并结果写回主索引 → best-effort 删旧文件。
        额外收敛：配置了图片保存目录但该处尚无 assets.json、且 fallback_dir 有降级期文件时，
        读 fallback 后同样写回主索引 + 删 fallback 文件（防「取消采纳」被旧文件复活）。
        """
        try:
            main_path = self._assets_path()
            configured_dir = self._configured_image_save_dir()

            # 主索引读盘顺序：图片保存目录 → fallback_dir
            read_path = main_path
            migrated_from_fallback = False
            if configured_dir and not os.path.exists(main_path):
                fallback_candidate = os.path.join(self.fallback_dir or os.path.expanduser('~'), 'assets.json')
                if os.path.exists(fallback_candidate):
                    read_path = fallback_candidate
                    migrated_from_fallback = True

            main_records = self._read_records(read_path)

            legacy_path = self._legacy_assets_path()
            legacy_records = []
            legacy_exists = False
            if (legacy_path and legacy_path != main_path and legacy_path != read_path
                    and os.path.exists(legacy_path)):
                legacy_exists = True
                legacy_records = self._read_records(legacy_path)

            if not main_records and not legacy_records:
                return {"status": "empty"}

            # 迁移/收敛场景：合并后写回主索引 + 删旧文件
            if legacy_exists or migrated_from_fallback:
                merged = self._merge_records(main_records, legacy_records)
                try:
                    directory = os.path.dirname(main_path)
                    if directory:
                        os.makedirs(directory, exist_ok=True)
                    atomic_write_json(main_path, {"version": 2, "records": merged})
                except Exception as e:
                    print(f"资产索引迁移写回失败: {e}")
                # best-effort 删除旧文件（旧位置不再作为事实源）
                stale_paths = {legacy_path, read_path if migrated_from_fallback else None}
                for stale in stale_paths:
                    if stale and stale != main_path and os.path.exists(stale):
                        try:
                            os.remove(stale)
                        except OSError:
                            pass
                return {"status": "success", "records": merged}

            return {"status": "success", "records": main_records}
        except Exception as e:
            print(f"读取资产索引失败: {e}")
            return {"status": "empty"}

    def cleanup_orphan_tmp_files(self):
        """最佳努力清理当前项目目录下崩溃遗留的 *.icproj.tmp 孤儿（绝不误删 .icproj，R1.4 P1）"""
        if not self.current_project_path:
            return
        directory = os.path.dirname(self.current_project_path)
        if not directory or not os.path.isdir(directory):
            return
        for name in os.listdir(directory):
            if name.endswith('.icproj.tmp'):
                try:
                    os.remove(os.path.join(directory, name))
                except OSError:
                    pass
