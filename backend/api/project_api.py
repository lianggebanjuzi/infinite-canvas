# backend/api/project_api.py
"""
项目文件管理 API
负责项目的保存、加载、另存为等操作
"""

import json
import os
from tkinter import filedialog

from backend.api.utils import get_tk_root


class ProjectAPI:
    """项目文件管理类"""

    def __init__(self):
        self.current_project_path = None  # 当前项目文件路径

    def save_project(self, data, path=None):
        """保存项目文件"""
        print(f"正在保存项目... 路径: {path}")
        try:
            if path:
                # 指定路径保存
                save_path = path
            elif self.current_project_path:
                # 保存到当前项目路径
                save_path = self.current_project_path
            else:
                # 没有路径，需要另存为
                return {"status": "need_save_as"}

            with open(save_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=4)

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

                with open(save_path, 'w', encoding='utf-8') as f:
                    json.dump(data, f, ensure_ascii=False, indent=4)

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
            return {"status": "success", "data": data, "path": file_path}
        except Exception as e:
            print(f"加载项目失败: {e}")
            return {"status": "error", "message": str(e)}

    def get_current_project_path(self):
        """获取当前项目路径"""
        return {"path": self.current_project_path}
