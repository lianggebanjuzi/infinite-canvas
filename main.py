"""
Infinite Canvas - 应用入口
"""
import sys
import io
import os
import shutil
import json
import subprocess
import ctypes
import threading
from ctypes import wintypes

import webview

from backend.api.provider_api  import ProviderAPI
from backend.api.unified_api   import UnifiedAPIRouter
from backend.api.image_api     import ImageAPI
from backend.api.video_api     import VideoAPI
from backend.api.clipboard_api import ClipboardAPI
from backend.api.project_api   import ProjectAPI
from backend.api.settings_api  import SettingsAPI
from backend.api.errors        import AppError, UnknownError

# ─────────────────────────────────────────
# 路径常量
# ─────────────────────────────────────────
if getattr(sys, 'frozen', False):
    APP_DIR      = os.path.dirname(sys.executable)
    RESOURCE_DIR = sys._MEIPASS
else:
    APP_DIR      = os.path.dirname(os.path.abspath(__file__))
    RESOURCE_DIR = APP_DIR

BASE_DIR   = RESOURCE_DIR
INDEX_HTML = os.path.join(RESOURCE_DIR, 'gui', 'dist', 'index.html')
ICON_PATH  = os.path.join(RESOURCE_DIR, 'icon.ico')

# 用户数据文件（读写，放在 exe 同级目录 / 开发时项目根目录）
PROVIDERS_FILE = os.path.join(APP_DIR, 'providers_data.json')
SETTINGS_FILE  = os.path.join(APP_DIR, 'settings.json')
PROMPTS_FILE   = os.path.join(APP_DIR, 'prompts_library.json')

sys.path.insert(0, RESOURCE_DIR)

# SSL 证书路径修正（打包后生效）
if getattr(sys, 'frozen', False):
    os.environ['SSL_CERT_FILE']      = os.path.join(RESOURCE_DIR, 'certifi', 'cacert.pem')
    os.environ['REQUESTS_CA_BUNDLE'] = os.path.join(RESOURCE_DIR, 'certifi', 'cacert.pem')


# ─────────────────────────────────────────
# 首次运行初始化（从 _defaults 复制默认数据）
# ─────────────────────────────────────────
def init_user_data():
    defaults = {
        'settings.json':        '_defaults/settings.json',
        'providers_data.json':  '_defaults/providers_data.json',
        'prompts_library.json': '_defaults/prompts_library.json',
    }
    for user_file, default_file in defaults.items():
        user_path    = os.path.join(APP_DIR, user_file)
        default_path = os.path.join(RESOURCE_DIR, default_file)
        if not os.path.exists(user_path):
            if os.path.exists(default_path):
                shutil.copy2(default_path, user_path)
            else:
                with open(user_path, 'w', encoding='utf-8') as f:
                    json.dump({}, f)


# ─────────────────────────────────────────
# 窗口句柄工具（无边框窗口专用）
# ─────────────────────────────────────────
def _get_window_hwnd():
    """获取当前顶层窗口的 Win32 句柄（HWND）。

    优先取 pywebview 暴露的 native 句柄（Windows 下为 WinForms 窗体对象，
    其 .Handle 即 HWND），不再依赖 FindWindowW 对窗口标题的耦合。失败返回 0。
    当前用于 _apply_rounded_corners（圆角补偿）、win_toggle_maximize（Win32 最大化）
    与 win_move_relative（自实现顶栏拖动，B1）；不再使用 pywebview 官方 drag-region。
    """
    try:
        win = webview.windows[0]
        if win is None:
            return 0
        native = win.native
        if native is None:
            return 0
        # 兼容 native 直接暴露整数句柄的极端情况；常规路径为 .Handle（IntPtr）
        handle = getattr(native, 'Handle', None)
        if handle is None:
            return native if isinstance(native, int) else 0
        if isinstance(handle, int):
            return handle
        return int(handle.ToInt32())
    except Exception:
        return 0


# ─────────────────────────────────────────
# Win32 窗口工具（无边框最大化贴工作区，W1-W3）
# 全程物理像素：pywebview/WinForms 进程已是 DPI aware，GetMonitorInfoW / GetWindowRect /
# SetWindowPos 均按物理像素，不与 pywebview 逻辑像素 API 混用（设计 §1.1）。
# ─────────────────────────────────────────
class _WinRect(ctypes.Structure):
    """Win32 RECT（物理像素）"""
    _fields_ = [('left', wintypes.LONG), ('top', wintypes.LONG),
                ('right', wintypes.LONG), ('bottom', wintypes.LONG)]


class _WinMonitorInfo(ctypes.Structure):
    """Win32 MONITORINFO（rcWork = 工作区，已不含任务栏）"""
    _fields_ = [('cbSize', wintypes.DWORD), ('rcMonitor', _WinRect),
                ('rcWork', _WinRect), ('dwFlags', wintypes.DWORD)]


def _get_monitor_work_area(hwnd):
    """获取窗口当前所在显示器的工作区（rcWork，不含任务栏）；失败返回 None。

    MonitorFromWindow(MONITOR_DEFAULTTONEAREST=2) 取「窗口当前所在显示器」，
    GetMonitorInfoW 返回其工作区 —— 多显示器 / 不同 DPI 下均贴合当前屏（W3）。
    """
    try:
        user32 = ctypes.windll.user32
        user32.MonitorFromWindow.restype = wintypes.HANDLE
        user32.MonitorFromWindow.argtypes = [wintypes.HWND, wintypes.DWORD]
        monitor = user32.MonitorFromWindow(hwnd, 2)  # MONITOR_DEFAULTTONEAREST
        if not monitor:
            return None
        user32.GetMonitorInfoW.restype = wintypes.BOOL
        user32.GetMonitorInfoW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_WinMonitorInfo)]
        info = _WinMonitorInfo()
        info.cbSize = ctypes.sizeof(_WinMonitorInfo)
        if not user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
            return None
        return (info.rcWork.left, info.rcWork.top,
                info.rcWork.right - info.rcWork.left,
                info.rcWork.bottom - info.rcWork.top)
    except Exception:
        return None


def _get_window_rect(hwnd):
    """获取窗口当前屏幕矩形 (left, top, width, height)；失败返回 None（最大化前记录原矩形用）"""
    try:
        user32 = ctypes.windll.user32
        user32.GetWindowRect.restype = wintypes.BOOL
        user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(_WinRect)]
        rect = _WinRect()
        if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            return None
        return (rect.left, rect.top,
                rect.right - rect.left,
                rect.bottom - rect.top)
    except Exception:
        return None


def _set_window_pos(hwnd, rect):
    """SetWindowPos 移动/改尺寸窗口；SWP_NOZORDER=0x0004 | SWP_NOACTIVATE=0x0010。返回是否成功。"""
    try:
        user32 = ctypes.windll.user32
        user32.SetWindowPos.restype = wintypes.BOOL
        user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int,
                                        ctypes.c_int, ctypes.c_int, wintypes.UINT]
        return bool(user32.SetWindowPos(hwnd, None, rect[0], rect[1], rect[2], rect[3], 0x0004 | 0x0010))
    except Exception:
        return False


def _get_dpi_scale(hwnd):
    """当前窗口所在显示器的 DPI 缩放系数（逻辑像素→物理像素；1.0=100%）。

    与 pywebview winforms._scale 同口径（GetDpiForWindow/96），保证前端拖拽增量（CSS px）
    换算成物理像素与窗口实际位置一致；GetDpiForWindow 不可用（Win10 1607 以下）时回退 1.0。
    """
    try:
        dpi = ctypes.windll.user32.GetDpiForWindow(hwnd)
        if dpi > 0:
            return dpi / 96.0
    except Exception:
        pass
    return 1.0


# ─────────────────────────────────────────
# 统一 API 类（所有 AI 逻辑统一走 UnifiedAPIRouter）
# ─────────────────────────────────────────
class InfiniteCanvasAPI:

    def __init__(self):
        self.provider  = ProviderAPI(PROVIDERS_FILE)
        self.settings  = SettingsAPI(SETTINGS_FILE, PROMPTS_FILE)
        self.unified   = UnifiedAPIRouter(self.provider, settings_api=self.settings)
        self.image     = ImageAPI(self.settings, self.unified)
        self.video     = VideoAPI(self.unified)
        self.clipboard = ClipboardAPI()
        self.project   = ProjectAPI(settings_api=self.settings, fallback_dir=APP_DIR)
        # 无边框窗口状态（自绘标题栏）
        self._win_maximized = False  # 最大化状态标志（win_toggle_maximize 切换用）
        self._win_restore_rect = None  # 最大化前窗口矩形 (left, top, width, height)；还原时恢复
        self._closing_forced = False  # 强制关闭标志：win_close 置位后 closing 拦截放行（绕过保护）
        # 关闭保护缓存（未响应修复）：前端经 win_set_dirty 上报 dirty，closing 事件读缓存而非同步 evaluate_js
        self._cached_dirty = True  # 初始保守为 True（前端未上报前不静默丢数据；前端就绪后会立即上报真实值）
        self._dirty_reported = False  # 前端是否至少上报过一次（未上报时回退旧同步查询，覆盖页面未加载/崩溃场景）

    # ─────────────────────────────────────────
    # 供应商管理
    # ─────────────────────────────────────────
    def load_providers(self):
        return self.provider.load_providers()

    def add_provider(self, name, provider_type, short_name=''):
        return self.provider.add_provider(name, provider_type, short_name)

    def update_provider(self, provider_id, updates):
        return self.provider.update_provider(provider_id, updates)

    def delete_provider(self, provider_id):
        return self.provider.delete_provider(provider_id)

    # ── 多 Key 管理（multi-key） ──
    def add_key(self, provider_id, key_name=''):
        return self.provider.add_key(provider_id, key_name)

    def delete_key(self, provider_id, key_id):
        return self.provider.delete_key(provider_id, key_id)

    def update_key(self, provider_id, key_id, updates):
        return self.provider.update_key(provider_id, key_id, updates)

    def test_api_connection(self, api_url, api_key):
        try:
            return self.provider.test_api_connection(api_url, api_key)
        except AppError as e:
            return e.to_dict()
        except Exception as e:
            return UnknownError(str(e)).to_dict()

    def fetch_models(self, api_url, api_key):
        try:
            return self.provider.fetch_models(api_url, api_key)
        except AppError as e:
            return e.to_dict()
        except Exception as e:
            return UnknownError(str(e)).to_dict()

    # ─────────────────────────────────────────
    # 对话模型管理
    # ─────────────────────────────────────────
    def add_chat_model(self, provider_id, key_id=None, model_id=None, model_name=None):
        return self.provider.add_chat_model(provider_id, key_id, model_id, model_name)

    def remove_model(self, provider_id, key_id, model_id):
        return self.provider.remove_model(provider_id, key_id, model_id)

    # ─────────────────────────────────────────
    # AI 图片生成（全部走 UnifiedAPIRouter）
    # ─────────────────────────────────────────

    def generate_image(self, prompt, config=None):
        """图片生成（异步，立即返回 task_id）— 保留旧接口兼容"""
        try:
            return self.unified.generate_image_async(prompt, config)
        except AppError as e:
            return e.to_dict()
        except Exception as e:
            return UnknownError(str(e)).to_dict()

    def generate_image_async(self, prompt, config=None):
        """图片生成（异步，立即返回 task_id）— 保留旧接口兼容"""
        try:
            return self.unified.generate_image_async(prompt, config)
        except AppError as e:
            return e.to_dict()
        except Exception as e:
            return UnknownError(str(e)).to_dict()

    def get_task_result(self, task_id):
        """查询异步任务结果"""
        return self.unified.get_task_result(task_id)

    # ─────────────────────────────────────────
    # AI 视频生成（FluxPort 全异步；本期仅后端，前端未接 UI）
    # ─────────────────────────────────────────

    def generate_video(self, prompt, config=None):
        """视频生成（异步，立即返回 task_id）"""
        try:
            return self.video.generate_video_async(prompt, config)
        except AppError as e:
            return e.to_dict()
        except Exception as e:
            return UnknownError(str(e)).to_dict()

    def generate_video_async(self, prompt, config=None):
        """视频生成（异步，立即返回 task_id）— 兼容命名，同 generate_video"""
        try:
            return self.video.generate_video_async(prompt, config)
        except AppError as e:
            return e.to_dict()
        except Exception as e:
            return UnknownError(str(e)).to_dict()

    def get_video_task_result(self, task_id):
        """查询视频异步任务结果（中间态 queued/processing/pending_confirmation；终态 done）"""
        try:
            return self.video.get_video_task_result(task_id)
        except AppError as e:
            return e.to_dict()
        except Exception as e:
            return UnknownError(str(e)).to_dict()

    def unified_generate_video(self, prompt, options=None):
        """统一视频生成（异步，立即返回 task_id）"""
        try:
            return self.video.generate_video_async(prompt, options)
        except AppError as e:
            return e.to_dict()
        except Exception as e:
            return UnknownError(str(e)).to_dict()

    def unified_generate_video_sync(self, prompt, options=None):
        """统一视频生成（同步，阻塞等待结果；QA/console 直测用）"""
        try:
            return self.video.generate_video(prompt, options)
        except AppError as e:
            return e.to_dict()
        except Exception as e:
            return UnknownError(str(e)).to_dict()

    def unified_get_video_task_result(self, task_id):
        """查询视频异步任务结果"""
        try:
            return self.video.get_video_task_result(task_id)
        except AppError as e:
            return e.to_dict()
        except Exception as e:
            return UnknownError(str(e)).to_dict()

    # ─────────────────────────────────────────
    # Agent 对话（全部走 UnifiedAPIRouter）
    # ─────────────────────────────────────────

    def agent_chat(self, meta_prompt, user_input, config=None):
        """对话接口（自动组装 messages）— 保留旧接口兼容"""
        try:
            messages = []
            if meta_prompt and meta_prompt.strip():
                messages.append({"role": "system", "content": meta_prompt.strip()})
            if user_input and user_input.strip():
                messages.append({"role": "user", "content": user_input.strip()})
            return self.unified.chat(messages, config)
        except AppError as e:
            return e.to_dict()
        except Exception as e:
            return UnknownError(str(e)).to_dict()

    # ─────────────────────────────────────────
    # 统一 API 路由层（直接透传）
    # ─────────────────────────────────────────

    def unified_chat(self, messages, options=None):
        """统一对话接口（数组格式 messages）"""
        try:
            return self.unified.chat(messages, options)
        except AppError as e:
            return e.to_dict()
        except Exception as e:
            return UnknownError(str(e)).to_dict()

    def unified_chat_v2(self, user_input, options=None):
        """统一对话接口（简化版，自动组装 messages）"""
        try:
            return self.unified.chat_v2(user_input, options)
        except AppError as e:
            return e.to_dict()
        except Exception as e:
            return UnknownError(str(e)).to_dict()

    def unified_generate_image(self, prompt, options=None):
        """统一图片生成（异步，立即返回 task_id）"""
        try:
            return self.unified.generate_image_async(prompt, options)
        except AppError as e:
            return e.to_dict()
        except Exception as e:
            return UnknownError(str(e)).to_dict()

    def unified_generate_image_sync(self, prompt, options=None):
        """统一图片生成（同步，阻塞等待结果）"""
        try:
            return self.unified.generate_image(prompt, options)
        except AppError as e:
            return e.to_dict()
        except Exception as e:
            return UnknownError(str(e)).to_dict()

    def unified_get_task_result(self, task_id):
        """查询异步任务结果"""
        return self.unified.get_task_result(task_id)

    # ─────────────────────────────────────────
    # 图片处理
    # ─────────────────────────────────────────
    def save_image_to_local(self, img_url):
        return self.image.save_image_to_local(img_url)

    def prepare_imported_image(self, image_data, filename=None):
        """手动导入：保存原图并返回轻量缩略图；未配置保存目录时使用会话临时目录。"""
        # 不沿用用户原始文件名，避免重复导入同名文件时覆盖已保存的原图。
        return self.image.save_image_to_local(image_data, allow_temp=True)

    def save_image_as(self, image_data, filename=None):
        return self.image.save_image_as(image_data, filename)

    def load_local_image(self, file_path):
        return self.image.load_local_image(file_path)

    def outpaint(self, image_base64, direction, ratio, prompt,
                 provider_id, model_id='', resolution=None, mask_data=None):
        return self.image.outpaint(
            image_base64, direction, ratio, prompt,
            provider_id, model_id, resolution, mask_data
        )

    # ─────────────────────────────────────────
    # 剪贴板
    # ─────────────────────────────────────────
    def copy_to_clipboard(self, canvas_data):
        return self.clipboard.write_to_clipboard(canvas_data)

    def paste_from_clipboard(self):
        return self.clipboard.read_from_clipboard()

    # ─────────────────────────────────────────
    # 项目文件管理
    # ─────────────────────────────────────────
    def save_project(self, data):
        return self.project.save_project(data)

    def save_project_as(self, data):
        return self.project.save_project_as(data)

    def open_project_dialog(self):
        return self.project.open_project_dialog()

    def append_history(self, entry):
        """追加一条生成档案到 history.jsonl（前端构造 trace，后端 append 单行）"""
        return self.project.append_history(entry)

    def load_history(self):
        """读取 history.jsonl（打开项目时跨会话展示）"""
        return self.project.load_history()

    def save_assets(self, records):
        """保存可变资产索引（<项目名>.assets.json，原子写；采纳/锁定/tags/category）"""
        return self.project.save_assets(records)

    def load_assets(self):
        """读取可变资产索引（打开项目时恢复采纳/锁定状态）"""
        return self.project.load_assets()

    # ─────────────────────────────────────────
    # 设置
    # ─────────────────────────────────────────
    def load_settings(self):
        return self.settings.load_settings()

    def save_settings(self, settings):
        return self.settings.save_settings(settings)

    def select_folder(self):
        return self.settings.select_folder()

    # ─────────────────────────────────────────
    # 提示词库
    # ─────────────────────────────────────────
    def load_prompts_library(self):
        return self.settings.load_prompts_library()

    def save_prompts_library(self, data):
        return self.settings.save_prompts_library(data)

    # ─────────────────────────────────────────
    # 窗口控制（无边框自绘标题栏）
    # ─────────────────────────────────────────
    def win_minimize(self):
        """最小化窗口"""
        webview.windows[0].minimize()

    def win_toggle_maximize(self):
        """最大化 / 还原切换（W1-W4，Win32 手动贴当前屏工作区）。

        最大化：GetWindowRect 记录原矩形 → MonitorFromWindow + GetMonitorInfoW 取 rcWork
                → SetWindowPos 贴边（不遮任务栏，W1；多屏/DPI 贴合当前屏，W3）；
        还原：SetWindowPos 恢复原矩形（缺失时 ShowWindow SW_RESTORE 兜底，W2）。
        返回 {maximized: bool} 供前端切换 #win-max 图标（W4）。
        """
        hwnd = _get_window_hwnd()
        if self._win_maximized:
            self._restore_window(hwnd)
            self._win_maximized = False
            self._sync_win_icon(False)
            return {"maximized": False}

        # 最大化：先记录当前矩形（W2 还原基准）
        if hwnd:
            rect = _get_window_rect(hwnd)
            if rect:
                self._win_restore_rect = rect
            area = _get_monitor_work_area(hwnd)
            if area:
                _set_window_pos(hwnd, area)
            else:
                # 兜底：Win32 不可用时退回 pywebview 原生最大化（可能盖任务栏，属可接受降级）
                webview.windows[0].maximize()
        else:
            webview.windows[0].maximize()
        self._win_maximized = True
        self._sync_win_icon(True)
        return {"maximized": True}

    def win_is_maximized(self):
        """查询窗口是否处于最大化态（前端启动初始化 W4 图标）。

        以本应用标志位为主；系统级原生最大化（IsZoomed，如 Win+↑）只升不降，
        避免把「自定义贴工作区最大化」（非系统 Zoom 态，IsZoomed 为 False）误判为还原。
        """
        hwnd = _get_window_hwnd()
        if hwnd:
            try:
                if ctypes.windll.user32.IsZoomed(hwnd):
                    self._win_maximized = True
            except Exception:
                pass
        return {"maximized": self._win_maximized}

    def win_move_relative(self, dx, dy):
        """按增量移动窗口（自实现顶栏拖动专用，B1）。

        与 pywebview 官方 drag-region 的差异：drag-region 用「绝对坐标 = screenX - initialX」，
        与假最大化（SetWindowPos 贴工作区，非系统 Maximized 态）交互存在已知坑——最大化态可被
        拖走导致标志位/位置漂移，还原后再拖失效。本方法改为「相对当前左上角增量移动」：
        任何窗口状态下都自洽；最大化状态下直接拒绝（前端同时锁定，双保险，避免假最大化窗口被拖走）。
        dx/dy 为逻辑像素（CSS px），按当前显示器 DPI 换算物理像素后 SetWindowPos 相对移动。
        返回 {"ok": bool}（供前端静默失败；最大化/无句柄/失败返回 ok=False）。
        """
        if self._win_maximized:
            return {"ok": False}
        hwnd = _get_window_hwnd()
        if not hwnd:
            return {"ok": False}
        rect = _get_window_rect(hwnd)
        if not rect:
            return {"ok": False}
        try:
            scale = _get_dpi_scale(hwnd)
        except Exception:
            scale = 1.0
        new_left = rect[0] + int(float(dx) * scale)
        new_top = rect[1] + int(float(dy) * scale)
        ok = _set_window_pos(hwnd, (new_left, new_top, rect[2], rect[3]))
        return {"ok": ok}

    def _restore_window(self, hwnd):
        """还原窗口到最大化前矩形；无记录/无句柄时兜底 ShowWindow(SW_RESTORE=9)"""
        if hwnd:
            if self._win_restore_rect:
                _set_window_pos(hwnd, self._win_restore_rect)
            else:
                try:
                    ctypes.windll.user32.ShowWindow(hwnd, 9)  # SW_RESTORE
                except Exception:
                    pass
        else:
            try:
                webview.windows[0].restore()
            except Exception:
                pass

    def _sync_win_icon(self, maximized):
        """evaluate_js 同步前端 #win-max 图标（W2 脱节兜底：覆盖系统手势等返回值之外的路径）。

        未响应修复：evaluate_js 是同步阻塞调用（等待 JS 主线程执行完），而 maximized/restored
        事件在 GUI 线程触发，JS 忙时直接调用会卡死窗口；改为 daemon 后台线程 fire-and-forget，
        只阻塞后台线程，GUI 线程保持响应。图标主路径本就由前端 win_toggle_maximize 返回值同步。
        """
        def _run():
            try:
                webview.windows[0].evaluate_js(
                    f'window.__icvWinMaxState && window.__icvWinMaxState({str(bool(maximized)).lower()})'
                )
            except Exception:
                pass
        threading.Thread(target=_run, daemon=True).start()

    def _on_win_maximized(self):
        """pywebview events.maximized：窗口进入系统最大化态 → 同步标志位与图标（W2 脱节兜底）"""
        self._win_maximized = True
        self._sync_win_icon(True)

    def _on_win_restored(self):
        """pywebview events.restored：窗口退出最大化态 → 同步标志位与图标（W2 脱节兜底）"""
        self._win_maximized = False
        self._sync_win_icon(False)

    def win_close(self):
        """强制关闭入口：由前端 requestClose 决定后调用（_closing_forced 标志绕过 closing 拦截）"""
        self._closing_forced = True
        try:
            webview.windows[0].destroy()
        finally:
            self._closing_forced = False

    def win_set_dirty(self, dirty):
        """前端上报 dirty 状态（关闭未响应修复）：closing 事件读此缓存，避免同步 evaluate_js 卡死 GUI 线程。

        由前端 close-guard 在 flowState 变更时主动调用（含 pywebview 就绪后的初始上报）。
        """
        self._cached_dirty = bool(dirty)
        self._dirty_reported = True
        return True

    def _request_close_async(self):
        """后台线程触发前端三选一弹窗（__icvRequestClose）。

        evaluate_js 是同步阻塞调用（等待 JS 主线程执行完）；在 GUI 线程直接调用会在 JS 忙于
        渲染大图时卡死窗口（未响应）。放到 daemon 后台线程后只阻塞该线程，GUI 线程保持响应，
        JS 空闲后弹窗自然出现。前端 closeGuard.requestClose() 自带 prompting 去重，重复触发无害；
        且 requestClose 内部会再校验真实 dirty（缓存脏读时干净项目会立即关闭，不弹多余确认）。
        """
        def _run():
            try:
                webview.windows[0].evaluate_js(
                    'window.__icvRequestClose && window.__icvRequestClose()'
                )
            except Exception:
                pass
        threading.Thread(target=_run, daemon=True).start()

    def _on_closing(self):
        """窗口关闭拦截：dirty=true 时阻止关闭并触发前端三选一弹窗；_closing_forced 时放行。

        返回 False 表示阻止关闭（pywebview closing 事件契约）。
        未响应修复：不再在 GUI 线程同步 evaluate_js（等待 JS 主线程执行完，渲染大图时会卡死窗口），
        改为读取前端主动上报的 dirty 缓存；确认 dirty 后经后台线程触发前端弹窗。
        """
        if self._closing_forced:
            return True
        if not self._dirty_reported:
            # 前端尚未上报（页面未加载完/已崩溃）：回退旧同步查询；异常即放行，避免窗口无法关闭
            try:
                is_dirty = webview.windows[0].evaluate_js(
                    'window.__icvIsDirty ? window.__icvIsDirty() : false'
                )
                if is_dirty:
                    webview.windows[0].evaluate_js(
                        'window.__icvRequestClose && window.__icvRequestClose()'
                    )
                    return False  # 阻止关闭，等待前端三选一弹窗
            except Exception:
                pass  # 前端未就绪时放行，避免窗口卡死无法关闭
            return True
        # 前端已上报：读缓存（近似实时），绝不同步等待 JS
        if self._cached_dirty:
            self._request_close_async()
            return False  # 阻止关闭，前端稍后弹三选一（requestClose 内部会再校验真实 dirty）
        return True


# ─────────────────────────────────────────
# 启动应用
# ─────────────────────────────────────────
def build_frontend_for_development():
    """在源码模式启动前构建 TS；打包后的 EXE 不会执行这里。"""
    npm = 'npm.cmd' if os.name == 'nt' else 'npm'
    npm_path = shutil.which(npm)
    if not npm_path:
        # 未找到 Node.js/npm 时，若前端已构建过则直接复用，避免因 PATH 缺 npm 阻塞启动
        if os.path.exists(INDEX_HTML):
            print('[Infinite Canvas] 未找到 Node.js/npm，但前端已构建，跳过编译，直接使用现有 dist')
            return
        raise RuntimeError('未找到 Node.js/npm，无法编译 TypeScript 前端')

    print('[Infinite Canvas] 正在编译 TypeScript 前端...')
    result = subprocess.run(
        [npm_path, 'run', 'build'],
        cwd=APP_DIR,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError('TypeScript 前端编译失败，请查看上方错误')


def _apply_rounded_corners():
    """Windows 11 无边框窗口圆角补偿：用 DWM 接口把圆角要回来（无边框窗口可能变直角 + 丢阴影）。

    句柄取自 pywebview native（_get_window_hwnd），不再依赖 FindWindowW 标题匹配。
    Win10 等不支持的环境会被 try/except 静默跳过（直角属可接受差异）。
    """
    try:
        import ctypes
        hwnd = _get_window_hwnd()
        if hwnd:
            pref = ctypes.c_int(2)  # DWMWCP_ROUND：强制圆角
            # 33 = DWMWA_WINDOW_CORNER_PREFERENCE
            ctypes.windll.dwmapi.DwmSetWindowAttribute(hwnd, 33, ctypes.byref(pref), 4)
    except Exception:
        pass  # Win10 等不支持的环境静默跳过


def main():
    if not getattr(sys, 'frozen', False):
        build_frontend_for_development()

    init_user_data()

    if not os.path.exists(INDEX_HTML):
        raise FileNotFoundError(f'前端入口不存在：{INDEX_HTML}')

    api    = InfiniteCanvasAPI()
    window = webview.create_window(
        title     = 'Infinite Canvas 1.0',
        url       = INDEX_HTML,
        js_api    = api,
        width     = 1400,
        height    = 900,
        resizable = True,
        min_size  = (800, 600),
        frameless = True,      # 新增：去掉 Windows 原生标题栏，改由前端自绘顶栏
        easy_drag = False      # 必须关掉：默认会在"按住任意位置"时拖动整个窗口，
                               # 会和画布平移/框选冲突；拖拽改由 pywebview 官方
                               # drag-region 机制接管（顶栏 .pywebview-drag-region）
    )

    # Win11 无边框窗口圆角补偿：start 前 hwnd 可能尚未生成，直接调用未必生效，
    # 因此注册 shown 事件（窗口显示后再设置，可靠路径），并提前尝试一次（hwnd 已存在时立即生效）。
    window.events.shown += _apply_rounded_corners
    _apply_rounded_corners()

    # 关闭保护：dirty 时拦截（返回 False 阻止关闭并触发前端三选一弹窗）
    window.events.closing += api._on_closing

    # W2 脱节兜底：系统手势（Win+↑/↓ 等）进入/退出最大化时同步 _win_maximized 与前端图标。
    # pywebview 6.2.1 WinForms 后端已在 winforms.py 的 on_resize 中 set() 这两个事件（实测支持）；
    # 若某版本不支持，try/except 静默跳过 → 降级为仅 win_toggle_maximize / win_is_maximized 同步（设计 §5.1）。
    try:
        window.events.maximized += api._on_win_maximized
    except Exception:
        pass
    try:
        window.events.restored += api._on_win_restored
    except Exception:
        pass

    webview.start(debug=getattr(sys, 'frozen', False) == False)


if __name__ == '__main__':
    main()
