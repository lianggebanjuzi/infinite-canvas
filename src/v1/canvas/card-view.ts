// src/v1/canvas/card-view.ts
// 卡片 DOM 渲染：图即卡片（宽 260、高随 ratio）、标签、状态点、悬浮操作按钮、空步骤虚线卡

import { flowState } from '../state/flow-state';
import { selection } from '../state/selection';
import { flowHistory } from '../state/history';
import { dirty } from '../state/dirty';
import { batchStore } from '../state/batch-store';
import { CARD_W, IMAGE_CARD_MAX_H, TEXT_CARD_MAX_H, imageCardHeight } from './canvas-view';
import { interactions } from './interactions';
import { applyCardStatus } from '../ui/status-visuals';
import { showToast } from '../ui/toast';
import { assetStore } from '../asset-store';
import { Backend } from '../api';

const ICON_EXPAND = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';
const ICON_ADD_ASSET = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M6 9h12"/><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/></svg>';

class CardView {
  private container: HTMLElement | null = null;
  private els = new Map<string, HTMLElement>();
  /** 内容指纹缓存：主图/缩略行/标题/状态/文本/角标态/素材态/空态文案/尺寸标注变化时才重建 img.innerHTML（避免高频调用反复重建大图 DOM） */
  private _contentFingerprint = new Map<string, { mainSrc: string; refStrip: string; title: string; status: string; text: string; assetState: string; isAsset: string; emptyHint: string; sizeLabel: string; splitState: string; galleryState: string }>();
  /** 当前处于就地编辑态的 text-gen 节点 id（编辑中跳过 img.innerHTML 重建，避免打字被重建打断） */
  private _editingNodeId: string | null = null;
  /** 处于「展开扇形排列」态的节点 id（会话内瞬态，不持久化；节点删除时随 renderAll 清理） */
  private _expandedFans = new Set<string>();
  /** 正在播放收起动画的结果组；动画结束后才从 DOM 移除，避免瞬间消失。 */
  private _closingFans = new Set<string>();

  init(): void {
    this.container = document.getElementById('canvas');
  }

  cardHeight(node: FlowNode): number {
    if (node.h) return node.h;
    if (node.type === 'text-split') {
      // A-2：拆分卡高度随段数增长但封顶 TEXT_CARD_MAX_H（520），槽位区内部滚动（.split-body overflow-y:auto）
      const segments = flowState.getTextSplitSegments(node.id);
      return Math.min(TEXT_CARD_MAX_H, Math.max(280, 126 + Math.max(1, segments.length) * 76));
    }
    return imageCardHeight(node.ratio);
  }

  getEl(id: string): HTMLElement | undefined {
    return this.els.get(id);
  }

  /**
   * 拖拽中的轻量几何同步：仅改动被拖节点的位置/尺寸，不扫描节点内容或重算参考图缩略行。
   * 参考图 data URL 较大，逐帧调用 renderAll 会造成不必要的字符串拼接和样式计算。
   */
  updateDragGeometry(nodeIds: Iterable<string>): void {
    for (const id of nodeIds) {
      const node = flowState.getNode(id);
      const el = this.els.get(id);
      if (!node || !el) continue;
      el.style.left = node.x + 'px';
      el.style.top = node.y + 'px';
      el.style.width = (node.w ?? CARD_W) + 'px';
      const img = el.querySelector('.pcard-img') as HTMLElement | null;
      if (img) {
        const isTextNode = node.type === 'text-gen' || node.type === 'text-split';
        img.style.height = (isTextNode ? (node.h ?? this.cardHeight(node)) : this.cardHeight(node)) + 'px';
      }
    }
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
        this._expandedFans.delete(id);
        this._closingFans.delete(id);
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
    const isTextSplit = node.type === 'text-split';
    if (isTextGen) el.classList.add('textgen');
    if (isTextSplit) el.classList.add('textsplit');
    el.innerHTML = `
      <div class="pcard-stack"></div>
      <div class="pcard-img"></div>
      <div class="pcard-tag"><span class="dot"></span><span class="tag-text"></span><span class="tag-status"></span></div>
      ${isTextGen || isTextSplit ? '' : `<div class="pcard-actions">
        <button class="pcard-act" title="查看大图">${ICON_EXPAND}</button>
        <button class="pcard-act asset-add" title="添加到资产库">${ICON_ADD_ASSET}</button>
      </div>`}
      ${isTextGen || isTextSplit ? '' : '<div class="port in"></div>'}
      <div class="port out"></div>
      <div class="pcard-error"></div>
      ${isTextGen || isTextSplit ? '<div class="pcard-resize" title="拖拽调整大小"></div>' : ''}
    `;

    // 文本反推卡：单击只负责选中/拖动，双击文本区才进入就地编辑（所见即所得；空态同样适用）。
    // 委托在卡片元素上，innerHTML 重建无需重绑；拖动后的误触由位移守卫排除。
    el.addEventListener('dblclick', (e: MouseEvent) => {
      const target = e.target as Element;
      if (!target.closest('.pcard-text')) return;
      if (interactions.wasNodeDragMoved()) return;
      const n = flowState.getNode(node.id);
      if (!n || n.type !== 'text-gen') return;
      if (n.status === 'run') return; // 运行中不进入编辑
      e.preventDefault();
      e.stopImmediatePropagation();
      this._enterTextEdit(node.id);
    });

    // 图片节点的资产库入口：与查看大图共用右上角悬浮操作区。
    el.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as Element;
      const button = target.closest('.pcard-act.asset-add') as HTMLButtonElement | null;
      if (!button) return;
      e.preventDefault();
      e.stopPropagation();
      this._addToAssetLibrary(node.id);
    });
    this._bindGalleryEvents(el, node.id);
    if (isTextSplit) this._bindTextSplitEvents(el, node.id);
    return el;
  }

  private _bindGalleryEvents(el: HTMLElement, nodeId: string): void {
    el.addEventListener('click', (e: MouseEvent) => {
      // 点击右侧露出的折叠叠图：展开所有结果（不额外放「多图」按钮）。
      const expandBtn = (e.target as Element).closest('.stack-layer') as HTMLElement | null;
      if (expandBtn) {
        e.preventDefault(); e.stopPropagation();
        const node = flowState.getNode(nodeId);
        if (!node) return;
        if (this._closingFans.has(nodeId)) return;
        this._expandedFans.add(nodeId);
        this._contentFingerprint.delete(nodeId); // 扇形态不在指纹里，强制重建
        const cardEl = this.els.get(nodeId);
        if (cardEl) this.updateCard(cardEl, node);
        return;
      }
      // 扇形缩略图：点击只切换封面，展开状态保持，方便连续比较其它图片。
      const thumb = (e.target as Element).closest('.fan-thumb') as HTMLElement | null;
      if (thumb) {
        e.preventDefault(); e.stopPropagation();
        const node = flowState.getNode(nodeId);
        const images = node?.generatedImages || [];
        const index = Math.min(Math.max(0, Number(thumb.dataset.index || 0)), Math.max(0, images.length - 1));
        const item = images[index];
        if (node && item) {
          flowState.updateNode(nodeId, { activeGeneratedIndex: index, imageUrl: item.url, imageOrigin: item.origin || null,
            imageWidth: item.width, imageHeight: item.height });
        }
        const cardEl = this.els.get(nodeId);
        if (cardEl && node) this.updateCard(cardEl, node);
        return;
      }
      const button = (e.target as Element).closest('.image-gallery-nav') as HTMLElement | null;
      if (!button) return;
      e.preventDefault(); e.stopPropagation();
      const node = flowState.getNode(nodeId);
      const images = node?.generatedImages || [];
      if (!node || images.length === 0) return;
      const next = Math.min(images.length - 1, Math.max(0, (node.activeGeneratedIndex || 0) + Number(button.dataset.dir || 0)));
      const item = images[next];
      flowState.updateNode(nodeId, { activeGeneratedIndex: next, imageUrl: item.url, imageOrigin: item.origin || null,
        imageWidth: item.width, imageHeight: item.height });
    });
  }

  /** 延迟移除展开缩略图，让收起也有与展开对应的退场动画。 */
  private _collapseFan(nodeId: string, node: FlowNode): void {
    if (!this._expandedFans.has(nodeId)) return;
    this._expandedFans.delete(nodeId);
    this._closingFans.add(nodeId);
    this._contentFingerprint.delete(nodeId);
    const cardEl = this.els.get(nodeId);
    if (cardEl) this.updateCard(cardEl, node);
    window.setTimeout(() => {
      this._closingFans.delete(nodeId);
      this._contentFingerprint.delete(nodeId);
      const current = flowState.getNode(nodeId);
      const currentEl = this.els.get(nodeId);
      if (current && currentEl) this.updateCard(currentEl, current);
    }, 230);
  }

  /** 点击画布空白处时收起所有已展开的多图扇形。 */
  collapseAllFans(): void {
    [...this._expandedFans].forEach(nodeId => {
      const node = flowState.getNode(nodeId);
      if (node) this._collapseFan(nodeId, node);
    });
  }

  /** 拆分卡全部在卡内编辑，避免挤占图片节点的指令面板。 */
  private _bindTextSplitEvents(el: HTMLElement, nodeId: string): void {
    const save = (patch: Partial<TextSplitParams>): void => {
      const node = flowState.getNode(nodeId);
      if (!node) return;
      flowState.updateNodeParams(nodeId, { ...patch });
      dirty.markUpstreamChanged(nodeId);
    };
    el.addEventListener('mousedown', (e: MouseEvent) => {
      if ((e.target as Element).closest('.split-control, .split-input, .split-delimiter, .gallery-nav')) e.stopPropagation();
    });
    el.addEventListener('focusin', (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      if (target.matches('.split-input, .split-delimiter') && !target.dataset.historyRecorded) {
        flowHistory.record();
        target.dataset.historyRecorded = '1';
      }
    });
    el.addEventListener('focusout', (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      if (target.matches('.split-input, .split-delimiter')) delete target.dataset.historyRecorded;
    });
    el.addEventListener('input', (e: Event) => {
      const target = e.target as HTMLInputElement | HTMLTextAreaElement;
      const node = flowState.getNode(nodeId);
      if (!node) return;
      if (target.classList.contains('split-input') && flowState.getUpstreams(nodeId).some(n => n.type === 'text-gen')) return;
      const p = node.params as unknown as TextSplitParams;
      const delimiter = target.classList.contains('split-delimiter') ? target.value : (p.delimiter || '');
      const rawSegments = Array.isArray(p.segments) ? [...p.segments] : [''];
      if (target.classList.contains('split-input')) {
        const index = Number(target.dataset.index || 0);
        rawSegments[index] = target.value;
      }
      // 任意输入中出现拆分符都立即拆成槽位；split() 天然不会把分隔符带入结果。
      const hasDelimiter = !!delimiter && rawSegments.some(text => String(text).includes(delimiter));
      const segments = hasDelimiter
        ? rawSegments.flatMap(text => String(text).split(delimiter).map(s => s.trim())).filter(s => s !== '')
        : rawSegments;
      // 普通输入不重建 DOM，避免每敲一个字就丢失 textarea 焦点；真正触发拆分时再刷新槽位。
      el.dataset.splitRebuild = hasDelimiter ? '1' : '';
      save({ delimiter, segments: segments.length ? segments : [''] });
    });
    el.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as Element;
      const button = target.closest('.split-control, .gallery-nav') as HTMLElement | null;
      if (!button) return;
      e.preventDefault(); e.stopPropagation();
      const node = flowState.getNode(nodeId);
      if (!node) return;
      if (button.classList.contains('gallery-nav')) {
        const images = node.generatedImages || [];
        const dir = Number(button.dataset.dir || 0);
        const index = Math.min(images.length - 1, Math.max(0, (node.activeGeneratedIndex || 0) + dir));
        flowState.updateNode(nodeId, { activeGeneratedIndex: index, imageUrl: images[index]?.url || node.imageUrl });
        return;
      }
      if (flowState.getUpstreams(nodeId).some(n => n.type === 'text-gen')) {
        showToast('拆分框由上游文本自动决定；可修改拆分符', false);
        return;
      }
      flowHistory.record();
      const p = node.params as unknown as TextSplitParams;
      const segments = Array.isArray(p.segments) ? [...p.segments] : [''];
      const act = button.dataset.action;
      if (act === 'add') segments.push('');
      else if (act === 'remove' && segments.length > 1) segments.pop();
      else if (act === 'clear') { flowState.updateNodeParams(nodeId, { segments: [''] }); dirty.markUpstreamChanged(nodeId); return; }
      flowState.updateNodeParams(nodeId, { segments });
      dirty.markUpstreamChanged(nodeId);
    });
  }

  /** 将当前图片添加到资产库。 */
  private _addToAssetLibrary(nodeId: string): void {
    const node = flowState.getNode(nodeId);
    if (!node || !node.imageUrl) return;
    const url = node.imageUrl;
    if (assetStore.isAddedByImageUrl(url)) return;
    flowHistory.record(); // 用户手势入口：变更前入撤销栈（X3）
    // AssetStore 保持既有资产持久化和去重语义；此处只暴露“添加到资产库”的用户动作。
    assetStore.addByUrl(url, node.id, assetStore.metaFromNode(node), node.imageOrigin?.path);
    showToast('已添加到资产库');
  }

  private updateCard(el: HTMLElement, node: FlowNode): void {
    el.style.left = node.x + 'px';
    el.style.top = node.y + 'px';
    // 文本卡支持右下角拖拽缩放（w/h 可选字段；image-gen 保持默认宽 CARD_W）
    el.style.width = (node.w ?? CARD_W) + 'px';

    // 主视觉来源：输出图 imageUrl，无输出图时回退第一张参考图（用户拖入的图）作全图占位。
    // 文本反推卡：主视觉为文本（outputText），无图。
    const ownRefs = Array.isArray(node.refImages) ? node.refImages : [];
    const isTextGen = node.type === 'text-gen';
    const isTextSplit = node.type === 'text-split';
    const isAsset = flowState.isAssetNode(node); // 素材态：整卡显图 + 角标「素材」（判分支 #9）
    const isTallImage = !isTextGen && !isTextSplit && CARD_W / (node.ratio > 0 ? node.ratio : 4 / 3) > IMAGE_CARD_MAX_H;
    // C-3 统一批次展示：count>1 与文本拆分驱动的成功图都写在 generatedImages，卡内统一浏览
    const galleryImages = (node.generatedImages || []);
    const galleryIndex = Math.min(Math.max(0, node.activeGeneratedIndex || 0), Math.max(0, galleryImages.length - 1));
    const galleryImage = galleryImages[galleryIndex];
    const mainSrc = (isTextGen || isTextSplit)
      ? ''
      : (galleryImage?.url || node.imageUrl || (ownRefs.length > 0 ? ownRefs[0] : ''));

    const img = el.querySelector('.pcard-img') as HTMLElement;
    if (img) {
      // 高度：text-gen 支持 h 覆盖（缩放）；image-gen 维持按图比例（CARD_W / ratio）
      img.style.height = ((isTextGen || isTextSplit) ? (node.h ?? this.cardHeight(node)) : this.cardHeight(node)) + 'px';
    }

    // 内容指纹：仅当主图/缩略行/标题/状态/文本/角标态变化时才重建 img.innerHTML 与标签文本。
    // 位置/选中态/状态视觉每次照常更新；避免滚轮缩放等高频调用反复重建大图 DOM（dataURL 大字符串）。
    // 文本：text-gen 卡片只显示结果 outputText（空则占位），其余节点无文本恒为空。
    const refStrip = this._refStrip(node);
    const title = node.title || '节点';
    const text = node.outputText || '';
    // 资产库状态纳入指纹，添加后立即重建按钮状态。
    const added = !!mainSrc && assetStore.isAddedByImageUrl(mainSrc);
    const assetState = added ? 'added' : '';
    // P1（W2-5）：文本节点空态引导——有图片上游（可反推）时给轻量提示
    const emptyHint = isTextGen && flowState.getReferenceImages(node.id).length > 0
      ? '已连接上游图，可反推'
      : '双击输入文本';
    // 分辨率/比例标注（B2：真实像素优先，无则回退 params；纳入指纹，像素/配方变化时重建）
    const sizeLabel = this._sizeLabel(node);
    const splitState = isTextSplit ? JSON.stringify({ params: node.params, segments: flowState.getTextSplitSegments(node.id) }) : '';
    const galleryState = JSON.stringify({ images: node.generatedImages || [], index: node.activeGeneratedIndex || 0 });
    const fp = { mainSrc, refStrip, title, status: node.status, text, assetState, isAsset: isAsset ? '1' : '0', emptyHint, sizeLabel, splitState, galleryState };
    const prev = this._contentFingerprint.get(node.id);
    const changed = !prev
      || prev.mainSrc !== fp.mainSrc
      || prev.refStrip !== fp.refStrip
      || prev.title !== fp.title
      || prev.status !== fp.status
      || prev.text !== fp.text
      || prev.assetState !== fp.assetState
      || prev.isAsset !== fp.isAsset
      || prev.emptyHint !== fp.emptyHint
      || prev.sizeLabel !== fp.sizeLabel
      || prev.splitState !== fp.splitState
      || prev.galleryState !== fp.galleryState;
    if (changed) {
      this._contentFingerprint.set(node.id, fp);
      // 就地编辑中跳过重建（避免状态等变化把 textarea 打没）；退出编辑态后由保存/取消路径强制重建
      const activeEl = document.activeElement as HTMLElement | null;
      const splitTyping = isTextSplit && !!activeEl && el.contains(activeEl)
        && activeEl.matches('.split-input, .split-delimiter') && el.dataset.splitRebuild !== '1';
      if (img && this._editingNodeId !== node.id && !splitTyping) {
        if (isTextSplit) delete el.dataset.splitRebuild;
        // 多张结果图两种形态：折叠 = 右侧露出的可点击叠图；展开 = 右侧规整缩略图列。
        // 容器都是 .pcard-stack（在 .pcard-img 之下、.pcard 无 overflow 裁剪，扇形排用 pointer-events:auto 恢复交互）。
        const fanOpen = !isTextGen && !isTextSplit && !!mainSrc && galleryImages.length > 1 && this._expandedFans.has(node.id);
        const fanClosing = !isTextGen && !isTextSplit && !!mainSrc && galleryImages.length > 1 && this._closingFans.has(node.id);
        const fanVisible = fanOpen || fanClosing;
        const showDeck = !isTextGen && !isTextSplit && !!mainSrc && galleryImages.length > 1 && !fanVisible;
        const stackEl = el.querySelector('.pcard-stack') as HTMLElement | null;
        if (stackEl) {
          stackEl.innerHTML = fanVisible
            ? this._fanStripHtml(galleryImages, galleryIndex, node.ratio, fanClosing)
            : (showDeck ? this._deckLayersHtml(galleryImages, galleryIndex) : '');
        }
        // 底部叠加参考图缩略行（本节点 refImages ∪ 上游可作参考图的图，动态增删，叠加不改变卡片尺寸）
        // 分辨率/比例标注条（仅图片卡有图且可算文案时显示；指针穿透，不遮挡操作）
        const sizeHtml = !isTextGen && mainSrc && sizeLabel
          ? `<div class="pcard-size"><span>${escapeHtml(sizeLabel)}</span></div>`
          : '';
        if (isTextSplit) {
          img.innerHTML = this._textSplitContent(node);
        } else if (isTextGen) {
          // 文本为主视觉：白底文本区（内部滚动），有结果显示 outputText，空态显示占位文案（有图片上游 → 反推引导）
          img.innerHTML = text
            ? `<div class="pcard-text">${escapeHtml(text)}</div><div class="scan"></div>${refStrip}`
            : `<div class="pcard-text empty"><span class="pcard-text-empty">${emptyHint}</span></div><div class="scan"></div>${refStrip}`;
        } else if (mainSrc) {
          // 素材节点保留整卡显图和边框区分；类型由左上角标题胶囊呈现，无需重复角标。
          // C-3：批次卡显示「第 x/N 张」+ 批次摘要（成功 x/y，仅部分失败时提示）+ 上下切换
          const gallerySummary = this._gallerySummary(node);
          const imageGallery = galleryImages.length > 1 ? `<div class="image-gallery-controls"><button class="image-gallery-nav" data-dir="-1" ${galleryIndex === 0 ? 'disabled' : ''}>↑</button><span class="image-gallery-count">${galleryIndex + 1} / ${galleryImages.length}${gallerySummary ? `<b class="image-gallery-summary">${gallerySummary}</b>` : ''}</span><button class="image-gallery-nav" data-dir="1" ${galleryIndex >= galleryImages.length - 1 ? 'disabled' : ''}>↓</button></div>` : '';
          img.innerHTML = `<div class="ph" style="background-image:url('${escapeUrl(mainSrc)}')"></div><div class="scan"></div>${refStrip}${sizeHtml}${imageGallery}`;
        } else {
          img.innerHTML = `<div class="ph"><div class="ph-empty">${emptyContent()}</div></div><div class="scan"></div>${refStrip}`;
        }
      }
      const tag = el.querySelector('.tag-text') as HTMLElement | null;
      if (tag) tag.textContent = title;
      // C-4：七态徽标文字（未运行不显示，保持卡片干净）
      const tagStatus = el.querySelector('.tag-status') as HTMLElement | null;
      if (tagStatus) tagStatus.textContent = this._statusText(node);
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

    el.classList.toggle('empty', !mainSrc && !isTextGen && !isTextSplit);
    el.classList.toggle('selected', selection.isSelected(node.id));
    el.classList.toggle('pcard-asset', isAsset); // 素材态：细边框视觉（判分支 #9）
    el.classList.toggle('pcard-tall-image', isTallImage);
    // .has-fan 抬升卡片层级，让展开的缩略图列浮于邻近卡片之上。
    const batchUi = !isTextGen && !isTextSplit && !!mainSrc && galleryImages.length > 1;
    el.classList.toggle('has-fan', batchUi && (this._expandedFans.has(node.id) || this._closingFans.has(node.id)));

    const assetAdd = el.querySelector('.pcard-act.asset-add') as HTMLButtonElement | null;
    if (assetAdd) {
      assetAdd.disabled = !mainSrc || added;
      assetAdd.title = added ? '已添加到资产库' : '添加到资产库';
      assetAdd.classList.toggle('added', added);
    }

    // 查看大图：与双击卡片统一走图片信息弹窗；多图时可在弹窗内翻页。
    const act = el.querySelector('.pcard-act') as HTMLButtonElement | null;
    if (act) {
      act.onclick = (e: MouseEvent) => {
        e.stopPropagation();
        if (mainSrc) void openNodeImageModal(node.id, node.activeGeneratedIndex || 0);
      };
    }
  }

  private _textSplitContent(node: FlowNode): string {
    const p = node.params as unknown as TextSplitParams;
    const hasTextUpstream = flowState.getUpstreams(node.id).some(n => n.type === 'text-gen');
    const derived = flowState.getTextSplitSegments(node.id);
    const segments = derived.length ? derived : [''];
    const images = node.generatedImages || [];
    const index = Math.min(Math.max(0, node.activeGeneratedIndex || 0), Math.max(0, images.length - 1));
    const active = images[index];
    const slots = segments.map((text, i) => `
      <div class="split-slot"><span>槽 ${i + 1}</span><textarea class="split-input" data-index="${i}" placeholder="输入文本…" ${hasTextUpstream ? 'readonly' : ''}>${escapeHtml(text)}</textarea></div>`).join('');
    const gallery = active ? `<div class="split-gallery">
      <div class="split-gallery-img" style="background-image:url('${escapeUrl(active.url)}')"></div>
      <div class="split-gallery-bar"><button class="gallery-nav" data-dir="-1" ${index === 0 ? 'disabled' : ''}>↑</button><span>${index + 1} / ${images.length}</span><button class="gallery-nav" data-dir="1" ${index >= images.length - 1 ? 'disabled' : ''}>↓</button></div>
    </div>` : '';
    return `<div class="split-body">
      <div class="split-toolbar"><button class="split-control" data-action="add" title="增加拆分框">＋</button><button class="split-control" data-action="remove" title="减少拆分框">－</button><button class="split-control" data-action="clear" title="一键清空">清空</button></div>
      <label class="split-label">拆分符<input class="split-delimiter" value="${escapeHtml(p.delimiter || '')}" placeholder="例如 ########"></label>
      ${hasTextUpstream ? '<div class="split-source-hint">已使用上游文本自动拆分</div>' : ''}<div class="split-slots">${slots}</div>${gallery}
    </div>`;
  }

  /**
   * 进入文本就地编辑（text-gen 卡双击文本区触发）：把 .pcard-text 替换为 textarea，聚焦全选便于整体替换。
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

    // 永远只写结果 outputText + 标下游 stale（旁路已删除：不再覆盖下游 prompt，W3-1/W4-1）
    flowHistory.record();
    flowState.updateNode(nodeId, { outputText: newText });
    dirty.markUpstreamChanged(nodeId);
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

  /**
   * 卡片底部参考图缩略行：展示 getReferenceImages(id)（本节点 refImages + 上游可作参考图的图）
   */
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

  /**
   * 折叠态叠图：露出后续图片的边缘；露出的图层本身就是展开入口。
   * 层数 = min(2, 总数-1)；2 张图只露 1 层。s2 先渲染（压在 s1 之下）。
   */
  private _deckLayersHtml(images: GeneratedImageItem[], index: number): string {
    const len = images.length;
    const l1 = images[(index + 1) % len];
    const l2 = len > 2 ? images[(index + 2) % len] : null;
    return `${l2 ? `<button class="stack-layer s2" type="button" title="展开 ${len} 张结果" aria-label="展开 ${len} 张结果" style="background-image:url('${escapeUrl(l2.url)}')"></button>` : ''}<button class="stack-layer s1" type="button" title="展开 ${len} 张结果" aria-label="展开 ${len} 张结果" style="background-image:url('${escapeUrl(l1.url)}')"></button>`;
  }

  /**
   * 展开态缩略图：按列规整排列（当前封面 accent 描边）。
   * 点缩略图 = 设为封面但保持展开（事件见 _bindGalleryEvents）。ratio = 卡片宽高比，缩略图保持同比例。
   */
  private _fanStripHtml(images: GeneratedImageItem[], activeIndex: number, ratio: number, closing = false): string {
    const r = ratio > 0 ? ratio : 4 / 3;
    const thumbs = images.map((img, i) =>
      `<div class="fan-thumb${i === activeIndex ? ' active' : ''}" data-index="${i}" title="第 ${i + 1} 张 · 点击切换封面" style="background-image:url('${escapeUrl(img.url)}');aspect-ratio:${r};--fan-delay:${i * 45}ms"></div>`
    ).join('');
    return `<div class="pcard-fan${closing ? ' is-closing' : ''}">${thumbs}</div>`;
  }

  /**
   * 批次摘要（C-3）：卡内批量浏览时显示「成功 x/y」（仅部分失败/失败时提示，避免常驻噪音）。
   * 数据源 = batch-store（执行态事实源）；restored 重建批次无 summarize 噪音（无失败）。
   */
  private _gallerySummary(node: FlowNode): string {
    const batchId = node.trace?.batchId;
    if (!batchId) return '';
    const batch = batchStore.getBatch(batchId);
    if (!batch || batch.restored === true) return '';
    const s = batchStore.summarize(batchId);
    return s.failed > 0 ? `成功 ${s.succeeded}/${s.total}` : '';
  }

  /** C-4 七态徽标文字（未运行返回空 → 不显示） */
  private _statusText(node: FlowNode): string {
    switch (node.status) {
      case 'queued': return '排队中';
      case 'run': return '运行中';
      case 'done': return '已完成';
      case 'partial-failed': return '部分失败';
      case 'fail': return '失败';
      case 'stale': return '待重跑';
      default: return '';
    }
  }

  /**
   * 卡片分辨率/比例标注文案：有真实像素（node.imageWidth/imageHeight）→ "1536×2048 · 3:4"；
   * 无真实像素回退 params resolution+aspectRatio → "2K · 3:4"；均无 → ''（不显示）。
   * 素材节点（无生成配方）与文本卡不显示。
   */
  private _sizeLabel(node: FlowNode): string {
    if (node.type === 'text-gen' || node.type === 'text-split' || flowState.isAssetNode(node)) return '';
    const w = typeof node.imageWidth === 'number' && node.imageWidth > 0 ? node.imageWidth : 0;
    const h = typeof node.imageHeight === 'number' && node.imageHeight > 0 ? node.imageHeight : 0;
    const p = (node.params || {}) as unknown as StyleTransferParams;
    const ratio = typeof p.aspectRatio === 'string' ? p.aspectRatio.trim() : '';
    const res = typeof p.resolution === 'string' ? p.resolution.trim() : '';
    if (w > 0 && h > 0) {
      return ratio && ratio !== 'Auto' ? `${w}×${h} · ${ratio}` : `${w}×${h}`;
    }
    const parts: string[] = [];
    if (res) parts.push(res.toUpperCase());
    if (ratio && ratio !== 'Auto') parts.push(ratio);
    return parts.join(' · ');
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

/** 大图信息栏数据（旧数据字段缺失 → 信息栏对应行显示 '—'，不报错不白屏） */
export interface ImageModalInfo {
  model?: string;
  createdAt?: number;
  aspectRatio?: string;
  resolution?: string;
  prompt?: string;
}

interface ImageModalNavigation {
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}

/** 当前图片弹窗请求号：切换图片或关闭后，较早的原图异步加载不得覆盖当前内容。 */
let imageModalRequest = 0;

/** 由节点合成大图信息栏数据：trace（实际生成档案）优先，params 兜底（旧节点无 trace） */
export function imageModalInfoFromNode(node: FlowNode): ImageModalInfo {
  const p = (node.params || {}) as unknown as StyleTransferParams;
  const t = node.trace;
  return {
    model: t?.model || p.model,
    createdAt: t?.createdAt,
    aspectRatio: t?.aspectRatio || p.aspectRatio,
    resolution: t?.resolution || p.resolution,
    prompt: t?.prompt || p.prompt,
  };
}

/**
 * 由节点打开图片信息弹窗：单图与多图共用同一查看体验；多图在弹窗内左右翻页，
 * 不改变画布卡片当前封面，避免“查看”行为意外修改画布状态。
 */
export function openNodeImageModal(nodeId: string, index?: number): void {
  const node = flowState.getNode(nodeId);
  if (!node || !node.imageUrl) return;
  const generated = Array.isArray(node.generatedImages) ? node.generatedImages.filter(item => !!item?.url) : [];
  const items = generated.length > 0
    ? generated
    : [{
        url: node.imageUrl,
        prompt: imageModalInfoFromNode(node).prompt || '',
        origin: node.imageOrigin,
        width: node.imageWidth,
        height: node.imageHeight,
      }];
  const current = Math.min(Math.max(0, index ?? node.activeGeneratedIndex ?? 0), items.length - 1);
  const item = items[current];
  const nodeInfo = imageModalInfoFromNode(node);
  const info: ImageModalInfo = { ...nodeInfo, prompt: item.prompt || nodeInfo.prompt };
  const navigation: ImageModalNavigation | undefined = items.length > 1
    ? {
        index: current,
        total: items.length,
        onPrev: () => openNodeImageModal(nodeId, Math.max(0, current - 1)),
        onNext: () => openNodeImageModal(nodeId, Math.min(items.length - 1, current + 1)),
      }
    : undefined;
  void openImageModal(item.url, item.origin, { width: item.width, height: item.height }, info, navigation);
}

/**
 * 大图查看（左右分栏：左信息栏 + 右大图；图片性能优化版）：
 * 先显示缩略图 src + loading（旧图 base64 直接显示）；
 * 有 origin.path → Backend.loadLocalImage 按需取原图（一次性，用完即弃不常驻）；
 * 成功替换为原图 data_url；失败/无 origin → 保持缩略图并 toast。
 * dims：调用方已知的原图真实像素（可选；信息栏「分辨率」优先展示，原图加载后用 naturalWidth/Height 权威覆盖）。
 * info：生成档案信息（可选；信息栏展示 模型/时间/比例/分辨率/提示词）。
 */
export async function openImageModal(
  src: string,
  origin?: { path?: string; url?: string } | null,
  dims?: { width?: number; height?: number },
  info?: ImageModalInfo,
  navigation?: ImageModalNavigation,
): Promise<void> {
  const modal = document.getElementById('img-modal') as HTMLElement | null;
  const img = document.getElementById('img-modal-img') as HTMLImageElement | null;
  const loading = document.getElementById('img-modal-loading') as HTMLElement | null;
  if (!modal || !img) return;
  const request = ++imageModalRequest;

  // 信息栏：渲染字段行（缺失字段 → '—'）；返回「分辨率」value 元素供原图加载后更新真实像素
  const resValueEl = renderModalInfo(info, dims);

  // 是否已加载原图（而非缩略图）：仅原图加载成功后才用 naturalWidth/Height 标注真实像素
  // （缩略图最长边 1024px，naturalWidth 是缩略图尺寸，不能当作真实像素）
  let showedOriginal = false;
  const refreshMeta = (): void => {
    if (showedOriginal && resValueEl) {
      const nw = img.naturalWidth;
      const nh = img.naturalHeight;
      if (nw > 0 && nh > 0) resValueEl.textContent = `${nw}×${nh}`;
    }
    // 未加载原图：保留 dims/info 初值（下方设置），不因缩略图 onload 覆盖
  };
  img.onload = () => {
    if (request === imageModalRequest) refreshMeta();
  };

  // 1. 先显示缩略图（几十 KB 秒开）+ loading
  img.src = src;
  modal.classList.add('show');
  modal.focus({ preventScroll: true });
  if (loading) loading.style.display = 'flex';

  const prevBtn = document.getElementById('img-modal-prev') as HTMLButtonElement | null;
  const nextBtn = document.getElementById('img-modal-next') as HTMLButtonElement | null;
  const countEl = document.getElementById('img-modal-count') as HTMLElement | null;
  const hasNavigation = !!navigation && navigation.total > 1;
  if (prevBtn) {
    prevBtn.style.display = hasNavigation ? 'flex' : 'none';
    prevBtn.disabled = !hasNavigation || navigation!.index <= 0;
    prevBtn.onclick = (e: MouseEvent) => { e.stopPropagation(); navigation?.onPrev(); };
  }
  if (nextBtn) {
    nextBtn.style.display = hasNavigation ? 'flex' : 'none';
    nextBtn.disabled = !hasNavigation || navigation!.index >= navigation!.total - 1;
    nextBtn.onclick = (e: MouseEvent) => { e.stopPropagation(); navigation?.onNext(); };
  }
  if (countEl) {
    countEl.textContent = hasNavigation ? `${navigation!.index + 1} / ${navigation!.total}` : '';
    countEl.style.display = hasNavigation ? 'block' : 'none';
  }

  const close = (): void => {
    imageModalRequest++;
    modal.classList.remove('show');
  };
  // 关闭：点背景（含右侧大图区）或右上 ×；信息栏内点击不关闭
  modal.onclick = (e: MouseEvent) => {
    const t = e.target as Element;
    if (t === modal || (t.closest('.img-modal-stage') && !t.closest('.img-modal-nav'))) close();
  };
  const closeBtn = document.getElementById('img-modal-close') as HTMLElement | null;
  if (closeBtn) {
    closeBtn.onclick = (e: MouseEvent) => {
      e.stopPropagation();
      close();
    };
  }
  modal.onkeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowLeft' && hasNavigation && navigation!.index > 0) { e.preventDefault(); navigation!.onPrev(); return; }
    if (e.key === 'ArrowRight' && hasNavigation && navigation!.index < navigation!.total - 1) { e.preventDefault(); navigation!.onNext(); }
  };

  // 2. 无原图引用（旧节点/旧历史 base64 直显）→ 直接完成（标注仅依赖 dims/info）
  const path = origin?.path;
  if (!path) {
    if (loading) loading.style.display = 'none';
    return;
  }

  // 3. 按需加载原图：桥接取原图 base64，一次性替换，失败回退缩略图
  try {
    const res = await Backend.loadLocalImage(path);
    if (request !== imageModalRequest) return;
    if (res.status === 'success' && res.data_url) {
      showedOriginal = true; // 先置位再换 src，onload 时用自然尺寸更新分辨率
      img.src = res.data_url;
    } else {
      showToast('原图加载失败，已显示缩略图', false);
    }
  } catch {
    if (request === imageModalRequest) showToast('原图加载失败，已显示缩略图', false);
  } finally {
    if (request === imageModalRequest && loading) loading.style.display = 'none';
  }
}

/** 渲染大图信息栏字段行（缺失 → '—'）；返回「分辨率」value 元素（原图加载后更新真实像素用） */
function renderModalInfo(info?: ImageModalInfo, dims?: { width?: number; height?: number }): HTMLElement | null {
  const fields = document.getElementById('img-modal-fields') as HTMLElement | null;
  if (!fields) return null;
  const data = info || {};
  const model = shortModel(data.model);
  const time = formatDateTime(data.createdAt);
  const ratio = (data.aspectRatio || '').trim();
  const ratioText = ratio && ratio !== 'Auto' ? ratio : '—';
  const w = dims && typeof dims.width === 'number' && dims.width > 0 ? dims.width : 0;
  const h = dims && typeof dims.height === 'number' && dims.height > 0 ? dims.height : 0;
  const resText = w > 0 && h > 0 ? `${w}×${h}` : ((data.resolution || '').trim() ? (data.resolution as string).trim().toUpperCase() : '—');
  const prompt = (data.prompt || '').trim();

  fields.innerHTML = `
    <div class="img-modal-field">
      <div class="img-modal-label">生成模型</div>
      <div class="img-modal-value">${escapeHtml(model || '—')}</div>
    </div>
    <div class="img-modal-field">
      <div class="img-modal-label">生成时间</div>
      <div class="img-modal-value">${escapeHtml(time || '—')}</div>
    </div>
    <div class="img-modal-field">
      <div class="img-modal-label">比例</div>
      <div class="img-modal-value">${escapeHtml(ratioText)}</div>
    </div>
    <div class="img-modal-field">
      <div class="img-modal-label">分辨率</div>
      <div class="img-modal-value" data-field="resolution">${escapeHtml(resText)}</div>
    </div>
    <div class="img-modal-field">
      <div class="img-modal-label">提示词</div>
      <div class="img-modal-value prompt">${escapeHtml(prompt || '—')}</div>
      ${prompt ? '<button class="img-modal-copy" type="button">复制提示词</button>' : ''}
    </div>`;

  const copyBtn = fields.querySelector('.img-modal-copy') as HTMLElement | null;
  copyBtn?.addEventListener('click', () => copyText(prompt));

  return fields.querySelector('[data-field="resolution"]') as HTMLElement | null;
}

/** 模型短名（"provider:key:model" → "model"；与 history-drawer 同思路，本地实现避免新增循环依赖） */
function shortModel(modelId?: string): string {
  if (!modelId) return '';
  return modelId.split(':').pop() || modelId || '';
}

/** 完整时间格式：YYYY-MM-DD HH:mm（非法/缺失 → ''） */
function formatDateTime(ts?: number): string {
  if (!ts || !(ts > 0)) return '';
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 复制文本（Clipboard API 优先，pywebview 旧内核/非安全上下文无 API 时兜底 execCommand；校验返回值，成功 toast） */
function copyText(text: string): void {
  const value = (text || '').trim();
  if (!value) { showToast('无提示词可复制', false); return; }
  const done = (): void => showToast('提示词已复制');
  const fail = (): void => showToast('复制失败', false);
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    void navigator.clipboard.writeText(value).then(done, fail);
    return;
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let copied = false;
    try {
      copied = document.execCommand('copy'); // WebView2 仍支持；返回 false 表示复制被拒
    } finally {
      // 无论如何都从 DOM 移除，避免残留隐藏 textarea
      document.body.removeChild(ta);
    }
    if (copied) done();
    else fail();
  } catch {
    fail();
  }
}

export const cardView = new CardView();
