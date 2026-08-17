# backend/api/image_api.py
"""
图片处理 API
"""

import base64
import os
import requests
from datetime import datetime

from backend.api.gemini_compat import resolve_image_api_base


class ImageAPI:

    def __init__(self, settings_api, unified_api=None):
        self.settings_api = settings_api
        self.unified_api  = unified_api

    # ─────────────────────────────────────────
    # 保存图片到本地
    # ─────────────────────────────────────────

    def save_image_to_local(self, image_data, filename=None):
        try:
            from PIL import Image
            import io
            
            # 类型检查：确保 image_data 是字符串
            if not isinstance(image_data, str):
                return {"status": "error", "message": "图片数据格式无效，需要字符串"}

            settings  = self.settings_api.load_settings()
            save_path = settings.get('image_save_path', '')

            if not save_path:
                return {"status": "skipped", "message": "未设置图片保存路径"}

            if not os.path.exists(save_path):
                os.makedirs(save_path)

            if not filename:
                timestamp = datetime.now().strftime('%Y%m%d_%H%M%S_%f')
                filename  = f"image_{timestamp}.png"

            file_path = os.path.join(save_path, filename)

            if image_data.startswith('data:image'):
                header, base64_data = image_data.split(',', 1)
                image_bytes = base64.b64decode(base64_data)
                with open(file_path, 'wb') as f:
                    f.write(image_bytes)

            elif image_data.startswith('http'):
                response = requests.get(image_data, timeout=30)
                if response.status_code == 200:
                    with open(file_path, 'wb') as f:
                        f.write(response.content)
                else:
                    return {
                        "status":  "error",
                        "message": f"下载图片失败: HTTP {response.status_code}"
                    }
            else:
                return {"status": "error", "message": "不支持的图片格式"}

            # 生成缩略图
            thumb_path = self._generate_thumbnail(file_path)

            print(f"图片已保存: {file_path}")
            safe_path = file_path.replace('\\', '/')
            safe_thumb = thumb_path.replace('\\', '/') if thumb_path else None
            
            return {
                "status": "success",
                "path":   file_path,
                "url":    f"file:///{safe_path}",
                "thumbnail": f"file:///{safe_thumb}" if safe_thumb else None
            }

        except Exception as e:
            print(f"保存图片失败: {e}")
            return {"status": "error", "message": str(e)}

    # ─────────────────────────────────────────
    # 另存为（让用户选择保存路径）
    # ─────────────────────────────────────────
    def save_image_as(self, image_data, filename=None):
        """打开文件夹选择对话框，让用户选择保存路径"""
        try:
            from tkinter import filedialog
            from tkinter import Tk as TkClass
            import io

            # 类型检查：确保 image_data 是字符串
            if not isinstance(image_data, str):
                return {"status": "error", "message": "图片数据格式无效，需要字符串"}

            # 创建临时 tkinter 根窗口用于对话框
            root = TkClass()
            root.withdraw()
            root.attributes('-topmost', True)

            folder_path = filedialog.askdirectory(
                title='选择保存文件夹',
                initialdir=self.settings_api.load_settings().get('image_save_path', '')
            )

            root.destroy()

            if not folder_path:
                return {"status": "cancelled", "message": "用户取消了操作"}

            if not os.path.exists(folder_path):
                os.makedirs(folder_path)

            if not filename:
                timestamp = datetime.now().strftime('%Y%m%d_%H%M%S_%f')
                filename = f"image_{timestamp}.png"

            file_path = os.path.join(folder_path, filename)

            if image_data.startswith('data:image'):
                header, base64_data = image_data.split(',', 1)
                image_bytes = base64.b64decode(base64_data)
                with open(file_path, 'wb') as f:
                    f.write(image_bytes)

            elif image_data.startswith('http'):
                response = requests.get(image_data, timeout=30)
                if response.status_code == 200:
                    with open(file_path, 'wb') as f:
                        f.write(response.content)
                else:
                    return {
                        "status": "error",
                        "message": f"下载图片失败: HTTP {response.status_code}"
                    }
            else:
                return {"status": "error", "message": "不支持的图片格式"}

            print(f"[ImageAPI] 图片已另存为: {file_path}")
            safe_path = file_path.replace('\\', '/')

            return {
                "status": "success",
                "path": file_path,
                "url": f"file:///{safe_path}",
                "message": f"图片已保存到: {file_path}"
            }

        except Exception as e:
            print(f"另存图片失败: {e}")
            return {"status": "error", "message": str(e)}

    # ─────────────────────────────────────────
    # 生成缩略图（内部方法）
    # ─────────────────────────────────────────
    def _generate_thumbnail(self, image_path, max_size=800):
        try:
            from PIL import Image
            
            base_name = os.path.splitext(image_path)[0]
            thumb_path = f"{base_name}_thumb.jpg"
            
            img = Image.open(image_path)
            img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
            img.convert('RGB').save(thumb_path, 'JPEG', quality=85, optimize=True)
            
            print(f"缩略图已生成: {thumb_path}")
            return thumb_path
        except Exception as e:
            print(f"生成缩略图失败: {e}")
            return None

    # ─────────────────────────────────────────
    # 读取本地图片
    # ─────────────────────────────────────────

    def load_local_image(self, file_path):
        try:
            clean_path = file_path
            if clean_path.startswith('file:///'):
                clean_path = clean_path[8:]
            elif clean_path.startswith('file://'):
                clean_path = clean_path[7:]

            if len(clean_path) > 2 and clean_path[0] == '/' and clean_path[2] == ':':
                clean_path = clean_path[1:]

            clean_path = clean_path.replace('/', os.sep)

            if not os.path.exists(clean_path):
                print(f"文件不存在: {clean_path}")
                return {"status": "error", "message": "文件不存在"}

            with open(clean_path, 'rb') as f:
                image_bytes = f.read()

            base64_data = base64.b64encode(image_bytes).decode('utf-8')

            ext      = os.path.splitext(clean_path)[1].lower()
            mime_map = {
                '.png':  'image/png',
                '.jpg':  'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.webp': 'image/webp',
                '.gif':  'image/gif'
            }
            mime = mime_map.get(ext, 'image/png')

            print(f"本地图片已读取: {clean_path}")
            return {
                "status":   "success",
                "data_url": f"data:{mime};base64,{base64_data}"
            }

        except Exception as e:
            print(f"读取本地图片失败: {e}")
            return {"status": "error", "message": str(e)}

    # ─────────────────────────────────────────
    # AI 扩图
    # ─────────────────────────────────────────

    def outpaint(self, image_base64, direction, ratio,
                 prompt, provider_id, model_id='', resolution=None, user_mask=None):
        try:
            import io
            from PIL import Image

            data      = self.unified_api.provider_api.load_providers()
            providers = data.get('providers', [])
            provider  = next(
                (p for p in providers if p['id'] == provider_id), None
            )
            if not provider:
                return {"success": False, "error": f"未找到供应商: {provider_id}"}

            api_url = provider.get('api_url', '').rstrip('/')
            api_key = provider.get('api_key', '')
            if ',' in api_key:
                api_key = api_key.split(',')[0].strip()

            print(f"[ImageAPI] outpaint provider={provider_id} "
                  f"model={model_id} direction={direction} ratio={ratio}%")

            raw_b64     = image_base64.split(',', 1)[1] \
                          if ',' in image_base64 else image_base64
            image_bytes = base64.b64decode(raw_b64)
            orig_img    = Image.open(io.BytesIO(image_bytes)).convert('RGBA')
            orig_w, orig_h = orig_img.size

            scale    = int(ratio) / 100
            expand_w = int(orig_w * scale)
            expand_h = int(orig_h * scale)

            offset_map = {
                'all':        (expand_w, expand_h, orig_w + expand_w * 2, orig_h + expand_h * 2),
                'horizontal': (expand_w, 0,         orig_w + expand_w * 2, orig_h              ),
                'vertical':   (0,        expand_h,  orig_w,                orig_h + expand_h * 2),
                'left':       (expand_w, 0,         orig_w + expand_w,     orig_h              ),
                'right':      (0,        0,          orig_w + expand_w,     orig_h              ),
                'top':        (0,        expand_h,  orig_w,                orig_h + expand_h   ),
                'bottom':     (0,        0,          orig_w,                orig_h + expand_h   ),
            }
            off_x, off_y, new_w, new_h = offset_map.get(direction, offset_map['all'])

            print(f"[ImageAPI] 原图 {orig_w}x{orig_h} -> 新画布 {new_w}x{new_h} 偏移({off_x},{off_y})")

            # 检查是否有用户提供的遮罩
            use_user_mask = user_mask and isinstance(user_mask, str) and user_mask.startswith('data:image')

            if use_user_mask:
                # 使用用户遮罩：用户遮罩决定哪些区域需要 AI 重绘
                print("[ImageAPI] 使用用户自定义遮罩")
                # 用户的遮罩是针对原图尺寸的，需要根据扩图方向扩展
                user_mask_b64 = user_mask.split(',', 1)[1] if ',' in user_mask else user_mask
                user_mask_bytes = base64.b64decode(user_mask_b64)
                user_mask_img = Image.open(io.BytesIO(user_mask_bytes)).convert('RGB')
                user_mask_img = user_mask_img.resize((orig_w, orig_h), Image.LANCZOS)

                # 创建扩展后的用户遮罩
                user_mask_extended = Image.new('RGB', (new_w, new_h), (0, 0, 0))
                user_mask_extended.paste(user_mask_img, (off_x, off_y))

                # 原图直接放入新画布（不扩展）
                new_canvas = orig_img.copy()
                if new_canvas.mode != 'RGBA':
                    new_canvas = new_canvas.convert('RGBA')

                # 使用用户遮罩：白色=要编辑，黑色=保持不变
                mask_img = user_mask_extended
                prompt_text = prompt.strip() if prompt.strip() else \
                    "Edit the white masked area to match the prompt, keep black areas unchanged."
            else:
                # 使用自动生成的扩图遮罩（原有逻辑）
                new_canvas = Image.new('RGBA', (new_w, new_h), (0, 0, 0, 0))
                new_canvas.paste(orig_img, (off_x, off_y))

                mask_img    = Image.new('RGB', (new_w, new_h), (255, 255, 255))
                black_patch = Image.new('RGB', (orig_w, orig_h), (0, 0, 0))
                mask_img.paste(black_patch, (off_x, off_y))

                prompt_text = prompt.strip() if prompt.strip() else \
                    "Extend this image naturally, filling the masked white area " \
                    "seamlessly to match the existing content."

            def to_data_url(img, fmt='PNG', mime='image/png'):
                buf = io.BytesIO()
                img.save(buf, format=fmt)
                b64 = base64.b64encode(buf.getvalue()).decode('utf-8')
                return f"data:{mime};base64,{b64}"

            canvas_data_url = to_data_url(new_canvas)
            mask_data_url   = to_data_url(mask_img)

            is_gemini = (
                'gemini'      in model_id.lower() or
                'nano-banana' in model_id.lower()
            )

            if is_gemini:
                # FluxPort 语言域名映射到图片直连域名，并避免 /v1/v1beta/ 双重前缀
                endpoint = f"{resolve_image_api_base(api_url)}/v1beta/models/{model_id}:generateContent"
                headers  = {
                    'x-goog-api-key': api_key,
                    'Content-Type':   'application/json'
                }

                canvas_b64 = canvas_data_url.split(',', 1)[1]
                mask_b64   = mask_data_url.split(',', 1)[1]

                payload = {
                    "contents": [{
                        "role": "user",
                        "parts": [
                            {"inlineData": {"mimeType": "image/png", "data": canvas_b64}},
                            {"inlineData": {"mimeType": "image/png", "data": mask_b64}},
                            {"text": prompt_text}
                        ]
                    }],
                    "generationConfig": {
                        "responseModalities": ["TEXT", "IMAGE"]
                    }
                }

                print(f"[ImageAPI] POST {endpoint}")
                resp = requests.post(
                    endpoint, headers=headers,
                    json=payload, timeout=120
                )

                print(f"[ImageAPI] 响应状态码: {resp.status_code}")
                if resp.status_code != 200:
                    print(f"[ImageAPI] 响应内容: {resp.text[:300]}")
                    return {
                        "success": False,
                        "error":   f"API 错误 {resp.status_code}: {resp.text[:300]}"
                    }

                result = resp.json()
                return self.unified_api._parse_gemini_response(result)

            else:
                import io as _io
                # FluxPort 直连域名映射（与 Gemini 分支共用 resolve_image_api_base）
                endpoint     = f"{resolve_image_api_base(api_url)}/v1/images/edits"
                canvas_bytes = base64.b64decode(canvas_data_url.split(',', 1)[1])
                mask_bytes   = base64.b64decode(mask_data_url.split(',', 1)[1])

                files = {
                    'image': ('image.png', _io.BytesIO(canvas_bytes), 'image/png'),
                    'mask':  ('mask.png',  _io.BytesIO(mask_bytes),   'image/png'),
                }
                form_data = {
                    'model':           model_id,
                    'prompt':          prompt_text,
                    'response_format': 'b64_json',
                    'n':               '1',
                }
                headers = {"Authorization": f"Bearer {api_key}"}

                print(f"[ImageAPI] POST {endpoint}")
                resp = requests.post(
                    endpoint, headers=headers,
                    files=files, data=form_data, timeout=120
                )

                print(f"[ImageAPI] 响应状态码: {resp.status_code}")
                if resp.status_code != 200:
                    print(f"[ImageAPI] 响应内容: {resp.text[:300]}")
                    return {
                        "success": False,
                        "error":   f"API 错误 {resp.status_code}: {resp.text[:300]}"
                    }

                result = resp.json()
                b64 = result['data'][0].get('b64_json', '')
                if not b64:
                    return {"success": False, "error": "接口未返回图片数据"}

                print(f"[ImageAPI] 生成成功")
                return {"success": True, "image_url": f"data:image/png;base64,{b64}"}

        except Exception as e:
            print(f"outpaint 失败: {e}")
            return {"success": False, "error": str(e)}
