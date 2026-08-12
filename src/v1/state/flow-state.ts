// src/v1/state/flow-state.ts
// 画布数据单一数据源（AppState.flow）：nodes/edges/选中集/画布视口 + 订阅通知

import { uid } from '../../utils/uid';
import { nodeRegistry } from '../nodes/node-registry';

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
