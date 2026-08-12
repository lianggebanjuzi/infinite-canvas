// src/v1/types/flow.d.ts
// ICV v1 流程画布核心类型（ambient 全局类型，无需 import 即可使用）
// 与架构文档「四、数据结构与接口」保持一致

/** 首版节点类型：产品图输入 / 换风格 / 图片生成（多图参考生成一张），注册式扩展 */
type NodeType = 'product-image' | 'style-transfer' | 'image-gen';

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
  imageUrl: string | null;   // 结果图（输入节点=所选图；生成节点=生成结果）
  error: string | null;      // fail 原因（红点 hover/点击展示）
  lastRunAt: number | null;
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

/** .icproj v3 项目格式 */
interface FlowProject {
  format: 'icv';
  version: '3.0';
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
  getImageModels(): Promise<Array<{ id: string; name: string }>>;
}

/** 注册式节点定义（新增节点 = 注册一个 NodeDefinition） */
interface NodeDefinition {
  type: NodeType;
  label: string;              // 悬浮标签
  defaultTitle: string;
  defaultRatio: number;       // 3/4
  defaultParams: Record<string, unknown>;
  canRun(node: FlowNode, ctx: FlowContext): boolean | string; // true / 禁止原因
  buildOptions(node: FlowNode, ctx: FlowContext): Record<string, unknown>; // backend options
}

/** 换风格节点参数 */
interface StyleTransferParams {
  prompt: string;             // 换风格指令
  model: string;              // "provider_id:model_id"
  aspectRatio: string;        // '3:4' | '1:1' | '16:9' | 'Auto'
  resolution: string;         // '1k' | '2k' | '4k'
  count: number;              // 1-4
}

/** 输入产品图节点参数（空或仅存文件信息） */
interface ProductImageParams {
  fileName?: string;
}

/** 前端统一错误（映射自 backend {success:false,error_code,message}） */
interface FlowError {
  code: number;
  message: string;
}
