# FluxPort API 接入手册

> 文档快照：2026-08-19。来源：[FluxPort API 文档](https://uselg.top/docs)。
>
> 模型、尺寸、价格和某个 Key 可见的模型会随分组变化；发请求前以 `GET /v1/models` 的结果为准。本文件不保存任何真实密钥。

## 1. 先记住这两个 Base URL

| 用途 | Base URL | 不要用于 |
| --- | --- | --- |
| 对话、Claude、OpenAI Chat/Responses、模型列表、用量 | `https://api.uselg.top/v1` | 长时间图片/视频媒体请求 |
| 图片与视频创建、轮询、下载 | `https://api.ai-media.vip/v1` | 对话、登录、管理接口 |

图片的 Gemini 原生协议使用 `https://api.ai-media.vip/v1beta`。媒体直连地址旨在绕过 Cloudflare 的长请求限制；本项目已在 `backend/api/gemini_compat.py` 中把 FluxPort 图片地址归一到该域名。

所有 OpenAI 兼容接口使用：

```http
Authorization: Bearer $FLUXPORT_API_KEY
Content-Type: application/json
```

Gemini 原生接口使用：

```http
x-goog-api-key: $FLUXPORT_API_KEY
Content-Type: application/json
```

## 2. Key 分组与模型列表

```http
GET https://api.uselg.top/v1/models
Authorization: Bearer $FLUXPORT_API_KEY
```

同一个供应商下的不同 Key 可以属于不同分组，`/models` 的返回也可以不同。例如 GPT 组只返回 `gpt-image-*`，Banana 组只返回 Gemini/Nano Banana 模型。

本项目的约定：

- 每个密钥组各自保存 `models[]`，不要把一个组的模型复制给另一个组。
- 设置页点击“拉取模型”会逐个请求全部启用密钥，并用各自的返回覆盖各自的旧列表。
- 节点下拉统一显示所有启用组的模型；同一个模型在多个组出现时，只保留第一个可用组作为路由 Key。
- `404 model_not_found` 通常不是模型代码错误，而是当前 Key 所属分组没有该模型。

## 3. 对话接口

### OpenAI Chat Completions

```http
POST https://api.uselg.top/v1/chat/completions
Authorization: Bearer $FLUXPORT_API_KEY
Content-Type: application/json
```

```json
{
  "model": "gpt-5.4",
  "messages": [
    {"role": "system", "content": "你是一个简洁的助手。"},
    {"role": "user", "content": "给我三个画面创意。"}
  ],
  "stream": false
}
```

读取 `choices[0].message.content`。`stream: true` 时按 OpenAI SSE 协议读取增量事件。

### OpenAI Responses（Codex/Responses 协议）

```http
POST https://api.uselg.top/v1/responses
Authorization: Bearer $FLUXPORT_API_KEY
Content-Type: application/json
```

另有 `/responses` 无 `/v1` 前缀的别名。Responses 与 Chat Completions 是不同协议；Codex 应使用 Responses，不要强行改成 Chat Completions。

### Claude Messages

```http
POST https://api.uselg.top/v1/messages
x-api-key: $FLUXPORT_API_KEY
anthropic-version: 2023-06-01
Content-Type: application/json
```

```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1024,
  "messages": [{"role": "user", "content": "Hello"}]
}
```

可用辅助端点：`POST /v1/messages/count_tokens`、`GET /v1/usage`。

## 4. 图片接口

### 路由选择

| 场景 | 模型示例 | 请求 |
| --- | --- | --- |
| GPT 文生图 | `gpt-image-2` | `POST /v1/images/generations`，JSON |
| GPT 参考图编辑 | `gpt-image-2` | `POST /v1/images/edits`，优先 multipart |
| Grok 文生图 | `grok-imagine-image-quality` | `POST /v1/images/generations`，JSON |
| Grok 参考图编辑 | `grok-imagine-image-edit` | `POST /v1/images/edits`，multipart |
| Gemini/Nano Banana | `gemini-3.1-flash-image-preview`、`gemini-3-pro-image-preview` | `POST /v1beta/models/{model}:generateContent`，Gemini 原生 JSON |

不要把这些模型当作同一种协议：GPT/Grok 读取 `b64_json` 或 `url`，Gemini 读取 `candidates[].content.parts[].inlineData`。

### GPT/Grok 文生图（推荐异步）

```http
POST https://api.ai-media.vip/v1/images/generations
Authorization: Bearer $FLUXPORT_API_KEY
Idempotency-Key: image-<业务唯一ID>
Content-Type: application/json
```

```json
{
  "model": "gpt-image-2",
  "prompt": "高级感咖啡杯产品图，白色背景，柔和自然光，无文字水印",
  "size": "1024x1024",
  "n": 1,
  "response_format": "url",
  "async": true
}
```

- `n` 默认 1，JSON 当前可接受 1–6，但模型/通道可能更小。
- `size`、`quality`、2K/4K 是否可用取决于模型和分组，不能跨模型照抄。
- `response_format` 可请求 `url` 或 `b64_json`；平台策略可改写它，所以客户端必须兼容二者。
- `async` 也可通过 `?async=true` 或 `X-FluxPort-Async: true` 传入，但最终以 HTTP `200`/`202` 判断实际模式。
- 创建请求必须有唯一 `Idempotency-Key`；网络重试使用**同一个**键和完全相同的请求体。

### GPT/Grok 参考图编辑

```bash
curl -X POST 'https://api.ai-media.vip/v1/images/edits' \
  -H "Authorization: Bearer $FLUXPORT_API_KEY" \
  -H 'Idempotency-Key: image-edit-<业务唯一ID>' \
  -F 'model=gpt-image-2' \
  -F 'prompt=保留主体，把背景换成明亮的电商摄影棚' \
  -F 'size=1024x1024' \
  -F 'async=true' \
  -F 'image=@reference.png'
```

可重复传 `image=@...` 提交多张参考图。上传 multipart 时不要自行设置 `Content-Type: multipart/form-data`，HTTP 客户端需要自动带 boundary。本项目已按此规则构造 `requests` 的 `files` 请求。

### Gemini/Nano Banana 原生图片

```http
POST https://api.ai-media.vip/v1beta/models/gemini-3.1-flash-image-preview:generateContent
x-goog-api-key: $FLUXPORT_API_KEY
Content-Type: application/json
```

```json
{
  "contents": [{
    "role": "user",
    "parts": [{"text": "一个现代机器人在工作台前，明亮清晰，无文字水印"}]
  }],
  "generationConfig": {
    "responseModalities": ["TEXT", "IMAGE"],
    "imageConfig": {"aspectRatio": "1:1", "imageSize": "2K"}
  }
}
```

结果中的图片路径为：

```text
candidates[].content.parts[].inlineData
  .mimeType
  .data                 # base64 图片本体
```

### 同步响应与异步图片任务

同步 `200` 常见格式：

```json
{"data": [{"b64_json": "iVBORw0..."}]}
```

或：

```json
{"data": [{"url": "https://..."}]}
```

异步 `202` 典型回执：

```json
{
  "task_id": "imgtask_xxx",
  "status": "queued",
  "status_url": "/v1/images/tasks/imgtask_xxx?view=summary",
  "result_url": "/v1/images/tasks/imgtask_xxx",
  "poll_after_ms": 2000,
  "assets": []
}
```

轮询流程：

1. 保存 `task_id`、`status_url`、`result_url` 与原始 `Idempotency-Key`。
2. 优先 `GET {status_url}`（通常为 `?view=summary`），带 `Authorization`；不要用完整结果接口做普通轮询，因为它可能返回很大的 base64。
3. 严格优先使用响应里的 `poll_after_ms`；正常状态不得快于 2 秒，429/网络错误退避到 5–10 秒。
4. 图片完成态是 **`success`**，不是 `completed`。处理中：`queued`、`dispatching`、`running`；失败终态：`failed`、`uncertain`、`canceled` 等。
5. 成功后优先下载 `assets[].signed_url`（约 6 小时、无需鉴权）；没有时使用 `assets[].url` 或 `download_url`，并携带 API Key。也可用 `GET /v1/images/tasks/{task_id}/assets/{file_name}?download=1`。

## 5. 视频接口（全异步）

### 创建任务

```http
POST https://api.ai-media.vip/v1/videos
Authorization: Bearer $FLUXPORT_API_KEY
Idempotency-Key: video-<业务唯一ID>
Content-Type: application/json
```

```json
{
  "model": "grok-imagine-video-1.5-preview",
  "prompt": "一条巨龙飞向城墙，火光照亮天空，镜头缓慢推进，史诗电影感，无文字水印",
  "seconds": 15,
  "size": "1280x720",
  "image_url": "https://example.com/reference.jpg"
}
```

也可 multipart 上传：`-F image=@reference.png`。单张参考图必须是服务器能直接下载的 JPG/PNG/WEBP/GIF，最大 20MB；本机路径、需登录页面、网盘分享页、SVG/HTML 预览页都不行。无公开链接时可使用 multipart 或 `image_base64`。

常用字段：

| 字段 | 说明 |
| --- | --- |
| `model` | 必填；仅使用当前 Key `GET /v1/models` 返回的模型。 |
| `prompt` | 强烈建议始终提供，描述主体、动作、镜头、风格与禁项。 |
| `seconds` / `duration` | 二选一；同时提供时优先 `seconds`。 |
| `size` | 像素尺寸，如 `1280x720`。新请求不要同时传 `size` 与 `resolution + aspect_ratio`。 |
| `resolution` + `aspect_ratio` | 只用于明确支持这套字段的模型。 |
| `image_url` / `input_reference` | 单张公网参考图。 |
| `reference_images` | 多参考图 URL/data URL 数组，或重复 multipart 文件字段。 |
| `start_frame` / `end_frame` | 首尾帧模式；尾帧不可单独用，也不要和普通参考图混用。 |
| `input_video` / `video_references` | 仅模型明确支持视频参考时传。 |
| `audio` | 是否要求结果音轨；仅支持该字段的模型使用。 |

创建回执至少保存 `id`、`task_id` 或 `request_id`。有 `status_url` 与 `poll_after_ms` 时优先使用；没有则自行查询 `/v1/videos/{task_id}`。

### 查询与下载

```http
GET https://api.ai-media.vip/v1/videos/{task_id}
Authorization: Bearer $FLUXPORT_API_KEY
```

```http
GET https://api.ai-media.vip/v1/videos/{task_id}/content
Authorization: Bearer $FLUXPORT_API_KEY
Accept: video/mp4,application/octet-stream,*/*
```

| 状态 | 客户端动作 |
| --- | --- |
| `queued`、`processing`、`in_progress` | 继续轮询，通常约 10 秒一次；优先 `poll_after_ms`/`Retry-After`。 |
| `pending_confirmation` | 不确定但并非失败；保留原任务与幂等键，约 60 秒后再查，绝不换 Key 直接重发。 |
| `completed` | 完成；读取 `output.video_url`、`video_url` 或 `download_url`，或带 Key 调 `/content` 下载。 |
| `failed`、`canceled`、`cancelled` | 终态；修正问题后使用新的业务 ID / 新幂等键创建新任务。 |

`video_url` / `download_url` 可能过期，不应当作永久 CDN 链接；可靠做法是保留 `task_id`，需要时用同一 Key 调 `/content`。查询与下载不会再次计费。

## 6. 错误与重试规则

| 现象 | 处理 |
| --- | --- |
| 400 `invalid_request_error` | 参数、协议或素材格式错误；修正后再发，不要盲目重试。 |
| 401 | Key 缺失、错误或禁用。 |
| 403 | 余额、订阅、分组权限或 IP 限制；检查对应 Key 分组。 |
| 404 `model_not_found` | 当前 Key 没有这个模型；先重新拉取该 Key 的 `/models`。 |
| 409 `idempotency_conflict` | 同一幂等键被用于不同请求；同一次重试必须请求体完全相同。 |
| 413 | 图片/文件太大；压缩或改为可访问 URL。 |
| 429 / 503 | 降并发、按 `Retry-After` 退避；创建任务不要换幂等键重放。 |
| 202 `upstream_result_uncertain` / `pending_confirmation` | 先查询原任务；不能当作明确失败后立即再创建。 |

## 7. Infinite Canvas 对接清单

- 图片请求实现：`backend/api/unified_api.py`
  - FluxPort 的 GPT/Grok 文生图：`/v1/images/generations` + `async: true`。
  - 参考图：`/v1/images/edits` + multipart `image` 字段。
  - 202 回执：后端轮询 `status_url`，跟随最新 `poll_after_ms`，成功后保存本地缩略图和原图。
- 模型类型规则：`backend/api/model_rules.py`
  - `grok-imagine-image-*` 被认定为绘图模型，使用 OpenAI Images 协议。
- 前端模型分组：`src/v1/ui/settings-panel.ts`
  - 每个密钥组独立拉取、独立保存模型，节点模型下拉按 `provider:key:model` 路由。

若再次出现“后端完成但前端空图”，按这个顺序查：请求 HTTP 状态 → 202 回执的 `task_id/status_url` → 轮询是否到 `success` → `assets[].signed_url`/受保护下载是否成功 → 本地缩略图与原图路径是否已写入任务结果。
