# FluxPort 供应商接入 — 增量实施设计（视频生成全链路 + 文本反推打通）

> 版本：2026-08-19（v1）
> 范围：**仅后端**实现视频生成全链路；文本反推（text-gen 反推归位）最小打通；OpenAI Responses（Codex）/ Claude Messages 协议本期**不做**（见 §11 扩展点备注）。
> 前置阅读：`docs/FluxPort-API-接入手册.md`、`docs/FluxPort图片API规范.md`。
> 本文档是工程师施工依据，改动点精确到函数；前端本期只做 1 处必要的类型保全（§7），其余为未来预留。

---

## 0. 摘要

| 项 | 结论 |
|---|---|
| 视频模型识别 | **新增 `MODEL_TYPE_VIDEO='video'`**（不沿用 drawing），理由见 D1 |
| 视频代码落点 | **新建 `backend/api/video_api.py`（`VideoAPI` 类）**，镜像 `ImageAPI` 分层，避免 82KB 的 `unified_api.py` 继续膨胀 |
| 视频任务管理 | **独立 `_video_tasks` + `_video_tasks_lock`**（不混用图片 `_tasks`），支持中间态进度回写，为未来前端预留 |
| 落盘 | `{image_save_path}/videos/unified_video_<ts>.mp4`（复用图片保存路径体系，视频单独子目录） |
| 文本反推 | 现状链路已通；只需 3 处最小改动：chat URL 对称域名归一 + payload 显式 `stream:false` + 视频模型防污染守卫 |
| 前端 | 仅 `settings-panel.ts` 1 处类型归一化保全（视频模型不被改写为 drawing）；其余零改动 |
| 新增 js_api | `generate_video / generate_video_async / get_video_task_result / unified_generate_video / unified_generate_video_sync / unified_get_video_task_result` |

---

## 1. 现状核对（已采信 team-lead 提供的核实结论 + 代码复查）

- `backend/api/unified_api.py`（1714 行）：`UnifiedAPIRouter` 已实现 OpenAI Chat Completions 的 `chat()` / `chat_v2()`（`_resolve_chat_model` / `_resolve_chat_url` / `_build_chat_payload` / `_parse_chat_response`，timeout=120 同步）；图片同步+异步链路 `generate_image` / `generate_image_async` / `get_task_result`；`_save_images_to_local` 落盘（thumbnail + original_path + width/height + saved_to_disk）；模块级 `_tasks` / `_tasks_lock` 管理后台任务。
- `backend/api/model_rules.py`：`MODEL_TYPE_DRAWING/CHAT` + `DRAWING_RULES/CHAT_RULES` + `detect_model_type/detect_model_format_name` 纯函数。**视频模型 `grok-imagine-video-*` 目前无规则 → 落入兜底 chat（错误）。**
- `backend/api/provider_api.py`：`fetch_models(api_url, api_key)` 按 `detect_model_type` 分 drawing/chat 存 `keys[i].models[]`；`test_api_connection` 同构。**均未处理 video 类型；`/models` URL 未做语言域/媒体域归一。**
- `main.py`：`InfiniteCanvasAPI` 暴露图片/对话/供应商方法（js_api 桥），无视频方法。
- 前端：`src/v1/api.ts`（fetchImageModels/fetchChatModels 按 `type==='drawing'/'chat'` 过滤）、`nodes/text-gen.ts`（反推走 `chat_v2` + 上游 data:image）、`engine/run-engine.ts runTextGen`（同步 chatV2 + 图片附带）、`engine/poller.ts`（pollTask 图片轮询）、`ui/cmd-panel.ts`（chatModelOptions）、`ui/settings-panel.ts`（**第 702 行 `type: m.type === 'chat' ? 'chat' : 'drawing'` 会把 video 类型改写成 drawing——必须修**）。
- `providers_data.json` 当前 flux 供应商 `api_url = https://api.ai-media.vip/v1`（媒体域）。手册要求对话/模型列表走语言域 `https://api.uselg.top/v1`，媒体请求走 `https://api.ai-media.vip/v1`。图片链路已有 `resolve_image_api_base` 做 uselg→ai-media 映射；**缺少反向映射（ai-media→uselg），导致用媒体域配置时 chat 与 /models 打错域名。**

---

## 2. 设计决策（D1–D6）

### D1 视频模型识别：新增 `MODEL_TYPE_VIDEO`，不沿用 drawing

**理由**：
1. **语义隔离**：视频任务走 `POST /v1/videos` + `GET /v1/videos/{task_id}`，与图片 `images/generations`、对话 `chat/completions` 都是不同协议。沿用 drawing 会让 `_build_image_request` 把视频模型当图片发（必错），且前端绘图下拉会出现视频模型。
2. **消费方兼容性（关键）**：`detect_model_type` 返回值是字符串，provider_api 存储 `type` 字段、前端按 `type==='drawing'/'chat'` 过滤。新增 `'video'` 是**加性**改动：
   - `fetchChatModels`/`fetchImageModels` 过滤 `type==='chat'/'drawing'` → 视频模型**不会**出现在文本/绘图下拉（本期前端不接视频，正好不需要改）；
   - `_resolve_chat_model`/`_resolve_drawing_model` 的匹配条件 `m_type == 'chat'` / `m_type == 'drawing'` → 视频模型不会被误解析为对话/绘图模型；
   - 兜底 `_first_available_model` 需补一个 video 分支（§3.4）。
3. **防污染**：不加视频规则时 `grok-imagine-video-*` 落入 chat 兜底，会被 text-gen 选中并发到 `/v1/chat/completions`（404/坏请求）。加了 video 规则后它只作为 `type:'video'` 存在。

**规则条目**（`model_rules.py`）：

```python
MODEL_TYPE_VIDEO = 'video'

VIDEO_RULES: List[Tuple[str, str]] = [
    # FluxPort 手册第 5 节明确：grok-imagine-video-* → POST /v1/videos 全异步
    ('grok-imagine-video', 'fluxport_video'),
    # 其它视频模型按 FluxPort 分组可能出现在 /v1/models；统一按 FluxPort 视频任务协议分类
    ('veo',                'fluxport_video'),
    ('kling',              'fluxport_video'),
    ('runway',             'fluxport_video'),
    ('pika',               'fluxport_video'),
    ('sora',               'fluxport_video'),
    ('wan',                'fluxport_video'),
]
```

- `detect_model_type`：匹配顺序 **DRAWING_RULES → VIDEO_RULES → CHAT_RULES → 兜底 CHAT**。
- `detect_model_format_name`：同顺序，返回 `'fluxport_video'`（新格式名）。
- 注意：`'grok-imagine-video'` 与 `DRAWING_RULES` 的 `'grok-imagine-image'` 互不包含，无冲突；子串匹配为前缀自由匹配，对 `/v1/models` 返回的真实 id 低风险。

### D2 视频任务管理：独立 `_video_tasks`，不混用图片 `_tasks`

- 图片 `get_task_result` 的返回契约（image_url/original_path/width/height…）与视频契约（video_url/video_path/duration…）**不同**，混用会让未来前端 pollTask 误读。
- 视频任务状态更丰富（queued/processing/pending_confirmation/completed/failed），独立存储支持**中间态进度回写**，为未来前端展示“生成中”预留。
- 清理策略沿用图片 600s 延迟删除（避免与前端重试竞态）。

### D3 落盘：`{image_save_path}/videos/` 子目录

- 复用 `settings.image_save_path`（`UnifiedAPIRouter._configured_image_save_dir()`），在其下建 `videos/` 子目录（视频与图片物理隔离，便于资产管理；未来若加缩略图仍放 `videos/` 内或同级）。
- 未配置保存路径 → `tempfile.gettempdir()` 兜底 + `saved_to_disk=false`（与图片语义一致）。
- 文件命名 `unified_video_YYYYmmdd_HHMMSS_ffffff.mp4`（与图片 `unified_image_*` 命名体系平行）。

### D4 URL 域名对称归一：新增 `resolve_chat_api_base`

- 现状 `gemini_compat.resolve_image_api_base` 只做 **语言域(uselg) → 媒体域(ai-media)** 单向映射（图片/视频用）。
- 新增 **媒体域(ai-media) → 语言域(uselg)** 的反向映射 `resolve_chat_api_base(api_url)`，供 `/models`、`chat/completions` 使用。这样无论用户把 FluxPort 供应商 api_url 配成语言域还是媒体域，chat 与模型拉取都打对域名（当前 `providers_data.json` 是媒体域，不修则 chat 必错）。
- 非 FluxPort 供应商域名原样返回（加性、零回归）。

### D5 文本反推：现状已通，仅最小加固

- 拉取/分类/选择：`gpt-5.4` 命中 `CHAT_RULES('gpt-')` → `type:'chat'` → `fetchChatModels` 可见 → text-gen 下拉可选 ✓；反推链路 `runTextGen` 已自动附带上游 `data:image` 进 `chat_v2` ✓。
- 需补 3 处（见 §5）：
  1. `_resolve_chat_url` 用 `resolve_chat_api_base`（媒体域配置也能对话）；
  2. `_build_chat_payload` 显式 `"stream": false`（对齐手册示例，防御个别通道默认开流）；
  3. `_resolve_chat_model`/`_first_available_model` 加**视频模型防污染守卫**（旧数据中 `grok-imagine-video-*` 曾以 `type:'chat'` 落盘时，实时规则拒绝，避免误发对话端点）。

### D6 视频代码分层：新建 `backend/api/video_api.py`

- `unified_api.py` 已 82KB，且它专注“模型解析/URL/payload/响应解析”的统一路由；视频的**任务生命周期管理**（创建→轮询→下载→落盘）独立成 `VideoAPI`，依赖注入 `UnifiedAPIRouter` 复用其 `_resolve_video_model` / `_configured_image_save_dir` / `_handle_http_error` / `_join_origin_path` 等内部方法（镜像 `ImageAPI(unified)` 模式）。
- `main.py` 组装：`self.video = VideoAPI(self.unified)`。

---

## 3. 模型识别扩展（文件级改动）

### 3.1 `backend/api/model_rules.py`

- 顶部新增 `MODEL_TYPE_VIDEO = 'video'`。
- 新增 `VIDEO_RULES`（见 D1）。
- `detect_model_type(model_id)`：在 DRAWING 循环之后、CHAT 循环之前插入 VIDEO 循环；返回 `MODEL_TYPE_VIDEO`。
- `detect_model_format_name(model_id)`：同样插入 VIDEO 循环，返回 `'fluxport_video'`。

### 3.2 `backend/api/gemini_compat.py`

新增纯函数：

```python
def resolve_chat_api_base(api_url):
    """
    chat / 模型列表域归一（resolve_image_api_base 的反向）：
    FluxPort 媒体域 api.ai-media.vip → 语言域 https://api.uselg.top/v1（对话与 /models 必须走语言域）。
    其它域名原样返回（保留原 api_url，含 /v1 路径段；由调用方按需剥离/拼接）。
    """
    raw = (api_url or '').strip()
    if not raw:
        return raw
    parsed = urlparse(raw)
    if parsed.hostname and parsed.hostname.lower() == 'api.ai-media.vip':
        return 'https://api.uselg.top/v1'
    return raw.rstrip('/')
```

### 3.3 `backend/api/provider_api.py`

- import 增加：`from backend.api.gemini_compat import resolve_chat_api_base`、`from backend.api.model_rules import MODEL_TYPE_VIDEO`。
- `fetch_models`：
  - `base_url = resolve_chat_api_base(api_url).rstrip('/')`，再走现有 `/v1` 补全逻辑 → `models_url = f"{base_url}/models"`（修掉“媒体域拉不到 chat 模型”问题）。
  - 分类循环增加 video 分支：`m_type == MODEL_TYPE_VIDEO` → 追加到 `all_video`（`type:'video'`，name=id）。
  - 返回 `{"status": "success", "models": deduped_drawing + all_chat + all_video}`。
- `test_api_connection`：同样改用 `resolve_chat_api_base` 拼 `/models`（与 fetch_models 一致）。

### 3.4 `backend/api/unified_api.py`（枚举/检测/解析接线）

- `ModelType` 增加 `VIDEO = "video"`。
- `ApiFormat` 增加 `FLUXPORT_VIDEO = "fluxport_video"`。
- `_API_FORMAT_MAP` 增加 `'fluxport_video': ApiFormat.FLUXPORT_VIDEO`。
- `_detect_model_type`：`if m_type_str == ModelType.DRAWING.value: ...` 之后插入 `if m_type_str == ModelType.VIDEO.value: return ModelType.VIDEO, fmt`。
- `_first_available_model`：`model_type == ModelType.CHAT` 分支保持不变；`ModelType.VIDEO` 分支 `is_match = (m_type == 'video' or (not m_type and self._detect_model_type(m['id'])[0] == ModelType.VIDEO))`；`ModelType.DRAWING` 分支不变（`m_type=='video'` 时自然不命中）。
- **新增 `_resolve_video_model(model_str)`**：与 `_resolve_drawing_model` 同构（三段/两段/兜底），匹配条件 `m_type == 'video' or (not m_type and self._detect_model_type(m['id'])[0] == ModelType.VIDEO)`，兜底 `self._first_available_model(providers, ModelType.VIDEO)`。
- **视频防污染守卫（chat 分支）**：`_resolve_chat_model` 三段/两段分支与 `_first_available_model` 的 CHAT 分支中，把匹配条件收紧为：

```python
if m_type == 'chat':
    # 旧数据兼容：曾落入 chat 兜底的视频模型（如 grok-imagine-video-* 存成 type='chat'），
    # 按实时规则拒绝，避免误发 /chat/completions
    if not self._is_chat_model(m['id']):
        continue
    is_match = True
elif not m_type:
    is_match = self._is_chat_model(m['id'])
else:
    is_match = False
```

> 兼容性说明：手动添加的 chat 模型 id 若未命中任何规则，`detect_model_type` 兜底返回 CHAT → `_is_chat_model` 为 True → 守卫放行，无回归。

---

## 4. 视频后端全链路（`backend/api/video_api.py` 新建）

### 4.1 模块骨架

```python
# backend/api/video_api.py
"""FluxPort 视频生成（全异步任务协议，本期仅后端）
POST {media}/v1/videos  (Idempotency-Key: video-<uuid>)
→ 轮询 GET {media}/v1/videos/{task_id}（status_url / poll_after_ms / Retry-After）
→ completed 后提取 output.video_url / video_url / download_url / assets[].signed_url
→ 下载落盘 {image_save_path}/videos/unified_video_*.mp4（失败兜底 GET /v1/videos/{task_id}/content）
"""
import threading, uuid, time, os, tempfile
from urllib.parse import urlparse
import requests
from backend.api.errors import AppError, ValidationError, UpstreamError, UpstreamTimeoutError
from backend.api.gemini_compat import resolve_image_api_base

_video_tasks = {}
_video_tasks_lock = threading.Lock()

_VIDEO_EXT_MAP = {'mp4': 'mp4', 'quicktime': 'mov', 'webm': 'webm',
                  'x-matroska': 'mkv', 'mpeg': 'mpg', 'ogg': 'ogv', 'avi': 'avi'}

class VideoAPI:
    def __init__(self, unified):          # unified: UnifiedAPIRouter
        self.unified = unified
```

### 4.2 公开接口

```python
def generate_video_async(self, prompt, options=None) -> dict
    # 返回 {"success": True, "task_id": "<本地 uuid>"}
    # 线程：_video_tasks[task_id] = {"status": "pending", ...}
    #       调用 self.generate_video(prompt, options, _progress_task_id=task_id)
    #       成功/异常写回 {"status": "done", "result": {...}}，异常走 AppError.to_dict / {"success": False, "error": str(e)}
    # 启动 daemon 线程后立即返回

def generate_video(self, prompt, options=None, _progress_task_id=None) -> dict
    # 同步全链路：校验 → 解析模型 → 建 URL/payload → POST → _poll_video_task → 下载落盘 → 结果 dict

def get_video_task_result(self, task_id) -> dict
    # 返回：
    #   {"status": "not_found"}
    #   {"status": "pending"}                       # 尚无中间态
    #   {"status": "queued"|"processing"|"in_progress"|"pending_confirmation", "result": None}   # 轮询线程回写的中间态
    #   {"status": "done", "result": {...}}          # 完成或失败；600s 延迟清理（同图片 _tasks 模式）
```

### 4.3 同步链路 `generate_video`（伪码级步骤）

1. `options = options or {}`；`prompt` 非空校验 → `ValidationError("提示词不能为空")`。
2. `provider, key, model_entry = self.unified._resolve_video_model(options.get('model'))`；空 → `AppError(503, "没有可用的视频模型，请先在设置中配置")`；api_url/api_key 缺失 → `AppError(503, "…尚未填写 API 地址或密钥…")`。
3. `api_url = provider['api_url'].rstrip('/')`；`api_key = key['api_key']`；`proxies = None if use_proxy else {"http": None, "https": None, "all": None}`（与图片/对话一致）。
4. `url = self._resolve_video_url(api_url)`；`payload = self._build_video_payload(model_entry.id, prompt, options)`。
5. `idempotency_key = options.get('idempotencyKey') or f"video-{uuid.uuid4().hex}"`。
6. `headers = {'Authorization': f'Bearer {api_key}', 'Idempotency-Key': idempotency_key, 'Content-Type': 'application/json'}`。
7. `requests.post(url, headers=headers, json=payload, timeout=60, proxies=proxies)`：
   - `200/202` → 解析 JSON（`task_data = resp.json()`），`origin = self.unified._get_api_origin(resp.url)`（跟随重定向后的最终域名），进入 `_poll_video_task`。
   - 其它状态 → `self.unified._handle_http_error(response)`（复用 401/429/5xx 映射；429 可在这里直接抛 `RateLimitError`，由 async 层落盘）。
   - `requests.exceptions.Timeout/ConnectionError` → 抛 `UpstreamTimeoutError` / `UpstreamError(503, ...)`。
8. `polled = self._poll_video_task(task_data, origin, headers, proxies, _progress_task_id=_progress_task_id)`：
   - 返回 `{"video_url": ..., "kind": 'url'|'fileuri', "task_id": <上游>, "origin": ..., "width": ..., "height": ..., "duration": ..., "size_bytes": ...}`。
9. 下载（`save_dir = self._video_save_dir()`）：
   ```python
   auth_headers = {'Authorization': f'Bearer {api_key}'} if polled['kind'] == 'fileuri' else None
   path = self._download_video_to_dir(polled['video_url'], save_dir, headers=auth_headers, proxies=proxies)
   if not path:
       path = self._download_video_content(polled['task_id'], polled['origin'],
                                           {'Authorization': f'Bearer {api_key}'}, proxies, save_dir)
   if not path:
       raise UpstreamError(502, "视频下载失败（签名地址过期且 /content 兜底不可用），请重试")
   ```
10. 返回结果（§4.6）。

### 4.4 内部方法

```python
def _resolve_video_url(self, api_url) -> str
    # base = resolve_image_api_base(api_url)   # uselg→ai-media 映射 + 剥离 /v1/v1beta
    # return f"{base}/v1/videos"

def _build_video_payload(self, model_id, prompt, options) -> dict
    # payload = {"model": model_id, "prompt": prompt}
    # seconds: options['seconds'] 优先，否则 options['duration']（手册：同时提供时 seconds 优先）
    # size:    options['size']（显式字符串如 "1280x720"）优先；
    #          否则 options['resolution']+'/aspectRatio' → _map_video_size；无 → 不传（平台默认）
    # 参考图（本期 JSON 通道）：
    #   options['image_url']（公网 URL）→ payload['image_url']
    #   options['referenceImages']（data:image 数组）→ payload['reference_images']（手册：URL/data URL 数组可用）
    #   options['startFrame']/['endFrame'] → payload['start_frame']/['end_frame']（首尾帧，成对传）
    #   options['audio'] → payload['audio']
    # multipart 上传 image=@file 本期不做（见 §11 扩展点）

def _map_video_size(self, resolution, aspect_ratio) -> str | None
    # 极简映射（视频尺寸无统一枚举，保守策略：能映射才传，否则 None 不传）
    # 720p: {'16:9':'1280x720','9:16':'720x1280','1:1':'1024x1024','4:3':'1152x864','3:4':'864x1152'}
    # 1080p: {'16:9':'1920x1080','9:16':'1080x1920','1:1':'1080x1080','4:3':'1440x1080','3:4':'1080x1440'}
    # resolution 非 '720p'/'1080p' 或 aspectRatio 未命中 → None

def _poll_video_task(self, task_data, origin, headers, proxies, _progress_task_id=None) -> dict
    # 1) poll_url：status_url → poll_url → result_url → f"/v1/videos/{task_id}"；相对路径 _join_origin_path(origin, ...)
    # 2) task_id：task_data.task_id / id / request_id
    # 3) poll_interval：poll_after_ms / 1000，下限 2.0s（手册：处理中通常约 10s，以上游建议为准）
    # 4) timeout_limit：默认 900s（15min）；expires_at 更短则用 expires_at+60s 缓冲（复用 _parse_expires_at）
    # 5) 循环内：
    #    - 网络异常/超时 → consecutive_failures++，退避 min(interval * 2^min(n,3), 10)
    #    - 429 → 优先 Retry-After（秒）；否则同上退避 5-10s；不换幂等键
    #    - 非 200 → self.unified._handle_http_error(resp)
    #    - 解析 JSON 失败 → sleep(interval) 继续
    #    - 更新 poll_interval = max(2.0, data.poll_after_ms/1000)
    #    - status_l = (data.status or '').lower()
    #      * queued / processing / in_progress / 其它未知非终态 → sleep(interval)；每轮回写 _progress_task_id 的中间态
    #      * pending_confirmation → pending_count++；>= 10（约 10min）→ UpstreamError(502, "任务长时间处于待确认状态…")；
    #        sleep(max(60.0, poll_interval)) 继续（手册：约 60s 后再查，绝不换 Key 重发）
    #      * completed → self._extract_video_url(data, origin)；无 url → UpstreamError(502, "任务标记 completed 但未找到视频地址")
    #      * failed / canceled / cancelled → UpstreamError(502, f"视频任务{status}：{self.unified._extract_task_error(data)}")
    #    - 每轮回写中间态（_progress_task_id 非空时）：
    #      with _video_tasks_lock: _video_tasks[_progress_task_id]["status"] = status_l
    # 6) 超时 → UpstreamTimeoutError("视频生成超时，请稍后重试（任务可能仍在排队）")

def _extract_video_url(self, data, origin) -> tuple
    # 返回 (url_or_None, kind)
    # 1) output.* ：data['output'] dict → output['video_url'] / output['download_url'] / output['url']
    # 2) 顶层：data['video_url'] / data['download_url'] / data['url']
    # 3) assets[]：优先 signed_url（kind='url'，免鉴权）；否则 url/download_url（kind='fileuri'，拼 origin 带 Key）
    # 绝对 http(s) 原样；相对路径 _join_origin_path(origin, ...)

def _download_video_to_dir(self, url, save_dir, headers=None, proxies=None) -> str | None
    # requests.get(url, headers=headers, stream=True, timeout=(10, 300), proxies=proxies)
    # 非 200 → 打印日志返回 None
    # ext：Content-Type video/* 映射（_VIDEO_EXT_MAP）→ URL 后缀兜底 → 'mp4'
    # 分块写 1MB：file_path = os.path.join(save_dir, self._make_video_filename(ext))
    # 返回绝对路径（replace('\\','/')）；异常返回 None

def _download_video_content(self, task_id, origin, headers, proxies, save_dir) -> str | None
    # GET {origin}/v1/videos/{task_id}/content
    # headers 增加 'Accept': 'video/mp4,application/octet-stream,*/*'
    # stream 分块落盘，逻辑同 _download_video_to_dir（ext 按 Content-Type/URL 判定）

def _video_save_dir(self) -> str
    # configured = self.unified._configured_image_save_dir()
    # if configured: sub = os.path.join(configured, 'videos'); os.makedirs(sub, exist_ok=True); return sub
    # return tempfile.gettempdir()

def _make_video_filename(self, ext='mp4') -> str
    # from datetime import datetime; ts = datetime.now().strftime('%Y%m%d_%H%M%S_%f')
    # return f"unified_video_{ts}.{ext}"
```

### 4.5 错误与重试规则（对齐手册第 6 节）

| 现象 | 处理 |
|---|---|
| 创建 400 invalid_request_error | `_handle_http_error` → AppError 400；不盲目重试 |
| 创建 401 / 403 | APIKeyError / 403 人话提示（余额/分组/权限） |
| 创建 404 model_not_found | `_handle_http_error` 已映射 ModelNotSupportedError；提示先重新拉取该 Key 的 /models |
| 创建 409 idempotency_conflict | 透传错误文案（同一次重试请求体必须完全一致） |
| 创建 413 | 参考图太大；改公网 URL |
| 创建/轮询 429、503 | 退避 5-10s（优先 Retry-After），创建不换幂等键重放 |
| 轮询 pending_confirmation | 保留原任务与幂等键，60s 后再查；连续 10 次（约 10min）仍不确定才报错 |
| 轮询 failed/canceled | 终态报错；修正后以新业务 ID / 新幂等键创建新任务 |
| 下载 signed_url 过期/失败 | 兜底 `GET /v1/videos/{task_id}/content`（同一 Key，不重复计费） |

### 4.6 返回结构（为未来前端预留）

`generate_video` / `get_video_task_result` 的 `result` 契约：

```jsonc
// 成功
{
  "success": true,
  "video_url": "file:///C:/.../videos/unified_video_20260819_121212_123456.mp4", // 本地播放（file:/// 绝对路径）
  "video_path": "C:/.../videos/unified_video_20260819_121212_123456.mp4",         // 本地绝对路径（正斜杠）
  "original_url": "https://api.ai-media.vip/...",                                 // 远端下载地址（信息性，可能过期）
  "saved_to_disk": true,                                                          // 未配置保存路径时 false
  "task_id": "vtask_xxx",                                                         // 上游任务 id（未来 /content 复用）
  "width": null, "height": null, "duration": null,                                // 可选元数据，拿不到为 null
  "size_bytes": 12345678                                                          // 本地文件字节数
}
// 失败（AppError.to_dict 结构，经 async 层落盘）
{ "success": false, "error_code": 502, "message": "...", "error": "..." }
```

> 前端本期不消费；`src/v1/types/backend.d.ts` 预留 `BackendVideoTaskResult` 类型（T04，可选）。

---

## 5. 文本反推打通（最小改动清单）

结论：**FluxPort chat 模型（gpt-5.4 等）可直接完成反推**。现状 `chat()` 已实现 OpenAI Chat Completions，`chat_v2()` 已支持多模态 `data:image`，前端 `runTextGen` 已自动附带上游图。唯一硬伤是**域名**：当前供应商配了媒体域，chat 会打错域名。最小改动 3 处：

1. `backend/api/gemini_compat.py`：新增 `resolve_chat_api_base`（D4 / §3.2）。
2. `backend/api/unified_api.py`：
   - `_resolve_chat_url(api_url)`：
     ```python
     base = resolve_chat_api_base(api_url).rstrip('/')
     if base.endswith('/chat/completions'): return base
     if base.endswith('/v1'): return f"{base}/chat/completions"
     return f"{base}/v1/chat/completions"
     ```
   - `_build_chat_payload`：payload 显式加 `"stream": False`（对齐手册示例；对 OpenAI 兼容通道无害，防御默认开流通道）。
3. 视频防污染守卫（§3.4）：确保旧数据里误存为 chat 的视频模型不会被反推选中。

验证口径（T02 smoke 脚本）：
- `ProviderAPI.fetch_models('https://api.ai-media.vip/v1', <key>)` → 返回含 `gpt-5.4`（type='chat'）与视频模型（type='video'）；
- `UnifiedAPIRouter.chat_v2('用一句话描述这张图', {model: 'provider:key:gpt-5.4', images: [data:image...]})` → `{success:true, text:...}`；
- text-gen 节点反推归位：前端已通，无需改。

---

## 6. main.py js_api 桥

`InfiniteCanvasAPI.__init__` 增加：

```python
from backend.api.video_api import VideoAPI
...
self.video = VideoAPI(self.unified)
```

新增方法（命名对齐图片/对话桥）：

```python
def generate_video(self, prompt, config=None):
    """视频生成（异步，立即返回 task_id）"""
    try: return self.video.generate_video_async(prompt, config)
    except AppError as e: return e.to_dict()
    except Exception as e: return UnknownError(str(e)).to_dict()

def generate_video_async(self, prompt, config=None):   # 兼容命名，同 generate_video
    ...

def get_video_task_result(self, task_id):
    return self.video.get_video_task_result(task_id)

def unified_generate_video(self, prompt, options=None):        # 异步
    ...
def unified_generate_video_sync(self, prompt, options=None):   # 同步（QA/console 直测用）
    try: return self.video.generate_video(prompt, options)
    except AppError as e: return e.to_dict()
    except Exception as e: return UnknownError(str(e)).to_dict()

def unified_get_video_task_result(self, task_id):
    return self.video.get_video_task_result(task_id)
```

> 前端 `src/utils/api.ts` 本期**不改**（前端不接视频）；未来前端接视频时再加 `generateVideo / getVideoTaskResult` 桥。

---

## 7. 前端最小改动（仅 1 处必须）

### 7.1 `src/v1/ui/settings-panel.ts`（必须）

第 ~702 行拉取模型写回时把类型归一化改写为**三态保全**：

```ts
// 现状：type: m.type === 'chat' ? 'chat' : 'drawing'   ← 会把后端 'video' 改写成 'drawing'
type: m.type === 'chat' ? 'chat' : (m.type === 'video' ? 'video' : 'drawing'),
```

否则视频模型经设置页“拉取模型”保存后会变成 `type:'drawing'`，污染绘图下拉（用户选到视频模型 → 后端按图片协议请求 → 报错）。

### 7.2 可选（P2，不影响本期功能）

- 第 ~611 行徽标：`isDrawing` 之外增加 `isVideo = m.type === 'video'`，文案 `视频`（否则视频模型在设置列表显示为“对话”，仅观感问题）。
- 第 ~720-721 行计数：`videoCount` 纳入提示文案。

> 前端节点下拉（`fetchImageModels`/`fetchChatModels`/`cmd-panel`）本期**零改动**：后端 video 类型天然不进 chat/drawing 列表。

---

## 8. 文件清单（函数级）

| 文件 | 改动类型 | 函数/位置级改动点 |
|---|---|---|
| `backend/api/model_rules.py` | 修改 | 新增 `MODEL_TYPE_VIDEO`、`VIDEO_RULES`；`detect_model_type` / `detect_model_format_name` 插入 VIDEO 匹配段 |
| `backend/api/gemini_compat.py` | 修改 | 新增 `resolve_chat_api_base(api_url)`（媒体域→语言域） |
| `backend/api/provider_api.py` | 修改 | import 增加；`fetch_models`（chat 域名 + video 分支 + 返回拼接）；`test_api_connection`（chat 域名） |
| `backend/api/unified_api.py` | 修改 | `ModelType.VIDEO`、`ApiFormat.FLUXPORT_VIDEO`、`_API_FORMAT_MAP`、`_detect_model_type`；新增 `_resolve_video_model`；`_first_available_model` 增加 VIDEO 分支；`_resolve_chat_model` 三处加视频防污染守卫；`_resolve_chat_url` 用 `resolve_chat_api_base`；`_build_chat_payload` 显式 `stream:false` |
| `backend/api/video_api.py` | **新建** | `VideoAPI`：`generate_video_async` / `generate_video` / `get_video_task_result` / `_resolve_video_url` / `_build_video_payload` / `_map_video_size` / `_poll_video_task` / `_extract_video_url` / `_download_video_to_dir` / `_download_video_content` / `_video_save_dir` / `_make_video_filename`；模块级 `_video_tasks` / `_video_tasks_lock` / `_VIDEO_EXT_MAP` |
| `main.py` | 修改 | `__init__` 组装 `self.video = VideoAPI(self.unified)`；新增 6 个 js_api 方法（§6） |
| `src/v1/ui/settings-panel.ts` | 修改 | 第 ~702 行三态类型保全（必须）；徽标/计数可选（P2） |
| `src/v1/types/backend.d.ts` | 修改（可选） | 预留 `BackendVideoTaskResult` / `BackendVideoTaskCreate` 接口（未来前端） |
| `smoke/test_fluxport_chat.py` | **新建** | chat 模型拉取/分类断言 + chat_v2 反推冒烟（含 data:image 多模态） |
| `smoke/test_fluxport_video.py` | **新建** | 视频任务创建→轮询→落盘冒烟（短 prompt + 短秒数，默认跳过长耗用例） |
| `docs/fluxport-接入-回归报告.md` | **新建** | QA 验证清单/回归记录（T05 产出） |

---

## 9. 任务列表（T01–T05，含依赖/并行）

| 任务 | 名称 | 源文件 | 依赖 | 优先级 |
|---|---|---|---|---|
| T01 | 基础规则层：模型识别 + URL 归一 + 类型解析接线 | `model_rules.py`、`gemini_compat.py`、`provider_api.py`、`unified_api.py`（枚举/检测/_resolve_video_model/_first_available_model/守卫） | 无 | P0 |
| T02 | 文本反推打通：chat 适配 + 类型保全 + 冒烟 | `unified_api.py`（_resolve_chat_url/_build_chat_payload）、`src/v1/ui/settings-panel.ts`（三态保全）、`smoke/test_fluxport_chat.py`（新建） | T01 | P0 |
| T03 | 视频生成后端主链路 | `backend/api/video_api.py`（新建）、`smoke/test_fluxport_video.py`（新建）、`docs/fluxport-接入-回归报告.md`（新建，QA 清单骨架） | T01 | P0 |
| T04 | 主进程桥接与前端契约预留 | `main.py`（js_api 桥）、`src/v1/types/backend.d.ts`（预留类型）、`src/v1/ui/settings-panel.ts`（徽标/计数，可选 P2） | T03 | P0 |
| T05 | 端到端集成验证与回归 | `smoke/test_fluxport_video.py`（扩展）、`smoke/test_fluxport_chat.py`（扩展）、`docs/fluxport-接入-回归报告.md`（填结果） | T02、T03、T04 | P1 |

**并行性**：T02 与 T03 仅依赖 T01，可并行；T04 依赖 T03；T05 收口全部。

> 说明：本增量不改项目脚手架（无新配置文件/依赖声明），T01 即本特性的“基础设施层”（规则 + URL 归一 + 解析接线），后续任务全部建立其上。

### 任务验收要点

- **T01**：`detect_model_type('grok-imagine-video-1.5-preview') == 'video'`；`detect_model_format_name(...) == 'fluxport_video'`；`fetch_models('https://api.ai-media.vip/v1', key)` 返回 video 类型且 chat 模型可拉到；`_resolve_video_model` 三段 id 命中；图片/对话既有行为回归通过（smoke/test_multikey.py、test_imageperf.py 等既有用例）。
- **T02**：媒体域配置下 `chat_v2` 反推成功；text-gen 反推归位回归（qa-textgen-*）；设置页拉取模型后视频模型 type 仍为 'video'。
- **T03**：`generate_video_async` 返回 task_id；`get_video_task_result` 返回中间态/完成态；视频落盘到 `{image_save_path}/videos/*.mp4`；下载失败走 /content 兜底；pending_confirmation/429 退避路径可日志验证。
- **T04**：`main.py` 6 个 js_api 方法可用（console 直测 `unified_generate_video_sync`）。
- **T05**：真 Key 端到端成功 1 条（短秒数小视频）；回归报告归档。

---

## 10. 依赖 / 风险

1. **依赖**：`requests`（已有，requirements.txt 已含）；无新第三方包。视频元数据（width/height/duration）不依赖 ffprobe——FluxPort 完成响应未承诺携带，取不到则为 null（本期不做本地解析）。
2. **下载体积 10–100MB**：必须 **stream + 分块落盘**，绝不整包 `resp.content` 进内存；**禁止**把视频 base64 穿 pywebview 桥（返回 file:/// 本地路径）；下载 read timeout 给足（300s/块）。
3. **桥接**：`get_video_task_result` 返回体积很小（路径字符串），不会触发 pywebview 大 payload 问题。
4. **轮询线程驻留**：视频任务可运行数分钟，daemon 线程驻留可接受（图片已同模式）；轮询每轮写中间态不阻塞请求线程。
5. **旧数据兼容**：
   - 已存储的 `type:'chat'` 视频模型 → 防污染守卫拒绝（§3.4），用户重拉模型后自愈；
   - `_API_FORMAT_MAP`/枚举新增是加性的，旧 providers_data.json 无需迁移；
   - `_resolve_chat_url` 行为对非 FluxPort 供应商不变（`resolve_chat_api_base` 原样返回）。
6. **域名**：务必用 `resolve_image_api_base`（媒体域）建视频 URL、`resolve_chat_api_base`（语言域）建对话/模型 URL，二者方向相反，别混用。
7. **幂等键**：创建视频任务必须带 `Idempotency-Key: video-<uuid>`；轮询/下载不带（幂等键只用于创建）。
8. **前端本期零接入**：后端返回结构按 §4.6 预留；`settings-panel` 三态保全是为了不污染绘图下拉，是本期唯一前端改动。

---

## 11. 待明确事项 / 扩展点备注

1. **待明确**：用户 Key 分组实际返回哪些视频模型 id（grok-imagine-video-* 之外的 veo/kling 等是否可见）——以拉取结果为准，规则已覆盖常见前缀。
2. **待明确**：`seconds`/`size` 是否需要在 UI 期提供选择——本期后端透传 options，默认不传（平台默认值）。
3. **待明确**：`pending_confirmation` 最长等待（默认 10 次 ≈ 10min）是否可接受——可调常量。
4. **本期不做（未来扩展点）**：
   - OpenAI **Responses**（Codex）：`POST /v1/responses`，需新增 `ApiFormat.OPENAI_RESPONSES` + 解析分支；
   - **Claude Messages**：`x-api-key` + `anthropic-version` + `POST /v1/messages`，需新增 `ApiFormat.CLAUDE_MESSAGES` + 鉴权头分支；
   - 视频参考图 **multipart 上传**（`image=@file`）：本期走 JSON `image_url` / `reference_images`（data URL 数组），multipart 为扩展点；
   - 视频节点 / 前端轮询 UI、视频缩略图生成、ffprobe 元数据解析。
5. **未来前端接视频的契约**：`Backend.generateVideo(prompt, {model, seconds, size, image_url}) → {task_id}`；`pollVideoTask(taskId)` 轮询 `getVideoTaskResult`（中间态 queued/processing/pending_confirmation，终态 completed → `video_url(file:///)` / `video_path`）。
