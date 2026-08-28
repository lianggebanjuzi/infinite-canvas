// src/v1/ui/outpaint-panel.ts
// 扩图调节弹层（画布内“扩图”节点的「调整扩图」入口）：
//   选目标比例 → 原图拖放/缩放 → 将配置持久化到节点 → canvas 合成白底底图
//   → runEngine.runOutpaint（banana 系列模型带图补全 → 新建结果节点连右侧）
// 不暴露分辨率选项（模型自动出图，最高 4K）；不暴露模型选择（自动解析 gemini/nano-banana/seedream 系 drawing 模型）。
// 弹层挂 .overlay 类：interactions.ts 已把 .overlay 排除在画布交互外，天然防冲突；
// 弹层内 pointer 事件独立处理，不侵入画布。

import { flowState } from '../state/flow-state';
import { runEngine } from '../engine/run-engine';
import { showToast } from './toast';
import { resolveOutpaintModel } from '../api';
import { RATIO_CANVAS, OUTPAINT_PROMPT_PREFIX, composeOutpaintDataUrl, defaultOutpaintPlacement, loadOutpaintImage } from '../engine/outpaint-util';
import { flowHistory } from '../state/history';

/** 弹层编辑态（确认时写回扩图节点；打开时从节点配置恢复） */
interface OutpaintPanelState {
  nodeId: string;
  img: HTMLImageElement | null;
  ratio: string;   // 目标比例 '1:1' | '3:4' | '4:3' | '16:9' | '9:16'
  posX: number;    // 原图中心相对画布中心的偏移（画布像素，可负）
  posY: number;
  scale: number;   // 缩放倍率（1 = 原图自然尺寸）
  model: string;   // 自动解析出的扩图模型（"provider:model"）
  ready: boolean;  // 图片加载完成且模型可用
}

class OutpaintPanel {
  private overlay: HTMLElement | null = null;
  private stage: HTMLElement | null = null;
  private imgEl: HTMLImageElement | null = null;
  private zoomInput: HTMLInputElement | null = null;
  private confirmBtn: HTMLButtonElement | null = null;
  private modelLabel: HTMLElement | null = null;
  private descInput: HTMLTextAreaElement | null = null;
  private ratioWrap: HTMLElement | null = null;
  private canvasSummary: HTMLElement | null = null;
  private positionGrid: HTMLElement | null = null;
  private zoomValue: HTMLOutputElement | null = null;

  private state: OutpaintPanelState = {
    nodeId: '', img: null, ratio: '1:1', posX: 0, posY: 0, scale: 1, model: '', ready: false,
  };
  private _dragging = false;
  private _dragStart = { x: 0, y: 0, posX: 0, posY: 0 };

  init(): void {
    this.overlay = document.getElementById('outpaint-overlay');
    if (!this.overlay) return;
    this.stage = document.getElementById('outpaint-stage');
    this.imgEl = document.getElementById('outpaint-img') as HTMLImageElement | null;
    this.zoomInput = document.getElementById('outpaint-zoom') as HTMLInputElement | null;
    this.confirmBtn = document.getElementById('outpaint-confirm') as HTMLButtonElement | null;
    this.modelLabel = document.getElementById('outpaint-model-label');
    this.descInput = document.getElementById('outpaint-desc') as HTMLTextAreaElement | null;
    this.ratioWrap = document.getElementById('outpaint-ratios');
    this.canvasSummary = document.getElementById('outpaint-canvas-summary');
    this.positionGrid = document.getElementById('outpaint-position-grid');
    this.zoomValue = document.getElementById('outpaint-zoom-value') as HTMLOutputElement | null;

    document.getElementById('outpaint-close')?.addEventListener('click', () => this.close());
    document.getElementById('outpaint-cancel')?.addEventListener('click', () => this.close());
    this.overlay.addEventListener('click', (e: MouseEvent) => {
      if (e.target === this.overlay) this.close();
    });
    this.confirmBtn?.addEventListener('click', () => void this._confirm());

    // 比例 chips
    this.ratioWrap?.querySelectorAll('.outpaint-ratio').forEach(btn => {
      btn.addEventListener('click', () => {
        const ratio = ((btn as HTMLElement).dataset.ratio) || '1:1';
        this._setRatio(ratio);
      });
    });
    this.positionGrid?.querySelectorAll<HTMLButtonElement>('[data-position]').forEach(btn => {
      btn.addEventListener('click', () => this._setPosition(btn.dataset.position || 'center'));
    });

    // 原图拖放（pointer 事件独立处理，不侵入画布；stage 在 .overlay 内，画布交互已排除）
    this.stage?.addEventListener('pointerdown', (e: PointerEvent) => this._onPointerDown(e));
    window.addEventListener('pointermove', (e: PointerEvent) => this._onPointerMove(e));
    window.addEventListener('pointerup', () => this._onPointerUp());
    this.stage?.addEventListener('wheel', (e: WheelEvent) => this._onWheel(e), { passive: false });

    // 缩放滑块
    this.zoomInput?.addEventListener('input', () => {
      const v = Number(this.zoomInput?.value || 1);
      if (v > 0) {
        this.state.scale = v;
        this._constrainPlacement();
        this._syncPositionButtons(this._currentPositionPreset());
        this._render();
      }
    });
  }

  /** 打开扩图调节弹层：异步加载已连接源图 + 自动解析模型 */
  async open(nodeId: string): Promise<void> {
    if (!this.overlay) return;
    const node = flowState.getNode(nodeId);
    if (!node) return;
    const src = node.imageUrl || flowState.getReferenceImages(nodeId)[0] || '';
    if (!src) { showToast('该节点还没有可用图片', false); return; }

    const p = node.params as unknown as StyleTransferParams;
    const ratio = RATIO_CANVAS[p.aspectRatio] ? p.aspectRatio : '1:1';
    const placement = p.outpaintPlacement;
    this.state = {
      nodeId, img: null, ratio,
      posX: placement?.posX || 0, posY: placement?.posY || 0, scale: placement?.scale || 1,
      model: '', ready: false,
    };
    this.overlay.classList.add('show');
    this._setConfirmDisabled(true);
    if (this.modelLabel) this.modelLabel.textContent = '正在解析扩图模型…';
    if (this.descInput) this.descInput.value = p.prompt || '';
    if (this.zoomInput) this.zoomInput.value = String(this.state.scale);
    if (this.imgEl) { this.imgEl.src = ''; this.imgEl.style.display = 'none'; } // 清空旧图，避免复用上次 src

    // 并行：加载原图 + 解析模型（解析顺序：节点当前 model（属 banana 系）→ 第一个可用扩图模型）
    const [img, model] = await Promise.all([
      loadOutpaintImage(src),
      resolveOutpaintModel(node),
    ]);

    // 打开期间可能已被关闭（Escape/点遮罩）
    if (!this.overlay.classList.contains('show')) return;

    if (!img) {
      this._setConfirmDisabled(true);
      if (this.modelLabel) this.modelLabel.textContent = '图片加载失败，无法扩图';
      showToast('图片加载失败', false);
      return;
    }
    this.state.img = img;
    this.state.model = model;
    if (!model) {
      this._setConfirmDisabled(true);
      if (this.modelLabel) this.modelLabel.textContent = '未找到可用的 Nano Banana 系列模型，请先在设置中配置';
      showToast('请先在设置中配置 Nano Banana 系列模型', false);
      return;
    }
    // 创建扩图步骤后即使用户先关闭弹层，已解析的可用模型也要留在节点上：
    // 这样它仍是一个可直接运行、可保存和可重跑的完整步骤，而不是空壳配置。
    const current = flowState.getNode(nodeId);
    if (current && (current.params as unknown as StyleTransferParams).mode === 'outpaint'
      && (current.params as unknown as StyleTransferParams).model !== model) {
      flowState.updateNodeParams(nodeId, { model });
    }
    this.state.ready = true;
    this._setConfirmDisabled(false);
    if (this.modelLabel) this.modelLabel.textContent = `扩图模型：${this._shortModelName(model)}`;
    if (this.imgEl) this.imgEl.src = img.src; // 显示层绑定本次原图（后续只改 style，不重复设 src）

    // 初始布局：原图居中，高度占画布 80%（等比缩放，不超宽），可拖动可缩放微调。
    // 缩放范围按当前原图和目标画布动态计算；不能再用固定的 300% 上限，
    // 否则较小原图会无法适配画布，视觉上像被推到了角落。
    const defaultPlacement = defaultOutpaintPlacement(img, this.state.ratio);
    this.state.scale = placement?.scale || defaultPlacement.scale;
    this.state.posX = placement?.posX || 0;
    this.state.posY = placement?.posY || 0;
    this._constrainPlacement();
    this._render();
    this._syncRatioChips();
    this._syncPositionButtons(this._currentPositionPreset());
  }

  close(): void {
    this.overlay?.classList.remove('show');
    this.state = { nodeId: '', img: null, ratio: '1:1', posX: 0, posY: 0, scale: 1, model: '', ready: false };
    this._dragging = false;
  }

  // ───────────────────────── 交互：拖放 / 缩放 ─────────────────────────

  private _onPointerDown(e: PointerEvent): void {
    if (!this.state.img || !this.stage) return;
    const p = this._toCanvasCoords(e);
    if (p === null) return;
    this._dragging = true;
    this._dragStart = { x: p.x, y: p.y, posX: this.state.posX, posY: this.state.posY };
    this.stage.setPointerCapture?.(e.pointerId);
  }

  private _onPointerMove(e: PointerEvent): void {
    if (!this._dragging || !this.stage) return;
    const p = this._toCanvasCoords(e);
    if (p === null) return;
    this.state.posX = this._dragStart.posX + (p.x - this._dragStart.x);
    this.state.posY = this._dragStart.posY + (p.y - this._dragStart.y);
    this._constrainPlacement();
    this._syncPositionButtons(this._currentPositionPreset());
    this._render();
  }

  private _onPointerUp(): void {
    this._dragging = false;
  }

  private _onWheel(e: WheelEvent): void {
    if (!this.state.img || !this.stage) return;
    e.preventDefault();
    const p = this._toCanvasCoords(e);
    if (p === null) return;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    this._zoomAt(p.x, p.y, factor);
  }

  /** 以画布内某点为中心缩放（保持该点对应画布内容不动） */
  private _zoomAt(cx: number, cy: number, factor: number): void {
    const { min, max } = this._scaleBounds();
    const next = Math.min(max, Math.max(min, this.state.scale * factor));
    const k = next / this.state.scale;
    const { w: cw, h: ch } = RATIO_CANVAS[this.state.ratio] || RATIO_CANVAS['1:1'];
    // 缩放中心相对画布中心的偏移 (cxRel, cyRel)；原图中心偏移 pos 按 k 等比映射，保持缩放中心不动
    const cxRel = cx - cw / 2;
    const cyRel = cy - ch / 2;
    this.state.posX = cxRel * (1 - k) + this.state.posX * k;
    this.state.posY = cyRel * (1 - k) + this.state.posY * k;
    this.state.scale = next;
    this._constrainPlacement();
    if (this.zoomInput) this.zoomInput.value = String(Number(next.toFixed(2)));
    this._syncPositionButtons(this._currentPositionPreset());
    this._render();
  }

  // ───────────────────────── 比例切换 ─────────────────────────

  private _setRatio(ratio: string): void {
    if (this.state.ratio === ratio) return;
    this.state.ratio = ratio;
    this._constrainPlacement();
    // 保持相对中心位置与缩放（像素偏移不变，视觉上原图相对画布中心位置不变）
    this._syncRatioChips();
    this._syncPositionButtons(this._currentPositionPreset());
    this._render();
  }

  private _syncRatioChips(): void {
    this.ratioWrap?.querySelectorAll('.outpaint-ratio').forEach(btn => {
      const el = btn as HTMLElement;
      el.classList.toggle('active', el.dataset.ratio === this.state.ratio);
    });
  }

  /** 用九宫格快速定位原图，仍可通过拖动进行像素级微调。 */
  private _setPosition(position: string): void {
    const { w, h } = RATIO_CANVAS[this.state.ratio] || RATIO_CANVAS['1:1'];
    const [vertical, horizontal] = position.includes('-')
      ? position.split('-')
      : (position === 'left' || position === 'right' ? ['center', position] : [position, 'center']);
    const x = horizontal === 'left' ? -1 : horizontal === 'right' ? 1 : 0;
    const y = vertical === 'top' ? -1 : vertical === 'bottom' ? 1 : 0;
    const iw = this.state.img ? this.state.img.naturalWidth * this.state.scale : 0;
    const ih = this.state.img ? this.state.img.naturalHeight * this.state.scale : 0;
    // 位置按钮贴到对应边缘，但原图始终完整留在目标画布内。
    this.state.posX = x * Math.max(0, (w - iw) / 2);
    this.state.posY = y * Math.max(0, (h - ih) / 2);
    this._constrainPlacement();
    this._syncPositionButtons(position);
    this._render();
  }

  private _syncPositionButtons(active = ''): void {
    this.positionGrid?.querySelectorAll<HTMLElement>('[data-position]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.position === active);
    });
  }

  /** 根据当前偏移推断九宫格状态；手动拖到中间区域时仍明确显示「居中」。 */
  private _currentPositionPreset(): string {
    const img = this.state.img;
    if (!img) return '';
    const { w, h } = RATIO_CANVAS[this.state.ratio] || RATIO_CANVAS['1:1'];
    const maxX = Math.max(0, (w - img.naturalWidth * this.state.scale) / 2);
    const maxY = Math.max(0, (h - img.naturalHeight * this.state.scale) / 2);
    const horizontal = maxX > 0 && Math.abs(this.state.posX) >= maxX * 0.8
      ? (this.state.posX < 0 ? 'left' : 'right') : 'center';
    const vertical = maxY > 0 && Math.abs(this.state.posY) >= maxY * 0.8
      ? (this.state.posY < 0 ? 'top' : 'bottom') : 'center';
    if (vertical === 'center') return horizontal;
    if (horizontal === 'center') return vertical;
    return `${vertical}-${horizontal}`;
  }

  /** 当前比例下允许的缩放范围：以原图「占满」画布为上限，默认可缩至 10%。 */
  private _scaleBounds(): { min: number; max: number } {
    const img = this.state.img;
    if (!img || img.naturalWidth <= 0 || img.naturalHeight <= 0) return { min: 0.01, max: 1 };
    const { w, h } = RATIO_CANVAS[this.state.ratio] || RATIO_CANVAS['1:1'];
    const fitMax = Math.min(w / img.naturalWidth, h / img.naturalHeight);
    const max = Math.max(0.01, fitMax);
    return { min: Math.max(0.01, max * 0.1), max };
  }

  /**
   * 约束原图完全落在待扩图画布内。此前拖拽与缩放没有边界，确认后 canvas
   * 会把越界部分裁掉，导致预览与实际扩图范围不一致。
   */
  private _constrainPlacement(): void {
    const img = this.state.img;
    if (!img || img.naturalWidth <= 0 || img.naturalHeight <= 0) return;
    const { min, max } = this._scaleBounds();
    this.state.scale = Math.min(max, Math.max(min, this.state.scale));
    const { w, h } = RATIO_CANVAS[this.state.ratio] || RATIO_CANVAS['1:1'];
    const iw = img.naturalWidth * this.state.scale;
    const ih = img.naturalHeight * this.state.scale;
    const maxX = Math.max(0, (w - iw) / 2);
    const maxY = Math.max(0, (h - ih) / 2);
    this.state.posX = Math.min(maxX, Math.max(-maxX, this.state.posX));
    this.state.posY = Math.min(maxY, Math.max(-maxY, this.state.posY));
    if (this.zoomInput) {
      this.zoomInput.min = String(Number(min.toFixed(2)));
      this.zoomInput.max = String(Number(max.toFixed(2)));
      this.zoomInput.value = String(Number(this.state.scale.toFixed(2)));
    }
  }

  // ───────────────────────── 渲染（显示层：白底 stage + 原图 DOM，交互流畅；确认时才画 canvas 合成） ─────────────────────────

  private _render(): void {
    if (!this.stage || !this.imgEl || !this.state.img) return;
    this._constrainPlacement();
    const { w: cw, h: ch } = RATIO_CANVAS[this.state.ratio] || RATIO_CANVAS['1:1'];
    const parentW = this.stage.parentElement?.clientWidth || 560;
    const stageW = Math.min(560, Math.max(280, parentW - 40));
    const stageH = Math.round((stageW * ch) / cw);
    this.stage.style.width = stageW + 'px';
    this.stage.style.height = stageH + 'px';
    this.stage.classList.add('has-img');

    const k = stageW / cw; // 显示像素 / 画布像素（stage 等比显示）
    const iw = this.state.img.naturalWidth * this.state.scale * k;
    const ih = this.state.img.naturalHeight * this.state.scale * k;
    const left = stageW / 2 + this.state.posX * k - iw / 2;
    const top = stageH / 2 + this.state.posY * k - ih / 2;

    this.imgEl.style.display = 'block';
    this.imgEl.style.width = iw + 'px';
    this.imgEl.style.height = ih + 'px';
    this.imgEl.style.left = left + 'px';
    this.imgEl.style.top = top + 'px';
    if (this.canvasSummary) this.canvasSummary.textContent = `${cw} × ${ch} px`;
    // 展示原图相对目标画布的占比，而不是自然尺寸倍率；用户能直接判断还会扩出多少空间。
    if (this.zoomValue) {
      const coverage = Math.max(iw / cw, ih / ch);
      this.zoomValue.value = `${Math.round(coverage * 100)}%`;
    }
  }

  /** 屏幕坐标 → 画布像素坐标（未命中 stage 返回 null） */
  private _toCanvasCoords(e: MouseEvent | PointerEvent | WheelEvent): { x: number; y: number } | null {
    if (!this.stage) return null;
    const rect = this.stage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const { w: cw, h: ch } = RATIO_CANVAS[this.state.ratio] || RATIO_CANVAS['1:1'];
    return {
      x: ((e.clientX - rect.left) / rect.width) * cw,
      y: ((e.clientY - rect.top) / rect.height) * ch,
    };
  }

  // ───────────────────────── 合成与提交 ─────────────────────────

  /** canvas 合成白底底图（PNG dataURL；长边≤4096；白底不透明） */
  private _composeDataUrl(): string | null {
    const img = this.state.img;
    if (!img) return null;
    return composeOutpaintDataUrl(img, this.state.ratio, this.state);
  }

  private async _confirm(): Promise<void> {
    if (!this.state.ready || !this.state.img || !this.state.model) return;
    const dataUrl = this._composeDataUrl();
    if (!dataUrl) { showToast('图片合成失败，无法扩图', false); return; }
    const userDesc = (this.descInput?.value || '').trim();
    const prompt = userDesc ? `${OUTPAINT_PROMPT_PREFIX}。${userDesc}` : OUTPAINT_PROMPT_PREFIX;
    // 先快照提交参数再关闭（close() 会重置瞬时 state）
    const nodeId = this.state.nodeId;
    const ratio = this.state.ratio;
    const model = this.state.model;
    const placement = { posX: this.state.posX, posY: this.state.posY, scale: this.state.scale };
    // 操作结果写回扩图节点，使提示词、比例和摆放在项目保存后仍可编辑和重跑。
    flowHistory.record();
    flowState.updateNodeParams(nodeId, { mode: 'outpaint', prompt: userDesc, aspectRatio: ratio, model, resolution: '4k', count: 1, outpaintPlacement: placement });
    this.close();
    await runEngine.runOutpaint(nodeId, {
      prompt,
      referenceImages: [dataUrl],
      aspectRatio: ratio,
      model,
      resolution: '4k',
    });
  }

  // ───────────────────────── 工具 ─────────────────────────

  /** 完整模型 id → 展示用简称（去 provider 前缀） */
  private _shortModelName(modelId: string): string {
    return modelId.split(':').pop() || modelId;
  }

  private _setConfirmDisabled(disabled: boolean): void {
    if (this.confirmBtn) this.confirmBtn.disabled = disabled;
  }
}

export const outpaintPanel = new OutpaintPanel();
