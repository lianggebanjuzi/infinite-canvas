// src/v1/state/flow-state.ts
// 画布数据单一数据源（AppState.flow）：nodes/edges/选中集/画布视口 + 订阅通知

import { uid } from '../../utils/uid';
import { nodeRegistry } from '../nodes/node-registry';

/** 卡片固定宽度（与 canvas-view.CARD_W 同值；数据层不依赖视图层） */
const CARD_W = 260;

export class FlowState {
  nodes: FlowNode[] = [];
  edges: FlowEdge[] = [];
  selectedIds = new Set<string>();
  canvas: FlowCanvasState = { scale: 1, panX: 60, panY: 40 };
  projectName = '未命名项目';
  dirty = false;
  createdAt = Date.now();
  updatedAt = Date.now();

  private _listeners = new Set<() => void>();

  /** 订阅状态变更，返回取消订阅函数 */
  subscribe(fn: () => void): () => void {
    this._listeners.add(fn);
    return () => { this._listeners.delete(fn); };
  }

  /** 通知所有订阅者（渲染层/悬浮 UI） */
  notify(): void {
    this._listeners.forEach(fn => {
      try { fn(); } catch { /* 单个订阅者异常不影响整体渲染 */ }
    });
  }

  // ───────────────────────── 节点 ─────────────────────────
  getNode(id: string): FlowNode | undefined {
    return this.nodes.find(n => n.id === id);
  }

  /** 直接上游（仅一层） */
  getUpstreams(id: string): FlowNode[] {
    return this.getEdgesTo(id)
      .map(e => this.getNode(e.from))
      .filter((n): n is FlowNode => !!n);
  }

  /** 直接下游（仅一层） */
  getDownstreams(id: string): FlowNode[] {
    return this.getEdgesFrom(id)
      .map(e => this.getNode(e.to))
      .filter((n): n is FlowNode => !!n);
  }

  /** 全部间接+直接下游（BFS，用于脏标记传播） */
  getAllDownstreams(id: string): FlowNode[] {
    const result: FlowNode[] = [];
    const seen = new Set<string>();
    const queue = this.getDownstreams(id);
    while (queue.length > 0) {
      const node = queue.shift()!;
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      result.push(node);
      this.getDownstreams(node.id).forEach(d => { if (!seen.has(d.id)) queue.push(d); });
    }
    return result;
  }

  /** 合并更新节点字段（params 需用 updateNodeParams） */
  updateNode(id: string, patch: Partial<FlowNode>): void {
    const node = this.getNode(id);
    if (!node) return;
    Object.assign(node, patch);
    this.updatedAt = Date.now();
    this.dirty = true;
    this.notify();
  }

  /** 合并更新节点参数（不改节点自身状态，由调用方决定是否标下游 stale） */
  updateNodeParams(id: string, paramsPatch: Record<string, unknown>): void {
    const node = this.getNode(id);
    if (!node) return;
    Object.assign(node.params, paramsPatch);
    this.updatedAt = Date.now();
    this.dirty = true;
    this.notify();
  }

  /** 替换节点图片（换图/生成回写），并更新比例 */
  setNodeImage(id: string, imageUrl: string | null, ratio?: number): void {
    const node = this.getNode(id);
    if (!node) return;
    if (imageUrl !== null && imageUrl !== undefined) node.imageUrl = imageUrl;
    if (ratio && ratio > 0) node.ratio = ratio;
    this.updatedAt = Date.now();
    this.dirty = true;
    this.notify();
  }

/** 新建节点（注册式定义） */
  addNode(type: NodeType, x: number, y: number, extra: Partial<FlowNode> = {}): FlowNode {
    const def = nodeRegistry.get(type);
    const node: FlowNode = {
      id: uid('node'),
      type,
      x,
      y,
      ratio: def.defaultRatio,
      status: 'idle',
      title: def.defaultTitle,
      params: { ...def.defaultParams },
      imageUrl: null,
      error: null,
      lastRunAt: null,
      ...extra,
    };
    this.nodes.push(node);
    this.updatedAt = Date.now();
    this.dirty = true;
    this.notify();
    return node;
  }

  /** 删除节点并清理相关连线与选中态 */
  removeNode(id: string): void {
    if (!this.getNode(id)) return;
    this.nodes = this.nodes.filter(n => n.id !== id);
    this.edges = this.edges.filter(e => e.from !== id && e.to !== id);
    this.selectedIds.delete(id);
    this.updatedAt = Date.now();
    this.dirty = true;
    this.notify();
  }

  // ───────────────────────── 连线 ─────────────────────────
  getEdgesFrom(id: string): FlowEdge[] { return this.edges.filter(e => e.from === id); }
  getEdgesTo(id: string): FlowEdge[] { return this.edges.filter(e => e.to === id); }

  addEdge(from: string, to: string): FlowEdge | null {
    if (from === to) return null;
    if (this.edges.some(e => e.from === from && e.to === to)) return null;
    const edge: FlowEdge = { id: uid('edge'), from, to };
    this.edges.push(edge);
    this.updatedAt = Date.now();
    this.dirty = true;
    this.notify();
    return edge;
  }

  /** 校验连线是否可建：返回 null=可建，否则为拒绝原因（手动连线 P0） */
  canConnect(from: string, to: string): string | null {
    if (!this.getNode(from) || !this.getNode(to)) return '节点不存在';
    if (from === to) return '不能连接自己';
    if (this.edges.some(e => e.from === from && e.to === to)) return '已有相同连线';
    const toNode = this.getNode(to);
    if (toNode && toNode.type === 'product-image') return '产品图是起点，不能作为下游';
    return null;
  }

  /** 校验后连线：返回 ok/error（供 UI 直接 toast 提示） */
  connect(from: string, to: string): { ok: boolean; error?: string } {
    const reason = this.canConnect(from, to);
    if (reason) return { ok: false, error: reason };
    const edge = this.addEdge(from, to);
    return edge ? { ok: true } : { ok: false, error: '连线创建失败' };
  }

  /**
   * 在连线中间插入新 style-transfer 节点（中点 + 号升级，手动连线 P0）：
   * 原 from → 新节点 → 原 to；新节点 status=idle、参数用注册表默认值。
   * 若原上游是产品图，新节点参考图由 buildOptions 自动取上游图，无需额外赋值。
   */
  insertStep(edgeId: string): FlowNode | null {
    const edge = this.edges.find(e => e.id === edgeId);
    if (!edge) return null;
    const from = this.getNode(edge.from);
    const to = this.getNode(edge.to);
    if (!from || !to) return null;
    if (to.type === 'product-image') return null; // 产品图不能作为下游（异常连线防御）

    const fromX = from.x + CARD_W;
    const fromY = from.y + (CARD_W / from.ratio) / 2;
    const toX = to.x;
    const toY = to.y + (CARD_W / to.ratio) / 2;
    const midX = (fromX + toX) / 2;
    const midY = (fromY + toY) / 2;

    const def = nodeRegistry.get('style-transfer');
    const newHeight = CARD_W / def.defaultRatio;

    // 断开原连线并重连
    this.edges = this.edges.filter(e => e.id !== edgeId);
    const node = this.addNode('style-transfer', midX - CARD_W / 2, midY - newHeight / 2);
    this.edges.push({ id: uid('edge'), from: edge.from, to: node.id });
    this.edges.push({ id: uid('edge'), from: node.id, to: edge.to });
    this.updatedAt = Date.now();
    this.dirty = true;
    this.notify();
    return node;
  }

  removeEdge(id: string): void {
    this.edges = this.edges.filter(e => e.id !== id);
    this.updatedAt = Date.now();
    this.dirty = true;
    this.notify();
  }

  /** 把 from 的连线出口改接到新节点（A4：拖入新建输入后重连） */
  redirectEdge(from: string, oldTo: string, newTo: string): void {
    const edge = this.edges.find(e => e.from === from && e.to === oldTo);
    if (edge) {
      edge.to = newTo;
      this.updatedAt = Date.now();
      this.dirty = true;
      this.notify();
    }
  }

  // ───────────────────────── 项目 ─────────────────────────
  /** 用新项目整体替换（restore/新建模板） */
  replaceAll(project: FlowProject): void {
    this.nodes = project.nodes.map(n => ({
      ...n,
      params: { ...(n.params || {}) },
      imageUrl: n.imageUrl ?? null,
      error: n.error ?? null,
      lastRunAt: n.lastRunAt ?? null,
    }));
    this.edges = project.edges.map(e => ({ ...e }));
    const defaultCanvas: FlowCanvasState = { scale: 1, panX: 60, panY: 40 };
    this.canvas = { ...defaultCanvas, ...(project.canvas || {}) };
    this.projectName = project.projectName || '未命名项目';
    this.createdAt = project.createdAt || Date.now();
    this.updatedAt = project.updatedAt || Date.now();
    this.selectedIds.clear();
    this.dirty = false;
    this.notify();
  }

  clear(): void {
    this.nodes = [];
    this.edges = [];
    this.selectedIds.clear();
    this.projectName = '未命名项目';
    this.canvas = { scale: 1, panX: 60, panY: 40 };
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
    this.dirty = false;
    this.notify();
  }
}

export const flowState = new FlowState();
