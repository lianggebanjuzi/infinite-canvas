# backend/api/settings_api.py
"""
设置管理 API
负责加载和保存应用设置、提示词库读写
"""

import base64
import json
import os
import re
import time
import uuid
from tkinter import filedialog

from backend.api.utils import atomic_write_json, get_tk_root


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

# 4.3-A 的新格式。内置素材刻意为空：后续若增加示例，必须是本项目原创的
# PromptCard，不能把任何参考产品的文字或封面带进安装包。
PROMPT_LIBRARY_VERSION = 2
DEFAULT_PROMPT_LIBRARY_V2 = {
    "version": PROMPT_LIBRARY_VERSION,
    "categories": [],
    "cards": [],
    "hiddenBuiltinIds": [],
}




class SettingsAPI:

    def __init__(self, settings_file, prompts_file):
        self.settings_file        = settings_file
        self.prompts_library_file = prompts_file

    def prompt_covers_dir(self):
        return os.path.join(os.path.dirname(self.prompts_library_file), 'prompt_covers')

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
        """保存设置。image_save_path 做归一（strip + abspath，P6）与目录校验（不存在创建 / 非目录报错 / 写探针可写，P4）。

        空字符串允许（= 未配置，生成图走「不落盘」降级提示）；校验失败返回人话 error。
        """
        print("正在保存设置...")
        try:
            normalized = dict(settings or {})
            if 'image_save_path' in normalized:
                normalized['image_save_path'] = self._normalize_image_save_path(normalized.get('image_save_path'))
            with open(self.settings_file, 'w', encoding='utf-8') as f:
                json.dump(normalized, f, ensure_ascii=False, indent=4)
            return {"status": "success", "message": "设置已保存"}
        except ValueError as e:
            return {"status": "error", "message": str(e)}
        except Exception as e:
            print(f"保存设置失败: {e}")
            return {"status": "error", "message": f"保存设置失败：{e}"}

    # ─────────────────────────────────────────
    # 4.3-C 最近项目（设置文件内的显示索引；绝不删除项目文件）
    # ─────────────────────────────────────────
    def load_recent_projects(self):
        settings = self.load_settings() or {}
        return {"status": "success", "projects": self._normalize_recent_projects(settings.get('recent_projects'))}

    def touch_recent_project(self, path, name='', cover_path=None):
        if not isinstance(path, str) or not path.strip():
            return {"status": "error", "message": "项目路径无效"}
        settings = self.load_settings() or {}
        absolute = os.path.abspath(path)
        old = self._normalize_recent_projects(settings.get('recent_projects'))
        existing = next((item for item in old if item['path'] == absolute), {})
        item = {"path": absolute, "name": str(name or existing.get('name') or os.path.splitext(os.path.basename(absolute))[0]).strip()[:120], "lastOpenedAt": int(time.time() * 1000)}
        candidate_cover = cover_path if isinstance(cover_path, str) else existing.get('coverPath')
        if candidate_cover: item['coverPath'] = candidate_cover
        settings['recent_projects'] = ([item] + [record for record in old if record['path'] != absolute])[:30]
        return self.save_settings(settings)

    def remove_recent_project(self, path):
        if not isinstance(path, str): return {"status": "error", "message": "项目路径无效"}
        settings = self.load_settings() or {}; absolute = os.path.abspath(path)
        settings['recent_projects'] = [item for item in self._normalize_recent_projects(settings.get('recent_projects')) if item['path'] != absolute]
        return self.save_settings(settings)

    def rename_recent_project(self, path, name):
        if not isinstance(path, str) or not isinstance(name, str) or not name.strip(): return {"status": "error", "message": "显示名称不能为空"}
        settings = self.load_settings() or {}; absolute = os.path.abspath(path); records = self._normalize_recent_projects(settings.get('recent_projects'))
        for item in records:
            if item['path'] == absolute:
                item['name'] = name.strip()[:120]; settings['recent_projects'] = records; return self.save_settings(settings)
        return {"status": "error", "message": "最近项目记录不存在"}

    @staticmethod
    def _normalize_recent_projects(value):
        if not isinstance(value, list): return []
        result, seen = [], set()
        for raw in value:
            if not isinstance(raw, dict) or not isinstance(raw.get('path'), str): continue
            path = os.path.abspath(raw['path'].strip())
            if not path or path in seen: continue
            seen.add(path)
            item = {'path': path, 'name': str(raw.get('name') or os.path.splitext(os.path.basename(path))[0]).strip()[:120] or '未命名项目', 'lastOpenedAt': int(raw.get('lastOpenedAt')) if isinstance(raw.get('lastOpenedAt'), (int, float)) else 0}
            if isinstance(raw.get('coverPath'), str) and raw['coverPath'].strip(): item['coverPath'] = raw['coverPath'].strip()
            result.append(item)
            if len(result) >= 30: break
        return result

    def _normalize_image_save_path(self, raw):
        """路径归一 + 目录校验（P4/P6）：
        - strip 首尾空格；空字符串 → ''（允许未配置）
        - 非空 → os.path.abspath 归一为绝对路径
        - 目录不存在 → 尝试创建；存在但非目录 → 报错；写探针验证可写 → 报错
        返回归一后的路径字符串；校验失败抛 ValueError（人话 message）。
        """
        if raw is None:
            return ''
        raw_str = str(raw).strip()
        if not raw_str:
            return ''
        path = os.path.abspath(raw_str)
        if os.path.exists(path):
            if not os.path.isdir(path):
                raise ValueError(f'「{path}」不是有效的目录')
        else:
            try:
                os.makedirs(path, exist_ok=True)
            except Exception as e:
                raise ValueError(f'目录不存在且无法创建：{e}')
        # 写探针：验证目录可写（P4）
        probe = os.path.join(path, '.icv_write_probe')
        try:
            with open(probe, 'w', encoding='utf-8') as f:
                f.write('ok')
            os.remove(probe)
        except Exception as e:
            raise ValueError(f'目录不可写：{e}')
        return path

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
                self._write_prompts_library(DEFAULT_PROMPT_LIBRARY_V2)
                return {"status": "success", "data": DEFAULT_PROMPT_LIBRARY_V2}

            with open(self.prompts_library_file, 'r', encoding='utf-8') as f:
                raw = json.load(f)
            data, migrated = self._normalize_prompt_library(raw)
            if migrated:
                self._write_prompts_library(data)
            return {"status": "success", "data": data}
        except Exception as e:
            print(f"加载提示词库失败: {e}")
            return {"status": "success", "data": DEFAULT_PROMPT_LIBRARY_V2}

    def save_prompts_library(self, data):
        """
        保存提示词库
        data 格式: {"common": [...], "skill": [...], "draw": [...]}
        """
        print("正在保存提示词库...")
        try:
            normalized, _ = self._normalize_prompt_library(data)
            self._write_prompts_library(normalized)
            return {"status": "success"}
        except Exception as e:
            print(f"保存提示词库失败: {e}")
            return {"status": "error", "message": str(e)}

    def _write_prompts_library(self, data):
        directory = os.path.dirname(self.prompts_library_file)
        if directory:
            os.makedirs(directory, exist_ok=True)
        atomic_write_json(self.prompts_library_file, data)

    def _normalize_prompt_library(self, raw):
        """兼容旧 common/skill/draw 与 favorites 字符串，不丢已有收藏。"""
        if not isinstance(raw, dict):
            return dict(DEFAULT_PROMPT_LIBRARY_V2), True
        cards_raw = raw.get('cards')
        now = int(time.time() * 1000)
        if isinstance(cards_raw, list):
            cards = []
            seen = set()
            for item in cards_raw:
                card = self._normalize_prompt_card(item, now)
                if card and card['id'] not in seen:
                    seen.add(card['id'])
                    cards.append(card)
            data = {
                "version": PROMPT_LIBRARY_VERSION,
                "categories": self._normalize_categories(raw.get('categories')),
                "cards": cards,
                "hiddenBuiltinIds": self._string_list(raw.get('hiddenBuiltinIds')),
            }
            return data, raw != data

        # 旧收藏是唯一有明确用户归属的数据：迁移成 user 卡；旧分类项保留为 builtin
        # 以免升级时静默丢掉用户以前可见的预置条目。
        cards = []
        seen_prompts = set()
        for text in self._string_list(raw.get('favorites')):
            prompt = text.strip()
            if prompt and prompt not in seen_prompts:
                seen_prompts.add(prompt)
                cards.append(self._new_prompt_card(prompt, now, source='user', favorite=True))
        for category_id in ('common', 'skill', 'draw'):
            for item in raw.get(category_id, []) if isinstance(raw.get(category_id), list) else []:
                if not isinstance(item, dict):
                    continue
                prompt = str(item.get('content') or '').strip()
                if not prompt or prompt in seen_prompts:
                    continue
                seen_prompts.add(prompt)
                cards.append({
                    "id": str(item.get('id') or uuid.uuid4().hex),
                    "title": str(item.get('name') or '未命名提示词'),
                    "prompt": prompt,
                    "tags": [], "favorite": False,
                    "createdAt": now, "updatedAt": now, "source": "builtin",
                    "categoryId": category_id,
                })
        return {
            "version": PROMPT_LIBRARY_VERSION,
            "categories": [], "cards": cards, "hiddenBuiltinIds": [],
        }, True

    def _new_prompt_card(self, prompt, now, source='user', favorite=True):
        return {
            "id": uuid.uuid4().hex, "title": self._title_for_prompt(prompt), "prompt": prompt,
            "tags": [], "favorite": favorite, "createdAt": now, "updatedAt": now,
            "source": source,
        }

    def _normalize_prompt_card(self, item, fallback_time):
        if not isinstance(item, dict):
            return None
        prompt = str(item.get('prompt') or item.get('content') or '').strip()
        if not prompt:
            return None
        source = item.get('source') if item.get('source') in ('builtin', 'user') else 'user'
        result = {
            "id": str(item.get('id') or uuid.uuid4().hex),
            "title": str(item.get('title') or item.get('name') or self._title_for_prompt(prompt)).strip()[:120],
            "prompt": prompt,
            "tags": self._string_list(item.get('tags')),
            "favorite": bool(item.get('favorite', False)),
            "createdAt": self._timestamp(item.get('createdAt'), fallback_time),
            "updatedAt": self._timestamp(item.get('updatedAt'), fallback_time),
            "source": source,
        }
        for key in ('summary', 'categoryId', 'coverPath'):
            value = item.get(key)
            if isinstance(value, str) and value.strip():
                result[key] = value.strip()
        return result

    @staticmethod
    def _string_list(value):
        if not isinstance(value, list):
            return []
        return list(dict.fromkeys(str(item).strip() for item in value if isinstance(item, str) and item.strip()))

    @staticmethod
    def _timestamp(value, fallback):
        return int(value) if isinstance(value, (int, float)) and value > 0 else fallback

    @staticmethod
    def _title_for_prompt(prompt):
        return re.sub(r'\s+', ' ', prompt).strip()[:40] or '未命名提示词'

    def _normalize_categories(self, value):
        if not isinstance(value, list):
            return []
        result, seen = [], set()
        for item in value:
            if not isinstance(item, dict):
                continue
            ident = str(item.get('id') or '').strip()
            name = str(item.get('name') or '').strip()
            if ident and name and ident not in seen:
                seen.add(ident)
                result.append({'id': ident, 'name': name[:80]})
        return result

    def save_prompt_cover(self, data_url, filename='cover'):
        """将封面作为本地副本保存，拒绝远端 URL 与非图片数据。"""
        try:
            if not isinstance(data_url, str) or not data_url.startswith('data:image/'):
                return {"status": "error", "message": "封面必须是本地图片"}
            header, encoded = data_url.split(',', 1)
            mime = header.split(';', 1)[0].lower()
            ext = {"data:image/png": '.png', "data:image/jpeg": '.jpg', "data:image/webp": '.webp', "data:image/gif": '.gif'}.get(mime)
            if not ext:
                return {"status": "error", "message": "仅支持 PNG、JPG、WebP 或 GIF 封面"}
            raw = base64.b64decode(encoded, validate=True)
            if len(raw) == 0 or len(raw) > 12 * 1024 * 1024:
                return {"status": "error", "message": "封面文件必须大于 0 且不超过 12 MB"}
            directory = self.prompt_covers_dir()
            os.makedirs(directory, exist_ok=True)
            path = os.path.join(directory, f'{uuid.uuid4().hex}{ext}')
            with open(path + '.tmp', 'wb') as f:
                f.write(raw)
                f.flush()
                os.fsync(f.fileno())
            os.replace(path + '.tmp', path)
            return {"status": "success", "path": path}
        except (ValueError, IndexError):
            return {"status": "error", "message": "封面数据无效"}
        except Exception as e:
            print(f"保存提示词封面失败: {e}")
            return {"status": "error", "message": "保存封面失败"}
