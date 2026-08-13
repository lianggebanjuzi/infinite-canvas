// src/cards/drawing-board-card.ts
// DrawingBoard 卡片（主类 + 6 个 helper 见 features/drawing-board/）

import { BaseCard } from './base-card';
import { CardContract, CardOptions, CardSerializedData } from '../types/cards';
import { DrawingBoardToolManager } from './features/drawing-board/tool-manager';
import { DrawingBoardLayerManager } from './features/drawing-board/layer-manager';
import { DrawingBoardViewController } from './features/drawing-board/view-controller';
import { DrawingBoardHistoryManager } from './features/drawing-board/history-manager';
import { DrawingBoardRenderer } from './features/drawing-board/renderer';
import { DrawingBoardInputHandler } from './features/drawing-board/input-handler';
import type { CanvasConfig, BoardLayer, TextItem } from './features/drawing-board/types';

declare const CardFactory: { getInstance(cardId: string): DrawingBoardCard | null };
declare const DataSource: { getUpstreamImage(cardId: string): Array<{ data: unknown; sourceCardId: string }>; getDownstreamCards(cardId: string): Array<{ onReceive?: Function }> };
declare const CardEventBus: { EventTypes: { DATA_CHANGED: string }; emit(type: string, payload: unknown): void };
declare const Toast: { show(msg: string, dur?: number): void };

export class DrawingBoardCard extends BaseCard {
  canvasConfig: CanvasConfig = { width: 1024, height: 1024 };
  _toolManager!: DrawingBoardToolManager;
  _layerManager!: DrawingBoardLayerManager;
  _viewController!: DrawingBoardViewController;
  _historyManager!: DrawingBoardHistoryManager;
  _renderer!: DrawingBoardRenderer;
  _inputHandler!: DrawingBoardInputHandler;
  _editingTextId: string | null = null;
  _editingTextInput: HTMLInputElement | null = null;
  _keyDownHandler: ((e: KeyboardEvent) => void) | null = null;
  _isDrawing = false;
  _isErasing = false;

  constructor(options: CardOptions = {}) {
    super({ width: '800px', height: '600px', minWidth: 400, minHeight: 300, title: '画板', ...options });
    const w = parseFloat(String(this.width)); const h = parseFloat(String(this.height));
    if (!isNaN(w) && w < this.minWidth) this.width = this.minWidth + 'px';
    if (!isNaN(h) && h < this.minHeight) this.height = this.minHeight + 'px';
    this.canvasConfig = { width: (options as unknown as { canvasWidth?: number }).canvasWidth || 1024, height: (options as unknown as { canvasHeight?: number }).canvasHeight || 1024, ...(options as unknown as { canvasConfig?: CanvasConfig }).canvasConfig || {} };
    if (options.content) {
      try { const parsed = JSON.parse(options.content as string); this.canvasConfig = { ...this.canvasConfig, ...parsed.canvasConfig }; } catch {}
    }
    this._toolManager = new DrawingBoardToolManager(this);
    this._layerManager = new DrawingBoardLayerManager(this);
    this._viewController = new DrawingBoardViewController(this);
    this._historyManager = new DrawingBoardHistoryManager(this);
    this._renderer = new DrawingBoardRenderer(this);
    this._inputHandler = new DrawingBoardInputHandler(this);
    if (options.content) this._restoreFromContent(options.content as string);
    if (this._layerManager.layers.length === 0) this._layerManager.createLayer('背景');
  }

  private _restoreFromContent(content: string): void {
    try {
      const parsed = JSON.parse(content);
      if (parsed.layers) this._layerManager.restore({ layers: parsed.layers, selectedLayerIndex: parsed.selectedLayerIndex });
      this._viewController.restore({ viewZoom: parsed.viewZoom, viewPanX: parsed.viewPanX, viewPanY: parsed.viewPanY });
      this._toolManager.restore({ brushSettings: parsed.brushSettings, eraserSettings: parsed.eraserSettings, textSettings: parsed.textSettings });
    } catch {}
  }

  getType(): string { return 'drawing-board'; }

  static override getContract(): CardContract {
    return {
      outputs: [{ name: 'default', type: 'image', notifyOn: 'onApply' }],
      inputs: [{ name: 'image', type: 'image', multiple: true, receivePolicy: 'append' }]
    };
  }

  override getOutput(outputName = 'default'): unknown {
    if (outputName === 'default') { this._renderer.render(); return this._renderer.toImage(); }
    return null;
  }

  override notifyDownstream(): void {
    const downstreamCards = DataSource.getDownstreamCards(this.id);
    downstreamCards.forEach(downstream => { downstream?.onReceive?.('image', this.getOutput(), this.id); });
    if ((window as unknown as { CardEventBus?: typeof CardEventBus }).CardEventBus && CardEventBus.EventTypes) {
      const output = this.getOutput ? this.getOutput() : null;
      if (output) CardEventBus.emit(CardEventBus.EventTypes.DATA_CHANGED, { cardId: this.id, type: 'image', data: output, source: 'manual' });
    }
  }

  override onReceive(type: 'text' | 'image', data: unknown, _source = 'upstream'): void {
    if (type === 'image' && data) this._addImageLayer(data as string);
  }

  refreshUpstream(): void {
    const hasOwnLayers = this._layerManager.layers.some(l => l.type === 'image' || (l.drawings?.length ?? 0) > 0 || (l.texts?.length ?? 0) > 0);
    if (!hasOwnLayers) this._loadLayersFromConnections();
  }

  private _addImageLayer(imageData: string): void {
    const newLayer: BoardLayer = {
      id: `layer-${Date.now()}`, type: 'image', name: `图片 ${this._layerManager.layers.length + 1}`,
      imageData, x: 0, y: 0, width: null, height: null, opacity: 1, visible: true, locked: false, drawings: [], texts: []
    };
    if (this._layerManager.layers.length > 0) this._historyManager.save();
    this._layerManager.layers.push(newLayer);
    this._layerManager.selectedIndex = this._layerManager.layers.length - 1;
    this._layerManager.preloadImages(() => { this._renderLayersList(); this._renderer.render(); this._viewController.fitToWindow(); });
  }

  private _loadLayersFromConnections(): void {
    DataSource.getUpstreamImage(this.id).forEach(item => { if (item.data) this._addImageLayer(item.data as string); });
  }

  _ensureCanvasFitsImage(layer: BoardLayer, img: HTMLImageElement): void {
    if (!img || !img.naturalWidth || !img.naturalHeight) return;
    const w = this.canvasConfig.width; const h = this.canvasConfig.height;
    const iw = img.naturalWidth; const ih = img.naturalHeight;
    const hasDrawings = (layer.drawings?.length ?? 0) > 0; const hasTexts = (layer.texts?.length ?? 0) > 0;
    const singleImageLayer = this._layerManager.layers.length === 1 && !hasDrawings && !hasTexts;
    if (singleImageLayer) {
      if (w !== iw || h !== ih) {
        this.canvasConfig.width = iw; this.canvasConfig.height = ih;
        this._renderer.resize(iw, ih); this._viewController._apply();
        this._updateCanvasSizeDisplay();
        setTimeout(() => this._viewController.fitToWindow(), 50);
      }
      return;
    }
    if (iw <= w && ih <= h) return;
    const newW = Math.max(w, iw); const newH = Math.max(h, ih);
    this.canvasConfig.width = newW; this.canvasConfig.height = newH;
    this._renderer.resize(newW, newH); this._viewController._apply();
    this._updateCanvasSizeDisplay();
    setTimeout(() => this._viewController.fitToWindow(), 50);
  }

  _updateCanvasSizeDisplay(): void {
    const el = this.element?.querySelector('.canvas-size-display');
    if (el) el.textContent = `${this.canvasConfig.width} × ${this.canvasConfig.height}`;
  }

  _hitTestText(x: number, y: number): { layerIndex: number; textIndex: number } | null {
    for (let i = this._layerManager.layers.length - 1; i >= 0; i--) {
      const layer = this._layerManager.layers[i];
      if (!layer.visible || layer.locked) continue;
      if (layer.texts) {
        for (let j = layer.texts.length - 1; j >= 0; j--) {
          const text = layer.texts[j];
          const estimatedWidth = text.text.length * text.fontSize * 0.6; const estimatedHeight = text.fontSize;
          if (x >= text.x && x <= text.x + estimatedWidth && y >= text.y - estimatedHeight && y <= text.y + estimatedHeight * 0.3) {
            return { layerIndex: i, textIndex: j };
          }
        }
      }
    }
    return null;
  }

  _hitTestLayer(x: number, y: number): BoardLayer | null {
    for (let i = this._layerManager.layers.length - 1; i >= 0; i--) {
      const layer = this._layerManager.layers[i];
      if (!layer.visible || layer.locked) continue;
      if (layer.imageData) {
        const img = this._layerManager.getImage(layer.imageData);
        if (img && img.complete && img.naturalWidth) {
          const width = layer.width || img.naturalWidth; const height = layer.height || img.naturalHeight;
          const inBounds = x >= layer.x && x <= layer.x + width && y >= layer.y && y <= layer.y + height;
          if (inBounds) return layer;
        }
      }
      if ((layer.drawings?.length ?? 0) > 0 || (layer.texts?.length ?? 0) > 0) return layer;
    }
    return null;
  }

  _startEditingText(layerIndex: number, textIndex: number): void {
    const layer = this._layerManager.layers[layerIndex];
    if (!layer || !layer.texts || !layer.texts[textIndex]) return;
    const text = layer.texts[textIndex];
    this._editingTextId = text.id;
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'text-editor-input'; input.value = text.text;
    this._updateTextInputPosition(input, text);
    const canvasWrap = this.element?.querySelector('.drawing-board-canvas-wrap');
    canvasWrap?.appendChild(input);
    input.focus(); input.select();
    const finishEditing = () => {
      const newText = input.value.trim();
      if (newText && newText !== '双击编辑文字') { layer.texts[textIndex].text = newText; this._historyManager.save(); }
      else if (!newText) layer.texts.splice(textIndex, 1);
      input.remove(); this._editingTextId = null; this._editingTextInput = null; this._renderer.render();
    };
    input.addEventListener('blur', finishEditing);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') { input.value = text.text; input.blur(); }
    });
    this._editingTextInput = input;
  }

  _updateTextInputPosition(input: HTMLInputElement, text: TextItem): void {
    const zoom = this._viewController.zoom; const panX = this._viewController.panX; const panY = this._viewController.panY;
    input.style.cssText = `position:absolute;left:${text.x * zoom + panX}px;top:${(text.y - text.fontSize) * zoom + panY}px;font-size:${text.fontSize * zoom}px;color:${text.color};font-family:${text.fontFamily};background:transparent;border:1px solid var(--pastel-mint);outline:none;padding:2px 4px;min-width:100px;z-index:1000;`;
  }

  _updateTextEditorPosition(): void {
    if (!this._editingTextInput || !this._editingTextId) return;
    for (const layer of this._layerManager.layers) {
      if (layer.texts) {
        const text = layer.texts.find(t => t.id === this._editingTextId);
        if (text) { this._updateTextInputPosition(this._editingTextInput, text); break; }
      }
    }
  }

  override renderContent(): string {
    const ts = this._toolManager.textSettings;
    return `
      <div class="drawing-board-toolbar">
        <button class="draw-tool-btn" data-tool="pan" title="平移画布 (H)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 9l-3 3 3 3"/><path d="M9 5l3-3 3 3"/><path d="M15 19l-3 3-3-3"/><path d="M19 9l3 3-3 3"/><path d="M2 12h20"/><path d="M12 2v20"/></svg></button>
        <button class="draw-tool-btn" data-tool="select" title="选择/移动 (V)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></svg></button>
        <button class="draw-tool-btn" data-tool="brush" title="画笔 (B)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/></svg></button>
        <button class="draw-tool-btn" data-tool="eraser" title="橡皮擦 (E)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 20H7L3 16c-.8-.8-.8-2 0-2.8l10-10c.8-.8 2-.8 2.8 0l6 6c.8.8.8 2 0 2.8L14 20"/><path d="M6 11l8 8"/></svg></button>
        <button class="draw-tool-btn" data-tool="text" title="文字 (T)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7V4h16v3"/><path d="M12 4v16"/><path d="M8 20h8"/></svg></button>
        <div class="draw-tool-divider"></div>
        <button class="draw-tool-btn" data-action="addLayer" title="新建图层"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8"/><path d="M8 12h8"/></svg></button>
        <button class="draw-tool-btn" data-action="deleteLayer" title="删除图层"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/></svg></button>
        <div class="draw-tool-divider"></div>
        <button class="draw-tool-btn" data-action="undo" title="撤销 (Ctrl+Z)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 00-9-9 9 9 0 00-6 2.3L3 13"/></svg></button>
        <button class="draw-tool-btn" data-action="redo" title="重做 (Ctrl+Y)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 019-9 9 9 0 016 2.3l3 2.7"/></svg></button>
        <div class="draw-tool-spacer"></div>
        <div class="canvas-size-display" title="画布尺寸" data-action="canvasSize">${this.canvasConfig.width} × ${this.canvasConfig.height}</div>
        <div class="zoom-control">
          <button class="zoom-btn" data-action="zoomOut" title="缩小">-</button>
          <span class="zoom-level">${Math.round(this._viewController.zoom * 100)}%</span>
          <button class="zoom-btn" data-action="zoomIn" title="放大">+</button>
          <button class="zoom-btn" data-action="zoomFit" title="适应窗口"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 00-2 2v3"/><path d="M21 8V5a2 2 0 00-2-2h-3"/><path d="M3 16v3a2 2 0 002 2h3"/><path d="M16 21h3a2 2 0 002-2v-3"/></svg></button>
        </div>
      </div>
      <div class="drawing-board-main">
        <div class="drawing-board-canvas-wrap" id="canvas-wrap-${this.id}">
          <div class="drawing-board-canvas-content">
            <div class="drawing-board-canvas-scaled">
              <canvas class="drawing-board-canvas" id="canvas-${this.id}" width="${this.canvasConfig.width}" height="${this.canvasConfig.height}"></canvas>
            </div>
          </div>
        </div>
        <div class="drawing-board-sidebar">
          <div class="layers-panel">
            <div class="layers-header">
              <span>图层</span>
              <button class="add-layer-btn" data-action="addLayerFromPanel" title="添加图层"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14"/><path d="M5 12h14"/></svg></button>
            </div>
            <div class="layers-list" id="layers-list-${this.id}"></div>
          </div>
          <div class="brush-settings-panel" id="brush-panel">
            <div class="panel-title">画笔设置</div>
            <div class="brush-size-row"><label>大小</label><input type="range" class="brush-size-slider" min="1" max="100" value="${this._toolManager.brushSettings.size}"><span class="brush-size-value">${this._toolManager.brushSettings.size}px</span></div>
            <div class="brush-color-row"><label>颜色</label><input type="color" class="brush-color-picker" value="${this._toolManager.brushSettings.color}"></div>
            <div class="brush-opacity-row"><label>不透明度</label><input type="range" class="brush-opacity-slider" min="0" max="100" value="${this._toolManager.brushSettings.opacity * 100}"><span class="brush-opacity-value">${Math.round(this._toolManager.brushSettings.opacity * 100)}%</span></div>
          </div>
          <div class="eraser-settings-panel hidden" id="eraser-panel">
            <div class="panel-title">橡皮擦设置</div>
            <div class="eraser-size-row"><label>大小</label><input type="range" class="eraser-size-slider" min="5" max="100" value="${this._toolManager.eraserSettings.size}"><span class="eraser-size-value">${this._toolManager.eraserSettings.size}px</span></div>
          </div>
          <div class="text-settings-panel hidden" id="text-panel">
            <div class="panel-title">文字设置</div>
            <div class="text-size-row"><label>字号</label><input type="range" class="text-size-slider" min="12" max="200" value="${ts.fontSize}"><span class="text-size-value">${ts.fontSize}px</span></div>
            <div class="text-color-row"><label>颜色</label><input type="color" class="text-color-picker" value="${ts.color}"></div>
            <div class="text-font-row"><label>字体</label><select class="text-font-select"><option value="sans-serif" ${ts.fontFamily === 'sans-serif' ? 'selected' : ''}>默认字体</option><option value="serif" ${ts.fontFamily === 'serif' ? 'selected' : ''}>宋体</option><option value="Microsoft YaHei" ${ts.fontFamily === 'Microsoft YaHei' ? 'selected' : ''}>黑体</option><option value="cursive" ${ts.fontFamily === 'cursive' ? 'selected' : ''}>楷体</option><option value="monospace" ${ts.fontFamily === 'monospace' ? 'selected' : ''}>等宽</option></select></div>
          </div>
        </div>
      </div>
      <div class="drawing-board-footer">
        <button class="apply-btn" data-action="apply"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg> 应用</button>
      </div>
    `;
  }

  override createElement(): HTMLElement {
    const el = super.createElement();
    el.classList.add('drawing-board-card');
    (el.querySelector('.card-body') as HTMLElement).style.cssText = 'padding:0; display:flex; flex-direction:column; overflow:hidden;';
    setTimeout(() => { this._init(); }, 0);
    return el;
  }

  private _init(): void {
    this._renderer.init();
    this._toolManager.initUI();
    this._layerManager.preloadImages(() => {
      this._renderLayersList(); this._renderer.render();
      this._renderer.syncDrawingLayerFromLayer(this._layerManager.getSelected());
      this._viewController.init();
      const hasOwnLayers = this._layerManager.layers.some(l => l.type === 'image' || (l.drawings?.length ?? 0) > 0 || (l.texts?.length ?? 0) > 0);
      if (!hasOwnLayers) this._loadLayersFromConnections();
    });
    this._bindToolbarEvents();
    this._bindLayerEvents();
    this._bindSettingsEvents();
    this._bindKeyboardShortcuts();
    this._inputHandler.init();
  }

  private _bindToolbarEvents(): void {
    const toolbar = this.element?.querySelector('.drawing-board-toolbar');
    if (!toolbar) return;
    toolbar.querySelectorAll('.draw-tool-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tool = (btn as HTMLElement).dataset.tool;
        const action = (btn as HTMLElement).dataset.action;
        if (tool) {
          if (this._isDrawing && this._isErasing) this._finishDrawing();
          this._toolManager.setTool(tool);
        } else if (action === 'undo') this.undo();
        else if (action === 'redo') this.redo();
        else if (action) this._handleToolbarAction(action);
      });
    });
    const zoomInBtn = toolbar.querySelector('[data-action="zoomIn"]');
    const zoomOutBtn = toolbar.querySelector('[data-action="zoomOut"]');
    const zoomFitBtn = toolbar.querySelector('[data-action="zoomFit"]');
    const sizeDisplay = toolbar.querySelector('[data-action="canvasSize"]');
    const applyBtn = this.element?.querySelector('[data-action="apply"]');
    zoomInBtn?.addEventListener('click', () => this._viewController.zoomIn());
    zoomOutBtn?.addEventListener('click', () => this._viewController.zoomOut());
    zoomFitBtn?.addEventListener('click', () => this._viewController.fitToWindow());
    sizeDisplay?.addEventListener('click', () => DrawingBoardCard._showCanvasSizeDialog(this.id));
    applyBtn?.addEventListener('click', () => this.apply());
  }

  private _handleToolbarAction(action: string): void {
    switch (action) {
      case 'addLayer': case 'addLayerFromPanel':
        this._layerManager.createLayer(`图层 ${this._layerManager.layers.length + 1}`);
        this._historyManager.save(); this._renderLayersList(); break;
      case 'deleteLayer':
        if (this._layerManager.deleteLayer(this._layerManager.getSelectedIndex())) {
          this._historyManager.save(); this._renderLayersList(); this._renderer.render();
        } break;
    }
  }

  private _finishDrawing(): void {
    this._isDrawing = false; this._isErasing = false;
  }

  apply(): void { this.notifyDownstream(); }

  private _bindLayerEvents(): void {
    const list = this.element?.querySelector('.layers-list');
    if (!list) return;
    let draggedIndex: number | null = null; let draggedOverIndex: number | null = null;
    list.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest('.layer-item');
      if (item) {
        const index = parseInt((item as HTMLElement).dataset.index || '0', 10);
        this._layerManager.setSelected(index);
        this._renderer.syncDrawingLayerFromLayer(this._layerManager.getSelected());
        this._renderLayersList(); this._renderer.render();
      }
      const visibilityBtn = (e.target as HTMLElement).closest('.layer-visibility-btn');
      if (visibilityBtn) {
        const index = parseInt(((visibilityBtn as HTMLElement).closest('.layer-item') as HTMLElement).dataset.index || '0', 10);
        if (this._layerManager.toggleVisibility(index)) { this._historyManager.save(); this._renderLayersList(); this._renderer.render(); }
      }
      const lockBtn = (e.target as HTMLElement).closest('.layer-lock-btn');
      if (lockBtn) {
        const index = parseInt(((lockBtn as HTMLElement).closest('.layer-item') as HTMLElement).dataset.index || '0', 10);
        if (this._layerManager.toggleLock(index)) { this._historyManager.save(); this._renderLayersList(); }
      }
      const deleteBtn = (e.target as HTMLElement).closest('.layer-delete-btn');
      if (deleteBtn) {
        const index = parseInt(((deleteBtn as HTMLElement).closest('.layer-item') as HTMLElement).dataset.index || '0', 10);
        if (this._layerManager.deleteLayer(index)) { this._historyManager.save(); this._renderLayersList(); this._renderer.render(); }
      }
    });
    list.addEventListener('dragstart', (e) => {
      const item = (e.target as HTMLElement).closest('.layer-item');
      if (item) { draggedIndex = parseInt((item as HTMLElement).dataset.index || '0', 10); (item as HTMLElement).classList.add('dragging'); (e as DragEvent).dataTransfer!.effectAllowed = 'move'; }
    });
    list.addEventListener('dragend', (e) => {
      const item = (e.target as HTMLElement).closest('.layer-item');
      if (item) (item as HTMLElement).classList.remove('dragging');
      draggedIndex = null; draggedOverIndex = null;
    });
    list.addEventListener('dragover', (e) => {
      e.preventDefault(); (e as DragEvent).dataTransfer!.dropEffect = 'move';
      const item = (e.target as HTMLElement).closest('.layer-item');
      if (item && draggedIndex !== null) {
        const overIndex = parseInt((item as HTMLElement).dataset.index || '0', 10);
        if (overIndex !== draggedIndex && overIndex !== draggedOverIndex) {
          draggedOverIndex = overIndex;
          this._layerManager.swapLayers(draggedIndex, overIndex);
          draggedIndex = overIndex;
          this._renderLayersList();
        }
      }
    });
    list.addEventListener('drop', (e) => { e.preventDefault(); if (draggedIndex !== null && draggedOverIndex !== null) this._historyManager.save(); });
  }

  private _bindSettingsEvents(): void {
    const panel = this.element as HTMLElement | undefined;
    if (!panel) return;
    const sizeSlider = panel.querySelector('.brush-size-slider') as HTMLInputElement | null;
    sizeSlider?.addEventListener('input', (e) => { const value = parseInt((e.target as HTMLInputElement).value, 10); this._toolManager.updateBrushSetting('size', value); (panel.querySelector('.brush-size-value') as HTMLElement).textContent = value + 'px'; });
    const colorPicker = panel.querySelector('.brush-color-picker') as HTMLInputElement | null;
    colorPicker?.addEventListener('input', (e) => { this._toolManager.updateBrushSetting('color', (e.target as HTMLInputElement).value); });
    const opacitySlider = panel.querySelector('.brush-opacity-slider') as HTMLInputElement | null;
    opacitySlider?.addEventListener('input', (e) => { const value = parseInt((e.target as HTMLInputElement).value, 10) / 100; this._toolManager.updateBrushSetting('opacity', value); (panel.querySelector('.brush-opacity-value') as HTMLElement).textContent = Math.round(value * 100) + '%'; });
    const eraserSlider = panel.querySelector('.eraser-size-slider') as HTMLInputElement | null;
    eraserSlider?.addEventListener('input', (e) => { const value = parseInt((e.target as HTMLInputElement).value, 10); this._toolManager.updateEraserSetting('size', value); (panel.querySelector('.eraser-size-value') as HTMLElement).textContent = value + 'px'; });
    const textSizeSlider = panel.querySelector('.text-size-slider') as HTMLInputElement | null;
    textSizeSlider?.addEventListener('input', (e) => { const value = parseInt((e.target as HTMLInputElement).value, 10); this._toolManager.updateTextSetting('fontSize', value); (panel.querySelector('.text-size-value') as HTMLElement).textContent = value + 'px'; });
    const textColorPicker = panel.querySelector('.text-color-picker') as HTMLInputElement | null;
    textColorPicker?.addEventListener('input', (e) => { this._toolManager.updateTextSetting('color', (e.target as HTMLInputElement).value); });
    const textFontSelect = panel.querySelector('.text-font-select') as HTMLSelectElement | null;
    textFontSelect?.addEventListener('change', (e) => { this._toolManager.updateTextSetting('fontFamily', (e.target as HTMLSelectElement).value); });
  }

  private _bindKeyboardShortcuts(): void {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (this._editingTextId) return;
      if (!this.element?.contains(document.activeElement!) && document.activeElement !== document.body) return;
      switch (e.key.toLowerCase()) {
        case 'v': case 'b': case 'e': case 't': case 'h':
          if (this._isDrawing && this._isErasing) this._finishDrawing();
          this._toolManager.setTool(e.key.toLowerCase()); break;
        case 'delete': case 'backspace': this._deleteSelected(); break;
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    this._keyDownHandler = handleKeyDown;
  }

  private _deleteSelected(): void {
    if (this._editingTextId) {
      for (const layer of this._layerManager.layers) {
        if (layer.texts) {
          const idx = layer.texts.findIndex(t => t.id === this._editingTextId);
          if (idx !== -1) { layer.texts.splice(idx, 1); this._historyManager.save(); this._renderer.render(); return; }
        }
      }
    }
  }

  _renderLayersList(): void {
    const list = this.element?.querySelector('.layers-list');
    if (!list) return;
    const layers = this._layerManager.layers;
    const reversed = layers.map((layer, index) => ({ layer, index })).reverse();
    list.innerHTML = reversed.map(({ layer, index }) => `
      <div class="layer-item ${index === this._layerManager.getSelectedIndex() ? 'selected' : ''}" data-index="${index}" draggable="true">
        <button class="layer-visibility-btn" title="${layer.visible ? '隐藏' : '显示'}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${layer.visible ? '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>' : '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'}</svg></button>
        <button class="layer-lock-btn" title="${layer.locked ? '解锁' : '锁定'}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${layer.locked ? '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>' : '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 019.9-1"/>'}</svg></button>
        <span class="layer-thumbnail">${layer.imageData ? `<img src="${layer.imageData}" alt="">` : '<div class="empty-thumbnail"></div>'}</span>
        <span class="layer-name">${layer.name}</span>
        ${layers.length > 1 ? `<button class="layer-delete-btn" title="删除图层"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>` : ''}
        <input type="range" class="layer-opacity-slider" data-layer-index="${index}" min="0" max="100" value="${layer.opacity * 100}" title="不透明度">
      </div>
    `).join('');
    list.querySelectorAll('.layer-opacity-slider').forEach(slider => {
      const index = parseInt((slider as HTMLElement).dataset.layerIndex || '0', 10);
      slider.addEventListener('input', (e) => { const value = parseInt((e.target as HTMLInputElement).value, 10) / 100; this._layerManager.setOpacity(index, value); this._renderer.requestRender(); });
      slider.addEventListener('change', () => { this._historyManager.save(); });
    });
  }

  hasLocalUndo(): boolean { return true; }
  undo(): boolean { return this._historyManager.undo(); }
  redo(): boolean { return this._historyManager.redo(); }

  override serialize(): CardSerializedData {
    return {
      ...super.serialize(),
      canvasConfig: this.canvasConfig,
      ...this._layerManager.export(),
      ...this._viewController.export(),
      ...this._toolManager.export()
    } as CardSerializedData;
  }

  override destroy(): void {
    if (this._keyDownHandler) document.removeEventListener('keydown', this._keyDownHandler);
    if (this._editingTextInput) this._editingTextInput.remove();
    this._inputHandler.destroy();
    this._layerManager.clearCache();
    if (this._renderer._brushCursor) this._renderer._brushCursor.remove();
    super.destroy();
  }

  static _showCanvasSizeDialog(cardId: string): void {
    const card = CardFactory.getInstance(cardId);
    if (!card) return;
    const currentWidth = card.canvasConfig.width; const currentHeight = card.canvasConfig.height;
    const dialog = document.createElement('div');
    dialog.className = 'canvas-size-dialog';
    dialog.innerHTML = `
      <div class="dialog-overlay"></div>
      <div class="dialog-content">
        <div class="dialog-title">设置画布尺寸</div>
        <div class="dialog-body">
          <div class="size-row"><label>宽度 (px)</label><input type="number" class="size-width" value="${currentWidth}" min="100" max="4096"></div>
          <div class="size-row"><label>高度 (px)</label><input type="number" class="size-height" value="${currentHeight}" min="100" max="4096"></div>
          <div class="preset-sizes">
            <button class="preset-btn" data-size="512,512">512×512</button>
            <button class="preset-btn" data-size="1024,768">1024×768</button>
            <button class="preset-btn" data-size="1024,1024">1024×1024</button>
            <button class="preset-btn" data-size="1920,1080">1920×1080</button>
          </div>
        </div>
        <div class="dialog-footer"><button class="cancel-btn">取消</button><button class="confirm-btn">确定</button></div>
      </div>
    `;
    document.body.appendChild(dialog);
    const overlay = dialog.querySelector('.dialog-overlay');
    const cancelBtn = dialog.querySelector('.cancel-btn');
    const confirmBtn = dialog.querySelector('.confirm-btn');
    const widthInput = dialog.querySelector('.size-width') as HTMLInputElement;
    const heightInput = dialog.querySelector('.size-height') as HTMLInputElement;
    const presetBtns = dialog.querySelectorAll('.preset-btn');
    const closeDialog = () => dialog.remove();
    overlay?.addEventListener('click', closeDialog);
    cancelBtn?.addEventListener('click', closeDialog);
    presetBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const [w, h] = ((btn as HTMLElement).dataset.size || '').split(',').map(Number);
        if (!isNaN(w) && !isNaN(h)) { widthInput.value = String(w); heightInput.value = String(h); }
      });
    });
    confirmBtn?.addEventListener('click', () => {
      const newWidth = parseInt(widthInput.value, 10); const newHeight = parseInt(heightInput.value, 10);
      if (newWidth >= 100 && newHeight >= 100 && newWidth <= 4096 && newHeight <= 4096) {
        card.canvasConfig.width = newWidth; card.canvasConfig.height = newHeight;
        card._renderer.resize(newWidth, newHeight);
        card._historyManager.save(); card._renderer.render(); card._viewController._apply(); card._viewController.fitToWindow();
        const sizeDisplay = card.element?.querySelector('.canvas-size-display');
        if (sizeDisplay) sizeDisplay.textContent = `${newWidth} × ${newHeight}`;
        closeDialog();
      }
    });
  }
}
