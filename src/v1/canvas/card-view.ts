// src/v1/canvas/card-view.ts
// 卡片 DOM 渲染：图即卡片（宽 260、高随 ratio）、标签、状态点、悬浮操作按钮、空步骤虚线卡

import { flowState } from '../state/flow-state';
import { selection } from '../state/selection';
import { CARD_W } from './canvas-view';
import { applyCardStatus } from '../ui/status-visuals';

const ICON_EXPAND = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';

class CardView {
  private container: HTMLElement | null = null;
  private els = new Map<string, HTMLElement>();

  init(): void {
    this.container = document.getElementById('canvas');
  }

  cardHeight(node: FlowNode): number {
    const ratio = node.ratio > 0 ? node.ratio : 3 / 4;
    return Math.round(CARD_W / ratio);
  }

  getEl(id: string): HTMLElement | undefined {
    return this.els.get(id);
  }

  renderAll(): void {
    if (!this.container) return;
    const ids = new Set(flowState.nodes.map(n => n.id));

    // 移除已删除节点
    this.els.forEach((el, id) => {
      if (!ids.has(id)) {
        el.remove();
        this.els.delete(id);
      }
    });

    flowState.nodes.forEach(node => {
      let el = this.els.get(node.id);
      if (!el) {
        el = this.buildCard(node);
        this.container!.appendChild(el);
        this.els.set(node.id, el);
      }
      this.updateCard(el, node);
    });
  }

  private buildCard(node: FlowNode): HTMLElement {
    const el = document.createElement('div');
    el.className = 'pcard';
    el.id = `node-${node.id}`;
    el.dataset.nodeId = node.id;
    el.innerHTML = `
      <div class="pcard-img"></div>
      <div class="pcard-tag"><span class="dot"></span><span class="tag-text"></span></div>
      <button class="pcard-act" title="查看大图">${ICON_EXPAND}</button>
      <div class="port in"></div>
      <div class="port out"></div>
    `;
    return el;
  }

  private updateCard(el: HTMLElement, node: FlowNode): void {
    el.style.left = node.x + 'px';
    el.style.top = node.y + 'px';
    el.style.width = CARD_W + 'px';

    const img = el.querySelector('.pcard-img') as HTMLElement;
    if (img) {
      img.style.height = this.cardHeight(node) + 'px';
      img.innerHTML = node.imageUrl
        ? `<div class="ph" style="background-image:url('${escapeUrl(node.imageUrl)}')"></div><div class="scan"></div>`
        : `<div class="ph"><div class="ph-empty">${emptyContent(node)}</div></div><div class="scan"></div>`;
    }

    const tag = el.querySelector('.tag-text') as HTMLElement | null;
    if (tag) tag.textContent = node.title || '节点';

    // 状态视觉 + 红点原因（hover title）
    applyCardStatus(el, node.status);
    if (node.status === 'fail' && node.error) {
      el.title = node.error;
    } else {
      el.removeAttribute('title');
    }

    el.classList.toggle('empty', !node.imageUrl);
    el.classList.toggle('selected', selection.isSelected(node.id));

    // 查看大图
    const act = el.querySelector('.pcard-act') as HTMLButtonElement | null;
    if (act) {
      act.onclick = (e: MouseEvent) => {
        e.stopPropagation();
        if (node.imageUrl) openImageModal(node.imageUrl);
      };
    }
  }
}

function emptyContent(node: FlowNode): string {
  const plus = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
  if (node.type === 'product-image') {
    return `${plus}<span>点击选择或拖入产品图</span>`;
  }
  return `${plus}<span>点「+」或选中上游后生成</span>`;
}

function escapeUrl(url: string): string {
  return url.replace(/'/g, "\\'").replace(/"/g, '\\"');
}

/** 大图查看（简单全屏浮层） */
export function openImageModal(src: string): void {
  const modal = document.getElementById('img-modal') as HTMLElement | null;
  const img = document.getElementById('img-modal-img') as HTMLImageElement | null;
  if (!modal || !img) return;
  img.src = src;
  modal.classList.add('show');
  const close = () => modal.classList.remove('show');
  modal.onclick = close;
}

export const cardView = new CardView();
