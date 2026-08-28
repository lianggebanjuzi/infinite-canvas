# FluxPort 接入回归报告

> 生成：2026-08-19（实施阶段 T01–T04 完成，T05 真 Key 端到端待验）
> 对应实施设计：`docs/fluxport-供应商接入-实施设计.md`；接口手册：`docs/FluxPort-API-接入手册.md`
> 说明：本文件为 QA 验证清单骨架，冒烟结论已由工程师在 T01–T04 阶段回填；**带 ⚠️ 真Key 的行必须由真实 FluxPort Key 验证后才能关闭**。

## 0. 验证环境

- Python：`C:/Users/zeng-rong/AppData/Local/Programs/Python/Python312/python.exe`
- 冒烟脚本：`smoke/test_fluxport_chat.py`、`smoke/test_fluxport_video.py`
- 前端类型检查：`npx tsc --noEmit`

## 1. 冒烟结果（T01–T04，不依赖真 Key 部分）

| 项 | 脚本 | 结果 |
|---|---|---|
| chat 域名归一 / 模型拉取三态 / chat_v2 组装 / 防污染守卫 | `smoke/test_fluxport_chat.py` | 23 项全过 |
| 视频 URL/payload/尺寸映射/提取/主链路/兜底/失败态/异步任务 | `smoke/test_fluxport_video.py` | 42 项全过 |
| 既有回归（multi-key 三段解析/归一化） | `smoke/test_multikey.py` | 53 项全过 |
| 后端语法编译 | `py_compile model_rules/gemini_compat/provider_api/unified_api/video_api` | 通过 |
| 前端类型检查 | `npx tsc --noEmit`（改动：settings-panel.ts、backend.d.ts） | 0 错误 |

## 2. QA 验证清单

### 2.1 模型识别与分类（T01）

- [ ] `detect_model_type('grok-imagine-video-1.5-preview') == 'video'`
- [ ] `detect_model_format_name('grok-imagine-video-1.5-preview') == 'fluxport_video'`
- [ ] `grok-imagine-image-*` 仍为 `drawing`（互不干扰）
- [ ] `gpt-5.4` 等仍为 `chat`
- [ ] 设置页“拉取模型”后视频模型在 keys[i].models[] 中 `type === 'video'`（未被改写 drawing）⚠️（需真 Key 拉到视频模型）

### 2.2 域名双向归一（T01/T02）

- [ ] `resolve_chat_api_base('https://api.ai-media.vip/v1') == 'https://api.uselg.top/v1'`
- [ ] `resolve_image_api_base('https://api.uselg.top/v1') == 'https://api.ai-media.vip'`（既有行为未回归）
- [ ] 媒体域配置下 `fetch_models` 实际请求 `https://api.uselg.top/v1/models` ⚠️（真 Key）
- [ ] 媒体域配置下 `chat_v2` 实际请求 `https://api.uselg.top/v1/chat/completions` ⚠️（真 Key）

### 2.3 文本反推（T02）

- [ ] 媒体域供应商配置下，text-gen 节点反推成功（runTextGen → chat_v2 → text）⚠️（真 Key）
- [ ] chat_v2 payload 显式 `stream:false`
- [ ] 旧数据中 `type='chat'` 的视频模型不会被对话选中（防污染守卫；重拉模型后自愈）

### 2.4 视频生成后端（T03）

- [ ] `POST https://api.ai-media.vip/v1/videos`，Header 含 `Idempotency-Key: video-<uuid>`、`Authorization`、`Content-Type: application/json` ⚠️（真 Key）
- [ ] 创建回执缺失 status_url 时回退 `GET /v1/videos/{task_id}`
- [ ] 轮询间隔遵守 `poll_after_ms` 且下限 2s
- [ ] 429 优先 Retry-After；无则 5–10s 退避；不换幂等键 ⚠️（真 Key 或日志验证）
- [ ] `pending_confirmation` 60s 后再查、连续 10 次报错、绝不换 Key 重发 ⚠️（真 Key 或日志验证）
- [ ] completed → `output.video_url / video_url / download_url / assets[].signed_url` 任一可提取
- [ ] 下载 stream + 1MB 分块落盘 `{image_save_path}/videos/unified_video_<ts>.mp4`
- [ ] signed_url 失败 → 兜底 `GET /v1/videos/{task_id}/content`（带 Key + `Accept: video/mp4,application/octet-stream,*/*`）
- [ ] 成功契约含 `video_url(file:///) / video_path / original_url / saved_to_disk / task_id(上游) / width / height / duration / size_bytes`
- [ ] 失败走 `AppError.to_dict`（async 落盘 `{"success": false, "error_code", "message", "error"}`）
- [ ] **无视频 base64 穿桥**（返回本地 file:/// 路径）

### 2.5 主进程桥接（T04）

- [ ] `main.py` 已组装 `self.video = VideoAPI(self.unified)`
- [ ] console/QA 直测：`unified_generate_video_sync(prompt, {model:'provider:key:grok-imagine-video-*', seconds: 5})` 返回成功契约 ⚠️（真 Key）
- [ ] `generate_video` / `generate_video_async` / `get_video_task_result` / `unified_generate_video` / `unified_generate_video_sync` / `unified_get_video_task_result` 均可用，异常 → `e.to_dict()`

### 2.6 前端（T02 类型保全）

- [ ] 设置页拉取模型后视频模型 `type` 保持 `'video'`
- [ ] 绘图模型下拉不出现视频模型（`fetchImageModels` 按 `type==='drawing'` 过滤天然隔离）
- [ ] 对话模型下拉不出现视频模型（`fetchChatModels` 按 `type==='chat'` 过滤天然隔离）
- [ ] `BackendVideoTaskResult` 类型已预留（未接 UI）

## 3. 已知限制 / 待明确

- 视频模型可见性取决于 Key 分组（`grok-imagine-video-*` 之外的 veo/kling 等以 `/models` 实际返回为准）。
- `seconds` / `size` 本期后端透传，UI 未提供选择（默认平台值）。
- 视频元数据（width/height/duration）不依赖 ffprobe，FluxPort 完成响应未承诺携带，取不到为 null。
- 本期不做：OpenAI Responses（Codex）、Claude Messages、视频参考图 multipart、前端视频节点/轮询 UI、缩略图、ffprobe 解析。

## 4. 回归记录

| 日期 | 验证人 | 结果 | 备注 |
|---|---|---|---|
| 2026-08-19 | 工程师（Alex） | 冒烟通过（57 项） | T05 真 Key 端到端待验 |
|  |  |  |  |
