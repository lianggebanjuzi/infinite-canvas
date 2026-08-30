// src/v1/canvas/link-view.ts
// 连线渲染：贝塞尔曲线（参照旧 _wirePointOnCard 算法）、流光动画、
// hover 中点 + 号（插入步骤）/ × 删除按钮、端口拖拽橡皮筋临时线

import { flowState } from '../state/flow-state';
import { selection } from '../state/selection';
import { dirty } from '../state/dirty';
import { flowHistory } from '../state/history';
import { CARD_W } from './canvas-view';
import { cardView } from './card-view';
import { showToast } from '../ui/toast';
import { applyLinkFlowing } from '../ui/status-visuals';
import { fetchImageModels } from '../api';
import { outputTypesOf, PORT_TYPES } from '../nodes/port-types';

const NS = 'http://www.w3.org/2000/svg';

/**
 * 连线的画布表达语义。它只由既有节点类型和 parentId 推断，绝不参与
 * 生成请求或改变 FlowEdge 的持久化格式。
 */
export type LinkRelation = 'reference' | 'text-input' | 'result' | 'generic' | 'audio-ref';

export function linkRelation(edge: FlowEdge): LinkRelation {
  const from = flowState.getNode(edge.from);
  const to = flowState.getNode(edge.to);
  if (!from || !to) return 'generic';
  // 4.2-C：音频节点 → 视频节点 = 音轨/配音参考（显式关系类型）
  if (edge.kind === 'audio-ref') return 'audio-ref';
  // 引擎写出的产出节点会保留 parentId；它比「图片 → 图片」这一宽泛类型
  // 判断更精确，因而必须优先识别为结果来源而不是参考输入。
  if (to.parentId === from.id) return 'result';
  if ((from.type === 'text-gen' || from.type === 'text-split') && to.type === 'image-gen') return 'text-input';
  if (from.type === 'image-gen' && to.type === 'image-gen') return 'reference';
  return 'generic';
}

function relationLabel(relation: LinkRelation): string {
  switch (relation) {
    case 'reference': return '参考';
    case 'text-input': return '文字';
    case 'result': return '结果';
    case 'audio-ref': return '音轨';
    default: return '';
  }
}

/**
 * C-5 连线传输语义描述（连线完成后 toast / 选中连线信息展示）：
 * 按「起点类型 → 终点类型」给出人话说明；未知组合回退端口类型明细。
 */
export function connectionDescription(fromId: string, toId: string): string {
  const from = flowState.getNode(fromId);
  const to = flowState.getNode(toId);
  if (!from || !to) return '已创建连线';
  const edge = flowState.edges.find(item => item.from === fromId && item.to === toId);
  if (edge && linkRelation(edge) === 'result') return '这是本次操作产生的结果';
  const outs = outputTypesOf(from);
  const ins = PORT_TYPES[to.type]?.inputs ?? [];
  if (from.type === 'text-split' && to.type === 'image-gen') {
    const n = flowState.getTextSplitSegments(from.id).length;
    return n > 0 ? `将按 ${n} 条提示词批量生成` : '批量生成（暂无提示词）';
  }
  if (from.type === 'text-gen' && to.type === 'image-gen') return '上游文本将作为提示词';
  if (from.type === 'text-gen' && to.type === 'text-split') return '按分隔符自动拆分';
  if (to.type === 'text-gen' && from.type === 'image-gen') return '可反推提示词';
  if (from.type === 'image-gen' && to.type === 'image-gen') return '作为参考图';
  if (from.type === 'audio-gen' && to.type === 'video-gen') return '音频将作为音轨/配音参考';
  return `${outs.join('/')} → ${ins.join('/')}`;
}

class LinkView {
  private svg: SVGSVGElement | null = null;
  private canvasEl: HTMLElement | null = null;
  private paths = new Map<string, SVGPathElement>();
  private labels = new Map<string, HTMLElement>();
  private pluses = new Map<string, HTMLElement>();
  private dels = new Map<string, HTMLElement>();
  private flowing = new Set<string>();
  private tempPath: SVGPathElement | null = null;
  /** C-5 选中连线 id（选中态 + 中点传输信息浮标） */
  private selectedEdgeId: string | null = null;
  private linkInfoEl: HTMLElement | null = null;

  init(canvasEl: HTMLElement): void {
    this.canvasEl = canvasEl;
    this.svg = canvasEl.querySelector('#link-layer') as SVGSVGElement | null;
    this._ensureDefs();
    // 点画布空白（非连线）取消连线选中
    canvasEl.addEventListener('mousedown', (e: MouseEvent) => {
      if (!(e.target as Element).closest('.link-path')) this.selectEdge(null);
    });
  }

  /** C-5：选中/取消选中一条连线（选中显示传输类型与来源摘要） */
  selectEdge(edgeId: string | null): void {
    this.selectedEdgeId = edgeId;
    this.paths.forEach((p, id) => p.classList.toggle('selected', id === edgeId));
    this._renderLinkInfo();
  }

  private _renderLinkInfo(): void {
    if (!this.canvasEl) return;
    if (!this.linkInfoEl) {
      this.linkInfoEl = document.createElement('div');
      this.linkInfoEl.className = 'link-info';
      this.canvasEl.appendChild(this.linkInfoEl);
    }
    const edge = this.selectedEdgeId ? flowState.edges.find(e => e.id === this.selectedEdgeId) : null;
    if (!edge) { this.linkInfoEl.classList.remove('show'); return; }
    const a = flowState.getNode(edge.from);
    const b = flowState.getNode(edge.to);
    if (!a || !b) { this.linkInfoEl.classList.remove('show'); return; }
    const x1 = a.x + (a.w ?? CARD_W);
    const y1 = a.y + (a.h ?? cardView.cardHeight(a)) / 2;
    const x2 = b.x;
    const y2 = b.y + (b.h ?? cardView.cardHeight(b)) / 2;
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;
    this.linkInfoEl.style.left = midX + 'px';
    this.linkInfoEl.style.top = midY + 'px';
    const label = `${a.title || a.type} → ${b.title || b.type}`;
    this.linkInfoEl.innerHTML = `<b>${escapeHtml(label)}</b><span>${escapeHtml(connectionDescription(edge.from, edge.to))}</span>`;
    this.linkInfoEl.classList.add('show');
  }

  private _ensureDefs(): void {
    if (!this.svg || this.svg.querySelector('#flowGrad')) return;
    const defs = document.createElementNS(NS, 'defs');
    defs.innerHTML = `
      <linearGradient id="flowGrad" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#7C9A72" stop-opacity=".3"/>
        <stop offset="50%" stop-color="#7C9A72"/>
        <stop offset="100%" stop-color="#7C9A72" stop-opacity=".3"/>
      </linearGradient>`;
    this.svg.appendChild(defs);
  }

  renderAll(): void {
    if (!this.svg) return;
    const edgeIds = new Set(flowState.edges.map(e => e.id));

    this.paths.forEach((p, id) => { if (!edgeIds.has(id)) { p.remove(); this.paths.delete(id); } });
    this.labels.forEach((label, id) => { if (!edgeIds.has(id)) { label.remove(); this.labels.delete(id); } });
    this.pluses.forEach((p, id) => { if (!edgeIds.has(id)) { p.remove(); this.pluses.delete(id); } });
    this.dels.forEach((p, id) => { if (!edgeIds.has(id)) { p.remove(); this.dels.delete(id); } });

    flowState.edges.forEach(edge => this.renderEdge(edge));
  }

  private renderEdge(edge: FlowEdge): void {
    const a = flowState.getNode(edge.from);
    const b = flowState.getNode(edge.to);
    if (!a || !b || !this.svg) return;

    const x1 = a.x + (a.w ?? CARD_W);
    const y1 = a.y + (a.h ?? cardView.cardHeight(a)) / 2;
    const x2 = b.x;
    const y2 = b.y + (b.h ?? cardView.cardHeight(b)) / 2;
    const dx = Math.max(50, Math.abs(x2 - x1) * 0.5);
    const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;

    let path = this.paths.get(edge.id);
    if (!path) {
      path = document.createElementNS(NS, 'path');
      path.setAttribute('class', 'link-path');
      path.dataset.edgeId = edge.id;
      this.svg.appendChild(path);
      this.paths.set(edge.id, path);

      // C-5：点击连线选中（显示传输类型与来源摘要）；再次点击取消
      path.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
        this.selectEdge(this.selectedEdgeId === edge.id ? null : edge.id);
      });

      // hover 连线 → 中点 + 号与删除按钮出现
      const plus = this._buildPlus(edge);
      const del = this._buildDelete(edge);
      path.addEventListener('mouseenter', () => { plus.classList.add('show'); del.classList.add('show'); });
      path.addEventListener('mouseleave', () => {
        setTimeout(() => {
          if (!plus.matches(':hover') && !del.matches(':hover')) {
            plus.classList.remove('show');
            del.classList.remove('show');
          }
        }, 120);
      });
    }
    path.setAttribute('d', d);
    applyLinkFlowing(path, this.flowing.has(edge.id));
    path.classList.toggle('selected', this.selectedEdgeId === edge.id);
    const relation = linkRelation(edge);
    path.dataset.relation = relation;

    const labelText = relationLabel(relation);
    let label = this.labels.get(edge.id);
    if (labelText && this.canvasEl) {
      if (!label) {
        label = document.createElement('div');
        label.className = 'link-kind';
        label.dataset.edgeId = edge.id;
        this.labels.set(edge.id, label);
      }
      label.textContent = labelText;
      label.dataset.relation = relation;
      label.style.left = midX + 'px';
      label.style.top = (midY - 12) + 'px';
      label.classList.toggle('link-kind-hidden', flowState.canvas.scale < 0.68);
      this.canvasEl.appendChild(label);
    } else if (label) {
      label.remove();
      this.labels.delete(edge.id);
    }

    const plus = this.pluses.get(edge.id);
    const del = this.dels.get(edge.id);
    if (plus && del && this.canvasEl) {
      plus.style.left = midX + 'px';
      plus.style.top = midY + 'px';
      del.style.left = (midX + 15) + 'px';
      del.style.top = (midY - 15) + 'px';
      this.canvasEl.appendChild(plus);
      this.canvasEl.appendChild(del);
    }
  }

  private _buildPlus(edge: FlowEdge): HTMLElement {
    let plus = this.pluses.get(edge.id);
    if (plus) return plus;
    plus = document.createElement('div');
    plus.className = 'link-plus';
    plus.dataset.edgeId = edge.id;
    plus.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
    plus.title = '在中间插入步骤';
    plus.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      this._insertStep(edge.id);
    });
    plus.addEventListener('mouseleave', () => plus.classList.remove('show'));
    this.pluses.set(edge.id, plus);
    return plus;
  }

  private _buildDelete(edge: FlowEdge): HTMLElement {
    let del = this.dels.get(edge.id);
    if (del) return del;
    del = document.createElement('div');
    del.className = 'link-del';
    del.dataset.edgeId = edge.id;
    del.innerHTML = '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    del.title = '删除连线';
    del.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      flowHistory.record();
      flowState.removeEdge(edge.id);
      showToast('连线已删除');
    });
    del.addEventListener('mouseleave', () => del.classList.remove('show'));
    this.dels.set(edge.id, del);
    return del;
  }

  /** 中点 + 号 → 真插入：断开原连线并在中点插入新「生成节点」 */
  private _insertStep(edgeId: string): void {
    flowHistory.record();
    const node = flowState.insertStep(edgeId);
    if (!node) { showToast('插入步骤失败', false); return; }
    dirty.markUpstreamChanged(node.id); // 原下游因上游变化标 stale
    selection.select(node.id);
    void fetchImageModels().then(models => {
      if (flowState.getNode(node.id)?.params.model) return;
      const saved = flowState.getModelDefault('drawing');
      const model = saved && models.some(item => item.id === saved)
        ? saved
        : (models.find(item => item.id)?.id || '');
      if (model) {
        flowState.updateNodeParams(node.id, { model });
      }
    });
    showToast('已插入新步骤');
  }

  /** 运行中的节点：上游所有入边亮流光 */
  setNodeFlowing(nodeId: string, on: boolean): void {
    flowState.getEdgesTo(nodeId).forEach(edge => {
      if (on) this.flowing.add(edge.id); else this.flowing.delete(edge.id);
      const path = this.paths.get(edge.id);
      applyLinkFlowing(path ?? null, on);
    });
  }

  // ───────────────────────── 端口拖拽橡皮筋临时线 ─────────────────────────
  /** 从 out 端口开始拖线：创建临时虚线（世界坐标） */
  startTempLine(fromNodeId: string): void {
    this.clearTempLine();
    if (!this.svg) return;
    const from = flowState.getNode(fromNodeId);
    if (!from) return;
    const x1 = from.x + (from.w ?? CARD_W);
    const y1 = from.y + (from.h ?? cardView.cardHeight(from)) / 2;
    const temp = document.createElementNS(NS, 'path');
    temp.setAttribute('class', 'link-temp');
    temp.dataset.fromId = fromNodeId;
    temp.setAttribute('d', `M ${x1} ${y1} L ${x1} ${y1}`);
    this.svg.appendChild(temp);
    this.tempPath = temp;
  }

  /** 拖动中更新橡皮筋终点（世界坐标） */
  updateTempLine(x: number, y: number): void {
    if (!this.tempPath) return;
    const fromId = this.tempPath.dataset.fromId;
    const from = fromId ? flowState.getNode(fromId) : undefined;
    const x1 = from ? from.x + (from.w ?? CARD_W) : x;
    const y1 = from ? from.y + (from.h ?? cardView.cardHeight(from)) / 2 : y;
    const dx = Math.max(30, Math.abs(x - x1) * 0.5);
    this.tempPath.setAttribute('d', `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x - dx} ${y}, ${x} ${y}`);
  }

  /** 结束拖线：移除橡皮筋 */
  clearTempLine(): void {
    if (this.tempPath) {
      this.tempPath.remove();
      this.tempPath = null;
    }
  }
}

/** HTML 转义（连线信息浮标展示节点名/语义，防注入） */
function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const linkView = new LinkView();
