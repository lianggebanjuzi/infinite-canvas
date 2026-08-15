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
  /** 内容指纹缓存：主图/缩略行/标题/状态/文本变化时才重建 img.innerHTML（避免高频调用反复重建大图 DOM） */
  private _contentFingerprint = new Map<string, { mainSrc: string; refStrip: string; title: string; status: string; text: string }>();

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
        this._contentFingerprint.delete(id);
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
    const isResult = node.type === 'image-result';
    const isTextGen = node.type === 'text-gen';
    if (isResult) el.classList.add('result');
    if (isTextGen) el.classList.add('textgen');
    el.innerHTML = `
      <div class="pcard-img"></div>
      <div class="pcard-tag"><span class="dot"></span><span class="tag-text"></span></div>
      ${isResult ? '<span class="pcard-badge">结果</span>' : ''}
      ${isResult || isTextGen ? '' : `<button class="pcard-act" title="查看大图">${ICON_EXPAND}</button>`}
      ${isResult ? '' : '<div class="port in"></div>'}
      <div class="port out"></div>
    `;
    return el;
  }

  private updateCard(el: HTMLElement, node: FlowNode): void {
    el.style.left = node.x + 'px';
    el.style.top = node.y + 'px';
    el.style.width = CARD_W + 'px';

    // 主视觉来源：输出图 imageUrl，无输出图时回退第一张参考图（用户拖入的图）作全图占位。
    // 结果卡只读：只取 imageUrl（无 refImages 回退，恒以自身输出图为主视觉）。
    // 文本反推卡：主视觉为文本（outputText），无图。
    const ownRefs = Array.isArray(node.refImages) ? node.refImages : [];
    const isResult = node.type === 'image-result';
    const isTextGen = node.type === 'text-gen';
    const mainSrc = isResult
      ? (node.imageUrl || '')
      : isTextGen
        ? ''
        : (node.imageUrl || (ownRefs.length > 0 ? ownRefs[0] : ''));

    const img = el.querySelector('.pcard-img') as HTMLElement;
    if (img) {
      img.style.height = this.cardHeight(node) + 'px'; // 高度随 ratio 每次照常更新（开销极小）
    }

    // 内容指纹：仅当主图/缩略行/标题/状态/文本变化时才重建 img.innerHTML 与标签文本。
    // 位置/选中态/状态视觉每次照常更新；避免滚轮缩放等高频调用反复重建大图 DOM（dataURL 大字符串）。
    // 文本：运行结果优先；text-gen 未运行时回退显示用户填写的指令（所见即所得），其余节点无 instruction 恒为空。
    const refStrip = this._refStrip(node);
    const title = node.title || '节点';
    const text = node.outputText || (node.params as unknown as TextGenParams).instruction || '';
    const fp = { mainSrc, refStrip, title, status: node.status, text };
    const prev = this._contentFingerprint.get(node.id);
    const changed = !prev
      || prev.mainSrc !== fp.mainSrc
      || prev.refStrip !== fp.refStrip
      || prev.title !== fp.title
      || prev.status !== fp.status
      || prev.text !== fp.text;
    if (changed) {
      this._contentFingerprint.set(node.id, fp);
      if (img) {
        // 底部叠加参考图缩略行（本节点 refImages ∪ 上游可作参考图的图，动态增删，叠加不改变卡片尺寸）；
        // 结果卡无参考图缩略行
        if (isTextGen) {
          // 文本为主视觉：白底文本区（内部滚动），未运行时显示用户填写的指令，空态显示占位文案
          img.innerHTML = text
            ? `<div class="pcard-text">${escapeHtml(text)}</div><div class="scan"></div>${refStrip}`
            : `<div class="pcard-text empty"><span class="pcard-text-empty">点击下方输入框填写指令</span></div><div class="scan"></div>${refStrip}`;
        } else if (mainSrc) {
          img.innerHTML = `<div class="ph" style="background-image:url('${escapeUrl(mainSrc)}')"></div><div class="scan"></div>${refStrip}`;
        } else {
          img.innerHTML = `<div class="ph"><div class="ph-empty">${emptyContent(isResult)}</div></div><div class="scan"></div>${refStrip}`;
        }
      }
      const tag = el.querySelector('.tag-text') as HTMLElement | null;
      if (tag) tag.textContent = title;
    }

    // 状态视觉 + 红点原因（hover title）
    applyCardStatus(el, node.status);
    if (node.status === 'fail' && node.error) {
      el.title = node.error;
    } else {
      el.removeAttribute('title');
    }

    el.classList.toggle('empty', !mainSrc && !isTextGen);
    el.classList.toggle('selected', selection.isSelected(node.id));

    // 查看大图
    const act = el.querySelector('.pcard-act') as HTMLButtonElement | null;
    if (act) {
      act.onclick = (e: MouseEvent) => {
        e.stopPropagation();
        if (mainSrc) openImageModal(mainSrc);
      };
    }
  }

  /** 卡片底部参考图缩略行：展示 getReferenceImages(id)（本节点 refImages + 上游可作参考图的图） */
  private _refStrip(node: FlowNode): string {
    // 结果卡只读：无参考图缩略行；文本反推卡保留缩略行（其主视觉是文本，无需排除占位图）
    if (node.type === 'image-result') return '';
    const isTextGen = node.type === 'text-gen';
    // 当主视觉正在用 refImages[0] 占位（即无输出图）时，缩略行排除这张占位图，避免重复显示
    const placeholder = !isTextGen && !node.imageUrl
      ? (Array.isArray(node.refImages) ? node.refImages[0] : null) || null
      : null;
    const refs = flowState.getReferenceImages(node.id).filter(u => u !== placeholder);
    if (refs.length === 0) return '';
    const thumbs = refs
      .map(u => `<div class="pcard-up-thumb" style="background-image:url('${escapeUrl(u)}')" title="参考图"></div>`)
      .join('');
    return `<div class="pcard-upstreams">${thumbs}</div>`;
  }
}

function emptyContent(isResult: boolean): string {
  if (isResult) return '<span>无结果图</span>';
  const plus = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
  return `${plus}<span>拖入图片或写提示词</span>`;
}

function escapeUrl(url: string): string {
  return url.replace(/'/g, "\\'").replace(/"/g, '\\"');
}

/** HTML 转义（文本卡展示 outputText 用，防注入） */
function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
