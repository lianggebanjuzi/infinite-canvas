# backend/api/audio_api.py
"""音频生成（4.2-B）：统一 async create/status/download 三段协议 + 可配置 adapter。

当前没有任何已确认的真实音频供应商/协议，本模块把协议描述写成可配置表
（AUDIO_ADAPTERS：endpoint / payload 字段 / 状态字段 / 结果 URL 字段），
前端能力门控（getAudioModelCapabilities available:false）保证未配置音频模型时
不出现可运行按钮，因此不会对未知供应商发起请求。

设计要点：
- 复用 UnifiedAPIRouter 的模型解析（_resolve_audio_model）/ 连接（_get_connection）/
  错误映射（_handle_http_error）/ 保存目录（_configured_image_save_dir）/
  origin 拼接（_get_api_origin / _join_origin_path）/ 任务错误提取（_extract_task_error）。
- 幂等键只用于创建；轮询/下载不带。网络/429 退避不换幂等键重放。
- 下载 stream + 1MB 分块落盘，严禁整包进内存；禁止把音频 base64 穿 pywebview 桥。
- 支持 audio/mpeg、audio/wav、audio/ogg 等落盘；元数据（时长/大小/MIME）优先
  mutagen（纯 Python），缺失时降级 ffprobe 探测，再缺失返回 None（前端可降级显示）。
- 错误返回脱敏并带远端 task id（与视频/图片同模式）。
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
# 并发常量（集中配置；4.0 规范 §6：视频默认 1、音频默认 2）
# ─────────────────────────────────────────
_VIDEO_TASKS_PER_KEY = 1
_AUDIO_TASKS_PER_KEY = 2

# ─────────────────────────────────────────
# 音频任务存储（独立于图片/视频 _tasks，契约不同：audio_url/audio_path/duration…）
# 带线程锁保护；终态 done 后 600s 延迟清理（与图片/视频同模式）。
# ─────────────────────────────────────────
_audio_tasks = {}
_audio_tasks_lock = threading.Lock()
_audio_task_slots = {}
_audio_task_slots_lock = threading.Lock()

# Content-Type 子类型 / URL 后缀 → 文件扩展名
_AUDIO_EXT_MAP = {
    'mpeg': 'mp3', 'mp3': 'mp3', 'wav': 'wav', 'x-wav': 'wav',
    'ogg': 'ogg', 'oga': 'ogg', 'opus': 'ogg', 'flac': 'flac',
    'x-flac': 'flac', 'aac': 'aac', 'm4a': 'm4a', 'mp4': 'm4a',
    'x-m4a': 'm4a', 'webm': 'weba',
}

# ─────────────────────────────────────────
# Adapter 描述表（可配置：endpoint / payload 字段 / 状态字段 / 结果 URL 字段）
# 当前无真实供应商，默认异步任务协议（fluxport_audio）与视频同构；未来确认
# 供应商后在 model_rules.AUDIO_RULES 把对应模型指向 'openai_audio' 即可切换。
# ─────────────────────────────────────────
AUDIO_ADAPTERS = {
    # FluxPort 风格全异步任务：POST /v1/audio/tasks → status_url/poll_url 轮询 → completed
    'fluxport_audio': {
        'endpoint': '/v1/audio/tasks',
        'payload': {},
        'status_field': 'status',
        'result_url_fields': ['output.audio_url', 'audio_url', 'download_url', 'url'],
        'async_task': True,
    },
    # OpenAI 兼容同步生成：POST /v1/audio/generations → 直接返回 base64 audio 或 URL
    'openai_audio': {
        'endpoint': '/v1/audio/generations',
        'payload': {},
        'status_field': 'status',
        'result_url_fields': ['data.audio_url', 'audio_url', 'download_url', 'url'],
        'async_task': False,
    },
}


def _audio_task_slot(provider, key):
    """返回指定供应商 Key 的音频并发闸门（默认 2）；不以 API Key 明文作为索引。"""
    slot_key = (str(provider.get('id') or ''), str(key.get('id') or ''))
    with _audio_task_slots_lock:
        slot = _audio_task_slots.get(slot_key)
        if slot is None:
            slot = threading.BoundedSemaphore(_AUDIO_TASKS_PER_KEY)
            _audio_task_slots[slot_key] = slot
        return slot


# ─────────────────────────────────────────
# 音频元数据（mutagen 优先 → ffprobe 降级 → None）
# ─────────────────────────────────────────
def _probe_audio_metadata(path):
    """返回 {duration, mime_type, size_bytes}；无法解析时缺失字段为 None（不抛异常）。"""
    meta = {'duration': None, 'mime_type': None, 'size_bytes': None}
    try:
        if os.path.exists(path):
            meta['size_bytes'] = os.path.getsize(path)
    except Exception:
        pass

    # 1) mutagen（纯 Python，无系统依赖）
    try:
        from mutagen import File as MutagenFile
        audio = MutagenFile(path, easy=True)
        if audio is not None and audio.info is not None:
            info = audio.info
            length = getattr(info, 'length', None)
            if isinstance(length, (int, float)) and length > 0:
                meta['duration'] = round(float(length), 2)
            meta['mime_type'] = _guess_mime_from_ext(path) or 'audio/mpeg'
            return meta
    except Exception:
        pass

    # 2) ffprobe 降级（外部命令；不可用时静默返回 None 字段）
    try:
        import shutil
        if shutil.which('ffprobe'):
            import subprocess
            proc = subprocess.run(
                ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                 '-of', 'default=noprint_wrappers=1:nokey=1', path],
                capture_output=True, text=True, timeout=15,
            )
            if proc.returncode == 0:
                try:
                    dur = float(proc.stdout.strip())
                    if dur > 0:
                        meta['duration'] = round(dur, 2)
                except (TypeError, ValueError):
                    pass
    except Exception:
        pass

    if not meta['mime_type']:
        meta['mime_type'] = _guess_mime_from_ext(path)
    return meta


def _guess_mime_from_ext(path):
    ext = os.path.splitext(path)[1].lower().lstrip('.')
    return {
        'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'ogg': 'audio/ogg',
        'oga': 'audio/ogg', 'opus': 'audio/ogg', 'flac': 'audio/flac',
        'aac': 'audio/aac', 'm4a': 'audio/mp4', 'weba': 'audio/webm',
    }.get(ext, 'audio/mpeg')


class AudioAPI:

    def __init__(self, unified):
        """
        unified: UnifiedAPIRouter（依赖注入，复用其模型解析/错误映射/保存目录等内部方法）
        """
        self.unified = unified

    # ─────────────────────────────────────────
    # 公开接口
    # ─────────────────────────────────────────

    def generate_audio_async(self, prompt, options=None):
        """
        音频生成（异步，立即返回 task_id）。
        后台 daemon 线程执行 generate_audio；成功/异常写回 _audio_tasks[task_id]。
        返回: {"success": True, "task_id": "<本地 uuid>"}
        """
        options = options or {}
        task_id = str(uuid.uuid4())
        with _audio_tasks_lock:
            _audio_tasks[task_id] = {"status": "pending"}

        def run():
            try:
                result = self.generate_audio(prompt, options, _progress_task_id=task_id)
                with _audio_tasks_lock:
                    remote_task_id = _audio_tasks.get(task_id, {}).get("remote_task_id")
                    _audio_tasks[task_id] = {"status": "done", "result": result,
                                             "cleanup_scheduled": False,
                                             "remote_task_id": remote_task_id}
                print(
                    f"[AudioAPI] 任务 {task_id[:8]} 完成 | "
                    f"audio_path={'有' if isinstance(result, dict) and result.get('audio_path') else '无'}"
                )
            except AppError as e:
                with _audio_tasks_lock:
                    remote_task_id = _audio_tasks.get(task_id, {}).get("remote_task_id")
                    _audio_tasks[task_id] = {"status": "done", "result": e.to_dict(),
                                             "cleanup_scheduled": False,
                                             "remote_task_id": remote_task_id}
            except Exception as e:
                import traceback
                traceback.print_exc()
                with _audio_tasks_lock:
                    _audio_tasks[task_id] = {
                        "status": "done",
                        "result": {"success": False, "error": str(e)},
                        "cleanup_scheduled": False,
                    }

        threading.Thread(target=run, daemon=True).start()
        print(f"[AudioAPI] 异步音频任务 {task_id[:8]} 已启动")
        return {"success": True, "task_id": task_id}

    def generate_audio(self, prompt, options=None, _progress_task_id=None):
        """
        音频生成（同步全链路）：校验 → 解析模型 → 建 URL/payload → POST → 轮询/直读
        → 下载落盘 → 元数据 → 结果 dict。

        options: {
            "model": "provider_id:key_id:model_id",
            "seconds": 10,
            "format": "mp3" / "wav" / "ogg",
            "referenceImages": ["data:image/..."],   # 仅模型支持图片条件音频时
            "idempotencyKey": "...",
        }
        返回成功契约：{success, audio_url, audio_path, original_url, saved_to_disk,
                      task_id, duration, size_bytes, mime_type}
        失败抛 AppError 子类（错误已脱敏，不包含 Key/Authorization）。
        """
        options = options or {}

        if not prompt or not prompt.strip():
            raise ValidationError("提示词不能为空")

        provider, key, model_entry = self.unified._resolve_audio_model(options.get('model'))
        if not provider:
            raise AppError(503, "没有可用的音频模型，请先在设置中配置")

        runtime_gate = getattr(self.unified, '_assert_runtime_adapter_supported', None)
        if callable(runtime_gate):
            runtime_gate(model_entry.id)

        connection = self.unified._get_connection(provider, key, model_entry.type, model_entry.id)
        if not connection:
            raise AppError(503, f"供应商「{provider.get('name', '')}」的音频生成未启用或尚未填写 URL / API Key，请到设置中补充后再生成")

        # 按 Key 限流（音频默认 2；与图片/视频同模式）
        slot = _audio_task_slot(provider, key)
        if not slot.acquire(blocking=False):
            print(f"[AudioAPI] 音频任务排队 | provider={provider.get('name', '-')} | "
                  f"model={model_entry.id} | 单 Key 并发上限={_AUDIO_TASKS_PER_KEY}")
            slot.acquire()
        try:
            return self._generate_audio_inner(
                prompt, options, provider, key, model_entry, connection, _progress_task_id,
            )
        finally:
            slot.release()

    def _generate_audio_inner(self, prompt, options, provider, key, model_entry,
                              connection, _progress_task_id=None):
        api_url = connection['api_url'].rstrip('/')
        api_key = connection['api_key']
        use_proxy = provider.get('use_proxy', False)
        proxies = None if use_proxy else {"http": None, "https": None, "all": None}

        adapter = AUDIO_ADAPTERS.get(model_entry.api_format.value, AUDIO_ADAPTERS['fluxport_audio'])
        url = self._resolve_audio_url(api_url, adapter['endpoint'])
        payload = self._build_audio_payload(model_entry.id, prompt, options)
        idempotency_key = options.get('idempotencyKey') or f"audio-{uuid.uuid4().hex}"
        headers = {
            'Authorization':   f'Bearer {api_key}',
            'Idempotency-Key': idempotency_key,
            'Content-Type':    'application/json',
        }

        print(f"[AudioAPI] 音频请求 | provider={provider['name']} | model={model_entry.id} | "
              f"format={model_entry.api_format.value} | url={url}")

        try:
            response = requests.post(url, headers=headers, json=payload, timeout=60, proxies=proxies)
            if response.status_code in (200, 202):
                try:
                    task_data = response.json()
                except ValueError:
                    task_data = {}
                origin = self.unified._get_api_origin(response.url)

                if not adapter['async_task']:
                    # OpenAI 兼容同步生成：直接解析结果
                    audio_url, kind = self._extract_audio_url(task_data, origin,
                                                              adapter['result_url_fields'])
                    base64_data = self._extract_audio_base64(task_data)
                    if not audio_url and not base64_data:
                        raise UpstreamError(502, "音频任务响应中未找到音频数据")
                    return self._materialize_audio(
                        audio_url, base64_data, origin, kind, headers, proxies, api_key,
                        task_data.get('task_id') or task_data.get('id') or '',
                        _progress_task_id,
                    )

                polled = self._poll_audio_task(task_data, origin, headers, proxies,
                                               adapter, _progress_task_id=_progress_task_id)
                return self._materialize_audio(
                    polled['audio_url'], None, polled['origin'], polled['kind'],
                    headers, proxies, api_key, polled['task_id'], _progress_task_id,
                )
            else:
                self.unified._handle_http_error(response)
                raise AppError(502, "音频任务创建失败（未知错误）")  # 不可达，防御性兜底
        except requests.exceptions.Timeout:
            raise UpstreamTimeoutError()
        except requests.exceptions.ConnectionError:
            raise UpstreamError(503, "无法连接到服务器，请检查网络或代理设置")

    def get_audio_task_result(self, task_id):
        """
        查询音频异步任务结果：
          {"status": "not_found"}
          {"status": "pending"}                        # 尚无中间态
          {"status": "queued"|"processing"|"in_progress"|"pending_confirmation", "result": None}
          {"status": "done", "result": {...}}          # 完成或失败；600s 延迟清理
        """
        with _audio_tasks_lock:
            task = _audio_tasks.get(task_id)
            if not task:
                return {"status": "not_found"}
            status = task.get("status")
            if status == "pending":
                return {"status": "pending"}
            if status in ("queued", "processing", "in_progress", "pending_confirmation"):
                return {"status": status, "result": None, "remote_task_id": task.get("remote_task_id")}
            if status != "done" or "result" not in task:
                return {"status": status, "result": task.get("result")}

            result = task["result"]

            if not task.get("cleanup_scheduled"):
                task["cleanup_scheduled"] = True

                def delayed_delete():
                    time.sleep(600)
                    with _audio_tasks_lock:
                        _audio_tasks.pop(task_id, None)
                    print(f"[AudioAPI] 音频任务 {task_id[:8]} 已清理")

                threading.Thread(target=delayed_delete, daemon=True).start()

        return {"status": "done", "result": result, "remote_task_id": task.get("remote_task_id")}

    # ─────────────────────────────────────────
    # 内部方法：URL / Payload
    # ─────────────────────────────────────────

    def _resolve_audio_url(self, api_url, endpoint):
        """解析音频创建 URL（媒体域归一；endpoint 来自 adapter 表）"""
        base = resolve_image_api_base(api_url)
        return f"{base}{endpoint}"

    def _build_audio_payload(self, model_id, prompt, options):
        """
        构建音频创建 payload：
        - model/prompt 必填
        - seconds → seconds（可选）
        - format → response_format（仅当在 whitelist 时传，未知格式不传）
        - referenceImages（data:image 数组）→ reference_images（仅模型支持时由前端传入）
        """
        payload = {"model": model_id, "prompt": prompt}

        seconds = options.get('seconds')
        if seconds is not None:
            try:
                payload['seconds'] = int(seconds)
            except (TypeError, ValueError):
                print(f"[AudioAPI] 忽略非法 seconds: {seconds!r}")

        fmt = options.get('format')
        if isinstance(fmt, str) and fmt.strip().lower() in ('mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'):
            payload['response_format'] = fmt.strip().lower()

        ref_images = [
            img for img in options.get('referenceImages', [])
            if isinstance(img, str) and img.startswith('data:image')
        ]
        if ref_images:
            payload['reference_images'] = ref_images

        return payload

    # ─────────────────────────────────────────
    # 内部方法：异步任务轮询（fluxport_audio）
    # ─────────────────────────────────────────

    def _poll_audio_task(self, task_data, origin, headers, proxies, adapter,
                         _progress_task_id=None):
        """
        轮询音频任务直到终态。
        - poll_url：status_url → poll_url → result_url → f"/v1/audio/tasks/{task_id}"
        - poll_interval：poll_after_ms/1000，下限 2.0s
        - 429/网络错误退避 min(interval*2^n,10)s；不换幂等键
        - completed → _extract_audio_url
        返回 {"audio_url", "kind", "task_id", "origin"}。
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
        if _progress_task_id and task_id:
            with _audio_tasks_lock:
                if _progress_task_id in _audio_tasks:
                    _audio_tasks[_progress_task_id]["remote_task_id"] = str(task_id)
        if not poll_url and task_id:
            poll_url = f"/v1/audio/tasks/{task_id}"
        if not poll_url:
            raise UpstreamError(502, "音频任务响应缺少 status_url / poll_url / result_url / task_id，无法轮询")
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

        print(f"[AudioAPI] 音频任务已接受 | task_id={task_id or '-'} | poll_url={poll_url} | "
              f"间隔={poll_interval:.1f}s | 超时={timeout_limit:.0f}s")

        poll_headers = {
            k: v for k, v in headers.items()
            if k not in ('Idempotency-Key', 'Content-Type')
        }

        consecutive_failures = 0
        status_field = adapter.get('status_field', 'status')

        while time.time() < deadline:
            try:
                resp = requests.get(poll_url, headers=poll_headers, timeout=60, proxies=proxies)
            except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
                consecutive_failures += 1
                wait = min(poll_interval * (2 ** min(consecutive_failures, 3)), 10.0)
                print(f"[AudioAPI] 音频任务轮询网络异常({type(e).__name__})，{wait:.1f}s 后重试")
                time.sleep(wait)
                continue

            if resp.status_code == 429:
                consecutive_failures += 1
                retry_after = resp.headers.get('Retry-After')
                try:
                    wait = max(2.0, float(retry_after))
                except (TypeError, ValueError):
                    wait = max(5.0, min(poll_interval * (2 ** min(consecutive_failures, 3)), 10.0))
                print(f"[AudioAPI] 音频任务轮询 429 限流，{wait:.1f}s 后退避重试（不换幂等键）")
                time.sleep(wait)
                continue

            if resp.status_code != 200:
                self.unified._handle_http_error(resp)

            consecutive_failures = 0

            try:
                data = resp.json()
            except ValueError:
                print("[AudioAPI] 音频任务轮询响应非 JSON，稍后重试...")
                time.sleep(poll_interval)
                continue
            if not isinstance(data, dict):
                print("[AudioAPI] 音频任务轮询响应非对象，稍后重试...")
                time.sleep(poll_interval)
                continue

            next_poll_after = data.get('poll_after_ms')
            try:
                if next_poll_after is not None:
                    poll_interval = max(2.0, float(next_poll_after) / 1000.0)
            except (TypeError, ValueError):
                pass

            status = data.get(status_field)
            status_l = str(status).strip().lower() if status is not None else ''

            if (_progress_task_id and status_l in
                    ('queued', 'processing', 'in_progress', 'pending_confirmation')):
                with _audio_tasks_lock:
                    if _progress_task_id in _audio_tasks:
                        _audio_tasks[_progress_task_id]["status"] = status_l

            if status_l in ('failed', 'canceled', 'cancelled'):
                raise UpstreamError(502, f"音频任务{status_l}：{self.unified._extract_task_error(data)}")

            if status_l == 'pending_confirmation':
                wait = max(60.0, poll_interval)
                print(f"[AudioAPI] 音频任务 pending_confirmation，{wait:.1f}s 后再查（保留原任务与幂等键）")
                time.sleep(wait)
                continue

            if status_l == 'completed':
                audio_url, kind = self._extract_audio_url(data, origin, adapter['result_url_fields'])
                if not audio_url:
                    base64_data = self._extract_audio_base64(data)
                    if base64_data:
                        return {'audio_url': None, 'base64': base64_data, 'kind': 'base64',
                                'task_id': task_id, 'origin': origin}
                    raise UpstreamError(502, "任务标记 completed 但未找到音频地址")
                return {"audio_url": audio_url, "kind": kind, "task_id": task_id, "origin": origin}

            time.sleep(poll_interval)

        raise UpstreamTimeoutError("音频生成超时，请稍后重试（任务可能仍在排队）")

    def _extract_audio_url(self, data, origin, result_url_fields):
        """
        从完成响应提取音频下载地址。
        返回 (url_or_None, kind)：
          - kind='url'    ：绝对直链，无需鉴权即可下载
          - kind='fileuri'：相对路径资源（已拼 origin），需带 Authorization 下载
        result_url_fields 支持 'a.b' 点路径（如 output.audio_url）与顶层字段。
        """
        if not isinstance(data, dict):
            return None, None

        def lookup(field):
            node = data
            for part in field.split('.'):
                if not isinstance(node, dict):
                    return None
                node = node.get(part)
            return node if isinstance(node, str) else None

        for field in result_url_fields:
            val = lookup(field)
            if val and val.strip():
                val = val.strip()
                if val.startswith(('http://', 'https://')):
                    return val, 'url'
                if val.startswith('data:audio'):
                    return val, 'data'
                return self.unified._join_origin_path(origin, val), 'fileuri'

        # assets[] 兼容（与视频同模式）
        assets = data.get('assets')
        if isinstance(assets, list):
            for asset in assets:
                if not isinstance(asset, dict):
                    continue
                for key in ('audio_url', 'signed_url', 'download_url', 'url'):
                    val = asset.get(key)
                    if isinstance(val, str) and val.strip():
                        val = val.strip()
                        if val.startswith(('http://', 'https://')):
                            return val, 'url'
                        return self.unified._join_origin_path(origin, val), 'fileuri'

        return None, None

    def _extract_audio_base64(self, data):
        """OpenAI 兼容：data[0].audio / data[0].b64_json / audio 字段的 base64 字符串。"""
        if not isinstance(data, dict):
            return ''
        for key in ('audio', 'b64_json', 'data'):
            val = data.get(key)
            if isinstance(val, str) and val.startswith(('data:audio', 'data:audio/')):
                return val
        arr = data.get('data')
        if isinstance(arr, list) and arr:
            first = arr[0]
            if isinstance(first, dict):
                for key in ('audio', 'b64_json'):
                    val = first.get(key)
                    if isinstance(val, str) and val:
                        return val
        return ''

    # ─────────────────────────────────────────
    # 内部方法：下载与落盘
    # ─────────────────────────────────────────

    def _materialize_audio(self, audio_url, base64_data, origin, kind, headers, proxies,
                           api_key, task_id, _progress_task_id):
        """
        把远端音频落地为本地文件并解析元数据。
        - audio_url + kind：stream 下载
        - base64_data：data URL 解码落盘（同步生成模型可能返回 base64）
        返回结果 dict（含 audio_url/audio_path/original_url/saved_to_disk/task_id/duration/size_bytes/mime_type）。
        """
        save_dir = self._audio_save_dir()
        configured_dir = self.unified._configured_image_save_dir()
        saved_to_disk = bool(configured_dir)
        auth_headers = {'Authorization': f'Bearer {api_key}'} if kind == 'fileuri' else None

        path = None
        if base64_data:
            path = self._save_audio_base64(base64_data, save_dir)
        elif audio_url and kind == 'data':
            path = self._save_audio_base64(audio_url, save_dir)
        elif audio_url:
            path = self._download_audio_to_dir(audio_url, save_dir, headers=auth_headers, proxies=proxies)

        if not path:
            raise UpstreamError(502, "音频下载失败（签名地址过期且无 base64 兜底），请重试")

        meta = _probe_audio_metadata(path)

        return {
            "success":      True,
            "audio_url":    f"file:///{path}",
            "audio_path":   path,
            "original_url": audio_url if isinstance(audio_url, str) and audio_url.startswith('http') else None,
            "saved_to_disk": saved_to_disk,
            "task_id":      task_id,
            "duration":     meta['duration'],
            "size_bytes":   meta['size_bytes'],
            "mime_type":    meta['mime_type'],
        }

    def _download_audio_to_dir(self, url, save_dir, headers=None, proxies=None):
        """stream 分块下载音频到 save_dir（1MB 分块，严禁整包进内存）。失败返回 None。"""
        try:
            resp = requests.get(url, headers=headers, stream=True, timeout=(10, 300), proxies=proxies)
            if resp.status_code != 200:
                print(f"[AudioAPI] 音频下载失败: HTTP {resp.status_code} | {url[:100]}")
                return None
            ext = self._guess_audio_ext(resp.headers.get('Content-Type', ''), url)
            file_path = os.path.join(save_dir, self._make_audio_filename(ext))
            with open(file_path, 'wb') as f:
                for chunk in resp.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        f.write(chunk)
            try:
                size = os.path.getsize(file_path)
                print(f"[AudioAPI] 音频已保存: {file_path} ({size / (1024 * 1024):.1f} MB)")
            except Exception:
                print(f"[AudioAPI] 音频已保存: {file_path}")
            return file_path.replace('\\', '/')
        except Exception as e:
            print(f"[AudioAPI] 音频下载异常: {e}")
            return None

    def _save_audio_base64(self, data_url, save_dir):
        """把 data:audio base64 落盘（OpenAI 兼容同步生成的降级路径）；失败返回 None。"""
        try:
            import base64 as b64
            raw = data_url
            if ',' in raw:
                raw = raw.split(',', 1)[1]
            ext = 'mp3'
            if data_url.startswith('data:audio/'):
                subtype = data_url[len('data:audio/'):].split(';', 1)[0].strip().lower()
                if subtype in _AUDIO_EXT_MAP:
                    ext = _AUDIO_EXT_MAP[subtype]
            file_path = os.path.join(save_dir, self._make_audio_filename(ext))
            with open(file_path, 'wb') as f:
                f.write(b64.b64decode(raw))
            return file_path.replace('\\', '/')
        except Exception as e:
            print(f"[AudioAPI] 音频 base64 落盘异常: {e}")
            return None

    def _guess_audio_ext(self, content_type, url=''):
        """Content-Type audio/* → URL 后缀 → 'mp3'"""
        ct = (content_type or '').lower()
        if 'audio/' in ct:
            subtype = ct.split('audio/', 1)[1].split(';', 1)[0].strip().lower()
            if subtype in _AUDIO_EXT_MAP:
                return _AUDIO_EXT_MAP[subtype]
        try:
            path = urlparse(url).path
            filename = path.rsplit('/', 1)[-1]
            if '.' in filename:
                suffix = filename.rsplit('.', 1)[-1].lower().strip()
                if suffix and suffix.isalnum():
                    if suffix in _AUDIO_EXT_MAP:
                        return _AUDIO_EXT_MAP[suffix]
                    if suffix in _AUDIO_EXT_MAP.values():
                        return suffix
        except Exception:
            pass
        return 'mp3'

    def _audio_save_dir(self):
        """音频落盘目录：{image_save_path}/audio（未配置回退 tempfile，saved_to_disk=false）"""
        configured = self.unified._configured_image_save_dir()
        if configured:
            sub = os.path.join(configured, 'audio')
            try:
                os.makedirs(sub, exist_ok=True)
                if os.path.isdir(sub):
                    return sub
            except Exception:
                pass
        return tempfile.gettempdir()

    def _make_audio_filename(self, ext='mp3'):
        from datetime import datetime
        ts = datetime.now().strftime('%Y%m%d_%H%M%S_%f')
        return f"unified_audio_{ts}.{ext}"
