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

    def __init__(self):
        self.current_project_path = None  # 当前项目文件路径
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
