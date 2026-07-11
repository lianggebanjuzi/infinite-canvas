// src/cards/features/drawing-board/view-controller.ts
// 视图控制器：缩放/平移/适配窗口/坐标变换

import type { DrawingBoardCard } from '../../drawing-board-card';

export class DrawingBoardViewController {
  private _card: DrawingBoardCard;
  zoom = 1.0;
  panX = 0;
  panY = 0;
  readonly MIN_ZOOM = 0.25;
  readonly MAX_ZOOM = 4.0;
  private _isPanning = false;
  private _panStartX = 0; private _panStartY = 0;
  private _panInitialX = 0; private _panInitialY = 0;

  constructor(card: DrawingBoardCard) { this._card = card; }

  restore(data: { viewZoom?: number; viewPanX?: number; viewPanY?: number } | null): void {
    this.zoom = data?.viewZoom ?? 1.0;
    this.panX = data?.viewPanX ?? 0;
    this.panY = data?.viewPanY ?? 0;
  }

  export(): { viewZoom: number; viewPanX: number; viewPanY: number } {
    return { viewZoom: this.zoom, viewPanX: this.panX, viewPanY: this.panY };
  }

  zoomAtPoint(newZoom: number, anchorX: number, anchorY: number): void {
    const oldZoom = this.zoom;
    newZoom = Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, newZoom));
    if (newZoom === oldZoom) return;
    this.panX = this.panX + (anchorX - this.panX) * (oldZoom - newZoom) / oldZoom;
    this.panY = this.panY + (anchorY - this.panY) * (oldZoom - newZoom) / oldZoom;
    this.zoom = newZoom;
    this._apply();
  }

  zoomCenter(newZoom: number): void {
    const wrap = this._card.element?.querySelector('.drawing-board-canvas-wrap');
    if (!wrap) { this.zoom = Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, newZoom)); this._apply(); return; }
    this.zoomAtPoint(newZoom, wrap.clientWidth / 2, wrap.clientHeight / 2);
  }

  zoomAtMouse(newZoom: number, mouseX: number, mouseY: number): void { this.zoomAtPoint(newZoom, mouseX, mouseY); }
  setZoom(newZoom: number): void { this.zoomCenter(newZoom); }
  zoomIn(): void { this.setZoom(this.zoom + 0.1); }
  zoomOut(): void { this.setZoom(this.zoom - 0.1); }

  startPan(x: number, y: number): void {
    this._panStartX = x; this._panStartY = y;
    this._panInitialX = this.panX; this._panInitialY = this.panY;
    this._isPanning = true;
  }

  updatePan(x: number, y: number): void {
    if (!this._isPanning) return;
    this.panX = this._panInitialX + (x - this._panStartX);
    this.panY = this._panInitialY + (y - this._panStartY);
    this._apply();
  }

  endPan(): void { this._isPanning = false; }
  isPanning(): boolean { return this._isPanning; }

  fitToWindow(): void {
    const wrap = this._card.element?.querySelector('.drawing-board-canvas-wrap');
    if (!wrap) return;
    const cw = this._card.canvasConfig.width; const ch = this._card.canvasConfig.height;
    const wrapW = wrap.clientWidth - 40; const wrapH = wrap.clientHeight - 40;
    if (wrapW <= 0 || wrapH <= 0) return;
    const fitZoom = Math.min(wrapW / cw, wrapH / ch, 1);
    this.zoom = Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, fitZoom));
    this.panX = (wrap.clientWidth - cw * this.zoom) / 2;
    this.panY = (wrap.clientHeight - ch * this.zoom) / 2;
    this._apply();
  }

  screenToCanvas(screenX: number, screenY: number): { x: number; y: number } {
    const canvas = this._card._renderer._canvas;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return { x: 0, y: 0 };
    const sx = canvas.width / rect.width; const sy = canvas.height / rect.height;
    return { x: (screenX - rect.left) * sx, y: (screenY - rect.top) * sy };
  }

  screenPxToCanvasPx(): number {
    const canvas = this._card._renderer._canvas;
    if (!canvas) return 1 / this.zoom;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return 1 / this.zoom;
    const sx = canvas.width / rect.width; const sy = canvas.height / rect.height;
    return (sx + sy) / 2;
  }

  _apply(): void {
    const content = this._card.element?.querySelector('.drawing-board-canvas-content');
    const scaled = this._card.element?.querySelector('.drawing-board-canvas-scaled');
    const zoomLevel = this._card.element?.querySelector('.zoom-level');
    const cw = this._card.canvasConfig.width; const ch = this._card.canvasConfig.height;

    if (content) { (content as HTMLElement).style.width = `${cw * this.zoom}px`; (content as HTMLElement).style.height = `${ch * this.zoom}px`; (content as HTMLElement).style.transform = `translate(${this.panX}px, ${this.panY}px)`; }
    if (scaled) { (scaled as HTMLElement).style.width = `${cw}px`; (scaled as HTMLElement).style.height = `${ch}px`; (scaled as HTMLElement).style.transform = `scale(${this.zoom})`; (scaled as HTMLElement).style.transformOrigin = '0 0'; }
    if (zoomLevel) zoomLevel.textContent = Math.round(this.zoom * 100) + '%';

    this._card._updateTextEditorPosition?.();
    const tool = this._card._toolManager?.currentTool;
    if (tool === 'brush' || tool === 'eraser') {
      const size = tool === 'brush' ? this._card._toolManager.brushSettings.size : this._card._toolManager.eraserSettings.size;
      const color = tool === 'brush' ? this._card._toolManager.brushSettings.color : null;
      this._card._renderer.updateBrushCursor(true, size, color);
    }
  }

  init(): void { this._apply(); this.fitToWindow(); }
}