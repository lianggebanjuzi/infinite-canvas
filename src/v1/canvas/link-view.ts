// src/v1/canvas/link-view.ts
// 连线渲染：贝塞尔曲线（参照旧 _wirePointOnCard 算法）、流光动画、hover 中点 + 号
// 首版连线中点 + 号：点击提示「暂不支持插入步骤」（不报错）

import { flowState } from '../state/flow-state';
import { CARD_W } from './canvas-view';
import { cardView } from './card-view';
import { showToast } from '../ui/toast';
import { applyLinkFlowing } from '../ui/status-visuals';

const NS = 'http://www.w3.org/2000/svg';

class LinkView {
  private svg: SVGSVGElement | null = null;
  private canvasEl: HTMLElement | null = null;
  private paths = new Map<string, SVGPathElement>();
  private pluses = new Map<string, HTMLElement>();
  private flowing = new Set<string>();

  init(canvasEl: HTMLElement): void {
    this.canvasEl = canvasEl;
    this.svg = canvasEl.querySelector('#link-layer') as SVGSVGElement | null;
    this._ensureDefs();
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
    this.pluses.forEach((p, id) => { if (!edgeIds.has(id)) { p.remove(); this.pluses.delete(id); } });

    flowState.edges.forEach(edge => this.renderEdge(edge));
  }

  private renderEdge(edge: FlowEdge): void {
    const a = flowState.getNode(edge.from);
    const b = flowState.getNode(edge.to);
    if (!a || !b || !this.svg) return;

    const x1 = a.x + CARD_W;
    const y1 = a.y + cardView.cardHeight(a) / 2;
    const x2 = b.x;
    const y2 = b.y + cardView.cardHeight(b) / 2;
    const dx = Math.max(50, Math.abs(x2 - x1) * 0.5);
    const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;

    let path = this.paths.get(edge.id);
    if (!path) {
      path = document.createElementNS(NS, 'path');
      path.setAttribute('class', 'link-path');
      path.dataset.edgeId = edge.id;
      this.svg.appendChild(path);
      this.paths.set(edge.id, path);

      // hover 连线 → 中点 + 号出现
      const plus = this._buildPlus(edge);
      path.addEventListener('mouseenter', () => plus.classList.add('show'));
      path.addEventListener('mouseleave', () => {
        setTimeout(() => { if (!plus.matches(':hover')) plus.classList.remove('show'); }, 120);
      });
    }
    path.setAttribute('d', d);
    applyLinkFlowing(path, this.flowing.has(edge.id));

    const plus = this.pluses.get(edge.id);
    if (plus && this.canvasEl) {
      plus.style.left = ((x1 + x2) / 2) + 'px';
      plus.style.top = ((y1 + y2) / 2) + 'px';
      this.canvasEl.appendChild(plus);
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
    plus.addEventListener('click', () => showToast('暂不支持插入步骤', false));
    plus.addEventListener('mouseleave', () => plus.classList.remove('show'));
    this.pluses.set(edge.id, plus);
    return plus;
  }

  /** 开关连线流光（上游 → 目标） */
  setFlowing(from: string, to: string, on: boolean): void {
    const edge = flowState.edges.find(e => e.from === from && e.to === to);
    if (!edge) return;
    if (on) this.flowing.add(edge.id); else this.flowing.delete(edge.id);
    const path = this.paths.get(edge.id);
    applyLinkFlowing(path ?? null, on);
  }

  /** 运行中的节点：上游所有入边亮流光 */
  setNodeFlowing(nodeId: string, on: boolean): void {
    flowState.getEdgesTo(nodeId).forEach(edge => {
      if (on) this.flowing.add(edge.id); else this.flowing.delete(edge.id);
      const path = this.paths.get(edge.id);
      applyLinkFlowing(path ?? null, on);
    });
  }
}

export const linkView = new LinkView();
