// src/v1/canvas/canvas-view.ts
// 画布容器：缩放/平移/点阵背景/坐标换算（改造自 src/core/canvas.ts，去 Minimap 依赖）

import { flowState } from '../state/flow-state';
import { selection } from '../state/selection';
import { cardView } from './card-view';
import { linkView } from './link-view';
import { showToast } from '../ui/toast';

/** 卡片固定宽度（原型 CARD_W=260） */
export const CARD_W = 260;
/** 超长图片在画布中的最大卡片高度；完整原图仍可通过查看大图打开。 */
export const IMAGE_CARD_MAX_H = 520;
/** 文本卡最大高度（A-2：长文本不撑高画布，内容区内滚；用户拍板保持 520 上限，不采纳 PRD 180） */
export const TEXT_CARD_MAX_H = 520;
/** 批次卡/多图卡最大高度（A-2：多图不撑高画布；用户拍板保持 520 上限，不采纳 PRD 260） */
export const BATCH_CARD_MAX_H = 520;

/** 图片卡统一高度：保持原比例，但限制超长图，避免单个素材撑满画布。 */
export function imageCardHeight(ratio: number, width = CARD_W): number {
  const safeRatio = ratio > 0 ? ratio : 4 / 3;
  return Math.min(IMAGE_CARD_MAX_H, Math.round(width / safeRatio));
}

/** 点阵间距（px）：与 app.css .canvas-wrap background-size 同步，缩放时按 scale 联动 */
const DOT_SPACING = 28;

class CanvasView {
  wrap: HTMLElement | null = null;
  canvasEl: HTMLElement | null = null;
  private _panning = false;
  private _panStart: { mx: number; my: number; vx: number; vy: number } | null = null;

  /** 实时读取 flowState.canvas（避免 replaceAll 后引用过期） */
  get view(): FlowCanvasState { return flowState.canvas; }

  init(): void {
    this.wrap = document.getElementById('canvas-wrap');
    this.canvasEl = document.getElementById('canvas');
    if (!this.wrap || !this.canvasEl) return;

    linkView.init(this.canvasEl);
    this.applyView();
    this._bindEvents();
    document.getElementById('btn-fit-canvas')?.addEventListener('click', () => this.fitAll());
    document.getElementById('btn-focus-selected')?.addEventListener('click', () => this.focusSelected());

    // 状态变更 → 重渲染
    flowState.subscribe(() => {
      this.applyView();
      cardView.renderAll();
      linkView.renderAll();
    });
  }

  applyView(): void {
    if (!this.canvasEl) return;
    const { panX, panY, scale } = this.view;
    this.canvasEl.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    // 点阵背景在 wrap（视口，无 transform）上按屏幕空间平铺：position=pan 使网格原点与世界原点（经 transform 后位于 pan）对齐，网格随世界移动；
    // size 乘 scale → 密度随缩放联动；视口裁剪 → 永不露白
    if (this.wrap) {
      this.wrap.style.backgroundPosition = `${panX}px ${panY}px`;
      this.wrap.style.backgroundSize = `${DOT_SPACING * scale}px ${DOT_SPACING * scale}px`;
    }
  }

  /** 屏幕坐标 → 世界坐标（画布坐标系） */
  toWorldCoords(screenX: number, screenY: number): { x: number; y: number } {
    const rect = this.wrap?.getBoundingClientRect() ?? { left: 0, top: 0 };
    const { panX, panY, scale } = this.view;
    return {
      x: (screenX - rect.left - panX) / scale,
      y: (screenY - rect.top - panY) / scale,
    };
  }

  /** 世界坐标 → wrap 内屏幕坐标（用于悬浮面板定位） */
  worldToWrap(x: number, y: number): { x: number; y: number } {
    const { panX, panY, scale } = this.view;
    return { x: panX + x * scale, y: panY + y * scale };
  }

  private _bindEvents(): void {
    if (!this.wrap) return;

    // 滚轮缩放（以鼠标为锚点）
    this.wrap.addEventListener('wheel', (e: WheelEvent) => {
      const target = e.target as Element;
      // 卡片内容的阅读/编辑优先于画布缩放：文本、拆分槽位、结果栏及所有可滚动面板
      // 都保留原生滚动。只有真正落在画布空白处时才缩放。
      if (target.closest('.pcard-text, .pcard-text-editor, .split-body, .split-input, .property-editor, .task-panel, .result-viewer, .cmd-input, .project-name, .settings-input, textarea, input')) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.92 : 1.08;
      const ns = Math.min(2, Math.max(0.3, this.view.scale * delta));
      const rect = this.wrap!.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const { panX, panY, scale } = this.view;
      this.view.panX = mx - (mx - panX) * (ns / scale);
      this.view.panY = my - (my - panY) * (ns / scale);
      this.view.scale = ns;
      // 缩放只改 #canvas 的 transform，卡片/连线均用世界坐标自动跟随，无需重建 DOM
      this.applyView();
    }, { passive: false });

    // 平移 mousedown 语义统一在 interactions.ts 处理（中键平移），此处只挂全局 move/up
    window.addEventListener('mousemove', (e: MouseEvent) => this._movePan(e));
    window.addEventListener('mouseup', () => this._endPan());
  }

  /** 供 interactions 调用：中键拖动画布平移 */
  startPan(clientX: number, clientY: number): void {
    this._startPan(clientX, clientY);
  }

  movePan(clientX: number, clientY: number): void {
    this._movePan({ clientX, clientY } as MouseEvent);
  }

  endPan(): void {
    this._endPan();
  }

  /** 将所有节点（含卡片实际高度）缩放并居中到可视范围。 */
  fitAll(): void {
    if (!this.wrap || flowState.nodes.length === 0) {
      showToast('画布中还没有节点', false);
      return;
    }
    const bounds = flowState.nodes.reduce((acc, node) => {
      const width = node.w ?? CARD_W;
      const height = node.h ?? cardView.cardHeight(node);
      acc.minX = Math.min(acc.minX, node.x);
      acc.minY = Math.min(acc.minY, node.y);
      acc.maxX = Math.max(acc.maxX, node.x + width);
      acc.maxY = Math.max(acc.maxY, node.y + height);
      return acc;
    }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
    const rect = this.wrap.getBoundingClientRect();
    const padding = 96;
    const width = Math.max(1, bounds.maxX - bounds.minX);
    const height = Math.max(1, bounds.maxY - bounds.minY);
    const scale = Math.min(1.35, Math.max(0.3, Math.min((rect.width - padding * 2) / width, (rect.height - padding * 2) / height)));
    this._centerWorldPoint((bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, scale);
  }

  /** 将单选节点置于画布中心，保留当前缩放级别。 */
  focusSelected(): void {
    const node = selection.single();
    if (!node) {
      showToast('请先选中一个节点', false);
      return;
    }
    const width = node.w ?? CARD_W;
    const height = node.h ?? cardView.cardHeight(node);
    this._centerWorldPoint(node.x + width / 2, node.y + height / 2, this.view.scale);
  }

  private _centerWorldPoint(x: number, y: number, scale: number): void {
    if (!this.wrap) return;
    const rect = this.wrap.getBoundingClientRect();
    this.view.scale = scale;
    this.view.panX = rect.width / 2 - x * scale;
    this.view.panY = rect.height / 2 - y * scale;
    flowState.updatedAt = Date.now();
    flowState.dirty = true;
    flowState.notify();
  }

  private _startPan(mx: number, my: number): void {
    this._panning = true;
    this._panStart = { mx, my, vx: this.view.panX, vy: this.view.panY };
    if (this.wrap) this.wrap.style.cursor = 'grabbing';
  }

  private _movePan(e: MouseEvent): void {
    if (!this._panning || !this._panStart) return;
    this.view.panX = this._panStart.vx + (e.clientX - this._panStart.mx);
    this.view.panY = this._panStart.vy + (e.clientY - this._panStart.my);
    this.applyView();
  }

  private _endPan(): void {
    if (!this._panning) return;
    this._panning = false;
    this._panStart = null;
    if (this.wrap) this.wrap.style.cursor = '';
    flowState.updatedAt = Date.now();
    flowState.dirty = true;
    flowState.notify();
  }
}

export const canvasView = new CanvasView();
