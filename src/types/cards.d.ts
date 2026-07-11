/**
 * 卡片系统类型定义
 */

// ─── 端口/契约 ───
export interface CardPortDeclaration {
  name: string;
  type: 'text' | 'image';
  receivePolicy?: 'replace' | 'append' | 'accumulate' | 'ignore';
  multiple?: boolean;
  notifyOn?: string;
}

export interface CardContract {
  outputs: CardPortDeclaration[];
  inputs: CardPortDeclaration[];
}

// ─── 卡片序列化 ───
export interface CardSerializedData {
  id: string;
  type: string;
  title: string;
  left: string;
  top: string;
  width: string;
  height: string;
  bg: string;
  content: string;
  groupId: string | null;
  bypass: boolean;
  maskData?: unknown;
}

// ─── 事件总线 ───
export type CardEventType = 'data:changed' | 'run:started' | 'run:completed' | 'connected' | 'disconnected';

export interface CardEventPayload {
  cardId: string;
  type: 'text' | 'image';
  data: unknown;
  source?: string;
}

export type CardEventFilter = (payload: CardEventPayload) => boolean;

export type CardEventCallback = (payload: CardEventPayload) => void;

// ─── 上游数据 ───
export interface UpstreamDataItem {
  data: unknown;
  sourceCardId: string;
  connectionId: string;
  endPort?: string;
}

// ─── 卡片拖拽 ───
export interface CardDragState {
  active: boolean;
  offsetX: number;
  offsetY: number;
}

// ─── 卡片构造函数选项 ───
export interface CardOptions {
  id?: string;
  x?: number;
  y?: number;
  width?: string;
  height?: string;
  minWidth?: number;
  minHeight?: number;
  title?: string;
  content?: string;
  bg?: string;
  groupId?: string | null;
  bypass?: boolean;
  canvasWidth?: number;
  canvasHeight?: number;
  canvasConfig?: Record<string, unknown>;
  agentConfig?: Record<string, unknown>;
  imageA?: string;
  imageB?: string;
  sliderPos?: number;
  thumbnail?: string;
  imageMeta?: Record<string, unknown>;
  aiConfig?: Record<string, unknown>;
  maskStore?: Record<string, unknown>;
}

// ─── 基础卡片类 ───
export abstract class BaseCard {
  id: string;
  x: number;
  y: number;
  width: string;
  height: string;
  minWidth: number;
  minHeight: number;
  title: string;
  bg: string;
  element: HTMLElement | null = null;
  groupId: string | null = null;
  bypass: boolean = false;
  protected _drag: CardDragState;
  protected _portLeft?: HTMLElement;
  protected _portRight?: HTMLElement;

  constructor(options?: CardOptions);
  abstract getType(): string;
  abstract renderContent(): string | HTMLElement;
  createElement(): HTMLElement;
  destroy(): void;
  serialize(): CardSerializedData;

  static getContract(): CardContract;
  static getDataType(): 'text' | 'image' | null;

  getOutput(outputName?: string): unknown;
  getAllOutputs(): Record<string, unknown>;
  onReceive(type: 'text' | 'image', data: unknown, source?: string): void;
  onPush(type: 'text' | 'image', data: unknown): void;
  getPushData(type: 'text' | 'image'): unknown;
  notifyDownstream(source?: string): void;
  onUpstreamChanged(upstreamCard: BaseCard, endPort?: string): void;
  hasLocalUndo(): boolean;
  undo(): boolean;
  redo(): boolean;

  protected _createPort(extraClass: string, portRole: string): HTMLElement;
  protected _bindDrag(el: HTMLElement, handle: HTMLElement): void;
  protected _bindSelect(el: HTMLElement): void;
  protected _bindPortDrag(port: HTMLElement, portRole: string): void;
  protected _bindResize(el: HTMLElement, handle: HTMLElement): void;
  protected _updatePortsVisibility(): void;
}

// ─── 卡片类型映射 ───
export type CardClass = typeof BaseCard;

export const CARD_TYPE_LABELS: Record<string, string> = {
  'text': 'Text',
  'image': 'Image',
  'ai-image': 'AI Draw',
  'drawing-board': '画板',
  'preview': 'Preview',
  'compare': 'Compare',
  'agent': 'Agent'
};
