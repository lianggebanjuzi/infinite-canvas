# backend/api/image_api.py
"""
图片处理 API
"""

import base64
import mimetypes
import os
import requests
from datetime import datetime
import tempfile

from backend.api.gemini_compat import resolve_image_api_base


def _probe_video_metadata(path):
    """返回视频的轻量元数据；不借用音频探测，避免 MP4 被误标为 audio/*。"""
    meta = {'duration': None, 'mime_type': None, 'size_bytes': None}
    try:
        if os.path.exists(path):
            meta['size_bytes'] = os.path.getsize(path)
    except Exception:
        pass

    mime_type, _encoding = mimetypes.guess_type(path)
    meta['mime_type'] = mime_type if mime_type and mime_type.startswith('video/') else 'video/mp4'

    try:
        import shutil
        import subprocess
        if shutil.which('ffprobe'):
            proc = subprocess.run(
                ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                 '-of', 'default=noprint_wrappers=1:nokey=1', path],
                capture_output=True, text=True, timeout=15,
            )
            if proc.returncode == 0:
                duration = float(proc.stdout.strip())
                if duration > 0:
                    meta['duration'] = round(duration, 2)
    except Exception:
        pass
    return meta


def make_thumbnail_data_url(image_bytes: bytes, max_edge: int = 1024, quality: int = 85) -> str | None:
    """bytes → JPEG q85 / 最长边 max_edge 缩略图 base64 data URL；失败返回 None（调用方回退原图）。

    - 同一原图确定性生成 → 同一 JPEG 字节 → 资产指纹 hashRef(展示图 URL) 稳定（跨会话可复现）。
    - 主生成链路（unified_api._save_images_to_local）逐图调用；任何异常静默返回 None，不阻断出图。
    """
    try:
        import io
        from PIL import Image, ImageOps

        # 浏览器会根据 JPEG 的 EXIF Orientation 自动旋转原图；缩略图也必须
        # 先将该方向实际烘焙到像素中，否则卡片的比例虽正确、内容却会横竖颠倒。
        img = ImageOps.exif_transpose(Image.open(io.BytesIO(image_bytes)))
        img.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        img.convert('RGB').save(buf, 'JPEG', quality=quality, optimize=True)
        b64 = base64.b64encode(buf.getvalue()).decode('utf-8')
        return f"data:image/jpeg;base64,{b64}"
    except Exception as e:
        print(f"生成缩略图失败: {e}")
        return None


def make_thumbnail_data_url_from_file(image_path: str, max_edge: int = 1024, quality: int = 85) -> str | None:
    """本地原图文件 → JPEG 缩略图 data URL。

    大图任务的结果可能是受保护 fileUri。该路径直接从文件解码，避免先将整张
    4K 原图编码为 base64、再立即解码一次；前端最终仍只接收缩略图。
    """
    try:
        import io
        from PIL import Image, ImageOps

        with Image.open(image_path) as img:
            img = ImageOps.exif_transpose(img)
            img.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
            buf = io.BytesIO()
            img.convert('RGB').save(buf, 'JPEG', quality=quality, optimize=True)
        b64 = base64.b64encode(buf.getvalue()).decode('utf-8')
        return f"data:image/jpeg;base64,{b64}"
    except Exception as e:
        print(f"从本地文件生成缩略图失败: {e}")
        return None


class ImageAPI:

    def __init__(self, settings_api, unified_api=None):
        self.settings_api = settings_api
        self.unified_api  = unified_api

    # ─────────────────────────────────────────
    # 保存图片到本地
    # ─────────────────────────────────────────

    def save_image_to_local(self, image_data, filename=None, allow_temp=False):
        try:
            from PIL import Image
            import io
            
            # 类型检查：确保 image_data 是字符串
            if not isinstance(image_data, str):
                return {"status": "error", "message": "图片数据格式无效，需要字符串"}

            settings  = self.settings_api.load_settings()
            save_path = settings.get('image_save_path', '')

            saved_to_disk = bool(save_path)
            if not save_path:
                if not allow_temp:
                    return {"status": "skipped", "message": "未设置图片保存路径"}
                # 手动导入也需要走「原图落地 + 缩略图展示」双轨；未配置目录时放在系统临时目录，
                # 只保证当前会话可查看大图，避免把 4K 原图常驻在项目 JSON / 画布 DOM 中。
                save_path = os.path.join(tempfile.gettempdir(), 'infinite_canvas_imports')

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
            thumb_data_url = make_thumbnail_data_url_from_file(file_path)

            print(f"图片已保存: {file_path}")
            safe_path = file_path.replace('\\', '/')
            safe_thumb = thumb_path.replace('\\', '/') if thumb_path else None
            
            return {
                "status": "success",
                "path":   safe_path,
                "url":    f"file:///{safe_path}",
                "thumbnail": f"file:///{safe_thumb}" if safe_thumb else None,
                "thumbnail_data_url": thumb_data_url,
                "saved_to_disk": saved_to_disk,
            }

        except Exception as e:
            print(f"保存图片失败: {e}")
            return {"status": "error", "message": str(e)}

    # ─────────────────────────────────────────
    # 4.2-B：本地媒体文件导入（视频/音频）
    # ─────────────────────────────────────────

    def prepare_imported_media(self, options=None):
        """手动导入本地媒体文件（视频/音频）：大文件仅落盘路径 + 轻量元数据，不把内容塞进项目 JSON。

        options: {
            "kind": "audio" | "video",
            "sourcePath": "本地绝对路径",      # 优先：直接复制，不经 base64 桥接
            "dataUrl": "data:audio/mpeg;base64,...",  # 兜底：浏览器无 File.path 时经桥接（瞬时，不持久化）
            "filename": "原始文件名（可选，用于扩展名推断）",
        }
        返回: {status, path, url, duration, mime_type, size_bytes}
        """
        options = options or {}
        kind = options.get('kind') if options.get('kind') in ('video', 'audio') else 'audio'
        try:
            settings = self.settings_api.load_settings()
            save_path = settings.get('image_save_path', '')
            saved_to_disk = bool(save_path)
            if not save_path:
                save_path = os.path.join(tempfile.gettempdir(), 'infinite_canvas_imports')
            media_dir = os.path.join(save_path, 'media')
            os.makedirs(media_dir, exist_ok=True)

            source_path = options.get('sourcePath')
            data_url = options.get('dataUrl')
            filename = options.get('filename') or ''
            if not source_path and not data_url:
                return {"status": "error", "message": "媒体文件数据无效"}

            ext = 'mp3' if kind == 'audio' else 'mp4'
            if filename and '.' in filename:
                suffix = filename.rsplit('.', 1)[-1].lower().strip()
                if suffix and suffix.isalnum() and len(suffix) <= 5:
                    ext = suffix

            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S_%f')
            target = os.path.join(media_dir, f"import_{kind}_{timestamp}.{ext}")

            if source_path and os.path.exists(source_path):
                import shutil
                shutil.copy2(source_path, target)
            elif data_url and ',' in data_url:
                raw = data_url.split(',', 1)[1]
                with open(target, 'wb') as f:
                    f.write(base64.b64decode(raw))
            else:
                return {"status": "error", "message": "源文件不存在或数据无效"}

            # 轻量元数据：音频走 mutagen/ffprobe，视频只走视频 MIME/ffprobe。
            duration = None
            mime_type = None
            size_bytes = None
            try:
                if os.path.exists(target):
                    size_bytes = os.path.getsize(target)
                if kind == 'video':
                    meta = _probe_video_metadata(target)
                else:
                    from backend.api.audio_api import _probe_audio_metadata
                    meta = _probe_audio_metadata(target)
                duration = meta.get('duration')
                mime_type = meta.get('mime_type')
                if meta.get('size_bytes') is not None:
                    size_bytes = meta['size_bytes']
            except Exception as e:
                print(f"[ImageAPI] 媒体元数据解析失败（可降级）: {e}")

            safe_path = target.replace('\\', '/')
            print(f"[ImageAPI] 媒体已导入: {safe_path} ({kind})")
            return {
                "status": "success",
                "path": safe_path,
                "url": f"file:///{safe_path}",
                "duration": duration,
                "mime_type": mime_type,
                "size_bytes": size_bytes,
                "saved_to_disk": saved_to_disk,
            }
        except Exception as e:
            print(f"[ImageAPI] 媒体导入失败: {e}")
            return {"status": "error", "message": f"媒体导入失败：{e}"}

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
            from PIL import Image, ImageOps
            
            base_name = os.path.splitext(image_path)[0]
            thumb_path = f"{base_name}_thumb.jpg"
            
            img = ImageOps.exif_transpose(Image.open(image_path))
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
    # 临时文件延迟清理（4.1-B 蒙版 mask-*.png 等）
    # ─────────────────────────────────────────

    def delete_temp_file(self, file_path):
        """删除应用自己管理的临时文件（如 mask-*.png）。

        安全约束：只允许删除「图片保存目录」或「会话临时导入目录」下的文件，
        绝不接受任意路径（防误删用户其它文件）。文件已不存在时视为成功（幂等）。
        """
        try:
            if not isinstance(file_path, str) or not file_path.strip():
                return {"status": "error", "message": "路径无效"}
            absolute = os.path.abspath(file_path)
            allowed_roots = []
            try:
                settings = self.settings_api.load_settings() or {}
                save_path = (settings.get('image_save_path') or '').strip()
                if save_path:
                    allowed_roots.append(os.path.abspath(save_path))
            except Exception:
                pass
            allowed_roots.append(os.path.abspath(os.path.join(tempfile.gettempdir(), 'infinite_canvas_imports')))
            if not any(absolute.startswith(root + os.sep) for root in allowed_roots):
                print(f"[ImageAPI] 拒绝删除非应用管理目录的文件: {absolute}")
                return {"status": "error", "message": "路径不在应用管理目录内，拒绝删除"}
            if not os.path.isfile(absolute):
                return {"status": "success"}  # 已不存在 → 幂等成功
            os.remove(absolute)
            print(f"[ImageAPI] 已清理临时文件: {absolute}")
            return {"status": "success"}
        except Exception as e:
            print(f"删除临时文件失败: {e}")
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
            # multi-key：顶层 api_key 已迁移进 keys[0]，兼容读 keys[0]（旧顶层字段作为兜底）
            api_key = provider.get('api_key', '')
            if not api_key:
                keys = provider.get('keys') or []
                api_key = keys[0].get('api_key', '') if keys else ''
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
