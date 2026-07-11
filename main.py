"""
Infinite Canvas - 应用入口
"""
import sys
import io
import os
import shutil
import json
import subprocess

import webview

from backend.api.provider_api  import ProviderAPI
from backend.api.unified_api   import UnifiedAPIRouter
from backend.api.image_api     import ImageAPI
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
# 统一 API 类（所有 AI 逻辑统一走 UnifiedAPIRouter）
# ─────────────────────────────────────────
class InfiniteCanvasAPI:

    def __init__(self):
        self.provider  = ProviderAPI(PROVIDERS_FILE)
        self.settings  = SettingsAPI(SETTINGS_FILE, PROMPTS_FILE)
        self.unified   = UnifiedAPIRouter(self.provider)
        self.image     = ImageAPI(self.settings, self.unified)
        self.clipboard = ClipboardAPI()
        self.project   = ProjectAPI()

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
    def add_chat_model(self, provider_id, model_id, model_name):
        return self.provider.add_chat_model(provider_id, model_id, model_name)

    def remove_model(self, provider_id, model_id):
        return self.provider.remove_model(provider_id, model_id)

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
# 启动应用
# ─────────────────────────────────────────
def build_frontend_for_development():
    """在源码模式启动前构建 TS；打包后的 EXE 不会执行这里。"""
    npm = 'npm.cmd' if os.name == 'nt' else 'npm'
    npm_path = shutil.which(npm)
    if not npm_path:
        raise RuntimeError('未找到 Node.js/npm，无法编译 TypeScript 前端')

    print('[Infinite Canvas] 正在编译 TypeScript 前端...')
    result = subprocess.run(
        [npm_path, 'run', 'build'],
        cwd=APP_DIR,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError('TypeScript 前端编译失败，请查看上方错误')


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
        min_size  = (800, 600)
    )

    webview.start(debug=getattr(sys, 'frozen', False) == False)


if __name__ == '__main__':
    main()
