/**
 * AppState 完整类型定义
 * 所有状态切片的接口
 */

// ─── 供应商 & 模型类型（定义在这里供全局使用）──
interface ProviderData {
  id: string;
  name: string;
  type: string;
  short_name: string;
  enabled: boolean;
  api_key?: string;
  api_url?: string;
  use_proxy?: boolean;
  models?: ModelData[];
}

interface ModelData {
  id: string;
  name: string;
  category?: string;
  type?: string;
  enabled?: boolean;
}

// ─── 画布状态 ───
export interface CanvasState {
  scale: number;
  panX: number;
  panY: number;
  isPanning: boolean;
  startPanX: number;
  startPanY: number;
  contextClickPos: { x: number; y: number };
}

// ─── 卡片状态 ───
export interface CardState {
  activeCardId: string | null;
  targetUploadCardId: string | null;
  multiSelected: HTMLElement[];
}

// ─── 供应商状态 ───
export interface ProvidersState {
  list: ProviderData[];
  currentId: string | null;
  fetchedModels: ModelData[] | null;
}

// ─── 连线状态 ───
export interface ConnectionData {
  id: string;
  start: string;
  end: string;
  endPort?: string | null;
  element?: SVGPathElement;
  isGroupPin?: boolean;
  groupId?: string;
  pinDirection?: string;
  pinId?: string;
}

export interface PendingConnection {
  cardId: string;
  portRole: string;
  x: number;
  y: number;
  startPortInfo?: { x: number; y: number; cardId: string; portRole: string };
}

export interface ConnectionState {
  list: ConnectionData[];
  isConnecting: boolean;
  tempLine: SVGPathElement | null;
  startPort: { cardId: string; portRole: string; x: number; y: number } | null;
  pendingConnection: PendingConnection | null;
}

// ─── 分组状态 ───
export interface GroupData {
  id: string;
  name: string;
  cardIds: string[];
  bounds: { x: number; y: number; width: number; height: number };
  colorIndex?: number;
  pinnedInputs?: unknown[];
  pinnedOutputs?: unknown[];
  [key: string]: unknown;
}

export interface GroupState {
  list: GroupData[];
  activeGroupId: string | null;
  isSelecting: boolean;
  tempBounds: { x: number; y: number; width: number; height: number } | null;
}

// ─── UI 交互状态 ───
export interface SelectionState {
  isBoxSelecting: boolean;
  selectionBox: HTMLElement | null;
  startX: number;
  startY: number;
}

export interface LaserState {
  isCutting: boolean;
  laserLine: SVGPathElement | null;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  justFinished: boolean;
}

export interface HistoryState {
  undoStack: unknown[];
  redoStack: unknown[];
  maxSteps: number;
}

export interface AIState {
  generatingCards: Map<string, unknown>;
}

export interface UIState {
  selection: SelectionState;
  laser: LaserState;
  history: HistoryState;
  ai: AIState;
}

// ─── 聚合 AppState ───
export interface AppStateType {
  canvas: CanvasState;
  cards: CardState;
  providers: ProvidersState;
  connections: ConnectionState;
  groups: GroupState;
  selection: SelectionState;
  laser: LaserState;
  history: HistoryState;
  ai: AIState;
  performance: Record<string, unknown>;
}

declare global {
  interface Window {
    AppState: AppStateType;
  }
}
