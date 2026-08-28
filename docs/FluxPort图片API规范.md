# FluxPort 图片 API 规范（uselg.top 中转站）

> 来源：https://uselg.top/docs（ApiDocsView 组件源码提取，2026-08-17）
> 用途：Infinite Canvas 2.0 unified_api.py 图片链路修复依据。后续图片生成统一兼容本中转站。

## 1. 端点地址（关键）

| 用途 | 地址 | 说明 |
|---|---|---|
| 语言任务（chat） | `https://api.uselg.top/v1` | OpenAI SDK 等继续使用 |
| **GPT/Grok/OpenAI 兼容图片** | `https://api.ai-media.vip/v1` | 不经过 Cloudflare |
| **Gemini 原生图片** | `https://api.ai-media.vip/v1beta` | 不经过 Cloudflare |
| Claude | `https://api.uselg.top` | 根地址，REST 用 /v1/messages |
| Gemini SDK | `https://api.uselg.top` | 根地址，REST 用 /v1beta，支持 ?key= |

**注意**：图片/视频请求必须走直连地址（api.ai-media.vip），否则 Cloudflare 长请求易断连 → 超时。

## 2. Gemini 图片（本项目使用）

- 路径：`POST /v1beta/models/{model}:generateContent`
- 模型：`gemini-3-pro-image-preview`、`gemini-3.1-flash-image-preview`
- 返回：图片在 `candidates[].content.parts[].inlineData`（base64），不是 fileData.fileUri
- 也可返回 202 异步任务（见下）

## 3. 异步图片任务推荐流程

1. 提交时带唯一 `Idempotency-Key` + `"async": true`
2. 收到 HTTP 202 后保存 `task_id`、`status_url`、`result_url`
3. 按 `poll_after_ms` 查询轻量 summary（`GET /v1/images/tasks/{id}?view=summary`）——**普通轮询不要用原始 result_url**（会拉大 base64）
4. 成功后读取 `assets[]` 资产

## 4. 任务状态

| 状态 | 含义 | 客户端处理 |
|---|---|---|
| `queued` | 已落盘等待队列 | 继续按 poll_after_ms 查询 |
| `dispatching` | 调度器取任务，选通道中 | 继续查询，不要重复提交 |
| `running` | 处理中/等模型结果 | 继续查询 |
| **`success`** | **图片任务完成**（不是 completed！） | 读 assets |
| `failed` | 已失败 | 记录 error，新幂等键重发 |
| `uncertain` | 模型超时/断线，结果不确定 | 先查原任务，勿盲目重发 |
| `client_disconnected` | 同步请求客户端断开 | 先核对原任务 |
| `paused` / `canceled` | 暂停/取消 | 终态 |

**视频任务完成态才是 `completed`，图片任务是 `success`。**

## 5. 任务资产读取

- 优先 `assets[].signed_url`（6 小时临时 HTTPS 直链，免 Authorization）
- 缺失时用 `assets[].url` / `download_url`（需带 API Key，受任务归属和 expires_at 限制）
- 轻量查询接口 `GET /v1/images/tasks/{id}?view=summary`：始终返回任务元数据 + 资产清单，不返回体积大的 base64 结果

## 6. 轮询间隔与超时

- 优先用响应里的 `poll_after_ms`（queued/dispatching/running 通常 2000ms，终态 0）
- 正常不要快于 2 秒
- 429、网络错误或连续失败 → 逐步退避到 5-10 秒

## 7. 请求示例（文档原样）

```bash
curl -X POST "https://api.ai-media.vip/v1/images/generations" \
  -H "Authorization: Bearer 你的API密钥" \
  -H "Idempotency-Key: image-订单号-001" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "高级感咖啡杯产品图，白色背景，柔和自然光，无文字水印",
    "size": "1024x1024",
    "n": 1,
    "async": true
  }'
```

202 回执示例：

```json
{
  "id": "imgtask_xxxxxxxxxxxxxxxxxxxxx",
  "task_id": "imgtask_xxxxxxxxxxxxxxxxxxxxx",
  "object": "image.task",
  "status": "queued",
  "poll_url": "/v1/images/tasks/imgtask_xxxxxxxxxxxxxxxxxxxxx",
  "status_url": "/v1/images/tasks/imgtask_xxxxxxxxxxxxxxxxxxxxx?view=summary",
  "result_url": "/v1/images/tasks/imgtask_xxxxxxxxxxxxxxxxxxxxx",
  "poll_after_ms": 2000,
  "assets": [],
  "expires_at": "2026-08-07T12:00:00Z"
}
```

## 8. 实测确认（2026-08-17）

- `https://api.uselg.top/v1/v1beta/models/gemini-3-pro-image-preview:generateContent`（双重 v1 前缀）→ 202 + task 对象（endpoint 原样回显 /v1/v1beta/...）
- `https://api.uselg.top/v1beta/models/gemini-3-pro-image-preview:generateContent`（单 v1beta）→ 同样 202 + task
- 两种路径下任务均卡 `queued` → `dispatching`，`image_requested: 0`，未在 120s 内出图（可能排队或配置问题，但**客户端必须正确解析异步协议**）
- `https://api.uselg.top/v1/images/generations`（OpenAI 图片格式）→ 404 "Images API is not supported for this platform"——**该 Key 分组只支持 Gemini 原生协议，OpenAI 图片格式不可用**
