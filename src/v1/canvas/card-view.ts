// src/v1/canvas/card-view.ts
// 卡片 DOM 渲染：图即卡片（宽 260、高随 ratio）、标签、状态点、悬浮操作按钮、空步骤虚线卡

import { flowState } from '../state/flow-state';
import { selection } from '../state/selection';
import { CARD_W } from './canvas-view';
import { interactions } from './interactions';
import { applyCardStatus } from '../ui/status-visuals';
import { applyTextToDownstream } from '../engine/run-engine';
import { showToast } from '../ui/toast';

const ICON_EXPAND = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';

class CardView {
  private container: HTMLElement | null = null;
  private els = new Map<string, HTMLElement>();
  /** 内容指纹缓存：主图/缩略行/标题/状态/文本变化时才重建 img.innerHTML（避免高频调用反复重建大图 DOM） */
  private _contentFingerprint = new Map<string, { mainSrc: string; refStrip: string; title: string; status: string; text: string }>();
  /** 当前处于就地编辑态的 text-gen 节点 id（编辑中跳过 img.innerHTML 重建，避免打字被重建打断） */
  private _editingNodeId: string | null = null;

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
    const isTextGen = node.type === 'text-gen';
    if (isTextGen) el.classList.add('textgen');
    el.innerHTML = `
      <div class="pcard-img"></div>
      <div class="pcard-tag"><span class="dot"></span><span class="tag-text"></span></div>
      ${isTextGen ? '' : `<button class="pcard-act" title="查看大图">${ICON_EXPAND}</button>`}
      ${isTextGen ? '' : '<div class="port in"></div>'}
      <div class="port out"></div>
      <div class="pcard-error"></div>
    `;

    // 文本反推卡：点击文本区进入就地编辑（所见即所得；空态同样可点）。委托在卡片元素上，innerHTML 重建无需重绑。
    // 拖动守卫：按住文本拖动卡片松手后浏览器仍会补发 click，位移过（wasNodeDragMoved）则不进入编辑。
    el.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as Element;
      if (!target.closest('.pcard-text')) return;
      if (interactions.wasNodeDragMoved()) return;
      const n = flowState.getNode(node.id);
      if (!n || n.type !== 'text-gen') return;
      if (n.status === 'run') return; // 运行中不进入编辑
      this._enterTextEdit(node.id);
    });
    return el;
  }

  private updateCard(el: HTMLElement, node: FlowNode): void {
    el.style.left = node.x + 'px';
    el.style.top = node.y + 'px';
    el.style.width = CARD_W + 'px';

    // 主视觉来源：输出图 imageUrl，无输出图时回退第一张参考图（用户拖入的图）作全图占位。
    // 文本反推卡：主视觉为文本（outputText），无图。
    const ownRefs = Array.isArray(node.refImages) ? node.refImages : [];
    const isTextGen = node.type === 'text-gen';
    const mainSrc = isTextGen
      ? ''
      : (node.imageUrl || (ownRefs.length > 0 ? ownRefs[0] : ''));

    const img = el.querySelector('.pcard-img') as HTMLElement;
    if (img) {
      img.style.height = this.cardHeight(node) + 'px'; // 高度随 ratio 每次照常更新（开销极小）
    }

    // 内容指纹：仅当主图/缩略行/标题/状态/文本变化时才重建 img.innerHTML 与标签文本。
    // 位置/选中态/状态视觉每次照常更新；避免滚轮缩放等高频调用反复重建大图 DOM（dataURL 大字符串）。
    // 文本：text-gen 卡片只显示结果 outputText（空则占位），其余节点无文本恒为空。
    const refStrip = this._refStrip(node);
    const title = node.title || '节点';
    const text = node.outputText || '';
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
      // 就地编辑中跳过重建（避免状态等变化把 textarea 打没）；退出编辑态后由保存/取消路径强制重建
      if (img && this._editingNodeId !== node.id) {
        // 底部叠加参考图缩略行（本节点 refImages ∪ 上游可作参考图的图，动态增删，叠加不改变卡片尺寸）
        if (isTextGen) {
          // 文本为主视觉：白底文本区（内部滚动），有结果显示 outputText，空态显示占位文案
          img.innerHTML = text
            ? `<div class="pcard-text">${escapeHtml(text)}</div><div class="scan"></div>${refStrip}`
            : `<div class="pcard-text empty"><span class="pcard-text-empty">点击输入文本</span></div><div class="scan"></div>${refStrip}`;
        } else if (mainSrc) {
          img.innerHTML = `<div class="ph" style="background-image:url('${escapeUrl(mainSrc)}')"></div><div class="scan"></div>${refStrip}`;
        } else {
          img.innerHTML = `<div class="ph"><div class="ph-empty">${emptyContent()}</div></div><div class="scan"></div>${refStrip}`;
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

    // 失败原因横幅：fail 且有 error 时直接显示在卡片底部（显隐由 CSS data-status 控制）；
    // 每次 update 同步 textContent（卡片数少，开销可忽略）；hover title 保留作冗余
    const errEl = el.querySelector('.pcard-error') as HTMLElement | null;
    if (errEl) {
      errEl.textContent = node.status === 'fail' && node.error ? node.error : '';
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

  /**
   * 进入文本就地编辑（text-gen 卡点击文本区触发）：把 .pcard-text 替换为 textarea，聚焦全选便于整体替换。
   * 编辑态防冲突：textarea 的 mousedown stopPropagation（不触发卡片拖拽/选中/连线）；节点选中态保持不动。
   */
  private _enterTextEdit(nodeId: string): void {
    const el = this.els.get(nodeId);
    const node = flowState.getNode(nodeId);
    if (!el || !node || node.type !== 'text-gen') return;
    if (this._editingNodeId === nodeId) return; // 已在编辑
    const textEl = el.querySelector('.pcard-text') as HTMLElement | null;
    if (!textEl) return;

    const currentText = node.outputText || '';
    const ta = document.createElement('textarea');
    ta.className = 'pcard-text-editor';
    ta.value = currentText;
    ta.spellcheck = false;

    ta.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation());
    ta.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this._cancelTextEdit(nodeId);
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._commitTextEdit(nodeId, ta);
      }
    });
    ta.addEventListener('blur', () => this._commitTextEdit(nodeId, ta));

    textEl.replaceWith(ta);
    this._editingNodeId = nodeId;
    ta.focus();
    ta.select(); // 全选便于整体替换（点击位置精确定位工程成本高，全选为可接受方案）
  }

  /**
   * 保存就地编辑（失焦 / 无 Shift 的 Enter）：
   * 编辑的永远是文本结果 outputText → 写 outputText + 联动直接 image-gen 下游 + 标 stale。
   * 空输入保护：原来有文本时不删没（保持原值退出编辑）；内容没变仅退出编辑。
   */
  private _commitTextEdit(nodeId: string, ta: HTMLTextAreaElement): void {
    if (this._editingNodeId !== nodeId) return; // 已提交/已取消（如 Enter 保存后重建触发的 blur）
    if (!ta.isConnected) return; // textarea 已被重建移除
    const node = flowState.getNode(nodeId);
    if (!node) { this._editingNodeId = null; return; }

    const prevText = node.outputText || '';
    const newText = ta.value;
    this._editingNodeId = null; // 先退出编辑态，保证后续 notify 重建不被编辑态拦截

    // 空输入保护：原来有文本时不删没（保持原值退出编辑）；原来就是空 → 无操作
    if (!newText.trim() && prevText.trim()) { this._restoreTextCard(nodeId); return; }
    if (newText === prevText) { this._restoreTextCard(nodeId); return; } // 内容没变，仅退出编辑

    // 永远只写结果 outputText + 覆盖直接 image-gen 下游 prompt + 标 stale（与处理成功联动一致）
    flowState.updateNode(nodeId, { outputText: newText });
    applyTextToDownstream(nodeId, newText);
    showToast('已保存文本');
  }

  /** 取消就地编辑（Escape）：还原为当前节点文本视图，不保存 */
  private _cancelTextEdit(nodeId: string): void {
    if (this._editingNodeId !== nodeId) return;
    this._editingNodeId = null;
    this._restoreTextCard(nodeId);
  }

  /** 强制重建文本卡视图（退出编辑态后恢复 .pcard-text 显示） */
  private _restoreTextCard(nodeId: string): void {
    const node = flowState.getNode(nodeId);
    const el = this.els.get(nodeId);
    if (!el || !node) return;
    this._contentFingerprint.delete(nodeId); // 清指纹强制重建
    this.updateCard(el, node);
  }

  /** 卡片底部参考图缩略行：展示 getReferenceImages(id)（本节点 refImages + 上游可作参考图的图） */
  private _refStrip(node: FlowNode): string {
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

function emptyContent(): string {
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
