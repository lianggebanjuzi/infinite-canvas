// src/v1/types/flow.d.ts
// ICV v1 流程画布核心类型（ambient 全局类型，无需 import 即可使用）
// 与架构文档「四、数据结构与接口」保持一致

/** 统一「生成节点」：多图参考（0~N）→ 生成 N 张新图（每张一张结果卡），注册式扩展 */
type NodeType = 'image-gen' | 'image-result';

/** 旧版节点类型字面量：仅在 persistence 迁移时使用，业务代码禁止引用 */
type LegacyNodeType = 'product-image' | 'style-transfer' | 'image-gen';

/** 节点状态机五态 */
type NodeStatus = 'idle' | 'run' | 'done' | 'stale' | 'fail';

/** 画布节点：宽固定 260，高 = 260 / ratio */
interface FlowNode {
  id: string;
  type: NodeType;
  x: number;                 // 画布世界坐标
  y: number;
  ratio: number;             // 高/宽 比例；卡片高 = CARD_W / ratio
  status: NodeStatus;
  title: string;             // 左上悬浮标签
  params: Record<string, unknown>;  // 节点参数（见 StyleTransferParams）
  imageUrl: string | null;   // 本节点输出图（卡片主视觉），与 refImages 严格分离
  refImages: string[];       // 用户主动挂载的参考图（默认 []；上游可作参考图的图由 getReferenceImages 派生）
  error: string | null;      // fail 原因（红点 hover/点击展示）
  lastRunAt: number | null;
  parentId: string | null;   // 结果卡专属：所属生成节点 id；其余节点恒 null（用于重跑顶掉旧结果卡）
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

/** .icproj 项目格式（3.2：新增 image-result 结果卡，节点带 parentId） */
interface FlowProject {
  format: 'icv';
  version: '3.2';
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
  creatable?: boolean;        // false=不进新建菜单（结果卡由引擎自动创建，缺省 true）
  canRun(node: FlowNode, ctx: FlowContext): boolean | string; // true / 禁止原因
  buildOptions(node: FlowNode, ctx: FlowContext): Record<string, unknown>; // backend options
}

/** 生成节点参数（统一节点复用） */
interface StyleTransferParams {
  prompt: string;             // 生成指令
  model: string;              // "provider_id:model_id"
  aspectRatio: string;        // '3:4' | '1:1' | '16:9' | 'Auto'
  resolution: string;         // '1k' | '2k' | '4k'
  count: number;              // 1-4
}

/** 前端统一错误（映射自 backend {success:false,error_code,message}） */
interface FlowError {
  code: number;
  message: string;
}
