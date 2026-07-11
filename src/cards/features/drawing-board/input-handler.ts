// src/cards/features/drawing-board/input-handler.ts
// 输入处理器：鼠标/滚轮事件分发 + 选区/拖拽/缩放

import type { DrawingLayer, BoardLayer, TextItem } from './types';
import type { DrawingBoardCard } from '../../drawing-board-card';

export class DrawingBoardInputHandler {
  private _card: DrawingBoardCard;
  private _isDrawing = false; private _isErasing = false; private _isPanning = false;
  private _isDraggingLayer = false; private _isResizing = false;
  private _currentPath: DrawingLayer | null = null;
  private _lastX = 0; private _lastY = 0;
  private _draggedLayer: BoardLayer | null = null;
  private _dragOffset = { x: 0, y: 0 };
  private _panStart = { x: 0, y: 0 }; private _panInitial = { x: 0, y: 0 };
  private _lastPoint = { x: 0, y: 0 };
  private _resizingHandle: string | null = null;
  private _resizeStart: { layer: BoardLayer; bounds: { x: number; y: number; width: number; height: number } } | null = null;
  private _selectedImageLayer: BoardLayer | null = null;
  _hoverHandle: string | null = null;
  private readonly _HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  private readonly _boundHandleMouseDown: (e: MouseEvent) => void;
  private readonly _boundHandleMouseMove: (e: MouseEvent) => void;
  private readonly _boundHandleMouseUp: (e: MouseEvent) => void;
  private readonly _boundHandleMouseLeave: (e: MouseEvent) => void;
  private readonly _boundHandleWheel: (e: WheelEvent) => void;

  constructor(card: DrawingBoardCard) {
    this._card = card;
    this._boundHandleMouseDown = this._handleMouseDown.bind(this);
    this._boundHandleMouseMove = this._handleMouseMove.bind(this);
    this._boundHandleMouseUp = this._handleMouseUp.bind(this);
    this._boundHandleMouseLeave = this._handleMouseLeave.bind(this);
    this._boundHandleWheel = this._handleWheel.bind(this);
  }

  init(): void {
    const canvas = this._card._renderer._canvas;
    const canvasWrap = this._card.element?.querySelector('.drawing-board-canvas-wrap');
    if (!canvas || !canvasWrap) return;
    canvas.addEventListener('mousedown', this._boundHandleMouseDown as EventListener);
    (canvasWrap as HTMLElement).addEventListener('mousedown', this._boundHandleMouseDown as EventListener);
    canvas.addEventListener('mousemove', this._boundHandleMouseMove as EventListener);
    canvas.addEventListener('mouseup', this._boundHandleMouseUp as EventListener);
    canvas.addEventListener('mouseleave', this._boundHandleMouseLeave as EventListener);
    (canvasWrap as HTMLElement).addEventListener('wheel', this._boundHandleWheel as EventListener, { passive: false });
  }

  destroy(): void {
    const canvas = this._card._renderer._canvas;
    const canvasWrap = this._card.element?.querySelector('.drawing-board-canvas-wrap');
    canvas?.removeEventListener('mousedown', this._boundHandleMouseDown as EventListener);
    canvas?.removeEventListener('mousemove', this._boundHandleMouseMove as EventListener);
    canvas?.removeEventListener('mouseup', this._boundHandleMouseUp as EventListener);
    canvas?.removeEventListener('mouseleave', this._boundHandleMouseLeave as EventListener);
    (canvasWrap as HTMLElement | undefined)?.removeEventListener('wheel', this._boundHandleWheel as EventListener);
  }

  private _handleWheel(e: WheelEvent): void {
    const isSelected = this._card.element?.classList.contains('selected');
    if (!isSelected) return;
    e.preventDefault();
    const canvasWrap = this._card.element?.querySelector('.drawing-board-canvas-wrap') as HTMLElement;
    const rect = canvasWrap.getBoundingClientRect();
    const mouseX = e.clientX - rect.left; const mouseY = e.clientY - rect.top;
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    this._card._viewController.zoomAtMouse(this._card._viewController.zoom * factor, mouseX, mouseY);
  }

  private _handleMouseDown(e: MouseEvent): void {
    if (e.button === 1) {
      const isSelected = this._card.element?.classList.contains('selected');
      if (!isSelected) return;
      e.preventDefault();
      this._startPan(e.clientX, e.clientY);
      return;
    }
    if (e.button !== 0) return;
    const tool = this._card._toolManager.currentTool;
    const coords = this._card._viewController.screenToCanvas(e.clientX, e.clientY);
    this._lastPoint = coords;
    if (tool === 'pan') { this._startPan(e.clientX, e.clientY); return; }
    const layer = this._card._layerManager.getSelected();
    switch (tool) {
      case 'brush': if (layer && !layer.locked) this._startDrawing(coords); break;
      case 'eraser': this._startErasing(coords); break;
      case 'select': this._trySelect(coords); break;
      case 'text': if (layer && !layer.locked) this._addText(coords); break;
    }
  }

  private _handleMouseMove(e: MouseEvent): void {
    const coords = this._card._viewController.screenToCanvas(e.clientX, e.clientY);
    const tool = this._card._toolManager.currentTool;
    if (tool === 'brush' || tool === 'eraser') {
      const size = tool === 'brush' ? this._card._toolManager.brushSettings.size : this._card._toolManager.eraserSettings.size;
      const color = tool === 'brush' ? this._card._toolManager.brushSettings.color : null;
      this._card._renderer.updateBrushCursor(true, size, color);
      this._card._renderer.moveBrushCursor(e.clientX, e.clientY);
    } else { this._card._toolManager.callBrushCursor(false); }
    if (tool === 'select' && !this._isDraggingLayer && !this._isResizing) {
      const hitHandle = this._hitTestHandle(coords);
      this._hoverHandle = hitHandle;
      if (hitHandle) {
        const cursors: Record<string, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };
        (this._card.element as HTMLElement).style.cursor = cursors[hitHandle] || 'default';
      } else { (this._card.element as HTMLElement).style.cursor = 'default'; }
      this._card._renderer.requestRender();
    }
    if (this._isPanning) { this._card._viewController.updatePan(e.clientX, e.clientY); return; }
    if (this._isResizing && this._resizeStart) {
      const layer = this._resizeStart.layer; const start = this._resizeStart.bounds; const handle = this._resizingHandle;
      const mouseX = coords.x; const mouseY = coords.y;
      const MIN_SIZE = 20;
      let newX = start.x; let newY = start.y; let newW = start.width; let newH = start.height;
      if (e.shiftKey) {
        const centerX = start.x + start.width / 2; const centerY = start.y + start.height / 2;
        const dx = mouseX - centerX; const dy = mouseY - centerY;
        const dist = Math.hypot(dx, dy); const startDist = Math.hypot(start.width, start.height) / 2;
        const scale = dist / startDist;
        newW = Math.max(MIN_SIZE, start.width * scale); newH = Math.max(MIN_SIZE, start.height * scale);
        newX = centerX - newW / 2; newY = centerY - newH / 2;
      } else {
        switch (handle) {
          case 'e': newW = Math.max(MIN_SIZE, mouseX - start.x); break;
          case 'w': newW = Math.max(MIN_SIZE, start.x + start.width - mouseX); newX = Math.min(mouseX, start.x + start.width - MIN_SIZE); break;
          case 's': newH = Math.max(MIN_SIZE, mouseY - start.y); break;
          case 'n': newH = Math.max(MIN_SIZE, start.y + start.height - mouseY); newY = Math.min(mouseY, start.y + start.height - MIN_SIZE); break;
          case 'se': newW = Math.max(MIN_SIZE, mouseX - start.x); newH = Math.max(MIN_SIZE, mouseY - start.y); break;
          case 'sw': newW = Math.max(MIN_SIZE, start.x + start.width - mouseX); newX = Math.min(mouseX, start.x + start.width - MIN_SIZE); newH = Math.max(MIN_SIZE, mouseY - start.y); break;
          case 'ne': newW = Math.max(MIN_SIZE, mouseX - start.x); newH = Math.max(MIN_SIZE, start.y + start.height - mouseY); newY = Math.min(mouseY, start.y + start.height - MIN_SIZE); break;
          case 'nw': newW = Math.max(MIN_SIZE, start.x + start.width - mouseX); newX = Math.min(mouseX, start.x + start.width - MIN_SIZE); newH = Math.max(MIN_SIZE, start.y + start.height - mouseY); newY = Math.min(mouseY, start.y + start.height - MIN_SIZE); break;
        }
      }
      layer.x = newX; layer.y = newY; layer.width = newW; layer.height = newH;
      this._card._renderer.requestRender();
      return;
    }
    if (this._isDraggingLayer && this._draggedLayer) {
      this._draggedLayer.x = coords.x - this._dragOffset.x; this._draggedLayer.y = coords.y - this._dragOffset.y;
      this._card._renderer.requestRender(); return;
    }
    if (this._isDrawing) {
      const t = this._card._toolManager.currentTool;
      if (t === 'brush' && this._currentPath) this._continueDrawing(coords);
      else if (t === 'eraser') this._continueErasing(coords);
    }
    this._lastPoint = coords;
  }

  private _handleMouseUp(_e: MouseEvent): void {
    if (this._isPanning) { this._endPan(); return; }
    if (this._isResizing) { this._isResizing = false; this._resizingHandle = null; this._resizeStart = null; this._card._historyManager.save(); return; }
    if (this._isDraggingLayer) this._endDragging();
    if (this._isDrawing) this._finishDrawing();
  }

  private _handleMouseLeave(_e: MouseEvent): void {
    this._card._toolManager.callBrushCursor(false);
    if (this._isPanning) this._endPan();
    if (this._isDrawing) this._finishDrawing();
  }

  private _startPan(x: number, y: number): void {
    this._isPanning = true; this._card._viewController.startPan(x, y);
    if (this._card._renderer._canvas) (this._card._renderer._canvas as HTMLCanvasElement).style.cursor = 'grabbing';
  }

  private _endPan(): void {
    this._isPanning = false; this._card._viewController.endPan();
    this._card._toolManager._updateCursor();
  }

  private _startDrawing(coords: { x: number; y: number }): void {
    this._isDrawing = true;
    const settings = this._card._toolManager.brushSettings;
    const lineW = settings.size * this._card._viewController.screenPxToCanvasPx();
    this._currentPath = { points: [{ x: coords.x, y: coords.y }], color: settings.color, size: lineW, opacity: settings.opacity, hardness: settings.hardness };
  }

  private _continueDrawing(coords: { x: number; y: number }): void {
    if (!this._currentPath) return;
    const points = this._currentPath.points; const last = points[points.length - 1];
    if (!last) { this._card._renderer.requestRender(); return; }
    const dx = coords.x - last.x; const dy = coords.y - last.y; const dist = Math.hypot(dx, dy);
    const step = 2;
    if (dist > step) {
      const n = Math.ceil(dist / step);
      for (let i = 1; i < n; i++) {
        const t = i / n;
        points.push({ x: last.x + dx * t, y: last.y + dy * t });
      }
    }
    points.push({ x: coords.x, y: coords.y });
    const layer = this._card._layerManager.getSelected();
    this._card._renderer._syncDrawingLayer(layer, this._currentPath);
    this._card._renderer.requestRender();
  }

  private _startErasing(coords: { x: number; y: number }): void {
    this._isDrawing = true; this._isErasing = true; this._lastX = coords.x; this._lastY = coords.y;
  }

  private _continueErasing(coords: { x: number; y: number }): void {
    if (!this._isDrawing) return;
    const ctx = this._card._renderer.getDrawingLayerCtx();
    if (!ctx) return;
    const size = this._card._toolManager.eraserSettings.size;
    const k = this._card._viewController.screenPxToCanvasPx();
    const lineWidthCanvas = Math.max(size * k, 1);
    ctx.save(); ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = 'rgba(0,0,0,1)'; ctx.lineWidth = lineWidthCanvas; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(this._lastX, this._lastY); ctx.lineTo(coords.x, coords.y); ctx.stroke();
    ctx.restore();
    this._lastX = coords.x; this._lastY = coords.y;
    this._card._renderer.requestRender();
  }

  private _finishDrawing(): void {
    if (!this._isDrawing) return;
    const wasErasing = this._isErasing;
    this._isDrawing = false; this._isErasing = false;
    const layer = this._card._layerManager.getSelected();
    const tool = this._card._toolManager.currentTool;
    if (tool === 'brush') {
      if (layer && this._currentPath && this._currentPath.points.length > 0) {
        layer.drawings.push({ ...this._currentPath });
        this._card._renderer.syncDrawingLayerFromLayer(layer);
        this._card._historyManager.save();
      }
      this._currentPath = null;
      this._card._renderer.render();
    }
    if (wasErasing) this._card._historyManager.save();
  }

  private _getSelectedImageBounds(): { x: number; y: number; width: number; height: number; centerX: number; centerY: number } | null {
    const layer = this._card._layerManager.getSelected();
    if (!layer || !layer.imageData) return null;
    const img = this._card._layerManager.getImage(layer.imageData);
    if (!img || !img.complete || !img.naturalWidth) return null;
    const width = layer.width || img.naturalWidth; const height = layer.height || img.naturalHeight;
    return { x: layer.x, y: layer.y, width, height, centerX: layer.x + width / 2, centerY: layer.y + height / 2 };
  }

  private _getHandlePositions(bounds: { x: number; y: number; width: number; height: number }): Record<string, { x: number; y: number }> {
    return {
      nw: { x: bounds.x, y: bounds.y }, n: { x: bounds.x + bounds.width / 2, y: bounds.y },
      ne: { x: bounds.x + bounds.width, y: bounds.y }, e: { x: bounds.x + bounds.width, y: bounds.y + bounds.height / 2 },
      se: { x: bounds.x + bounds.width, y: bounds.y + bounds.height }, s: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height },
      sw: { x: bounds.x, y: bounds.y + bounds.height }, w: { x: bounds.x, y: bounds.y + bounds.height / 2 }
    };
  }

  private _hitTestHandle(coords: { x: number; y: number }): string | null {
    const bounds = this._getSelectedImageBounds();
    if (!bounds) return null;
    const handles = this._getHandlePositions(bounds);
    const HIT_SIZE = 20;
    for (const dir of this._HANDLES) {
      const h = handles[dir];
      if (Math.abs(coords.x - h.x) <= HIT_SIZE && Math.abs(coords.y - h.y) <= HIT_SIZE) return dir;
    }
    return null;
  }

  private _trySelect(coords: { x: number; y: number }): void {
    const hitHandle = this._hitTestHandle(coords);
    if (hitHandle) {
      const layer = this._card._layerManager.getSelected();
      if (!layer || !layer.imageData || layer.locked) return;
      const bounds = this._getSelectedImageBounds();
      this._resizingHandle = hitHandle;
      this._resizeStart = { layer, bounds: { ...bounds! } };
      this._isResizing = true;
      this._card._historyManager.save();
      return;
    }
    const hitText = this._card._hitTestText(coords.x, coords.y);
    if (hitText) { this._selectedImageLayer = null; this._card._startEditingText(hitText.layerIndex, hitText.textIndex); return; }
    const layer = this._card._hitTestLayer(coords.x, coords.y);
    if (layer && !layer.locked) {
      const layerIndex = this._card._layerManager.layers.indexOf(layer);
      if (layerIndex !== -1) { this._card._layerManager.setSelected(layerIndex); this._card._renderLayersList(); }
      this._draggedLayer = layer; this._dragOffset = { x: coords.x - layer.x, y: coords.y - layer.y };
      this._isDraggingLayer = true;
      if (layer.imageData) this._selectedImageLayer = layer; else this._selectedImageLayer = null;
      this._card._renderer.requestRender();
    } else { this._selectedImageLayer = null; this._card._renderer.requestRender(); }
  }

  private _endDragging(): void { this._isDraggingLayer = false; this._draggedLayer = null; }

  private _addText(coords: { x: number; y: number }): void {
    const layer = this._card._layerManager.getSelected();
    if (!layer || !layer.texts) return;
    const settings = this._card._toolManager.textSettings;
    const newText: TextItem = { id: `text-${Date.now()}`, text: '双击编辑文字', x: coords.x, y: coords.y, fontSize: settings.fontSize, color: settings.color, fontFamily: settings.fontFamily };
    layer.texts.push(newText);
    this._card._historyManager.save();
    this._card._renderer.render();
    setTimeout(() => { const textIndex = layer.texts.length - 1; this._card._startEditingText(this._card._layerManager.getSelectedIndex(), textIndex); }, 50);
  }
}