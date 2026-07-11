# backend/api/settings_api.py
"""
设置管理 API
负责加载和保存应用设置、提示词库读写
"""

import json
import os
from tkinter import filedialog

from backend.api.utils import get_tk_root


# ─────────────────────────────────────────
# 提示词库默认数据
# ─────────────────────────────────────────
DEFAULT_PROMPTS_LIBRARY = {
    "common": [
        {"id": "c1", "name": "专业助理",   "content": "你是一名专业助理，回答简洁、准确，使用中文。"},
        {"id": "c2", "name": "文案优化师", "content": "你是一名资深文案优化师，帮助用户改进文字表达，使其更加生动、专业。"},
        {"id": "c3", "name": "代码审查员", "content": "你是一名高级工程师，专注于代码质量和最佳实践，给出具体的改进建议。"},
        {"id": "c4", "name": "翻译专家",   "content": "你是一名翻译专家，将用户提供的内容准确翻译成目标语言，保留原文风格。"},
        {"id": "c5", "name": "内容总结员", "content": "你是一名内容总结专家，将长文本提炼为结构清晰的摘要，突出核心要点。"}
    ],
    "skill": [
        {"id": "s1", "name": "宣传片风格开头", "content": "以震撼的宣传片风格开场，用简短有力的句子吸引注意力，营造强烈的视觉感。"},
        {"id": "s2", "name": "统一 Emoji 风格", "content": "在回答中适当加入 Emoji 表情，使内容更加生动活泼，风格保持统一。"},
        {"id": "s3", "name": "输出 Markdown",   "content": "使用 Markdown 格式输出，包含标题、列表和代码块，结构清晰易读。"},
        {"id": "s4", "name": "逐步分析",         "content": "请逐步分析问题，先理解需求，再给出思路，最后提供完整方案。"},
        {"id": "s5", "name": "批判性思考",       "content": "从多角度分析，指出潜在问题和风险，给出平衡的建议。"}
    ],
    "draw": [
        {"id": "d1", "name": "写实摄影风",   "content": "photorealistic, 8K resolution, professional photography, sharp focus, natural lighting"},
        {"id": "d2", "name": "赛博朋克",     "content": "cyberpunk style, neon lights, futuristic city, dark atmosphere, cinematic"},
        {"id": "d3", "name": "水彩插画",     "content": "watercolor illustration, soft colors, artistic, hand-painted style, dreamy"},
        {"id": "d4", "name": "极简主义",     "content": "minimalist design, clean composition, simple shapes, white background, elegant"},
        {"id": "d5", "name": "负面提示词",   "content": "ugly, blurry, low quality, distorted, deformed, bad anatomy, watermark"}
    ]
}




class SettingsAPI:

    def __init__(self, settings_file, prompts_file):
        self.settings_file        = settings_file
        self.prompts_library_file = prompts_file

    # ─────────────────────────────────────────
    # 应用设置
    # ─────────────────────────────────────────

    def load_settings(self):
        """加载设置"""
        print("正在加载设置...")
        try:
            if not os.path.exists(self.settings_file):
                return {
                    "image_save_path":      "",
                    "default_project_path": ""
                }
            with open(self.settings_file, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"加载设置失败: {e}")
            return {"image_save_path": "", "default_project_path": ""}

    def save_settings(self, settings):
        """保存设置"""
        print("正在保存设置...")
        try:
            with open(self.settings_file, 'w', encoding='utf-8') as f:
                json.dump(settings, f, ensure_ascii=False, indent=4)
            return {"status": "success", "message": "设置已保存"}
        except Exception as e:
            print(f"保存设置失败: {e}")
            return {"status": "error", "message": str(e)}

    def select_folder(self):
        """打开文件夹选择对话框"""
        try:
            root        = get_tk_root()
            folder_path = filedialog.askdirectory(
                title      = '选择文件夹',
                initialdir = os.path.expanduser('~')
            )
            root.destroy()

            if folder_path:
                return {"status": "success", "path": folder_path}
            return {"status": "cancelled"}
        except Exception as e:
            print(f"选择文件夹失败: {e}")
            return {"status": "error", "message": str(e)}

    # ─────────────────────────────────────────
    # 提示词库
    # ─────────────────────────────────────────

    def load_prompts_library(self):
        """
        加载提示词库
        文件不存在时返回内置默认数据并写入文件
        """
        print("正在加载提示词库...")
        try:
            if not os.path.exists(self.prompts_library_file):
                self._write_prompts_library(DEFAULT_PROMPTS_LIBRARY)
                return {"status": "success", "data": DEFAULT_PROMPTS_LIBRARY}

            with open(self.prompts_library_file, 'r', encoding='utf-8') as f:
                data = json.load(f)

            for key in ('common', 'skill', 'draw'):
                if key not in data:
                    data[key] = DEFAULT_PROMPTS_LIBRARY[key]

            return {"status": "success", "data": data}
        except Exception as e:
            print(f"加载提示词库失败: {e}")
            return {"status": "success", "data": DEFAULT_PROMPTS_LIBRARY}

    def save_prompts_library(self, data):
        """
        保存提示词库
        data 格式: {"common": [...], "skill": [...], "draw": [...]}
        """
        print("正在保存提示词库...")
        try:
            self._write_prompts_library(data)
            return {"status": "success"}
        except Exception as e:
            print(f"保存提示词库失败: {e}")
            return {"status": "error", "message": str(e)}

    def _write_prompts_library(self, data):
        with open(self.prompts_library_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=4)
