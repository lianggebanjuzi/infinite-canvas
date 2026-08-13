// src/cards/features/drawing-board/renderer.ts
// 渲染器：Canvas 渲染 / 光标 / 选区手柄 / 笔刷轨迹合成

import type { BoardLayer, DrawingLayer } from './types';
import type { DrawingBoardCard } from '../../drawing-board-card';

export class DrawingBoardRenderer {
  private _card: DrawingBoardCard;
  _ctx: CanvasRenderingContext2D | null = null;
  _canvas: HTMLCanvasElement | null = null;
  private _pendingRender = false;
  _drawingLayerCanvas: HTMLCanvasElement | null = null;
  _drawingLayerCtx: CanvasRenderingContext2D | null = null;
  _brushCursor: HTMLDivElement | null = null;

  constructor(card: DrawingBoardCard) { this._card = card; }

  init(): void {
    this._canvas = this._card.element?.querySelector('.drawing-board-canvas') as HTMLCanvasElement | null;
    this._ctx = this._canvas?.getContext('2d') || null;
    const w = this._card.canvasConfig.width; const h = this._card.canvasConfig.height;
    this._drawingLayerCanvas = document.createElement('canvas');
    this._drawingLayerCanvas.width = w; this._drawingLayerCanvas.height = h;
    this._drawingLayerCtx = this._drawingLayerCanvas.getContext('2d');
    if (this._drawingLayerCtx) { this._drawingLayerCtx.imageSmoothingEnabled = true; this._drawingLayerCtx.imageSmoothingQuality = 'high'; }
    this._brushCursor = document.createElement('div');
    this._brushCursor.className = 'brush-cursor';
    this._brushCursor.style.cssText = 'position:fixed;pointer-events:none;border:1px solid rgba(0,0,0,0.5);border-radius:50%;transform:translate(-50%,-50%);z-index:9999;display:none;';
    document.body.appendChild(this._brushCursor);
  }

  updateBrushCursor(visible: boolean, size: number, color: string | null): void {
    if (!this._brushCursor) return;
    if (visible) {
      const diameter = Math.max(size, 10);
      this._brushCursor.style.width = diameter + 'px'; this._brushCursor.style.height = diameter + 'px';
      this._brushCursor.style.borderColor = color || 'rgba(0,0,0,0.5)';
      this._brushCursor.style.display = 'block';
    } else { this._brushCursor.style.display = 'none'; }
  }

  moveBrushCursor(screenX: number, screenY: number): void {
    if (this._brushCursor) { this._brushCursor.style.left = screenX + 'px'; this._brushCursor.style.top = screenY + 'px'; }
  }

  requestRender(): void {
    if (this._pendingRender) return;
    this._pendingRender = true;
    requestAnimationFrame(() => { this.render(); this._pendingRender = false; });
  }

  render(): void {
    if (!this._ctx) return;
    const ctx = this._ctx; const w = this._card.canvasConfig.width; const h = this._card.canvasConfig.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);

    this._card._layerManager.layers.forEach((layer, index) => {
      if (!layer.visible) return;
      ctx.globalAlpha = layer.opacity;
      if (layer.imageData) this._drawImageLayer(ctx, layer);
      if (layer.texts) layer.texts.forEach(text => {
        ctx.font = `${text.fontSize}px ${text.fontFamily}`;
        ctx.fillStyle = text.color;
        ctx.fillText(text.text, text.x, text.y);
      });
      const isSelected = (index === this._card._layerManager.getSelectedIndex());
      if (isSelected && this._drawingLayerCtx && this._drawingLayerCanvas) ctx.drawImage(this._drawingLayerCanvas, 0, 0);
      else if (layer.drawings) layer.drawings.forEach(drawing => { if (drawing.points && drawing.points.length > 0) this._drawPath(ctx, drawing); });
    });

    ctx.globalAlpha = 1;
    if (this._card._toolManager.currentTool === 'select') {
      const hoverHandle = this._card._inputHandler?._hoverHandle || null;
      this._drawSelectionHandles(ctx, hoverHandle);
    }
  }

  private _drawSelectionHandles(ctx: CanvasRenderingContext2D, hoverHandle: string | null): void {
    const layer = this._card._layerManager.getSelected();
    if (!layer || !layer.imageData) return;
    const img = this._card._layerManager.getImage(layer.imageData);
    if (!img || !img.complete || !img.naturalWidth) return;
    const x = layer.x; const y = layer.y;
    const width = layer.width || img.naturalWidth; const height = layer.height || img.naturalHeight;
    ctx.strokeStyle = '#0066ff'; ctx.lineWidth = 8; ctx.setLineDash([8, 8]);
    ctx.strokeRect(x, y, width, height); ctx.setLineDash([]);
    const handleSize = 14;
    const handles = [
      { x: x, y: y, dir: 'nw' }, { x: x + width / 2, y: y, dir: 'n' }, { x: x + width, y: y, dir: 'ne' },
      { x: x + width, y: y + height / 2, dir: 'e' }, { x: x + width, y: y + height, dir: 'se' },
      { x: x + width / 2, y: y + height, dir: 's' }, { x: x, y: y + height / 2, dir: 'w' }, { x: x, y: y + height, dir: 'sw' }
    ];
    handles.forEach(h => {
      const isHovered = hoverHandle === h.dir;
      ctx.fillStyle = isHovered ? '#0066ff' : '#ffffff'; ctx.strokeStyle = '#0066ff'; ctx.lineWidth = 4;
      ctx.fillRect(h.x - handleSize / 2, h.y - handleSize / 2, handleSize, handleSize);
      ctx.strokeRect(h.x - handleSize / 2, h.y - handleSize / 2, handleSize, handleSize);
    });
  }

  private _drawImageLayer(ctx: CanvasRenderingContext2D, layer: BoardLayer): void {
    const img = this._card._layerManager.getImage(layer.imageData!);
    if (!img || !img.complete || !img.naturalWidth) return;
    const width = layer.width || img.naturalWidth; const height = layer.height || img.naturalHeight;
    ctx.drawImage(img, layer.x, layer.y, width, height);
  }

  private _drawPath(ctx: CanvasRenderingContext2D, path: DrawingLayer): void {
    if (!path || !path.points || path.points.length < 2) return;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = path.size;
    ctx.strokeStyle = this._hexToRgba(path.color, path.opacity);
    ctx.beginPath(); ctx.moveTo(path.points[0].x, path.points[0].y);
    for (let i = 1; i < path.points.length; i++) ctx.lineTo(path.points[i].x, path.points[i].y);
    ctx.stroke();
  }

  private _hexToRgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16); const g = parseInt(hex.slice(3, 5), 16); const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  toImage(): string | null { return this._canvas?.toDataURL('image/png') || null; }

  resize(width: number, height: number): void {
    if (this._canvas) { this._canvas.width = width; this._canvas.height = height; }
    if (this._drawingLayerCanvas) { this._drawingLayerCanvas.width = width; this._drawingLayerCanvas.height = height; }
  }

  syncDrawingLayerFromLayer(layer: BoardLayer | null): void { this._syncDrawingLayer(layer, null); }

  _syncDrawingLayer(layer: BoardLayer | null, currentPath: DrawingLayer | null): void {
    if (!this._drawingLayerCtx || !layer) return;
    const w = this._drawingLayerCanvas!.width; const h = this._drawingLayerCanvas!.height;
    this._drawingLayerCtx.clearRect(0, 0, w, h);
    if (layer.drawings) layer.drawings.forEach(drawing => { if (drawing.points && drawing.points.length > 0) this._drawPath(this._drawingLayerCtx!, drawing); });
    if (currentPath && currentPath.points && currentPath.points.length >= 2) this._drawPath(this._drawingLayerCtx!, currentPath);
  }

  getDrawingLayerCtx(): CanvasRenderingContext2D | null { return this._drawingLayerCtx; }
}