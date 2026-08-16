// src/v1/ui/outpaint-panel.ts
// 扩图弹层（image-gen 悬浮「扩图」入口）：
//   选目标比例 → 原图拖放/缩放 → canvas 合成白底底图（PNG dataURL，长边≤4096）
//   → runEngine.runOutpaint（banana 系列模型带图补全 → 新建 image-gen 产出节点连右侧）
// 不暴露分辨率选项（模型自动出图，最高 4K）；不暴露模型选择（自动解析 gemini/nano-banana/seedream 系 drawing 模型）。
// 弹层挂 .overlay 类：interactions.ts 已把 .overlay 排除在画布交互外，天然防冲突；
// 弹层内 pointer 事件独立处理，不侵入画布。

import { flowState } from '../state/flow-state';
import { runEngine } from '../engine/run-engine';
import { showToast } from './toast';
import { resolveOutpaintModel } from '../api';

/** 目标比例 → 合成画布像素尺寸（长边 ≤4096；白底不透明） */
const RATIO_CANVAS: Record<string, { w: number; h: number }> = {
  '1:1': { w: 4096, h: 4096 },
  '3:4': { w: 3072, h: 4096 },
  '4:3': { w: 4096, h: 3072 },
  '16:9': { w: 4096, h: 2304 },
  '9:16': { w: 2304, h: 4096 },
};

/** 固定补全提示前缀（拼在可选用户描述前） */
const OUTPAINT_PROMPT_PREFIX = '白色区域是待补全区域，扩展为协调背景，保留原图内容与比例';

/** 缩放范围（倍率，1 = 原图自然尺寸） */
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 3;

/** 弹层瞬时状态（不持久化；打开时重置） */
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
        this._render();
      }
    });
  }

  /** 打开扩图弹层（action-bar expand 入口）：异步加载原图 + 自动解析模型 */
  async open(nodeId: string): Promise<void> {
    if (!this.overlay) return;
    const node = flowState.getNode(nodeId);
    if (!node) return;
    const src = node.imageUrl || flowState.getReferenceImages(nodeId)[0] || '';
    if (!src) { showToast('该节点还没有可用图片', false); return; }

    this.state = { nodeId, img: null, ratio: '1:1', posX: 0, posY: 0, scale: 1, model: '', ready: false };
    this.overlay.classList.add('show');
    this._setConfirmDisabled(true);
    if (this.modelLabel) this.modelLabel.textContent = '正在解析扩图模型…';
    if (this.descInput) this.descInput.value = '';
    if (this.zoomInput) this.zoomInput.value = '1';
    if (this.imgEl) { this.imgEl.src = ''; this.imgEl.style.display = 'none'; } // 清空旧图，避免复用上次 src

    // 并行：加载原图 + 解析模型（解析顺序：节点当前 model（属 banana 系）→ 第一个可用扩图模型）
    const [img, model] = await Promise.all([
      this._loadImage(src),
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
    this.state.ready = true;
    this._setConfirmDisabled(false);
    if (this.modelLabel) this.modelLabel.textContent = `扩图模型：${this._shortModelName(model)}`;
    if (this.imgEl) this.imgEl.src = img.src; // 显示层绑定本次原图（后续只改 style，不重复设 src）

    // 初始布局：原图居中，高度占画布 80%（等比缩放，不超宽），可拖动可缩放微调。
    // scale 与滑块同步：clamp 到 [ZOOM_MIN, ZOOM_MAX]（fitScale 可能超滑块上限，
    // 如 1024² 源图在 1:1 下 fitScale≈3.2 > 3），保证滑块显示值与实际缩放一致、首次触摸滑块/滚轮不跳变。
    const { w: cw, h: ch } = RATIO_CANVAS[this.state.ratio] || RATIO_CANVAS['1:1'];
    const fitScale = Math.min((ch * 0.8) / img.naturalHeight, cw / img.naturalWidth);
    const initScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, fitScale));
    this.state.scale = initScale;
    this.state.posX = 0;
    this.state.posY = 0;
    if (this.zoomInput) this.zoomInput.value = String(Number(initScale.toFixed(2)));
    this._render();
    this._syncRatioChips();
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
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.state.scale * factor));
    const k = next / this.state.scale;
    const { w: cw, h: ch } = RATIO_CANVAS[this.state.ratio] || RATIO_CANVAS['1:1'];
    // 缩放中心相对画布中心的偏移 (cxRel, cyRel)；原图中心偏移 pos 按 k 等比映射，保持缩放中心不动
    const cxRel = cx - cw / 2;
    const cyRel = cy - ch / 2;
    this.state.posX = cxRel * (1 - k) + this.state.posX * k;
    this.state.posY = cyRel * (1 - k) + this.state.posY * k;
    this.state.scale = next;
    if (this.zoomInput) this.zoomInput.value = String(Number(next.toFixed(2)));
    this._render();
  }

  // ───────────────────────── 比例切换 ─────────────────────────

  private _setRatio(ratio: string): void {
    if (this.state.ratio === ratio) return;
    this.state.ratio = ratio;
    // 保持相对中心位置与缩放（像素偏移不变，视觉上原图相对画布中心位置不变）
    this._syncRatioChips();
    this._render();
  }

  private _syncRatioChips(): void {
    this.ratioWrap?.querySelectorAll('.outpaint-ratio').forEach(btn => {
      const el = btn as HTMLElement;
      el.classList.toggle('active', el.dataset.ratio === this.state.ratio);
    });
  }

  // ───────────────────────── 渲染（显示层：白底 stage + 原图 DOM，交互流畅；确认时才画 canvas 合成） ─────────────────────────

  private _render(): void {
    if (!this.stage || !this.imgEl || !this.state.img) return;
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
    const { w: cw, h: ch } = RATIO_CANVAS[this.state.ratio] || RATIO_CANVAS['1:1'];
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, cw, ch);
    const dw = img.naturalWidth * this.state.scale;
    const dh = img.naturalHeight * this.state.scale;
    const dx = cw / 2 + this.state.posX - dw / 2;
    const dy = ch / 2 + this.state.posY - dh / 2;
    ctx.drawImage(img, dx, dy, dw, dh);
    try {
      return canvas.toDataURL('image/png');
    } catch {
      return null; // 画布被跨域污染时返回 null（调用方 toast）
    }
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

  /** 加载图片（带 15s 超时保护；返回 null 表示失败） */
  private _loadImage(src: string): Promise<HTMLImageElement | null> {
    return new Promise(resolve => {
      const img = new Image();
      let settled = false;
      const timer = setTimeout(() => finish(null), 15000);
      const finish = (result: HTMLImageElement | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        img.onload = null;
        img.onerror = null;
        resolve(result);
      };
      img.onload = () => finish(img);
      img.onerror = () => finish(null);
      img.src = src;
    });
  }

  /** 完整模型 id → 展示用简称（去 provider 前缀） */
  private _shortModelName(modelId: string): string {
    return modelId.split(':').pop() || modelId;
  }

  private _setConfirmDisabled(disabled: boolean): void {
    if (this.confirmBtn) this.confirmBtn.disabled = disabled;
  }
}

export const outpaintPanel = new OutpaintPanel();
