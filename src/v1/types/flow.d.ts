// src/v1/types/flow.d.ts
// ICV v1 流程画布核心类型（ambient 全局类型，无需 import 即可使用）
// 与架构文档「四、数据结构与接口」保持一致

/** 统一「生成节点」：多图参考（0~N）→ 生成 N 张新图（每张一个可编辑 image-gen 产出节点；文生图第 1 张写回自身），注册式扩展 */
type NodeType = 'image-gen' | 'text-gen';

/** 节点状态机五态 */
type NodeStatus = 'idle' | 'run' | 'done' | 'stale' | 'fail';

/** text-gen 参数：命令（临时，发送后清空）+ 文本模型 */
interface TextGenParams {
  instruction?: string;  // 命令；新建为空、用户自填、发送后清空（仅作命令暂存）
  model: string;         // "provider_id:model_id"（chat 模型）
}

/** 节点级文本历史条目（text-gen 专属；不存图片信息，见架构决策） */
interface TextGenHistoryItem {
  text: string;          // 反推结果全文
  ts: number;            // 运行完成时间戳（Date.now()）
}

/**
 * 生成档案（trace）：记录一张产出图“是怎么来的”。
 * 不存图本身，只存配方：prompt / 模型 / 比例 / 分辨率 / 张数 / 参考图指纹。
 * seed 字段先留空；官方 API 或中转站支持时由后端透传并写回。
 */
interface GenerationTrace {
  prompt: string;
  model: string;
  aspectRatio: string;
  resolution: string;
  count: number;
  refImageHashes: string[];  // 参考图指纹（轻量字符串哈希，用于“是否同源”比对，不是密码学哈希）
  refImageUrls?: string[];   // 可选：本次实际使用的参考图 URL（跨会话复现用；旧 trace 缺失时按 hash 反查图池兜底）
  seed?: string | null;      // 官方/中转站支持 seed 时记录；否则 null
  createdAt: number;
  parentId?: string | null;  // 生成源节点（手建节点自身生成时即自己 id）
  outputType: 'txt2img' | 'img2img' | 'outpaint';
}


/** 画布节点：宽固定 260，高 = 260 / ratio */
interface FlowNode {
  id: string;
  type: NodeType;
  x: number;                 // 画布世界坐标
  y: number;
  ratio: number;             // 高/宽 比例；卡片高 = CARD_W / ratio
  status: NodeStatus;
  title: string;             // 左上悬浮标签
  params: Record<string, unknown>;  // 节点参数（见 StyleTransferParams / TextGenParams）
  imageUrl: string | null;   // 本节点输出图（卡片主视觉），与 refImages 严格分离
  outputText: string | null; // 新增：text-gen 输出文本；其余类型恒 null
  textHistory: TextGenHistoryItem[]; // 新增：节点级文本历史；非 text-gen 恒 []
  refImages: string[];       // 用户主动挂载的参考图（默认 []；上游可作参考图的图由 getReferenceImages 派生）
  error: string | null;      // fail 原因（红点 hover/点击展示）
  lastRunAt: number | null;
  parentId: string | null;   // 引擎产出节点标记：本节点由哪个生成节点产出（重跑顶掉旧产出用）；手建节点恒 null
  trace: GenerationTrace | null; // 生成档案：该节点主视觉图的配方；text-gen / 手建未跑节点为 null
}

/** 画布连线：模板默认连好，首版不支持手动新建 */
interface FlowEdge {
  id: string;
  from: string;              // 上游节点 id
  to: string;                // 下游节点 id
}

/** 画布视口状态 */
interface FlowCanvasState {
  scale: number;
  panX: number;
  panY: number;
}

/** .icproj 项目格式（3.4：双卡模型——image-result 已并入 image-gen，产出节点=image-gen+parentId 标记） */
interface FlowProject {
  format: 'icv';
  version: '3.4';
  projectName: string;
  canvas: FlowCanvasState;
  nodes: FlowNode[];
  edges: FlowEdge[];
  createdAt: number;
  updatedAt: number;
}

/** 节点定义执行上下文（由 run-engine 注入） */
interface FlowContext {
  getUpstreams(nodeId: string): FlowNode[];
  getDownstreams(nodeId: string): FlowNode[];
  getReferenceImages(nodeId: string): string[]; // refImages ∪ 上游可作参考图的图（imageUrl 优先，无则回退其 refImages；去重保序）
  getImageModels(): Promise<Array<{ id: string; name: string }>>;
}

/** 注册式节点定义（新增节点 = 注册一个 NodeDefinition） */
interface NodeDefinition {
  type: NodeType;
  label: string;              // 悬浮标签
  defaultTitle: string;
  defaultRatio: number;       // 3/4
  defaultParams: Record<string, unknown>;
  creatable?: boolean;        // false=不进新建菜单（引擎产出节点由引擎自动创建，缺省 true）
  canRun(node: FlowNode, ctx: FlowContext): boolean | string; // true / 禁止原因
  buildOptions(node: FlowNode, ctx: FlowContext): Record<string, unknown>; // backend options
}

/** 生成节点参数（统一节点复用） */
interface StyleTransferParams {
  prompt: string;             // 生成指令；文本模型反推模式下复用为「命令」
  model: string;              // "provider_id:model_id"（绘图模型）
  aspectRatio: string;        // '3:4' | '1:1' | '16:9' | 'Auto'
  resolution: string;         // '1k' | '2k' | '4k'
  count: number;              // 1-4
  modelType?: 'draw' | 'text'; // image-gen 模型 chip 类型：绘图（默认，生成图）/ 文本（反推）
  textModel?: string;          // image-gen 文本模型（modelType='text' 时用于反推，chat 模型）
}

/** 前端统一错误（映射自 backend {success:false,error_code,message}） */
interface FlowError {
  code: number;
  message: string;
}

/**
 * 扩图执行参数（image-gen 悬浮「扩图」入口专用）：
 * 前端 canvas 合成白底底图（PNG dataURL）→ banana 系列模型带图补全。
 * 不持久化到节点 params（首版不支持重跑；重跑走普通生成），仅引擎调用时传递。
 */
interface OutpaintOptions {
  prompt: string;            // 组装后的完整提示词（固定前缀「白色区域是待补全区域…」+ 可选用户描述）
  referenceImages: string[]; // 合成底图（PNG dataURL，白底不透明 + 原图，长边 ≤4096）
  aspectRatio: string;       // 目标比例 '1:1' | '3:4' | '4:3' | '16:9' | '9:16'
  model: string;             // 自动解析的 gemini/nano-banana/seedream 系绘图模型（"provider:model"）
  resolution: string;        // '4k'（不暴露分辨率选项，模型自动出图最高 4K）
}

/**
 * 撤销/重做快照：携带捕获时刻的 nodes/edges/projectName/dirty（不含 canvas 视口，避免撤销导致视口跳变）。
 * 快照回滚模型：applySnapshot 原样恢复，dirty 精确复位（回到与磁盘一致时自动 false）。
 */
interface FlowSnapshot {
  nodes: FlowNode[];
  edges: FlowEdge[];
  projectName: string;
  dirty: boolean;
}

/**
 * history.jsonl 单行条目（append-only 流水账，跨会话图库展示用）。
 * 用 kind 判别 image/text：text 行用精简字段（无 aspectRatio/resolution 等图片字段）。
 */
type HistoryEntry =
  | {
      kind: 'image';
      nodeId: string;
      imageUrl?: string;        // 新行：该产出图 URL（旧行缺失时回退按 nodeId 解析当前节点 imageUrl）
      prompt: string;
      model: string;
      aspectRatio: string;
      resolution: string;
      count: number;
      refImageHashes: string[];   // 参考图指纹（hashRef 轻量哈希）
      refImageUrls?: string[];    // 新行：本次实际使用的参考图 URL（跨会话复现用）
      seed?: string | null;
      createdAt: number;
      parentId?: string | null;
      outputType: 'txt2img' | 'img2img' | 'outpaint';
    }
  | {
      kind: 'text';
      nodeId: string;
      instruction: string;
      model: string;
      outputText: string;
      createdAt: number;
      parentId?: string | null;
    };

/** 资产索引记录（采纳/锁定单一数据源；键 = 图指纹 hashRef(imageUrl)，冗余 nodeId 供保护回溯） */
interface ImageAssetRecord {
  key: string;            // hashRef(imageUrl) 图指纹主键（唯一定位「一张图」而非「一个节点」）
  nodeId: string;         // 图当前所在节点（冗余；同一 nodeId 被重跑覆盖后旧图指纹不变，仍作用旧图）
  imageUrl?: string;      // 图 URL（incremental-3 起采纳时写入，资产库独立显示用；旧记录缺失 → 占位）
  projectName: string[];  // 采纳过的项目名列表（A5：跨项目溯源；只追加去重，不删除；旧记录缺失 → []）
  adopted: boolean;       // 已采纳（认可；采纳自动置 locked）
  locked: boolean;        // 已锁定（保护：removeChildren 不删 / _writeBackToSelf 不覆盖）
  tags: string[];         // 手动标签（B6 P1；搜索纳入）
  category: string;       // 分类预留（B8 P2；默认 '成图'，本期不渲染分类 UI）
  updatedAt: number;
}

/** 采纳时刻的内存元数据（不持久化，资产库复现 S9 用；缺失时经 historyDrawer.getEntryByImageUrl 反查） */
interface AdoptMeta {
  prompt?: string;
  model?: string;
  aspectRatio?: string;
  resolution?: string;
  count?: number;
  refImageUrls?: string[];
  refImageHashes?: string[];
  outputType?: string;
  createdAt?: number;
}

/** 资产库条目（getAdoptedAssets 输出：记录 + 可渲染 URL + 内存元数据） */
interface AssetAsset {
  record: ImageAssetRecord;
  url: string;
  meta?: AdoptMeta;
}

/** 资产快照（HistoryStack 并行撤销栈用） */
interface AssetSnapshot {
  records: ImageAssetRecord[];
}

/** 对比面板瞬时状态（不持久化；关闭仅清瞬时态，不污染画布主链） */
interface ComparePanelState {
  open: boolean;
  nodeIds: string[];
  grid: 2 | 4 | 8;
}
