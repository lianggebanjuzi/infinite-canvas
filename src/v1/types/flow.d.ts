// src/v1/types/flow.d.ts
// ICV v1 流程画布核心类型（ambient 全局类型，无需 import 即可使用）
// 与架构文档「四、数据结构与接口」保持一致

/** 统一「生成节点」：多图参考（0~N）→ 生成 N 张新图（每张一个可编辑 image-gen 产出节点；文生图第 1 张写回自身），注册式扩展 */
type NodeType = 'image-gen' | 'text-gen' | 'text-split';

/**
 * 节点状态机七态（B-5：由五态扩展，新增 queued / partial-failed）。
 * 持久化只存五态（idle/run/done/stale/fail）：queued→idle、partial-failed→done 由 persistence.collect 归一（共享约定 6）。
 * 七态派生唯一出口 = BatchStore.nodeStatus(nodeId)（无批次时回退节点自身终态）。
 */
type NodeStatus = 'idle' | 'queued' | 'run' | 'done' | 'partial-failed' | 'fail' | 'stale';

/** 端口数据类型（A-3 端口类型契约；五类型，见 docs/重构-增量架构设计 §3.3） */
type PortType = 'Image' | 'ImageList' | 'Text' | 'TextList' | 'GenerationConfig';

/** text-gen 参数：命令（临时，发送后清空）+ 文本模型 */
interface TextGenParams {
  instruction?: string;  // 命令；新建为空、用户自填、发送后清空（仅作命令暂存）
  model: string;         // "provider_id:key_id:model_id"（chat 模型；旧两段值仍由后端兼容）
}

/** 文本拆分节点参数：文档被拆成可独立编辑的提示词槽位。 */
interface TextSplitParams {
  delimiter: string;
  segments: string[];
}

/** 文本拆分驱动生成时，图片节点卡内保留的每一张结果。 */
interface GeneratedImageItem {
  url: string;
  prompt: string;
  origin?: ImageOrigin | null;
  width?: number;
  height?: number;
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
  imageWidth?: number;       // 原图真实像素宽（PIL im.size；旧 trace 缺失 → 展示回退 params）
  imageHeight?: number;      // 原图真实像素高
  batchId?: string;          // B-6 追溯：所属批次（R3 同格式 `${nodeId}_${Date.now()}`；旧 trace 缺失 → 读侧回退单图）
  jobId?: string;            // B-6 追溯：任务编号（`${batchId}_j${index}`；可反查「来自第几条拆分文本」= index+1）
}

/**
 * 单个生成任务状态机（B-1/B-2）：一条提示词的一次完整执行（含重试）。
 */
type JobStatus = 'queued' | 'creating' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** 批次状态机（B-1/B-2） */
type BatchStatus = 'queued' | 'running' | 'completed' | 'partial-failed' | 'failed' | 'cancelled';

/** 单个生成任务：一条提示词的一次完整执行（含重试）。 */
interface GenerationJob {
  id: string;              // uid('job') 风格；追溯用，写回 trace.jobId（实际格式 `${batchId}_j${index}`）
  batchId: string;         // 所属批次
  index: number;           // 0-based；面板显示 #(index+1)，拆分模式对应拆分槽位序号
  prompt: string;          // 该任务实际使用的提示词（拆分槽位原文 / 合成 prompt）
  status: JobStatus;       // 独立状态机
  remoteTaskId?: string;   // 远端任务 id（轮询用；creating 成功后写）
  image?: {                // 成功图（仅 succeeded 时有；含缩略/原图引用/真实像素）
    url: string;
    originalPath?: string;
    originalUrl?: string;
    width?: number;
    height?: number;
  } | null;
  error?: string | null;   // 独立错误（B-3：禁止共享 lastError）
  attempts: number;        // 已尝试次数（重试 +1；首次 = 1）
  createdAt: number;       // Job 创建时间（= 批次创建时刻）
  startedAt?: number;      // 进入 running 时刻
  finishedAt?: number;     // 进入终态时刻
}

/** 一次批量生成：先同步创建（total=N + N 个 queued Job）再入队执行。 */
interface GenerationBatch {
  id: string;              // 沿用 R3 格式：`${nodeId}_${Date.now()}`（与 history.jsonl 旧行兼容）
  nodeId: string;          // 所属图片生成节点
  source: 'manual-count' | 'text-split';  // 驱动来源
  total: number;           // 恒等于 jobs.length（B-1 验收：任意时刻 jobs.length === total）
  concurrency: number;     // 创建时快照并发上限（展示用）
  status: BatchStatus;
  jobs: GenerationJob[];
  createdAt: number;
  finishedAt?: number;
  // ── B-7 刷新恢复标记（仅 rebuildFromNodes 产生；正常批次缺省） ──
  restored?: boolean;      // true = 刷新后从节点结果重建
  unknownCount?: number;   // 刷新前进行中/未知任务数（UI 显示「另有 N 个任务状态未知」）
}



/** 原图引用（图片性能优化：卡片主视觉=缩略图，查看大图按需经 load_local_image 取原图） */
interface ImageOrigin {
  path: string;   // 原图本地绝对路径（正斜杠 C:/...）
  url?: string;   // file:// 引用（备用；禁止直接用于渲染）
}

/** 画布节点：宽缺省 260（w 可覆盖），高 = w / ratio（h 可覆盖，text-gen 缩放专用） */
interface FlowNode {
  id: string;
  type: NodeType;
  x: number;                 // 画布世界坐标
  y: number;
  ratio: number;             // 高/宽 比例；卡片高 = CARD_W / ratio
  w?: number;                // 可选：卡片宽（text-gen 缩放；缺省 undefined = CARD_W；旧项目加载自动回退，不写死）
  h?: number;                // 可选：卡片高（text-gen 缩放；缺省 undefined = 按 ratio 计算）
  status: NodeStatus;
  title: string;             // 左上悬浮标签
  params: Record<string, unknown>;  // 节点参数（见 StyleTransferParams / TextGenParams）
  imageUrl: string | null;   // 本节点输出图（卡片主视觉=缩略图，与 refImages 严格分离）
  imageOrigin?: ImageOrigin | null; // 原图引用（查看大图按需加载用；旧节点缺省 null）
  imageWidth?: number;       // 原图真实像素宽（生成/回写时透传；旧节点/旧数据缺失 → 展示回退 params）
  imageHeight?: number;      // 原图真实像素高
  outputText: string | null; // 新增：text-gen 输出文本；其余类型恒 null
  generatedImages?: GeneratedImageItem[]; // 仅 text-split 上游驱动的 image-gen 使用，按拆分槽位顺序保存
  activeGeneratedIndex?: number; // 卡内当前浏览的批量结果下标
  textHistory: TextGenHistoryItem[]; // 新增：节点级文本历史；非 text-gen 恒 []
  refImages: string[];       // 用户主动挂载的参考图（默认 []；上游可作参考图的图由 getReferenceImages 派生）
  error: string | null;      // fail 原因（红点 hover/点击展示）
  lastRunAt: number | null;
  parentId: string | null;   // 引擎产出节点标记：本节点由哪个生成节点产出（重跑顶掉旧产出用）；手建节点恒 null
  trace: GenerationTrace | null; // 生成档案：该节点主视觉图的配方；text-gen / 手建未跑节点为 null
  isAsset?: boolean;         // 素材态标记（仅 image-gen 节点为素材时 true；text-gen / 自建 image-gen 缺省 undefined，序列化不输出 key）
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
  /** 项目内最近一次由用户选择的模型；新建同类节点时优先沿用。 */
  modelDefaults?: Partial<Record<'drawing' | 'chat', string>>;
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
  defaultRatio: number;       // 4/3（新节点默认横版；旧节点 ratio 已持久化不动）
  defaultParams: Record<string, unknown>;
  creatable?: boolean;        // false=不进新建菜单（引擎产出节点由引擎自动创建，缺省 true）
  canRun(node: FlowNode, ctx: FlowContext): boolean | string; // true / 禁止原因
  buildOptions(node: FlowNode, ctx: FlowContext): Record<string, unknown>; // backend options
}

/** 生成节点参数（统一节点复用） */
interface StyleTransferParams {
  prompt: string;             // 生成指令；文本模型反推模式下复用为「命令」
  model: string;              // "provider_id:key_id:model_id"（绘图模型；旧两段值仅在唯一匹配时兼容）
  aspectRatio: string;        // '3:4' | '1:1' | '16:9' | 'Auto'
  resolution: string;         // '1k' | '2k' | '4k'
  count: number;              // 1-4
  modelType?: 'draw' | 'text'; // 保留字段、运行时忽略（Q7 旧数据容错）：不再用于引擎分派 / UI 展示 / canRun 判定，旧 modelType='text' 节点一律按 draw 处理
  textModel?: string;          // 保留字段、无 UI 入口（旧数据残留无害）：不再被引擎/面板使用
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
  model: string;             // 自动解析的 gemini/nano-banana/seedream 系绘图模型（"provider:key:model"）
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
  modelDefaults: Record<'drawing' | 'chat', string>;
  dirty: boolean;
}

/** 可复用工作流：只保存节点编排和默认配置，绝不保存项目成图、历史、任务和本地文件引用。 */
interface WorkflowTemplate {
  id: string;
  title: string;
  description?: string;
  version: 1;
  canvas: FlowCanvasState;
  modelDefaults?: Partial<Record<'drawing' | 'chat', string>>;
  nodes: FlowNode[];
  edges: FlowEdge[];
  createdAt: number;
  updatedAt: number;
}

/**
 * history.jsonl 单行条目（append-only 流水账，跨会话图库展示用）。
 * 用 kind 判别 image/text：text 行用精简字段（无 aspectRatio/resolution 等图片字段）。
 */
type HistoryEntry =
  | {
      kind: 'image';
      nodeId: string;
      imageUrl?: string;        // 展示图 URL（新行=缩略图；旧行缺失时回退按 nodeId 解析当前节点 imageUrl）
      thumbnail?: string;       // 显式缩略图（新行；读侧 thumbnail 优先、imageUrl 回退）
      originalPath?: string;    // 原图本地绝对路径（查看大图按需加载用）
      originalUrl?: string;     // file:// 引用（备用）
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
      batchId?: string;        // R3：一次生成的批次号（count=N 共用一个；text 分支不加）；旧行缺失 → 读侧按单图回退展示
      jobId?: string;          // B-6 追溯：与 batchId 并列，写 history.jsonl 行（旧行缺失 → 读侧回退，不报错）
      imageWidth?: number;     // 原图真实像素宽（PIL im.size；旧行缺失 → 展示回退 params）
      imageHeight?: number;    // 原图真实像素高
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

/** 资产库记录（键 = 图指纹 hashRef(展示图 URL)）。 */
interface ImageAssetRecord {
  key: string;            // hashRef(展示图 URL) 图指纹主键（唯一定位「一张图」而非「一个节点」）
  nodeId: string;         // 图当前所在节点（仅溯源用）
  imageUrl?: string;      // 展示图 URL（添加时写入，资产库独立显示用；旧记录缺失 → 占位）
  thumbnail?: string;     // 显式缩略图（=展示图 URL；新记录冗余写入，读侧 thumbnail||imageUrl 回退）
  originalPath?: string;  // 原图本地绝对路径（查看大图按需加载用；冗余写入，P1 可升级指纹键）
  projectName: string[];  // 添加过的项目名列表（跨项目溯源；只追加去重，不删除；旧记录缺失 → []）
  added: boolean;         // 当前在资产库中
  adopted?: boolean;      // 旧版兼容字段：false 表示已移除，加载时不再展示
  locked?: boolean;       // 旧版兼容字段：加载时忽略
  tags: string[];         // 手动标签（B6 P1；搜索纳入）
  category: string;       // 分类预留（B8 P2；默认 '成图'，本期不渲染分类 UI）
  updatedAt: number;
  // ── 资产配方持久化（全部可选；缺失 = undefined，不写 null；随添加落盘 assets.json） ──
  prompt?: string;              // 生成提示词
  model?: string;               // "provider:key:model"
  aspectRatio?: string;         // '3:4' | '1:1' | '16:9' | 'Auto'
  resolution?: string;          // '1k' | '2k' | '4k'
  count?: number;               // 本批张数 1-4
  refImageUrls?: string[];      // 本次实际参考图 URL（复现直接可用）
  refImageHashes?: string[];    // 参考图指纹（hashRef）
  outputType?: string;          // 'txt2img' | 'img2img' | 'outpaint'
  createdAt?: number;           // 生成完成时间戳（trace.createdAt）
}

/**
 * 添加元数据（资产库复现/配方展示用）。
 * 添加时会把配方字段合并写入 ImageAssetRecord 本体并随 assets.json 落盘
 * （持久化真相 = 记录本体）；metaByKey 仅作会话级快速缓存，重启后由记录配方合成恢复。
 * 缺失时经 historyDrawer.getEntryByImageUrl 反查兜底。
 */
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

/** 资产库条目（getAssets 输出：记录 + 可渲染 URL + 内存元数据） */
interface AssetAsset {
  record: ImageAssetRecord;
  url: string;                 // 展示图 URL（兼容字段：thumbnailUrl || imageUrl 兜底）
  thumbnailUrl?: string;       // 缩略图 URL（图片性能优化：资产库卡片主视觉）
  originalPath?: string;       // 原图本地绝对路径（查看大图按需加载用）
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
