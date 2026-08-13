# 系统设计：三种节点合并为统一「生成节点」

> 架构师：高见远 · 范围：pywebview + Vite/TS 前端 `src/v1/`（Vite root=`src`，构建输出 `gui/dist`），后端 `backend/` 无需改动。

## 1. 实现方案与选型

**选型结论：零新增依赖，纯前端类型收敛 + 数据流改造。** 后端 `unified_api.py` 已支持 `referenceImages`（camelCase）选项，模型 `id = "${providerId}:${modelId}"` 由 `_getImageModels()` 产出，无需改后端。

**是否保留旧文件：删除。** `product-image.ts` / `style-transfer.ts` 两个定义文件删除，`main.ts` 不再 import；旧类型字符串仅在 `persistence.ts` 迁移函数内以 `LegacyNodeType` 字面量出现（业务代码一律禁止出现，否则 `NodeType='image-gen'` 单值下 tsc 会报"无重叠比较"错误）。

**refImages 数据流贯穿（核心约定）**：
- `FlowNode` 新增顶层字段 `refImages: string[]`（用户主动挂的参考图），与 `imageUrl`（本节点输出图=主视觉）严格分离。
- `addNode` 默认 `refImages: []`；追加/删除走 `FlowState.addRefImage / removeRefImage`（本期只做追加+删除，替换/排序 P2）。
- 连线语义 = **运行时派生**，不落库：上游 `imageUrl` 自动并入下游参考。唯一合并入口 `FlowState.getReferenceImages(id)` = `refImages ∪ 上游imageUrl`（去重保序），`buildOptions` / 卡片缩略行 / 指令面板三者共用，避免各自写一份导致漂移。
- `canRun` 统一为「非空 prompt && 已选 model」，参考图 0~N 可选；无 prompt 报「请输入提示词」。删除原 product-image「有图即完成、不调 backend」分支（`run-engine` 与 `product-image.ts` 两处）。
- 卡片主视觉 = `imageUrl`；参考图放卡片底部缩略行（所有节点，不再限定 image-gen）。
- 连线规则：任意节点同权互连；`canConnect` 删除「product-image 不能作下游」特例，新增防环检测（BFS 判可达）。
- 指令面板：删三 tab（`index.html` 的 `.cmd-tabs` + `cmd-panel.ts` 的 `activeTab`），固定单面板 = 参考图区 + 提示词 + model/ratio/resolution/count chips。

## 2. 数据结构与接口

```ts
// src/v1/types/flow.d.ts
type NodeType = 'image-gen';                                   // 收敛为单一类型
type LegacyNodeType = 'product-image' | 'style-transfer' | 'image-gen'; // 仅迁移用

interface FlowNode {
  id: string; type: NodeType;
  x: number; y: number; ratio: number;
  status: NodeStatus; title: string;
  params: Record<string, unknown>;   // 复用 StyleTransferParams 语义
  imageUrl: string | null;           // 本节点输出图（主视觉）
  refImages: string[];               // 新增：用户主动挂的参考图
  error: string | null; lastRunAt: number | null;
}

interface FlowContext {
  getUpstreams(nodeId: string): FlowNode[];
  getDownstreams(nodeId: string): FlowNode[];
  getReferenceImages(nodeId: string): string[]; // 新增：refImages ∪ 上游imageUrl
  getImageModels(): Promise<Array<{ id: string; name: string }>>;
}

interface FlowProject { format: 'icv'; version: '3.1'; /* 升 3.1 */ }
```

```ts
// src/v1/nodes/image-gen.ts —— 唯一节点定义
canRun(node, ctx) {
  const p = node.params as StyleTransferParams;
  if (!p.prompt?.trim()) return '请输入提示词';
  if (!p.model) return '请先选择绘图模型';
  return true; // 参考图可选 0~N
}
buildOptions(node, ctx) {
  const p = node.params as StyleTransferParams;
  return { model: p.model || undefined, aspectRatio: p.aspectRatio || 'Auto',
           resolution: p.resolution || '1k', count: p.count || 1,
           referenceImages: ctx.getReferenceImages(node.id) };
}
```

```ts
// src/v1/state/flow-state.ts 关键变更
addNode(...) { /* 节点初值增加 refImages: []（extra 可覆盖） */ }
getReferenceImages(id) { /* refImages 在前 + 上游 imageUrl 在后，Set 去重保序 */ }
addRefImage(id, url)   { /* 去重追加 → notify → dirty.markStale(id) */ }
removeRefImage(id, url){ /* 过滤删除 → notify → dirty.markStale(id) */ }
canConnect(from, to)   {
  if (!getNode(from)||!getNode(to)) return '节点不存在';
  if (from===to) return '不能连接自己';
  if (edges.some(e=>e.from===from&&e.to===to)) return '已有相同连线';
  if (this._wouldCycle(from,to)) return '不能形成循环';   // 新增
  return null;
}
_wouldCycle(from,to)   { /* 从 to 出发 BFS 收集可达节点，含 from 即成环 */ }
insertStep(edgeId)     { /* 新节点 type 改为 'image-gen' */ }
```

```ts
// src/v1/persistence.ts 迁移
function migrateNode(raw: any): FlowNode | null {
  const t = raw?.type as string;
  if (t !== 'product-image' && t !== 'style-transfer' && t !== 'image-gen') return null;
  const node: FlowNode = { /* 校验/补默认值 */ type:'image-gen', refImages:[],
    params: { prompt:'', model:'', aspectRatio:'3:4', resolution:'2k', count:1, ...(raw.params||{}) } };
  if (t === 'product-image') {                 // 旧"输入图"→参考图
    node.refImages = typeof raw.imageUrl==='string' ? [raw.imageUrl] : [];
    node.imageUrl = null; node.status = 'idle'; // 旧 done 无输出图，重置避免"done但空图"
  } else {
    node.refImages = Array.isArray(raw.refImages) ? raw.refImages : [];
  }
  return node;
}
```

## 3. 程序调用流程

见 `docs/sequence-diagram.mermaid`（拖图进画布 / 运行 / 旧项目加载 三条）；类图见 `docs/class-diagram.mermaid`。

## 4. 文件清单

| 文件（相对路径） | 动作 | 职责 |
|---|---|---|
| `src/v1/types/flow.d.ts` | 改 | NodeType 收敛；FlowNode 增 refImages；FlowContext 增 getReferenceImages；version 3.1；加 LegacyNodeType |
| `src/v1/nodes/image-gen.ts` | 改 | 成为唯一「生成节点」定义（canRun/buildOptions 统一） |
| `src/v1/nodes/product-image.ts` | 删 | 并入 image-gen，不再注册 |
| `src/v1/nodes/style-transfer.ts` | 删 | 并入 image-gen，不再注册 |
| `src/v1/state/flow-state.ts` | 改 | addNode 默认 refImages；getReferenceImages/addRefImage/removeRefImage；canConnect 去特例+防环；insertStep 用 image-gen |
| `src/v1/engine/run-engine.ts` | 改 | 删 product-image 特殊分支（统一走 backend 生成） |
| `src/v1/canvas/interactions.ts` | 改 | 右键三新建合一；拖线新建菜单合一；_dropImage 改为挂参考图；文件选图改 addRefImage |
| `src/v1/canvas/card-view.ts` | 改 | 底部缩略行改用 getReferenceImages（不限类型）；空态文案统一 |
| `src/v1/canvas/link-view.ts` | 改 | 仅注释/文案核对（插入步骤提示），无功能改动 |
| `src/v1/ui/cmd-panel.ts` | 改 | 删三 tab 与 activeTab；参考区统一渲染 refImages+上游（refImages 带 × 删除）；ref-add 改为追加参考图 |
| `src/v1/ui/empty-state.ts` | 改 | _fillModels 过滤条件 style-transfer → image-gen |
| `src/v1/templates.ts` | 改 | 默认模板改为「生成节点A(挂产品图+提示词)→生成节点B」 |
| `src/v1/persistence.ts` | 改 | version 3.1 + migrateNode 旧类型归一迁移 |
| `src/v1/main.ts` | 改 | 只 import image-gen；fillDefaultModels 过滤条件收敛 |
| `src/index.html` | 改 | 删 `.cmd-tabs` 三 tab 元素 |
| `src/v1/styles/app.css` | 改 | 参考图缩略 × 删除按钮样式；单面板微调 |

## 5. 任务列表（按实现顺序）

| ID | 任务名 | 涉及文件 | 依赖 | 优先级 |
|---|---|---|---|---|
| T01 | 数据层与类型收敛（基础） | flow.d.ts、nodes/image-gen.ts、nodes/product-image.ts(删)、nodes/style-transfer.ts(删)、state/flow-state.ts、main.ts、ui/empty-state.ts | — | P0 |
| T02 | 运行语义与项目迁移 | engine/run-engine.ts、persistence.ts、templates.ts | T01 | P0 |
| T03 | 画布交互与卡片渲染 | canvas/interactions.ts、canvas/card-view.ts、canvas/link-view.ts | T01 | P0 |
| T04 | 指令面板与页面样式 | ui/cmd-panel.ts、index.html、styles/app.css | T01 | P0 |

- **串行**：T01 必须最先（所有任务依赖其类型与数据层）。
- **可并行**：T02 / T03 / T04 在 T01 完成后可并行分派给不同工程师（互不依赖）。

## 6. 依赖包

无新增依赖。纯 TS 前端改造，后端与 `package.json` 均不动。

## 7. 共享知识（跨文件约定）

1. `refImages` 命名（camelCase，FlowNode 顶层，`string[]`，默认 `[]`）；`imageUrl` = 本节点输出图，二者严格分离。
2. 参考图合并唯一入口 `FlowState.getReferenceImages(id)`（refImages 在前、上游 imageUrl 在后、去重保序）；buildOptions/card-view/cmd-panel 一律调用它。
3. `model` 参数格式 `${providerId}:${modelId}`；默认模型回填用 `resolveDefaultModel()`（localStorage key `icv_default_model`）。
4. 防环算法唯一位置 `FlowState._wouldCycle`（BFS），`canConnect` 是唯一连线校验入口；`connect()` / `_createNodeFromMenu` 都先走 canConnect。
5. 唯一生成入口 `RunEngine`，节点定义不直连 backend。
6. 改上游 → `dirty.markUpstreamChanged(id)` 标下游 stale；`run` 中节点不覆盖状态。
7. `.icproj` 读写仅 `persistence.ts`；迁移只在此处，业务代码禁止出现 `'product-image'/'style-transfer'` 字面量（会触发 tsc 无重叠比较报错）。
8. `count>1` 时引擎仍只回写第一张（沿用 pollTask 单张语义），多图后续 P2。

## 8. 待明确事项

1. **旧项目 version 判断**：当前 `restore` 只校验 `format==='icv'` 不校验 version。建议「3.0/3.1 统一走 migrateNode，不拒绝」，沿用 A9「非 icv 拒绝」口径。
2. **refImages 与 imageUrl 同时存在**：主视觉恒为 imageUrl，参考图只进底部缩略行；同一 URL 同时作为 refImage 与上游时 `getReferenceImages` 已去重。
3. **连线删除后下游 refImages 不受影响**：refImages 是用户主动挂载，不随连线删除清除，仅标 stale（沿用 `removeEdge` 现有逻辑）。
4. **迁移后 product-image 的 status**：旧 `done` 但无输出图会"done+空卡"矛盾，建议迁移时重置为 `idle`（已在 migrateNode 落实）。
5. **点击空卡 / 拖图命中节点**：统一按「追加参考图」处理（本期无替换语义），点击空卡打开文件选择器追加参考图。
6. **insertStep 防环**：断边重连不产生环（DAG 保序操作），但新节点默认无 model，需沿用 `resolveDefaultModel` 回填。
