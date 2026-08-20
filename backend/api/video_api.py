# backend/api/video_api.py
"""FluxPort 视频生成（全异步任务协议，本期仅后端）

POST {media}/v1/videos  (Idempotency-Key: video-<uuid>)
→ 轮询 GET {media}/v1/videos/{task_id}（status_url / poll_after_ms / Retry-After）
→ completed 后提取 output.video_url / video_url / download_url / assets[].signed_url
→ 下载落盘 {image_save_path}/videos/unified_video_*.mp4（失败兜底 GET /v1/videos/{task_id}/content）

设计要点：
- 域名：视频创建/轮询/下载走媒体域（resolve_image_api_base：语言域 → api.ai-media.vip）；
  对话/模型列表走语言域（resolve_chat_api_base，见 unified_api._resolve_chat_url）——二者方向相反，勿混用。
- 幂等键只用于创建；轮询/下载不带。网络/429 退避不换幂等键重放。
- 下载必须 stream + 1MB 分块落盘，严禁整包进内存；禁止把视频 base64 穿 pywebview 桥。
- 依赖注入 UnifiedAPIRouter，复用其 _resolve_video_model / _handle_http_error /
  _configured_image_save_dir / _get_api_origin / _join_origin_path / _parse_expires_at / _extract_task_error。
"""
import os
import tempfile
import threading
import time
import uuid
from urllib.parse import urlparse

import requests

from backend.api.errors import (
    AppError, UpstreamError, UpstreamTimeoutError, ValidationError,
)
from backend.api.gemini_compat import resolve_image_api_base

# ─────────────────────────────────────────
# 视频任务存储（独立于图片 _tasks，契约不同：video_url/video_path/duration…）
# 带线程锁保护；中间态（queued/processing/in_progress/pending_confirmation）回写，
# 终态 done 后 600s 延迟清理（与图片 _tasks 同模式，避免与前端重试竞态）。
# ─────────────────────────────────────────
_video_tasks = {}
_video_tasks_lock = threading.Lock()

# Content-Type 子类型 / URL 后缀 → 文件扩展名
_VIDEO_EXT_MAP = {
    'mp4': 'mp4', 'quicktime': 'mov', 'webm': 'webm',
    'x-matroska': 'mkv', 'mpeg': 'mpg', 'ogg': 'ogv', 'avi': 'avi',
}

# 极简视频尺寸映射（无统一枚举，能映射才传，否则平台默认）
_VIDEO_SIZE_MAP_720 = {
    '16:9': '1280x720', '9:16': '720x1280', '1:1': '1024x1024',
    '4:3': '1152x864', '3:4': '864x1152',
}
_VIDEO_SIZE_MAP_1080 = {
    '16:9': '1920x1080', '9:16': '1080x1920', '1:1': '1080x1080',
    '4:3': '1440x1080', '3:4': '1080x1440',
}

# pending_confirmation 连续查询次数上限（约 10 分钟）；手册要求 60s 后再查，绝不换 Key 重发
_VIDEO_PENDING_LIMIT = 10


class VideoAPI:

    def __init__(self, unified):
        """
        unified: UnifiedAPIRouter（依赖注入，复用其模型解析/错误映射/保存目录等内部方法）
        """
        self.unified = unified

    # ─────────────────────────────────────────
    # 公开接口
    # ─────────────────────────────────────────

    def generate_video_async(self, prompt, options=None):
        """
        视频生成（异步，立即返回 task_id）。
        后台 daemon 线程执行 generate_video；成功/异常写回 _video_tasks[task_id]。
        返回: {"success": True, "task_id": "<本地 uuid>"}
        """
        options = options or {}
        task_id = str(uuid.uuid4())
        with _video_tasks_lock:
            _video_tasks[task_id] = {"status": "pending"}

        def run():
            try:
                result = self.generate_video(prompt, options, _progress_task_id=task_id)
                with _video_tasks_lock:
                    _video_tasks[task_id] = {"status": "done", "result": result, "cleanup_scheduled": False}
                print(
                    f"[VideoAPI] 任务 {task_id[:8]} 完成 | "
                    f"video_path={'有' if isinstance(result, dict) and result.get('video_path') else '无'}"
                )
            except AppError as e:
                with _video_tasks_lock:
                    _video_tasks[task_id] = {"status": "done", "result": e.to_dict(), "cleanup_scheduled": False}
            except Exception as e:
                import traceback
                traceback.print_exc()
                with _video_tasks_lock:
                    _video_tasks[task_id] = {
                        "status": "done",
                        "result": {"success": False, "error": str(e)},
                        "cleanup_scheduled": False,
                    }

        threading.Thread(target=run, daemon=True).start()
        print(f"[VideoAPI] 异步视频任务 {task_id[:8]} 已启动")
        return {"success": True, "task_id": task_id}

    def generate_video(self, prompt, options=None, _progress_task_id=None):
        """
        视频生成（同步全链路）：校验 → 解析模型 → 建 URL/payload → POST → 轮询 → 下载落盘 → 结果 dict。

        options: {
            "model": "provider_id:key_id:model_id",   # 可选（旧两段自动兼容）
            "seconds": 15, "duration": 15,            # 二选一，seconds 优先
            "size": "1280x720",                       # 显式像素尺寸优先
            "resolution": "720p"/"1080p", "aspectRatio": "16:9",  # 否则极简映射
            "image_url": "https://...",               # 单张公网参考图
            "referenceImages": ["data:image/..."],    # 多参考图（data URL 数组）
            "startFrame": "...", "endFrame": "...",   # 首尾帧（成对传）
            "audio": True,
            "idempotencyKey": "...",                  # 可选，默认 video-<uuid>
        }
        返回成功契约见 §4.6；失败抛 AppError 子类。
        """
        options = options or {}

        if not prompt or not prompt.strip():
            raise ValidationError("提示词不能为空")

        provider, key, model_entry = self.unified._resolve_video_model(options.get('model'))
        if not provider:
            raise AppError(503, "没有可用的视频模型，请先在设置中配置")

        connection = self.unified._get_connection(provider, key, model_entry.type, model_entry.id)
        if not connection:
            raise AppError(503, f"供应商「{provider.get('name', '')}」的视频生成未启用或尚未填写 URL / API Key，请到设置中补充后再生成")

        api_url   = connection['api_url'].rstrip('/')
        api_key   = connection['api_key']
        use_proxy = provider.get('use_proxy', False)
        proxies   = None if use_proxy else {"http": None, "https": None, "all": None}

        url     = self._resolve_video_url(api_url)
        payload = self._build_video_payload(model_entry.id, prompt, options)
        idempotency_key = options.get('idempotencyKey') or f"video-{uuid.uuid4().hex}"
        headers = {
            'Authorization':   f'Bearer {api_key}',
            'Idempotency-Key': idempotency_key,
            'Content-Type':    'application/json',
        }

        print(f"[VideoAPI] 视频请求 | provider={provider['name']} | model={model_entry.id} | url={url}")

        try:
            response = requests.post(
                url, headers=headers, json=payload, timeout=60, proxies=proxies
            )
            if response.status_code in (200, 202):
                try:
                    task_data = response.json()
                except ValueError:
                    task_data = {}
                # status_url / poll_url 常为相对路径，必须拼到实际请求域名；
                # 使用 response.url（跟随重定向后的最终地址），避免 302 跳转打到旧域名。
                origin = self.unified._get_api_origin(response.url)
                polled = self._poll_video_task(
                    task_data, origin, headers, proxies,
                    _progress_task_id=_progress_task_id,
                )
            else:
                # 401/403/404/409/413/429/5xx 等：统一映射（429 会直接抛 RateLimitError）
                self.unified._handle_http_error(response)
                raise AppError(502, "视频任务创建失败（未知错误）")  # 不可达，防御性兜底
        except requests.exceptions.Timeout:
            raise UpstreamTimeoutError()
        except requests.exceptions.ConnectionError:
            raise UpstreamError(503, "无法连接到服务器，请检查网络或代理设置")

        # ── 下载落盘（signed_url 免鉴权；fileuri/相对路径带 Key；失败兜底 /content） ──
        save_dir = self._video_save_dir()
        configured_dir = self.unified._configured_image_save_dir()
        saved_to_disk = bool(configured_dir)
        auth_headers = {'Authorization': f'Bearer {api_key}'} if polled['kind'] == 'fileuri' else None
        path = self._download_video_to_dir(polled['video_url'], save_dir, headers=auth_headers, proxies=proxies)
        if not path:
            path = self._download_video_content(
                polled['task_id'], polled['origin'],
                {'Authorization': f'Bearer {api_key}'}, proxies, save_dir,
            )
        if not path:
            raise UpstreamError(502, "视频下载失败（签名地址过期且 /content 兜底不可用），请重试")

        size_bytes = None
        try:
            if os.path.exists(path):
                size_bytes = os.path.getsize(path)
        except Exception:
            size_bytes = None

        return {
            "success":      True,
            "video_url":    f"file:///{path}",
            "video_path":   path,
            "original_url": polled['video_url'],
            "saved_to_disk": saved_to_disk,
            "task_id":      polled.get('task_id'),
            "width":        polled.get('width'),
            "height":       polled.get('height'),
            "duration":     polled.get('duration'),
            "size_bytes":   size_bytes,
        }

    def get_video_task_result(self, task_id):
        """
        查询视频异步任务结果：
          {"status": "not_found"}
          {"status": "pending"}                        # 尚无中间态
          {"status": "queued"|"processing"|"in_progress"|"pending_confirmation", "result": None}
          {"status": "done", "result": {...}}          # 完成或失败；600s 延迟清理
        """
        with _video_tasks_lock:
            task = _video_tasks.get(task_id)
            if not task:
                return {"status": "not_found"}
            status = task.get("status")
            if status == "pending":
                return {"status": "pending"}
            if status in ("queued", "processing", "in_progress", "pending_confirmation"):
                return {"status": status, "result": None}
            if status != "done" or "result" not in task:
                # 防御：任何其它非终态按中间态返回（不误读缺失的 result）
                return {"status": status, "result": task.get("result")}

            result = task["result"]

            if not task.get("cleanup_scheduled"):
                task["cleanup_scheduled"] = True

                def delayed_delete():
                    # 600s 后才清理：与前端轮询/重试解耦（同图片 _tasks 模式）
                    time.sleep(600)
                    with _video_tasks_lock:
                        _video_tasks.pop(task_id, None)
                    print(f"[VideoAPI] 视频任务 {task_id[:8]} 已清理")

                threading.Thread(target=delayed_delete, daemon=True).start()

        return {"status": "done", "result": result}

    # ─────────────────────────────────────────
    # 内部方法：URL / Payload
    # ─────────────────────────────────────────

    def _resolve_video_url(self, api_url):
        """解析视频创建 URL（媒体域；resolve_image_api_base 已剥离 /v1、/v1beta）"""
        base = resolve_image_api_base(api_url)
        return f"{base}/v1/videos"

    def _build_video_payload(self, model_id, prompt, options):
        """
        构建视频创建 payload（参考图本期走 JSON 通道；multipart 为扩展点）：
        - model/prompt 必填
        - seconds 优先于 duration（手册：同时提供时 seconds 优先）
        - size 显式优先；否则 resolution+aspectRatio → _map_video_size；映射不到不传（平台默认）
        - image_url（公网 URL）→ image_url；referenceImages（data:image 数组）→ reference_images
        - startFrame/endFrame 成对传 → start_frame/end_frame（尾帧不可单独用）
        - audio → audio
        """
        payload = {"model": model_id, "prompt": prompt}

        seconds = options.get('seconds')
        if seconds is None:
            seconds = options.get('duration')
        if seconds is not None:
            try:
                payload['seconds'] = int(seconds)
            except (TypeError, ValueError):
                print(f"[VideoAPI] 忽略非法 seconds: {seconds!r}")

        size = options.get('size')
        if isinstance(size, str) and size.strip():
            payload['size'] = size.strip()
        else:
            mapped = self._map_video_size(options.get('resolution'), options.get('aspectRatio'))
            if mapped:
                payload['size'] = mapped

        image_url = options.get('image_url')
        if isinstance(image_url, str) and image_url.strip().startswith(('http://', 'https://')):
            payload['image_url'] = image_url.strip()

        ref_images = [
            img for img in options.get('referenceImages', [])
            if isinstance(img, str) and img.startswith('data:image')
        ]
        if ref_images:
            payload['reference_images'] = ref_images

        start_frame = options.get('startFrame')
        end_frame = options.get('endFrame')
        if start_frame is not None and end_frame is not None:
            payload['start_frame'] = start_frame
            payload['end_frame'] = end_frame
        elif start_frame is not None or end_frame is not None:
            # 手册：尾帧不可单独用，也不要和普通参考图混用；缺一半则整体不传（平台默认）
            print("[VideoAPI] startFrame/endFrame 需成对提供，已忽略（平台默认首尾帧）")

        audio = options.get('audio')
        if audio is not None:
            payload['audio'] = audio

        return payload

    def _map_video_size(self, resolution, aspect_ratio):
        """极简视频尺寸映射（能映射才传，否则 None 不传）。resolution 仅 '720p'/'1080p' 支持。"""
        res = str(resolution or '').strip().lower()
        ar = str(aspect_ratio or '').strip().lower()
        if res == '720p':
            return _VIDEO_SIZE_MAP_720.get(ar)
        if res == '1080p':
            return _VIDEO_SIZE_MAP_1080.get(ar)
        return None

    # ─────────────────────────────────────────
    # 内部方法：任务轮询
    # ─────────────────────────────────────────

    def _poll_video_task(self, task_data, origin, headers, proxies, _progress_task_id=None):
        """
        轮询视频任务直到终态。
        - poll_url：status_url → poll_url → result_url → f"/v1/videos/{task_id}"（相对路径拼 origin）
        - poll_interval：poll_after_ms/1000，下限 2.0s
        - timeout_limit：默认 900s；expires_at 更短则用 expires_at+60s 缓冲
        - 429/网络错误退避 min(interval*2^n,10)s（429 优先 Retry-After）；不换幂等键
        - pending_confirmation：60s 后再查，连续 _VIDEO_PENDING_LIMIT 次（约 10min）仍不确定才报错
        - completed → _extract_video_url；failed/canceled/cancelled → UpstreamError
        返回 {"video_url", "kind", "task_id", "origin", "width", "height", "duration", "size_bytes"}。
        """
        if not isinstance(task_data, dict):
            task_data = {}

        poll_url = (
            task_data.get('status_url')
            or task_data.get('poll_url')
            or task_data.get('result_url')
            or ''
        )
        task_id = task_data.get('task_id') or task_data.get('id') or task_data.get('request_id') or ''
        if not poll_url and task_id:
            poll_url = f"/v1/videos/{task_id}"
        if not poll_url:
            raise UpstreamError(502, "视频任务响应缺少 status_url / poll_url / result_url / task_id，无法轮询")
        if not poll_url.startswith(('http://', 'https://')):
            poll_url = self.unified._join_origin_path(origin, poll_url)

        poll_after_ms = task_data.get('poll_after_ms')
        try:
            poll_interval = float(poll_after_ms) / 1000.0 if poll_after_ms else 2.0
        except (TypeError, ValueError):
            poll_interval = 2.0
        poll_interval = max(2.0, poll_interval)

        timeout_limit = 900.0
        expires_ts = self.unified._parse_expires_at(task_data.get('expires_at'))
        if expires_ts is not None:
            remaining = expires_ts - time.time()
            if remaining > 0:
                timeout_limit = min(timeout_limit, remaining + 60.0)
        deadline = time.time() + timeout_limit

        print(f"[VideoAPI] 视频任务已接受 | task_id={task_id or '-'} | poll_url={poll_url} | "
              f"间隔={poll_interval:.1f}s | 超时={timeout_limit:.0f}s")

        # 幂等键只用于创建；轮询 GET 不带 Idempotency-Key / Content-Type
        poll_headers = {
            k: v for k, v in headers.items()
            if k not in ('Idempotency-Key', 'Content-Type')
        }

        consecutive_failures = 0  # 429 / 网络错误连续计数，用于逐步退避
        pending_count = 0         # pending_confirmation 连续计数

        while time.time() < deadline:
            try:
                resp = requests.get(poll_url, headers=poll_headers, timeout=60, proxies=proxies)
            except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
                consecutive_failures += 1
                wait = min(poll_interval * (2 ** min(consecutive_failures, 3)), 10.0)
                print(f"[VideoAPI] 视频任务轮询网络异常({type(e).__name__})，{wait:.1f}s 后重试")
                time.sleep(wait)
                continue

            if resp.status_code == 429:
                consecutive_failures += 1
                retry_after = resp.headers.get('Retry-After')
                try:
                    wait = max(2.0, float(retry_after))
                except (TypeError, ValueError):
                    wait = max(5.0, min(poll_interval * (2 ** min(consecutive_failures, 3)), 10.0))
                print(f"[VideoAPI] 视频任务轮询 429 限流，{wait:.1f}s 后退避重试（不换幂等键）")
                time.sleep(wait)
                continue

            if resp.status_code != 200:
                self.unified._handle_http_error(resp)

            consecutive_failures = 0

            try:
                data = resp.json()
            except ValueError:
                print("[VideoAPI] 视频任务轮询响应非 JSON，稍后重试...")
                time.sleep(poll_interval)
                continue
            if not isinstance(data, dict):
                print("[VideoAPI] 视频任务轮询响应非对象，稍后重试...")
                time.sleep(poll_interval)
                continue

            # 平台允许每次状态响应调整建议轮询间隔，仍遵守至少 2 秒下限
            next_poll_after = data.get('poll_after_ms')
            try:
                if next_poll_after is not None:
                    poll_interval = max(2.0, float(next_poll_after) / 1000.0)
            except (TypeError, ValueError):
                pass

            status = data.get('status')
            status_l = str(status).strip().lower() if status is not None else ''

            # 中间态回写（供 get_video_task_result 查询；只写真中间态，终态由 async 层统一写 done）
            if (_progress_task_id and status_l in
                    ('queued', 'processing', 'in_progress', 'pending_confirmation')):
                with _video_tasks_lock:
                    if _progress_task_id in _video_tasks:
                        _video_tasks[_progress_task_id]["status"] = status_l

            # 终态失败
            if status_l in ('failed', 'canceled', 'cancelled'):
                raise UpstreamError(502, f"视频任务{status_l}：{self.unified._extract_task_error(data)}")

            # 不确定但并非失败：保留原任务与幂等键，约 60s 后再查，绝不换 Key 重发
            if status_l == 'pending_confirmation':
                pending_count += 1
                if pending_count >= _VIDEO_PENDING_LIMIT:
                    raise UpstreamError(
                        502,
                        f"任务长时间处于待确认状态（pending_confirmation），结果不确定："
                        f"{self.unified._extract_task_error(data)}",
                    )
                wait = max(60.0, poll_interval)
                print(f"[VideoAPI] 视频任务 pending_confirmation（第 {pending_count} 次），"
                      f"{wait:.1f}s 后再查（保留原任务与幂等键）")
                time.sleep(wait)
                continue

            # 完成
            if status_l == 'completed':
                video_url, kind = self._extract_video_url(data, origin)
                if not video_url:
                    raise UpstreamError(502, "任务标记 completed 但未找到视频地址")
                output = data.get('output') if isinstance(data.get('output'), dict) else {}
                width = data.get('width') or output.get('width')
                height = data.get('height') or output.get('height')
                duration = data.get('duration') or output.get('duration') or data.get('seconds')
                return {
                    "video_url":   video_url,
                    "kind":        kind,
                    "task_id":     task_id,
                    "origin":      origin,
                    "width":       width,
                    "height":      height,
                    "duration":    duration,
                    "size_bytes":  None,
                }

            # 其它状态（queued / processing / in_progress / 未知非终态）→ 继续轮询
            time.sleep(poll_interval)

        raise UpstreamTimeoutError("视频生成超时，请稍后重试（任务可能仍在排队）")

    def _extract_video_url(self, data, origin):
        """
        从完成响应提取视频下载地址。
        返回 (url_or_None, kind)：
          - kind='url'    ：signed_url / 绝对直链，无需鉴权即可下载
          - kind='fileuri'：相对路径资源（已拼 origin），需带 Authorization 下载
        提取顺序：output.*（video_url/download_url/url）→ 顶层（video_url/download_url/url）
                  → assets[]（优先 signed_url，否则 url/download_url）
        """
        if not isinstance(data, dict):
            return None, None

        # 1) output.*
        output = data.get('output')
        if isinstance(output, dict):
            for key in ('video_url', 'download_url', 'url'):
                val = output.get(key)
                if isinstance(val, str) and val.strip():
                    val = val.strip()
                    if val.startswith(('http://', 'https://')):
                        return val, 'url'
                    return self.unified._join_origin_path(origin, val), 'fileuri'

        # 2) 顶层
        for key in ('video_url', 'download_url', 'url'):
            val = data.get(key)
            if isinstance(val, str) and val.strip():
                val = val.strip()
                if val.startswith(('http://', 'https://')):
                    return val, 'url'
                return self.unified._join_origin_path(origin, val), 'fileuri'

        # 3) assets[]
        assets = data.get('assets')
        if isinstance(assets, list):
            for asset in assets:
                if not isinstance(asset, dict):
                    continue
                signed = asset.get('signed_url')
                if isinstance(signed, str) and signed.strip():
                    signed = signed.strip()
                    if signed.startswith(('http://', 'https://')):
                        return signed, 'url'
                    return self.unified._join_origin_path(origin, signed), 'url'
                raw = asset.get('url') or asset.get('download_url')
                if isinstance(raw, str) and raw.strip():
                    raw = raw.strip()
                    if raw.startswith(('http://', 'https://')):
                        return raw, 'fileuri'
                    return self.unified._join_origin_path(origin, raw), 'fileuri'

        return None, None

    # ─────────────────────────────────────────
    # 内部方法：下载与落盘
    # ─────────────────────────────────────────

    def _download_video_to_dir(self, url, save_dir, headers=None, proxies=None):
        """
        stream 分块下载视频到 save_dir（1MB 分块，严禁整包进内存）。
        ext：Content-Type video/* 映射 → URL 后缀兜底 → 'mp4'。
        返回绝对路径（正斜杠）；失败返回 None。
        """
        try:
            resp = requests.get(url, headers=headers, stream=True, timeout=(10, 300), proxies=proxies)
            if resp.status_code != 200:
                print(f"[VideoAPI] 视频下载失败: HTTP {resp.status_code} | {url[:100]}")
                return None
            ext = self._guess_video_ext(resp.headers.get('Content-Type', ''), url)
            file_path = os.path.join(save_dir, self._make_video_filename(ext))
            with open(file_path, 'wb') as f:
                for chunk in resp.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        f.write(chunk)
            try:
                size = os.path.getsize(file_path)
                print(f"[VideoAPI] 视频已保存: {file_path} ({size / (1024 * 1024):.1f} MB)")
            except Exception:
                print(f"[VideoAPI] 视频已保存: {file_path}")
            return file_path.replace('\\', '/')
        except Exception as e:
            print(f"[VideoAPI] 视频下载异常: {e}")
            return None

    def _download_video_content(self, task_id, origin, headers, proxies, save_dir):
        """
        signed_url 失败兜底：GET {origin}/v1/videos/{task_id}/content（同一 Key，不重复计费）。
        复用 _download_video_to_dir 的分块下载逻辑。
        """
        try:
            url = self.unified._join_origin_path(origin, f"/v1/videos/{task_id}/content")
            dl_headers = dict(headers or {})
            dl_headers['Accept'] = 'video/mp4,application/octet-stream,*/*'
            return self._download_video_to_dir(url, save_dir, headers=dl_headers, proxies=proxies)
        except Exception as e:
            print(f"[VideoAPI] /content 兜底下载异常: {e}")
            return None

    def _guess_video_ext(self, content_type, url=''):
        """Content-Type video/* → URL 后缀 → 'mp4'"""
        ct = (content_type or '').lower()
        if 'video/' in ct:
            subtype = ct.split('video/', 1)[1].split(';', 1)[0].strip().lower()
            if subtype in _VIDEO_EXT_MAP:
                return _VIDEO_EXT_MAP[subtype]
        try:
            path = urlparse(url).path
            filename = path.rsplit('/', 1)[-1]
            if '.' in filename:
                suffix = filename.rsplit('.', 1)[-1].lower().strip()
                if suffix and suffix.isalnum():
                    if suffix in _VIDEO_EXT_MAP:
                        return _VIDEO_EXT_MAP[suffix]
                    if suffix in _VIDEO_EXT_MAP.values():
                        return suffix
        except Exception:
            pass
        return 'mp4'

    def _video_save_dir(self):
        """视频落盘目录：{image_save_path}/videos（未配置回退 tempfile，saved_to_disk=false）"""
        configured = self.unified._configured_image_save_dir()
        if configured:
            sub = os.path.join(configured, 'videos')
            try:
                os.makedirs(sub, exist_ok=True)
                if os.path.isdir(sub):
                    return sub
            except Exception:
                pass
        return tempfile.gettempdir()

    def _make_video_filename(self, ext='mp4'):
        from datetime import datetime
        ts = datetime.now().strftime('%Y%m%d_%H%M%S_%f')
        return f"unified_video_{ts}.{ext}"
