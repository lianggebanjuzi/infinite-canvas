# PRD：供应商多 Key 支持（Multi-Key）

## 1. 项目信息

- **Language**: 中文
- **技术栈**: pywebview + TypeScript/Vite（沿用现有，非 React/MUI）
- **Project Name**: multi_key_support
- **原始需求**：部分中转站（如 api.ai-media.vip / FluxPort）按 API key 分组提供模型，一个 key 只对应一组模型（跨组调用报 400）。当前 providers_data.json 每个供应商只能填一个 key，用户希望**一个供应商条目（同一 api_url）下挂多个 key，每个 key 独立拉取自己的模型组，节点选模型时自动路由到所属 key 出图**。
- **已确认方向**：每个 key 独立模型组（推荐方案）。

## 2. 产品定义

### 产品目标（一句话）
让一个供应商（同一 api_url）支持挂多个 API key，每个 key 独立管理自己的模型组，节点选模型后自动用该模型所属的 key 出图，用户无需新建供应商或手动换 key。

### 用户故事
1. 作为使用 FluxPort 中转站的用户，我希望在同一供应商下添加第二个 key 并拉取它的模型组，这样不用换供应商就能用不同分组的模型。
2. 作为用户，我希望给每个 key 命名（如「绘图A组」「绘图B组」），这样跨 key 重名模型在节点选择时能一眼区分。
3. 作为用户，我希望停用某个 key 后它的模型不再出现在选择列表，这样不会误选到已过期/不用的分组。
4. 作为用户，我希望升级后旧的默认模型设置仍然有效，这样不用重新配置。

## 3. 需求池

### P0（本期必须）
- **数据模型多 key 化**：`api_key`（单值字符串）+ `models[]` → `keys[]` 数组，每个 key 独立持有 `{id, name, api_key, enabled, models[]}`。
- **旧数据无损迁移**：现有 `api_key` / `models` 自动迁移为第一个 key（`keys[0]`），读时兼容归一化，用户无感知。
- **设置 UI 多 key 管理**：同一供应商下可添加/删除多个 key；每个 key 独立「拉取模型」「显示/隐藏 key」「测试连接」。
- **节点模型选择汇总**：模型下拉列出**所有 key** 的 drawing 模型，完整 id 三段式（见数据模型约束），label 带 key 名区分重名模型。
- **后端按 key 出图**：`_resolve_drawing_model` 解析三段 id 得到 provider + key + model，用该 key 的 `api_key` 调 API（chat 链路同构处理）。

### P1（应该，可后置一小步）
- key 级启用/停用开关（停用 key 的模型不进入节点选择列表）。
- key 命名/备注（默认自动生成「key1/key2…」，用户可改，用于区分重名模型）。
- 测试连接按 key 独立执行。
- 删除 key 的确认弹窗 + 影响提示（该 key 下模型将失效，节点需重新选择）。

### P2（可以后置）
- key 排序（上移/下移或拖拽）。
- 一键复制 key。
- 模型列表按 key 分组展示/折叠、按 key 显示徽标。
- 对话模型（chat）同样按 key 展示（P0 至少保证绘图链路，chat 复用同一解析函数）。

> **本期必须（P0）**：多 key 数据结构 + 迁移 + UI 增删 + 独立拉模型 + 节点三段 id 选择 + 后端按 key 出图。
> **可后置（P1/P2）**：key 启停/命名/测试连接细化、排序/复制/徽标等体验优化。

## 4. 数据模型约束（给架构师）

### 4.1 新结构（建议）
```json
{
  "id": "provider_xxx",
  "name": "FluxPort",
  "short_name": "flux",
  "type": "openai",
  "enabled": true,
  "api_url": "https://api.ai-media.vip",
  "use_proxy": true,
  "keys": [
    {
      "id": "key_1a2b3c4d",
      "name": "绘图A组",
      "api_key": "sk-...",
      "enabled": true,
      "models": [
        { "id": "gemini-3-pro-image-preview", "name": "Nano Banana Pro", "type": "drawing", "enabled": true }
      ]
    },
    {
      "id": "key_5e6f7a8b",
      "name": "绘图B组",
      "api_key": "sk-...",
      "enabled": true,
      "models": [ ... ]
    }
  ]
}
```

### 4.2 新旧兼容
- **读时归一化（推荐）**：`load_providers()` 对旧结构（有 `api_key` 无 `keys`）自动生成 `keys[0]`（`name` 默认「默认」或供应商简称，`enabled` 继承 provider 级），把旧 `api_key` / `models` 移入；内存中始终以新结构为准，`save_providers()` 写新结构。旧文件无需手工改。
- **顶层冗余字段**：迁移后**不再保留**顶层 `api_key`/`models`（单机工具，一次性迁移；保留只会造成双写不一致）。
- `update_provider` 需兼容：收到顶层 `api_key` 更新（旧前端/旧脚本）时，落到 `keys[0].api_key`。

### 4.3 模型 id 唯一性（节点侧）
- 完整 id：**`${providerId}:${keyId}:${modelId}`**（三段式）。
- `fetchImageModels` / `fetchChatModels` 拼接三段 id；label 建议 `供应商短名 · key名 - 模型名`（重名模型靠 key 名区分）。
- `_resolve_drawing_model` / `_resolve_chat_model` 改为三段解析：`provider_id:key_id:model_id` → 找到 key → 用 `key.api_key` 出图。
- **两段 id 向后兼容**：旧项目文件 / 旧 localStorage 存的是 `${providerId}:${modelId}`。解析时若三段失败，尝试两段匹配到该 provider 第一个可用 key 下的同名模型；仍失败则回退第一个可用模型。

### 4.4 default_model 的 localStorage 旧 id 处理
- 键：`icv_default_model`（绘图）、`icv_default_chat_model`（对话，text-gen）。
- **建议策略：宽容解析 + 惰性重写**。`resolveDefaultModel()` / `resolveDefaultChatModel()` 读取旧两段 id 时宽容回退（见 4.3）；解析成功后把新三段 id 写回 localStorage，逐步自愈，无需升级脚本。

### 4.5 相关 API 调整点
- `remove_model(provider_id, model_id)` → 需带 key 维度：`remove_model(provider_id, key_id, model_id)`。
- `fetch_models(api_url, api_key)` 逻辑不变（本来就是 url+key 拉取），前端按 key 调用后写入对应 `keys[i].models`。
- 手动添加模型归属到当前编辑的 key 下（不再是 provider 级）。

## 5. 待确认问题

1. **旧 localStorage 默认模型 id 迁移策略**：采用「宽容解析 + 惰性重写」是否 OK？还是希望升级时一次性扫描重写/清空？（推荐前者）
2. **多 key 下「默认绘图模型」语义**：默认模型应是「provider+key+model」三元组，还是「provider+model」自动选 key？跨 key 重名模型存在，建议三元组，需拍板。
3. **迁移后顶层冗余字段**：确认不再保留顶层 `api_key`/`models` 冗余字段（回滚不友好，但单机工具可接受）？
4. **key 被删除/停用时，已引用其模型的节点行为**：建议删除 key 前弹确认提示；已失效节点出图时报错并提示重新选择模型。是否接受？
5. **对话模型（chat）是否本期一并按 key 支持**：用户场景以绘图为主，但结构同构；P0 是否覆盖 chat 链路，还是仅绘图？（建议一并覆盖，成本低）
6. **key id 生成**：用 `key_${uuid}` 即可，无需用户可读，确认无异议。
