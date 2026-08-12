// src/v1/canvas/canvas-view.ts
// 画布容器：缩放/平移/点阵背景/坐标换算（改造自 src/core/canvas.ts，去 Minimap 依赖）

import { flowState } from '../state/flow-state';
import { cardView } from './card-view';
import { linkView } from './link-view';

/** 卡片固定宽度（原型 CARD_W=260） */
export const CARD_W = 260;

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
      if (target.closest('.cmd-input') || target.closest('.project-name') || target.closest('.settings-input')) {
        return; // 输入框内允许原生滚动
      }
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
      this.applyView();
      cardView.renderAll();
      linkView.renderAll();
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
