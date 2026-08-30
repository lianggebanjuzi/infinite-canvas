# backend/director_api.py
"""
导演台（4.4 MONOFORM 式导演台）独立窗口桥接 API。

约定：
- 所有方法以 `director_` 前缀命名，绝不覆盖主窗口 API（R3 共享契约）。
- `.icdirector` 工程与 `.icproj` 完全隔离；工程 JSON 原子写。
- 回传 PNG/MP4 走现有图片/媒体落盘管线；trace 由前端记录（不含内部绝对路径）。
- GLTF/工程视为不可信文件：校验扩展名、大小与路径，不执行任何脚本。
"""

import base64
import json
import os
import tempfile
import threading
from datetime import datetime

from tkinter import filedialog

from backend.api.utils import atomic_write_json, get_tk_root

# GLB/GLTF 大小上限（与前端 src/director/import/gltf.ts GLTF_LIMITS 一致）
GLTF_MAX_BYTES = 200 * 1024 * 1024
# 参考图/回传图片大小上限
IMAGE_MAX_BYTES = 64 * 1024 * 1024
# 回传视频大小上限（低分辨率/短时长验证）
VIDEO_MAX_BYTES = 256 * 1024 * 1024


class DirectorAPI:
    """导演台窗口 js_api（独立窗口；仅暴露 director_* 方法）。"""

    def __init__(self, app_api=None, main_window=None):
        # 主窗口 InfiniteCanvasAPI：复用 图片保存 / 最近项目 / 设置 能力
        self._app_api = app_api
        self._main_window = main_window
        self._launch_options = {}

    # ── 启动参数 ──
    def set_launch_options(self, options):
        self._launch_options = options or {}
        return True

    def director_ping(self):
        return {"status": "ok", "app": "icdirector", "version": 1}

    def director_get_launch_options(self):
        return self._launch_options

    # ── 工程文件 ──
    @staticmethod
    def _validate_director_path(path):
        """校验保存目标：非空字符串且扩展名为 .icdirector；合法返回 None，非法返回错误信息。

        拒绝保存到任意非工程文件（如 .json / 无扩展名），防止覆盖非 .icdirector 内容。
        """
        if not isinstance(path, str) or not path:
            return "保存路径无效"
        if not path.lower().endswith('.icdirector'):
            return "保存路径必须是 .icdirector 文件"
        return None

    @staticmethod
    def _validate_director_data(data):
        """校验工程数据：合法 JSON 对象且 format === 'icdirector'；合法返回 None，非法返回错误信息。"""
        if not isinstance(data, dict):
            return "工程数据必须是 JSON 对象"
        if data.get('format') != 'icdirector':
            return "不是有效的 .icdirector 导演工程数据（format 必须为 icdirector）"
        return None

    def director_save_project(self, path, data):
        """原子写 .icdirector；path 为空时返回 need_save_as（前端转另存）。

        保存前校验目标扩展名与工程格式，校验失败直接拒绝，不创建/覆盖任何文件。
        """
        try:
            if not path:
                return {"status": "need_save_as"}
            path_error = self._validate_director_path(path)
            if path_error:
                return {"status": "error", "message": path_error}
            data_error = self._validate_director_data(data)
            if data_error:
                return {"status": "error", "message": data_error}
            atomic_write_json(path, data)
            name = data.get('name', '') if isinstance(data, dict) else ''
            self._touch_recent(path, name)
            return {"status": "success", "path": path}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    def director_save_project_as(self, data, initial_name='untitled.icdirector'):
        try:
            # 工程数据先校验：非法数据不弹保存对话框，直接拒绝
            data_error = self._validate_director_data(data)
            if data_error:
                return {"status": "error", "message": data_error}
            root = get_tk_root()
            path = filedialog.asksaveasfilename(
                title='保存导演工程',
                initialfile=initial_name,
                defaultextension='.icdirector',
                filetypes=[('Infinite Canvas Director Project', '*.icdirector')],
            )
            root.destroy()
            if not path:
                return {"status": "cancelled"}
            if not path.lower().endswith('.icdirector'):
                path += '.icdirector'
            path_error = self._validate_director_path(path)
            if path_error:
                return {"status": "error", "message": path_error}
            atomic_write_json(path, data)
            name = data.get('name', '') if isinstance(data, dict) else ''
            self._touch_recent(path, name)
            return {"status": "success", "path": path}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    def director_open_project_dialog(self):
        try:
            root = get_tk_root()
            path = filedialog.askopenfilename(
                title='打开导演工程',
                filetypes=[('Infinite Canvas Director Project', '*.icdirector')],
            )
            root.destroy()
            if not path:
                return {"status": "cancelled"}
            return self._read_project(path)
        except Exception as e:
            return {"status": "error", "message": str(e)}

    def director_load_project(self, path):
        try:
            if not isinstance(path, str) or not path:
                return {"status": "error", "message": "路径无效"}
            return self._read_project(path)
        except Exception as e:
            return {"status": "error", "message": str(e)}

    def _read_project(self, path):
        if not os.path.exists(path):
            return {"status": "error", "message": "文件不存在"}
        try:
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if not isinstance(data, dict) or data.get('format') != 'icdirector':
                return {"status": "error", "message": "不是有效的 .icdirector 导演工程文件"}
            self._touch_recent(path, data.get('name', ''))
            return {"status": "success", "data": data, "path": path}
        except Exception as e:
            return {"status": "error", "message": f"读取工程失败: {e}"}

    # ── 最近工程 ──
    def director_touch_recent(self, path, name=''):
        try:
            if self._app_api and hasattr(self._app_api, 'settings'):
                return self._app_api.settings.touch_recent_project(path, name)
            return {"status": "success"}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    def director_load_recent(self):
        try:
            if self._app_api and hasattr(self._app_api, 'settings'):
                return self._app_api.settings.load_recent_projects()
            return {"status": "success", "projects": []}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    def director_remove_recent(self, path):
        try:
            if self._app_api and hasattr(self._app_api, 'settings'):
                return self._app_api.settings.remove_recent_project(path)
            return {"status": "success"}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    # ── 资源校验 ──
    def director_validate_resource(self, path):
        """校验引用的外部资源是否存在（打开工程时逐项检查，缺失提示降级）。"""
        try:
            if not isinstance(path, str) or not path:
                return {"status": "error", "message": "路径无效"}
            exists = os.path.exists(path) and os.path.isfile(path)
            size = os.path.getsize(path) if exists else 0
            return {"status": "success", "exists": exists, "sizeBytes": size}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    # ── GLB/GLTF 导入 ──
    def director_open_gltf_dialog(self):
        """选择 GLB/GLTF：校验扩展名/大小，返回 base64 数据与真实路径（供前端解析）。"""
        try:
            root = get_tk_root()
            path = filedialog.askopenfilename(
                title='导入模型（GLB/GLTF）',
                filetypes=[('GLB / GLTF', '*.glb *.gltf'), ('GLB', '*.glb'), ('GLTF', '*.gltf')],
            )
            root.destroy()
            if not path:
                return {"status": "cancelled"}
            if '..' in path:
                return {"status": "error", "message": "非法路径"}
            size = os.path.getsize(path)
            if size > GLTF_MAX_BYTES:
                return {"status": "error", "message": f"文件超过 {GLTF_MAX_BYTES // (1024 * 1024)}MB 限制"}
            ext = os.path.splitext(path)[1].lower()
            if ext not in ('.glb', '.gltf'):
                return {"status": "error", "message": "仅支持 .glb / .gltf"}
            with open(path, 'rb') as f:
                data = f.read()
            return {
                "status": "success",
                "path": path,
                "sizeBytes": size,
                "dataBase64": base64.b64encode(data).decode('ascii'),
            }
        except Exception as e:
            return {"status": "error", "message": str(e)}

    # ── 回传图片/视频落盘 ──
    def director_save_image_from_data_url(self, data_url, filename=None):
        """回传/参考图：走现有图片落盘管线（data:image 前缀由 ImageAPI 处理）。"""
        try:
            if not isinstance(data_url, str) or not data_url.startswith('data:image'):
                return {"status": "error", "message": "图片数据格式无效"}
            # 大小校验（base64 解码前粗估）
            if len(data_url) > IMAGE_MAX_BYTES * 1.5:
                return {"status": "error", "message": "图片超过大小限制"}
            if self._app_api and hasattr(self._app_api, 'image'):
                return self._app_api.image.save_image_to_local(data_url, allow_temp=True)
            return {"status": "error", "message": "图片管线不可用"}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    def director_save_video_blob(self, base64_str, filename=None):
        """回传视频：base64 → 落盘（优先媒体保存目录，缺省临时目录）；捕获磁盘空间错误。"""
        try:
            if not isinstance(base64_str, str) or not base64_str:
                return {"status": "error", "message": "视频数据无效"}
            if len(base64_str) > VIDEO_MAX_BYTES * 1.5:
                return {"status": "error", "message": "视频超过大小限制"}
            raw = base64.b64decode(base64_str)
            if len(raw) > VIDEO_MAX_BYTES:
                return {"status": "error", "message": f"视频超过 {VIDEO_MAX_BYTES // (1024 * 1024)}MB 限制"}

            save_dir = ''
            if self._app_api and hasattr(self._app_api, 'settings'):
                settings = self._app_api.settings.load_settings()
                save_dir = settings.get('image_save_path', '') or ''
            if not save_dir:
                save_dir = os.path.join(tempfile.gettempdir(), 'infinite_canvas_imports')
            if not os.path.exists(save_dir):
                os.makedirs(save_dir)

            if not filename:
                filename = f"director_video_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')}.mp4"
            file_path = os.path.join(save_dir, filename)
            with open(file_path, 'wb') as f:
                f.write(raw)
            return {"status": "success", "path": file_path.replace('\\', '/'), "sizeBytes": len(raw)}
        except OSError as e:
            if getattr(e, 'errno', None) == 28:  # ENOSPC
                return {"status": "error", "message": "磁盘空间不足，导出视频失败。请清理磁盘后重试。"}
            return {"status": "error", "message": f"写入视频失败: {e}"}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    # ── 回传画布（转发到主窗口） ──
    def director_return_to_canvas(self, payload):
        """导演台 → 主画布临时返回通道：通过主窗口 evaluate_js 调用 __icvDirectorReturn。"""
        try:
            if self._main_window is None:
                return {"status": "error", "message": "主画布窗口不可用（请先打开主应用）"}
            payload = payload or {}
            # 脱敏：不向主画布暴露导演台内部绝对路径之外的信息（path 由主画布导入管线使用）
            safe = {
                "kind": payload.get('kind', 'png'),
                "path": payload.get('path', ''),
                "projectId": payload.get('projectId', ''),
                "cameraId": payload.get('cameraId', ''),
                "time": payload.get('time', 0),
                "shotId": payload.get('shotId'),
                "sourceProjectId": payload.get('sourceProjectId'),
                "sourceNodeId": payload.get('sourceNodeId'),
            }
            js_payload = json.dumps(safe, ensure_ascii=False)

            def _forward():
                try:
                    self._main_window.evaluate_js(
                        f"window.__icvDirectorReturn && window.__icvDirectorReturn({js_payload})"
                    )
                except Exception:
                    pass

            threading.Thread(target=_forward, daemon=True).start()
            return {"status": "success", "message": "已转发到主画布"}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    def _touch_recent(self, path, name):
        try:
            if self._app_api and hasattr(self._app_api, 'settings'):
                self._app_api.settings.touch_recent_project(path, name)
        except Exception:
            pass
