// gui/js/cards/DrawingBoardCard.js
// UI组件版：字体选择 UISelect，尺寸输入 UIInput

// ═══════════════════════════════════════════════════════════════════════════
// 工具管理器 - 负责工具状态切换、设置管理、光标更新
// ═══════════════════════════════════════════════════════════════════════════
class DrawingBoardToolManager {
    constructor(card) {
        this._card = card;
        
        // 工具类型
        this.TOOLS = {
            SELECT: 'select',
            BRUSH: 'brush',
            ERASER: 'eraser',
            TEXT: 'text',
            PAN: 'pan'
        };
        
        // 当前工具
        this.currentTool = 'pan';
        
        // 画笔设置
        this.brushSettings = {
            size: 10,
            hardness: 0.8,
            color: '#000000',
            opacity: 1.0
        };
        
        // 橡皮擦设置
        this.eraserSettings = {
            size: 20
        };
        
        // 文字设置
        this.textSettings = {
            fontSize: 32,
            color: '#000000',
            fontFamily: 'sans-serif'
        };
    }
    
    // 从序列化数据恢复
    restore(settings) {
        if (!settings) return;
        this.brushSettings = { ...this.brushSettings, ...settings.brushSettings };
        this.eraserSettings = { ...this.eraserSettings, ...settings.eraserSettings };
        this.textSettings = { ...this.textSettings, ...settings.textSettings };
    }
    
    // 导出设置
    export() {
        return {
            brushSettings: { ...this.brushSettings },
            eraserSettings: { ...this.eraserSettings },
            textSettings: { ...this.textSettings }
        };
    }
    
    // 设置当前工具
    setTool(tool) {
        if (!Object.values(this.TOOLS).includes(tool)) return;
        this.currentTool = tool;
        this._updateUI();
        this._updateCursor();

        // 切换到笔刷/橡皮工具时，显示圆圈光标
        if (tool === 'brush' || tool === 'eraser') {
            const size = tool === 'brush' ? this.brushSettings.size : this.eraserSettings.size;
            const color = tool === 'brush' ? this.brushSettings.color : null;
            this._card._renderer.updateBrushCursor(true, size, color);
        } else {
            this._card._renderer.updateBrushCursor(false);
        }

        // 切换工具时重绘画布，使选择框在非选择工具下消失
        this._card._renderer?.requestRender();
    }
    
    // 更新画笔设置
    updateBrushSetting(key, value) {
        if (key in this.brushSettings) {
            this.brushSettings[key] = value;
            this._updateCursor();
            // 更新圆圈大小（如果当前是画笔工具）
            if (this.currentTool === 'brush') {
                this._card._renderer.updateBrushCursor(true, this.brushSettings.size, this.brushSettings.color);
            }
        }
    }

    // 更新橡皮擦设置
    updateEraserSetting(key, value) {
        if (key in this.eraserSettings) {
            this.eraserSettings[key] = value;
            this._updateCursor();
            // 更新圆圈大小（如果当前是橡皮工具）
            if (this.currentTool === 'eraser') {
                this._card._renderer.updateBrushCursor(true, this.eraserSettings.size, null);
            }
        }
    }
    
    // 更新文字设置
    updateTextSetting(key, value) {
        if (key in this.textSettings) {
            this.textSettings[key] = value;
        }
    }
    
    // 更新 UI 选中状态
    _updateUI() {
        const toolbar = this._card.element?.querySelector('.drawing-board-toolbar');
        if (!toolbar) return;
        
        toolbar.querySelectorAll('.draw-tool-btn[data-tool]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tool === this.currentTool);
        });
        
        // 显示/隐藏相应的设置面板
        this._card.element?.querySelector('.brush-settings-panel')?.classList.toggle('hidden', this.currentTool !== this.TOOLS.BRUSH);
        this._card.element?.querySelector('.eraser-settings-panel')?.classList.toggle('hidden', this.currentTool !== this.TOOLS.ERASER);
        this._card.element?.querySelector('.text-settings-panel')?.classList.toggle('hidden', this.currentTool !== this.TOOLS.TEXT);
    }
    
    // 更新画布光标
    _updateCursor() {
        const canvas = this._card._renderer?._canvas;
        if (!canvas) return;
        
        switch (this.currentTool) {
            case this.TOOLS.SELECT:
                canvas.style.cursor = 'default';
                break;
            case this.TOOLS.BRUSH:
            case this.TOOLS.ERASER: {
                // 笔刷/橡皮只用圆环光标（_brushCursor），隐藏原生光标避免重复
                canvas.style.cursor = 'none';
                break;
            }
            case this.TOOLS.TEXT:
                canvas.style.cursor = 'text';
                break;
            case this.TOOLS.PAN:
                canvas.style.cursor = 'grab';
                break;
        }
    }
    
    // 初始化 UI
    initUI() {
        this._updateUI();
        this._updateCursor();
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 图层管理器 - 负责图层 CRUD、排序、可见性、锁定
// ═══════════════════════════════════════════════════════════════════════════
class DrawingBoardLayerManager {
    constructor(card) {
        this._card = card;
        this.layers = [];
        this.selectedIndex = 0;
        
        // 图片缓存
        this._imageCache = new Map();
    }
    
    // 从序列化数据恢复
    restore(data) {
        this.layers = data.layers || [];
        this.selectedIndex = data.selectedLayerIndex ?? 0;
        
        // 重建图片缓存
        this.layers.forEach(layer => {
            if (layer.imageData) {
                const img = new Image();
                img.onload = () => this._card._renderer.requestRender();
                img.onerror = () => { layer.imageData = null; };
                img.src = layer.imageData;
                this._imageCache.set(layer.imageData, img);
            }
        });
    }
    
    // 导出数据
    export() {
        return {
            layers: this.layers.map(l => ({ ...l })),
            selectedLayerIndex: this.selectedIndex
        };
    }
    
    // 获取选中的图层
    getSelected() {
        if (this.selectedIndex >= 0 && this.selectedIndex < this.layers.length) {
            return this.layers[this.selectedIndex];
        }
        return null;
    }
    
    // 获取选中的图层索引
    getSelectedIndex() {
        return this.selectedIndex;
    }
    
    // 设置选中的图层
    setSelected(index) {
        if (index >= 0 && index < this.layers.length) {
            this.selectedIndex = index;
        }
    }
    
    // 创建空图层
    createLayer(name = '新图层') {
        const layer = {
            id: `layer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            type: 'empty',
            name: name,
            imageData: null,
            x: 0,
            y: 0,
            width: null,
            height: null,
            opacity: 1,
            visible: true,
            locked: false,
            drawings: [],
            texts: []
        };
        this.layers.push(layer);
        this.selectedIndex = this.layers.length - 1;
        return layer;
    }
    
    // 删除图层
    deleteLayer(index) {
        if (this.layers.length <= 1) return false;
        if (index < 0 || index >= this.layers.length) return false;
        
        this.layers.splice(index, 1);
        if (this.selectedIndex >= this.layers.length) {
            this.selectedIndex = this.layers.length - 1;
        }
        return true;
    }
    
    // 切换图层可见性
    toggleVisibility(index) {
        if (index >= 0 && index < this.layers.length) {
            this.layers[index].visible = !this.layers[index].visible;
            return true;
        }
        return false;
    }
    
    // 切换图层锁定
    toggleLock(index) {
        if (index >= 0 && index < this.layers.length) {
            this.layers[index].locked = !this.layers[index].locked;
            return true;
        }
        return false;
    }
    
    // 交换图层顺序
    swapLayers(fromIndex, toIndex) {
        if (fromIndex < 0 || fromIndex >= this.layers.length) return false;
        if (toIndex < 0 || toIndex >= this.layers.length) return false;
        
        const temp = this.layers[fromIndex];
        this.layers.splice(fromIndex, 1);
        this.layers.splice(toIndex, 0, temp);
        
        // 更新选中索引
        if (this.selectedIndex === fromIndex) {
            this.selectedIndex = toIndex;
        } else if (fromIndex < this.selectedIndex && toIndex >= this.selectedIndex) {
            this.selectedIndex--;
        } else if (fromIndex > this.selectedIndex && toIndex <= this.selectedIndex) {
            this.selectedIndex++;
        }
        return true;
    }
    
    // 更新图层不透明度
    setOpacity(index, opacity) {
        if (index >= 0 && index < this.layers.length) {
            this.layers[index].opacity = Math.max(0, Math.min(1, opacity));
            return true;
        }
        return false;
    }
    
    // 从上游设置图片图层
    setImageLayers(imageLayers) {
        this.layers = imageLayers;
        if (this.layers.length > 0 && this.selectedIndex === -1) {
            this.selectedIndex = 0;
        }
    }
    
    // 获取图层图片缓存
    getImage(imageData) {
        if (!imageData) return null;

        if (this._imageCache.has(imageData)) {
            return this._imageCache.get(imageData);
        }

        const img = new Image();
        img.onload = () => {
            const layer = this.layers.find(l => l.imageData === imageData);
            if (layer) {
                layer.width = img.naturalWidth;
                layer.height = img.naturalHeight;
                this._card._ensureCanvasFitsImage?.(layer, img);
            }
            // 不再这里调用 requestRender，由外部控制渲染时机
        };
        img.onerror = () => { this._imageCache.delete(imageData); };
        img.src = imageData;
        this._imageCache.set(imageData, img);
        return img;
    }
    
    // 预加载图片
    preloadImages(onComplete) {
        let loadedCount = 0;
        let totalCount = 0;

        this.layers.forEach(layer => {
            if (layer.imageData && !this._imageCache.has(layer.imageData)) {
                totalCount++;
                const img = new Image();
                img.onload = () => {
                    const layer = this.layers.find(l => l.imageData === img.src);
                    if (layer) {
                        layer.width = img.naturalWidth;
                        layer.height = img.naturalHeight;
                        this._card._ensureCanvasFitsImage?.(layer, img);
                    }
                    loadedCount++;
                    if (onComplete && loadedCount === totalCount) {
                        onComplete();
                    }
                };
                img.onerror = () => {
                    loadedCount++;
                    this._imageCache.delete(layer.imageData);
                    if (onComplete && loadedCount === totalCount) {
                        onComplete();
                    }
                };
                img.src = layer.imageData;
                this._imageCache.set(layer.imageData, img);
            }
        });

        // 如果没有图片需要加载，直接调用回调
        if (onComplete && totalCount === 0) {
            onComplete();
        }
    }
    
    // 清理缓存
    clearCache() {
        this._imageCache.clear();
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 视图控制器 - 负责缩放、平移、适应窗口
// ═══════════════════════════════════════════════════════════════════════════
class DrawingBoardViewController {
    constructor(card) {
        this._card = card;
        
        this.zoom = 1.0;
        this.panX = 0;
        this.panY = 0;
        
        this.MIN_ZOOM = 0.25;
        this.MAX_ZOOM = 4.0;
    }
    
    // 从序列化数据恢复
    restore(data) {
        this.zoom = data.viewZoom ?? 1.0;
        this.panX = data.viewPanX ?? 0;
        this.panY = data.viewPanY ?? 0;
    }
    
    // 导出数据
    export() {
        return {
            viewZoom: this.zoom,
            viewPanX: this.panX,
            viewPanY: this.panY
        };
    }
    
    // 以指定点为中心缩放
    zoomAtPoint(newZoom, anchorX, anchorY) {
        const oldZoom = this.zoom;
        newZoom = Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, newZoom));
        
        if (newZoom === oldZoom) return;
        
        // 计算新的平移量，保持锚点位置不变
        this.panX = this.panX + (anchorX - this.panX) * (oldZoom - newZoom) / oldZoom;
        this.panY = this.panY + (anchorY - this.panY) * (oldZoom - newZoom) / oldZoom;
        
        this.zoom = newZoom;
        this._apply();
    }
    
    // 以视口中心为锚点缩放
    zoomCenter(newZoom) {
        const wrap = this._card.element?.querySelector('.drawing-board-canvas-wrap');
        if (!wrap) {
            this.zoom = Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, newZoom));
            this._apply();
            return;
        }
        this.zoomAtPoint(newZoom, wrap.clientWidth / 2, wrap.clientHeight / 2);
    }
    
    // 以鼠标位置缩放（滚轮）
    zoomAtMouse(newZoom, mouseX, mouseY) {
        this.zoomAtPoint(newZoom, mouseX, mouseY);
    }
    
    // 设置缩放
    setZoom(newZoom) {
        this.zoomCenter(newZoom);
    }
    
    // 放大
    zoomIn() {
        this.setZoom(this.zoom + 0.1);
    }
    
    // 缩小
    zoomOut() {
        this.setZoom(this.zoom - 0.1);
    }
    
    // 开始平移
    startPan(x, y) {
        this._panStartX = x;
        this._panStartY = y;
        this._panInitialX = this.panX;
        this._panInitialY = this.panY;
        this._isPanning = true;
    }
    
    // 继续平移
    updatePan(x, y) {
        if (!this._isPanning) return;
        this.panX = this._panInitialX + (x - this._panStartX);
        this.panY = this._panInitialY + (y - this._panStartY);
        this._apply();
    }
    
    // 结束平移
    endPan() {
        this._isPanning = false;
    }
    
    // 是否正在平移
    isPanning() {
        return this._isPanning;
    }
    
    // 适应窗口
    fitToWindow() {
        const wrap = this._card.element?.querySelector('.drawing-board-canvas-wrap');
        if (!wrap) return;
        
        const cw = this._card.canvasConfig.width;
        const ch = this._card.canvasConfig.height;
        const wrapW = wrap.clientWidth - 40;
        const wrapH = wrap.clientHeight - 40;
        
        if (wrapW <= 0 || wrapH <= 0) return;
        
        const fitZoom = Math.min(wrapW / cw, wrapH / ch, 1);
        this.zoom = Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, fitZoom));
        this.panX = (wrap.clientWidth - cw * this.zoom) / 2;
        this.panY = (wrap.clientHeight - ch * this.zoom) / 2;
        
        this._apply();
    }
    
    // 坐标转换：视口(屏幕)坐标 -> 画布像素坐标
    // 必须用 canvas 实际渲染尺寸与 getBoundingClientRect 的比值，不能把外层无限画布的 scale 漏掉
    screenToCanvas(screenX, screenY) {
        const canvas = this._card._renderer?._canvas;
        if (!canvas) return { x: 0, y: 0 };

        const rect = canvas.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return { x: 0, y: 0 };

        const sx = canvas.width / rect.width;
        const sy = canvas.height / rect.height;
        const x = (screenX - rect.left) * sx;
        const y = (screenY - rect.top) * sy;

        return { x, y };
    }

    /** 视口 1px 对应多少画布像素（笔刷/橡皮线宽与圆圈光标一致） */
    screenPxToCanvasPx() {
        const canvas = this._card._renderer?._canvas;
        if (!canvas) return 1 / this.zoom;

        const rect = canvas.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return 1 / this.zoom;

        const sx = canvas.width / rect.width;
        const sy = canvas.height / rect.height;
        return (sx + sy) / 2;
    }
    
    // 应用视图到 DOM
    _apply() {
        const content = this._card.element?.querySelector('.drawing-board-canvas-content');
        const scaled = this._card.element?.querySelector('.drawing-board-canvas-scaled');
        const zoomLevel = this._card.element?.querySelector('.zoom-level');

        if (content) {
            const cw = this._card.canvasConfig.width;
            const ch = this._card.canvasConfig.height;
            content.style.width = `${cw * this.zoom}px`;
            content.style.height = `${ch * this.zoom}px`;
            content.style.transform = `translate(${this.panX}px, ${this.panY}px)`;
        }

        if (scaled) {
            const cw = this._card.canvasConfig.width;
            const ch = this._card.canvasConfig.height;
            scaled.style.width = `${cw}px`;
            scaled.style.height = `${ch}px`;
            scaled.style.transform = `scale(${this.zoom})`;
            scaled.style.transformOrigin = '0 0';
        }

        if (zoomLevel) {
            zoomLevel.textContent = Math.round(this.zoom * 100) + '%';
        }

        // 更新文字编辑框位置
        this._card._updateTextEditorPosition?.();

        // zoom 变化时更新笔刷/橡皮圆圈大小
        const tool = this._card._toolManager?.currentTool;
        if (tool === 'brush' || tool === 'eraser') {
            const size = tool === 'brush'
                ? this._card._toolManager.brushSettings.size
                : this._card._toolManager.eraserSettings.size;
            const color = tool === 'brush' ? this._card._toolManager.brushSettings.color : null;
            this._card._renderer.updateBrushCursor(true, size, color);
        }
    }
    
    // 初始化视图
    init() {
        this._apply();
        this.fitToWindow();
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 历史管理器 - 撤销/重做
// ═══════════════════════════════════════════════════════════════════════════
class DrawingBoardHistoryManager {
    constructor(card, maxHistory = 50) {
        this._card = card;
        this._maxHistory = maxHistory;
        this._history = [];
        this._index = -1;
        // 标记是否刚执行了撤销/重做，用于阻止上游图片自动刷新
        this._justRestored = false;
    }

    // 保存当前状态
    save() {
        const layerState = this._card._layerManager.export();
        const viewState = this._card._viewController.export();
        const state = { ...layerState, ...viewState };

        this._history = this._history.slice(0, this._index + 1);
        this._history.push(JSON.stringify(state));

        if (this._history.length > this._maxHistory) {
            this._history.shift();
        } else {
            this._index++;
        }

        // 保存新操作后，清除撤销标记，允许上游刷新
        this._justRestored = false;
    }

    // 检查是否刚执行了撤销/重做（用于阻止上游图片刷新）
    isJustRestored() {
        return this._justRestored;
    }
    
    // 撤销
    undo() {
        if (this._index > 0) {
            this._index--;
            this._restore();
            return true;
        }
        return false;
    }
    
    // 重做
    redo() {
        if (this._index < this._history.length - 1) {
            this._index++;
            this._restore();
            return true;
        }
        return false;
    }
    
    // 从历史恢复
    _restore() {
        const state = JSON.parse(this._history[this._index]);
        this._card._layerManager.restore(state);
        this._card._viewController.restore(state);
        this._card._viewController._apply();
        this._card._renderer.syncDrawingLayerFromLayer(this._card._layerManager.getSelected());
        this._card._renderer.render();
        this._card._renderLayersList();

        // 标记刚执行了撤销/重做，阻止上游图片自动刷新
        this._justRestored = true;
    }
    
    // 是否有撤销
    canUndo() {
        return this._index > 0;
    }
    
    // 是否有重做
    canRedo() {
        return this._index < this._history.length - 1;
    }
    
    // 清空历史
    clear() {
        this._history = [];
        this._index = -1;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 渲染器 - 负责画布渲染
// ═══════════════════════════════════════════════════════════════════════════
class DrawingBoardRenderer {
    constructor(card) {
        this._card = card;
        this._ctx = null;
        this._canvas = null;
        this._pendingRender = false;
        // 当前图层的「笔触层」画布（透明底），橡皮只擦这里，露出下层图片
        this._drawingLayerCanvas = null;
        this._drawingLayerCtx = null;
    }
    
    // 初始化
    init() {
        this._canvas = this._card.element?.querySelector('.drawing-board-canvas');
        this._ctx = this._canvas?.getContext('2d');

        const w = this._card.canvasConfig.width;
        const h = this._card.canvasConfig.height;
        this._drawingLayerCanvas = document.createElement('canvas');
        this._drawingLayerCanvas.width = w;
        this._drawingLayerCanvas.height = h;
        this._drawingLayerCtx = this._drawingLayerCanvas.getContext('2d');
        if (this._drawingLayerCtx) {
            this._drawingLayerCtx.imageSmoothingEnabled = true;
            this._drawingLayerCtx.imageSmoothingQuality = 'high';
        }

        // 创建笔刷/橡皮大小圆圈（跟随鼠标）
        this._brushCursor = document.createElement('div');
        this._brushCursor.className = 'brush-cursor';
        this._brushCursor.style.cssText = `
            position: fixed;
            pointer-events: none;
            border: 1px solid rgba(0, 0, 0, 0.5);
            border-radius: 50%;
            transform: translate(-50%, -50%);
            z-index: 9999;
            display: none;
        `;
        document.body.appendChild(this._brushCursor);
    }

    // 更新圆圈光标（大小和位置在 InputHandler 里单独更新）
    // size 表示「当前视野下的直径（屏幕像素）」：光标固定为 size px，擦除/笔刷在画布上为 size/zoom 像素，显示也为 size px
    updateBrushCursor(visible, size, color) {
        if (!this._brushCursor) return;
        if (visible) {
            const diameter = Math.max(size, 10); // 最小 10px，屏幕像素
            this._brushCursor.style.width = diameter + 'px';
            this._brushCursor.style.height = diameter + 'px';
            this._brushCursor.style.borderColor = color || 'rgba(0,0,0,0.5)';
            this._brushCursor.style.display = 'block';
        } else {
            this._brushCursor.style.display = 'none';
        }
    }

    // 移动圆圈光标到指定屏幕坐标
    moveBrushCursor(screenX, screenY) {
        if (!this._brushCursor) return;
        this._brushCursor.style.left = screenX + 'px';
        this._brushCursor.style.top = screenY + 'px';
    }
    
    // 请求渲染（防抖）
    requestRender() {
        if (this._pendingRender) return;
        this._pendingRender = true;
        requestAnimationFrame(() => {
            this.render();
            this._pendingRender = false;
        });
    }
    
    // 渲染
    render() {
        if (!this._ctx) return;
        
        const ctx = this._ctx;
        const w = this._card.canvasConfig.width;
        const h = this._card.canvasConfig.height;
        
        // 清空画布
        ctx.clearRect(0, 0, w, h);
        
        // 绘制背景
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        
        // 绘制图层
        const layerManager = this._card._layerManager;
        layerManager.layers.forEach((layer, index) => {
            if (!layer.visible) return;
            
            ctx.globalAlpha = layer.opacity;
            
            // 绘制图片
            if (layer.imageData) {
                this._drawImageLayer(ctx, layer);
            }
            
            // 绘制文字
            if (layer.texts) {
                layer.texts.forEach(text => {
                    ctx.font = `${text.fontSize}px ${text.fontFamily}`;
                    ctx.fillStyle = text.color;
                    ctx.fillText(text.text, text.x, text.y);
                });
            }
            
            // 绘制路径：当前图层用笔触层画布（透明底，橡皮只擦这里），其它图层用路径数组
            const isSelected = (index === this._card._layerManager.getSelectedIndex());
            if (isSelected && this._drawingLayerCtx) {
                ctx.drawImage(this._drawingLayerCanvas, 0, 0);
            } else if (layer.drawings) {
                layer.drawings.forEach(drawing => {
                    if (drawing.points && drawing.points.length > 0) {
                        this._drawPath(ctx, drawing);
                    }
                });
            }
        });
        
        ctx.globalAlpha = 1;
        
        // 绘制选中图层的选框和手柄（仅在选择工具下）
        if (this._card._toolManager.currentTool === 'select') {
            const hoverHandle = this._card._inputHandler?._hoverHandle || null;
            this._drawSelectionHandles(ctx, hoverHandle);
        }
    }
    
    // 绘制选中图层的选框和手柄
    _drawSelectionHandles(ctx, hoverHandle = null) {
        const layer = this._card._layerManager.getSelected();
        if (!layer || !layer.imageData) return;
        
        const img = this._card._layerManager.getImage(layer.imageData);
        if (!img || !img.complete || !img.naturalWidth) return;
        
        const x = layer.x;
        const y = layer.y;
        const width = layer.width || img.naturalWidth;
        const height = layer.height || img.naturalHeight;
        
        // 绘制选框（线宽再翻一倍）
        ctx.strokeStyle = '#0066ff';
        ctx.lineWidth = 8;
        ctx.setLineDash([8, 8]);
        ctx.strokeRect(x, y, width, height);
        ctx.setLineDash([]);
        
        // 计算手柄位置和大小（手柄也加大）
        const handleSize = 14;
        const handles = [
            { x: x, y: y, dir: 'nw' },
            { x: x + width / 2, y: y, dir: 'n' },
            { x: x + width, y: y, dir: 'ne' },
            { x: x + width, y: y + height / 2, dir: 'e' },
            { x: x + width, y: y + height, dir: 'se' },
            { x: x + width / 2, y: y + height, dir: 's' },
            { x: x, y: y + height, dir: 'sw' },
            { x: x, y: y + height / 2, dir: 'w' }
        ];
        
        // 绘制手柄（悬停时高亮显示）
        handles.forEach(h => {
            const isHovered = hoverHandle === h.dir;
            ctx.fillStyle = isHovered ? '#0066ff' : '#ffffff';
            ctx.strokeStyle = '#0066ff';
            ctx.lineWidth = 4;
            ctx.fillRect(h.x - handleSize / 2, h.y - handleSize / 2, handleSize, handleSize);
            ctx.strokeRect(h.x - handleSize / 2, h.y - handleSize / 2, handleSize, handleSize);
        });
    }
    
    // 绘制图片图层
    _drawImageLayer(ctx, layer) {
        const img = this._card._layerManager.getImage(layer.imageData);
        if (!img || !img.complete || !img.naturalWidth) return;
        
        const width = layer.width || img.naturalWidth;
        const height = layer.height || img.naturalHeight;
        
        ctx.drawImage(img, layer.x, layer.y, width, height);
    }
    
    // 绘制整条路径（用于从图层数据重绘、同步笔触层）
    _drawPath(ctx, path) {
        if (!path || !path.points || path.points.length < 2) return;

        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = path.size;
        ctx.strokeStyle = this._hexToRgba(path.color, path.opacity);
        ctx.beginPath();
        ctx.moveTo(path.points[0].x, path.points[0].y);
        for (let i = 1; i < path.points.length; i++) {
            ctx.lineTo(path.points[i].x, path.points[i].y);
        }
        ctx.stroke();
    }
    
    // Hex 转 RGBA
    _hexToRgba(hex, alpha) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    
    // 导出为图片
    toImage() {
        if (!this._ctx) return null;
        return this._canvas?.toDataURL('image/png') || null;
    }
    
    // 调整画布尺寸
    resize(width, height) {
        if (this._canvas) {
            this._canvas.width = width;
            this._canvas.height = height;
        }
        if (this._drawingLayerCanvas) {
            this._drawingLayerCanvas.width = width;
            this._drawingLayerCanvas.height = height;
        }
    }

    /** 把某图层的路径数组画到笔触层画布（透明底），用于当前图层 */
    syncDrawingLayerFromLayer(layer) {
        this._syncDrawingLayer(layer, null);
    }

    /**
     * 同步笔触层：先画已保存的路径，再画当前正在画的一笔（整条路径一次 stroke，抗锯齿更平滑）。
     * @param {Object} layer - 当前图层
     * @param {Object|null} currentPath - 当前笔触（含 points），为 null 则只画已保存的
     */
    _syncDrawingLayer(layer, currentPath) {
        if (!this._drawingLayerCtx || !layer) return;
        const w = this._drawingLayerCanvas.width;
        const h = this._drawingLayerCanvas.height;
        this._drawingLayerCtx.clearRect(0, 0, w, h);
        if (layer.drawings) {
            layer.drawings.forEach(drawing => {
                if (drawing.points && drawing.points.length > 0) {
                    this._drawPath(this._drawingLayerCtx, drawing);
                }
            });
        }
        if (currentPath && currentPath.points && currentPath.points.length >= 2) {
            this._drawPath(this._drawingLayerCtx, currentPath);
        }
    }

    /** 返回笔触层 ctx，画笔/橡皮只操作这一层 */
    getDrawingLayerCtx() {
        return this._drawingLayerCtx;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 输入处理器 - 统一管理所有输入事件
// ═══════════════════════════════════════════════════════════════════════════
class DrawingBoardInputHandler {
    constructor(card) {
        this._card = card;
        
        // 状态
        this._isDrawing = false;
        this._isErasing = false;
        this._isPanning = false;
        this._isDraggingLayer = false;
        this._isResizing = false;
        this._currentPath = null;
        this._lastX = 0;  // 橡皮擦用
        this._lastY = 0;  // 橡皮擦用
        this._draggedLayer = null;
        this._dragOffset = { x: 0, y: 0 };
        this._panStart = { x: 0, y: 0 };
        this._panInitial = { x: 0, y: 0 };
        this._lastPoint = { x: 0, y: 0 };
        
        // 缩放相关
        this._resizingHandle = null;      // 当前拖拽的手柄方向
        this._resizeStart = null;         // 缩放开始时的状态
        this._selectedImageLayer = null;   // 当前选中的图片图层（用于显示手柄）
        this._hoverHandle = null;         // 当前悬停的手柄方向
        
        // 手柄位置定义
        this._HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];  // 8个方向
        
        // 绑定方法
        this._boundHandleMouseDown = this._handleMouseDown.bind(this);
        this._boundHandleMouseMove = this._handleMouseMove.bind(this);
        this._boundHandleMouseUp = this._handleMouseUp.bind(this);
        this._boundHandleMouseLeave = this._handleMouseLeave.bind(this);
        this._boundHandleWheel = this._handleWheel.bind(this);
    }
    
    // 初始化事件
    init() {
        // 从渲染器获取 canvas
        const canvas = this._card._renderer._canvas;
        const canvasWrap = this._card.element?.querySelector('.drawing-board-canvas-wrap');
        
        if (!canvas || !canvasWrap) return;
        
        canvas.addEventListener('mousedown', this._boundHandleMouseDown);
        canvasWrap.addEventListener('mousedown', this._boundHandleMouseDown);
        canvas.addEventListener('mousemove', this._boundHandleMouseMove);
        canvas.addEventListener('mouseup', this._boundHandleMouseUp);
        canvas.addEventListener('mouseleave', this._boundHandleMouseLeave);
        
        canvasWrap.addEventListener('wheel', this._boundHandleWheel, { passive: false });
    }
    
    // 销毁
    destroy() {
        // 从渲染器获取 canvas
        const canvas = this._card._renderer._canvas;
        const canvasWrap = this._card.element?.querySelector('.drawing-board-canvas-wrap');
        
        canvas?.removeEventListener('mousedown', this._boundHandleMouseDown);
        canvas?.removeEventListener('mousemove', this._boundHandleMouseMove);
        canvas?.removeEventListener('mouseup', this._boundHandleMouseUp);
        canvas?.removeEventListener('mouseleave', this._boundHandleMouseLeave);
        canvasWrap?.removeEventListener('wheel', this._boundHandleWheel);
    }
    
    // 滚轮缩放
    _handleWheel(e) {
        // ── 防御性守卫：只有卡片处于选中态才处理滚轮缩放 ──
        const isSelected = this._card.element?.classList.contains('selected');
        if (!isSelected) {
            // 卡片未选中 → 让滚轮穿透给 Canvas 全局缩放
            return;
        }
        e.preventDefault();

        const canvasWrap = this._card.element?.querySelector('.drawing-board-canvas-wrap');
        const rect = canvasWrap.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        const newZoom = this._card._viewController.zoom * factor;

        this._card._viewController.zoomAtMouse(newZoom, mouseX, mouseY);
    }
    
    // 鼠标按下
    _handleMouseDown(e) {
        // ── 防御性守卫：只有卡片处于选中态才处理中键 ──
        if (e.button === 1) {
            const isSelected = this._card.element?.classList.contains('selected');
            if (!isSelected) {
                // 卡片未选中 → 不拦截中键，让事件穿透给 Canvas 全局漫游
                return;
            }
            // 卡片已选中 → 正常处理中键平移
            e.preventDefault();
            this._startPan(e.clientX, e.clientY);
            return;
        }
        
        // 只响应左键
        if (e.button !== 0) return;
        
        const tool = this._card._toolManager.currentTool;
        const coords = this._card._viewController.screenToCanvas(e.clientX, e.clientY);
        
        this._lastPoint = coords;
        
        // 工具模式平移
        if (tool === 'pan') {
            this._startPan(e.clientX, e.clientY);
            return;
        }
        
        const layer = this._card._layerManager.getSelected();
        
        switch (tool) {
            case 'brush':
                if (layer && !layer.locked) {
                    this._startDrawing(coords);
                }
                break;
            case 'eraser':
                // 橡皮擦可在任何图层上使用，不需要选中图层
                this._startErasing(coords);
                break;
            case 'select':
                this._trySelect(coords);
                break;
            case 'text':
                if (layer && !layer.locked) {
                    this._addText(coords);
                }
                break;
        }
    }
    
    // 鼠标移动
    _handleMouseMove(e) {
        const coords = this._card._viewController.screenToCanvas(e.clientX, e.clientY);
        const tool = this._card._toolManager.currentTool;

        // 更新笔刷/橡皮圆圈光标
        if (tool === 'brush' || tool === 'eraser') {
            const size = tool === 'brush'
                ? this._card._toolManager.brushSettings.size
                : this._card._toolManager.eraserSettings.size;
            const color = tool === 'brush'
                ? this._card._toolManager.brushSettings.color
                : null;
            this._card._renderer.updateBrushCursor(true, size, color);
            this._card._renderer.moveBrushCursor(e.clientX, e.clientY);
        } else {
            this._card._renderer.updateBrushCursor(false);
        }

        // 选择工具下更新光标和悬停状态
        if (tool === 'select' && !this._isDraggingLayer && !this._isResizing) {
            const hitHandle = this._hitTestHandle(coords);
            this._hoverHandle = hitHandle;
            if (hitHandle) {
                const cursors = {
                    nw: 'nwse-resize', se: 'nwse-resize',
                    ne: 'nesw-resize', sw: 'nesw-resize',
                    n: 'ns-resize', s: 'ns-resize',
                    e: 'ew-resize', w: 'ew-resize'
                };
                this._card.element.style.cursor = cursors[hitHandle] || 'default';
            } else {
                this._card.element.style.cursor = 'default';
            }
            // 重绘以显示悬停效果
            this._card._renderer.requestRender();
        }
        
        // 平移模式
        if (this._isPanning) {
            this._card._viewController.updatePan(e.clientX, e.clientY);
            return;
        }
        
        // 缩放模式（参考 Konva/StackOverflow 实现）
        if (this._isResizing && this._resizeStart) {
            const layer = this._resizeStart.layer;
            const start = this._resizeStart.bounds;
            const handle = this._resizingHandle;
            const mouseX = coords.x;
            const mouseY = coords.y;
            const shiftKey = e.shiftKey;
            
            const MIN_SIZE = 20;
            let newX = start.x;
            let newY = start.y;
            let newW = start.width;
            let newH = start.height;
            
            // 参考 Stack Overflow 的 switch 方式
            if (shiftKey) {
                // 等比缩放（以中心为锚点）
                const centerX = start.x + start.width / 2;
                const centerY = start.y + start.height / 2;
                const dx = mouseX - centerX;
                const dy = mouseY - centerY;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const startDist = Math.sqrt(start.width * start.width + start.height * start.height) / 2;
                const scale = dist / startDist;
                
                newW = Math.max(MIN_SIZE, start.width * scale);
                newH = Math.max(MIN_SIZE, start.height * scale);
                newX = centerX - newW / 2;
                newY = centerY - newH / 2;
            } else {
                // 非等比缩放，根据拖拽的手柄计算新尺寸和位置
                switch (handle) {
                    case 'e':
                        // 右边：宽度增加，位置不变
                        newW = Math.max(MIN_SIZE, mouseX - start.x);
                        break;
                    case 'w':
                        // 左边：宽度变化，x 坐标跟随鼠标
                        newW = Math.max(MIN_SIZE, start.x + start.width - mouseX);
                        newX = Math.min(mouseX, start.x + start.width - MIN_SIZE);
                        break;
                    case 's':
                        // 下边：高度增加，位置不变
                        newH = Math.max(MIN_SIZE, mouseY - start.y);
                        break;
                    case 'n':
                        // 上边：高度变化，y 坐标跟随鼠标
                        newH = Math.max(MIN_SIZE, start.y + start.height - mouseY);
                        newY = Math.min(mouseY, start.y + start.height - MIN_SIZE);
                        break;
                    case 'se':
                        // 右下角：宽高都增加
                        newW = Math.max(MIN_SIZE, mouseX - start.x);
                        newH = Math.max(MIN_SIZE, mouseY - start.y);
                        break;
                    case 'sw':
                        // 左下角：宽度向左变化，高度增加
                        newW = Math.max(MIN_SIZE, start.x + start.width - mouseX);
                        newX = Math.min(mouseX, start.x + start.width - MIN_SIZE);
                        newH = Math.max(MIN_SIZE, mouseY - start.y);
                        break;
                    case 'ne':
                        // 右上角：宽度增加，高度向上变化
                        newW = Math.max(MIN_SIZE, mouseX - start.x);
                        newH = Math.max(MIN_SIZE, start.y + start.height - mouseY);
                        newY = Math.min(mouseY, start.y + start.height - MIN_SIZE);
                        break;
                    case 'nw':
                        // 左上角：宽高都向左上变化
                        newW = Math.max(MIN_SIZE, start.x + start.width - mouseX);
                        newX = Math.min(mouseX, start.x + start.width - MIN_SIZE);
                        newH = Math.max(MIN_SIZE, start.y + start.height - mouseY);
                        newY = Math.min(mouseY, start.y + start.height - MIN_SIZE);
                        break;
                }
            }
            
            layer.x = newX;
            layer.y = newY;
            layer.width = newW;
            layer.height = newH;
            this._card._renderer.requestRender();
            return;
        }
        
        // 拖拽图层
        if (this._isDraggingLayer && this._draggedLayer) {
            this._draggedLayer.x = coords.x - this._dragOffset.x;
            this._draggedLayer.y = coords.y - this._dragOffset.y;
            this._card._renderer.requestRender();
            return;
        }
        
        // 绘制模式
        if (this._isDrawing) {
            const tool = this._card._toolManager.currentTool;
            
            if (tool === 'brush' && this._currentPath) {
                this._continueDrawing(coords);
            } else if (tool === 'eraser') {
                this._continueErasing(coords);
            }
        }
        
        this._lastPoint = coords;
    }
    
    // 鼠标松开
    _handleMouseUp(e) {
        if (this._isPanning) {
            this._endPan();
            return;
        }
        
        if (this._isResizing) {
            this._isResizing = false;
            this._resizingHandle = null;
            this._resizeStart = null;
            this._card._historyManager.save();
            return;
        }
        
        if (this._isDraggingLayer) {
            this._endDragging();
        }
        
        if (this._isDrawing) {
            this._finishDrawing();
        }
    }
    
    // 鼠标离开
    _handleMouseLeave(e) {
        // 隐藏笔刷/橡皮圆圈
        this._card._renderer.updateBrushCursor(false);

        if (this._isPanning) {
            this._endPan();
        }

        if (this._isDrawing) {
            this._finishDrawing();
        }
    }
    
    // 开始平移
    _startPan(x, y) {
        this._isPanning = true;
        this._card._viewController.startPan(x, y);
        if (this._card._renderer?._canvas) {
            this._card._renderer._canvas.style.cursor = 'grabbing';
        }
    }
    
    // 结束平移
    _endPan() {
        this._isPanning = false;
        this._card._viewController.endPan();
        this._card._toolManager._updateCursor();
    }
    
    // 开始绘制
    _startDrawing(coords) {
        this._isDrawing = true;
        const settings = this._card._toolManager.brushSettings;
        const lineW = settings.size * this._card._viewController.screenPxToCanvasPx();

        this._currentPath = {
            points: [{ x: coords.x, y: coords.y }],
            color: settings.color,
            size: lineW,
            opacity: settings.opacity,
            hardness: settings.hardness
        };
        // 历史记录在 _finishDrawing 中保存，避免空操作占用历史
    }
    
    // 继续绘制：插值保证点足够密，再整条路径一次 stroke，避免多段拼接的锯齿和串珠感
    _continueDrawing(coords) {
        if (!this._currentPath) return;

        const points = this._currentPath.points;
        const len = points.length;
        const last = len > 0 ? points[len - 1] : null;
        if (!last) {
            this._card._renderer.requestRender();
            return;
        }

        const dx = coords.x - last.x;
        const dy = coords.y - last.y;
        const dist = Math.hypot(dx, dy);
        // 固定约 2 像素一步：大笔刷时步长太疏会露出圆头，变成“串珠”
        const step = 2;
        if (dist > step) {
            const n = Math.ceil(dist / step);
            for (let i = 1; i < n; i++) {
                const t = i / n;
                points.push({
                    x: last.x + dx * t,
                    y: last.y + dy * t
                });
            }
        }
        points.push({ x: coords.x, y: coords.y });

        const layer = this._card._layerManager.getSelected();
        this._card._renderer._syncDrawingLayer(layer, this._currentPath);
        this._card._renderer.requestRender();
    }

    // 开始擦除（直接擦除模式，不记录路径）
    _startErasing(coords) {
        this._isDrawing = true;
        this._isErasing = true;
        this._lastX = coords.x;
        this._lastY = coords.y;
    }

    // 继续擦除（只擦笔触层，露出下层图片，不露白底）
    _continueErasing(coords) {
        if (!this._isDrawing) return;

        const ctx = this._card._renderer.getDrawingLayerCtx();
        if (!ctx) return;

        const size = this._card._toolManager.eraserSettings.size;
        const k = this._card._viewController.screenPxToCanvasPx();
        const lineWidthCanvas = Math.max(size * k, 1);
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.strokeStyle = 'rgba(0,0,0,1)';
        ctx.lineWidth = lineWidthCanvas;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        ctx.beginPath();
        ctx.moveTo(this._lastX, this._lastY);
        ctx.lineTo(coords.x, coords.y);
        ctx.stroke();

        ctx.restore();

        this._lastX = coords.x;
        this._lastY = coords.y;
        this._card._renderer.requestRender();
    }

    // 结束绘制/擦除
    _finishDrawing() {
        if (!this._isDrawing) return;

        const wasErasing = this._isErasing;
        this._isDrawing = false;
        this._isErasing = false;

        const layer = this._card._layerManager.getSelected();
        const tool = this._card._toolManager.currentTool;

        if (tool === 'brush') {
            // 画笔：先同步笔触层，再保存历史
            if (layer && this._currentPath && this._currentPath.points.length > 0) {
                layer.drawings.push({ ...this._currentPath });
                this._card._renderer.syncDrawingLayerFromLayer(layer);
                this._card._historyManager.save();
            }
            this._currentPath = null;
            this._card._renderer.render();
        }

        // 橡皮擦：不管最终工具是什么（可能中途切了），只要擦过就保存
        if (wasErasing) {
            this._card._historyManager.save();
        }
    }

    // 获取选中图片图层的边界和手柄位置
    _getSelectedImageBounds() {
        const layer = this._card._layerManager.getSelected();
        if (!layer || !layer.imageData) return null;
        
        const img = this._card._layerManager.getImage(layer.imageData);
        if (!img || !img.complete || !img.naturalWidth) return null;
        
        const width = layer.width || img.naturalWidth;
        const height = layer.height || img.naturalHeight;
        
        return {
            x: layer.x,
            y: layer.y,
            width: width,
            height: height,
            centerX: layer.x + width / 2,
            centerY: layer.y + height / 2
        };
    }

    // 获取手柄的屏幕坐标位置
    _getHandlePositions(bounds) {
        const handles = {};
        
        handles.nw = { x: bounds.x, y: bounds.y };
        handles.n  = { x: bounds.x + bounds.width / 2, y: bounds.y };
        handles.ne = { x: bounds.x + bounds.width, y: bounds.y };
        handles.e  = { x: bounds.x + bounds.width, y: bounds.y + bounds.height / 2 };
        handles.se = { x: bounds.x + bounds.width, y: bounds.y + bounds.height };
        handles.s  = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height };
        handles.sw = { x: bounds.x, y: bounds.y + bounds.height };
        handles.w  = { x: bounds.x, y: bounds.y + bounds.height / 2 };
        
        return handles;
    }

    // 检测鼠标是否在某个手柄上
    _hitTestHandle(coords) {
        const bounds = this._getSelectedImageBounds();
        if (!bounds) return null;

        const handles = this._getHandlePositions(bounds);
        // 使用固定大小的检测区域，不再受缩放影响
        const HIT_SIZE = 20;

        for (const dir of this._HANDLES) {
            const h = handles[dir];
            if (Math.abs(coords.x - h.x) <= HIT_SIZE && Math.abs(coords.y - h.y) <= HIT_SIZE) {
                return dir;
            }
        }
        return null;
    }

    // 尝试选择
    _trySelect(coords) {
        // 先检查是否点击在缩放手柄上
        const hitHandle = this._hitTestHandle(coords);
        if (hitHandle) {
            const layer = this._card._layerManager.getSelected();
            if (!layer || !layer.imageData || layer.locked) return;
            
            const bounds = this._getSelectedImageBounds();
            this._resizingHandle = hitHandle;
            this._resizeStart = {
                layer: layer,
                bounds: { ...bounds },
                mouseX: coords.x,
                mouseY: coords.y
            };
            this._isResizing = true;
            this._card._historyManager.save();
            return;
        }
        
        // 先检查文字
        const hitText = this._card._hitTestText(coords.x, coords.y);
        if (hitText) {
            this._selectedImageLayer = null;
            this._card._startEditingText(hitText.layerIndex, hitText.textIndex);
            return;
        }
        
        // 检查图层（从最上层往下检测，点击哪个就选哪个）
        const layer = this._card._hitTestLayer(coords.x, coords.y);
        if (layer && !layer.locked) {
            // 找到点击的图层在数组中的索引，并设置为选中状态
            const layerIndex = this._card._layerManager.layers.indexOf(layer);
            if (layerIndex !== -1) {
                this._card._layerManager.setSelected(layerIndex);
                this._card._renderLayersList();
            }
            
            this._draggedLayer = layer;
            this._dragOffset = {
                x: coords.x - layer.x,
                y: coords.y - layer.y
            };
            this._isDraggingLayer = true;
            
            // 如果是图片图层，记录用于显示手柄
            if (layer.imageData) {
                this._selectedImageLayer = layer;
            } else {
                this._selectedImageLayer = null;
            }
            // 重绘以显示选择框
            this._card._renderer.requestRender();
        } else {
            this._selectedImageLayer = null;
            this._card._renderer.requestRender();
        }
    }
    
    // 结束拖拽
    _endDragging() {
        this._isDraggingLayer = false;
        this._draggedLayer = null;
    }
    
    // 添加文字
    _addText(coords) {
        const layer = this._card._layerManager.getSelected();
        if (!layer || !layer.texts) return;
        
        const settings = this._card._toolManager.textSettings;
        
        const newText = {
            id: `text-${Date.now()}`,
            text: '双击编辑文字',
            x: coords.x,
            y: coords.y,
            fontSize: settings.fontSize,
            color: settings.color,
            fontFamily: settings.fontFamily
        };
        
        layer.texts.push(newText);
        this._card._historyManager.save();
        this._card._renderer.render();
        
        // 开始编辑
        setTimeout(() => {
            const textIndex = layer.texts.length - 1;
            this._card._startEditingText(this._card._layerManager.getSelectedIndex(), textIndex);
        }, 50);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 主卡片类
// ═══════════════════════════════════════════════════════════════════════════

class DrawingBoardCard extends BaseCard {

    constructor(options = {}) {
        super({
            width:    '800px',
            height:   '600px',
            minWidth:  400,
            minHeight: 300,
            title:    '画板',
            ...options
        });

        const w = parseFloat(String(this.width));
        const h = parseFloat(String(this.height));
        if (!isNaN(w) && w < this.minWidth) this.width = this.minWidth + 'px';
        if (!isNaN(h) && h < this.minHeight) this.height = this.minHeight + 'px';

        this.canvasConfig = {
            width: options.canvasWidth || 1024,
            height: options.canvasHeight || 1024,
            ...(options.canvasConfig || {})
        };

        // 从内容恢复数据
        if (options.content) {
            try {
                const parsed = JSON.parse(options.content);
                this.canvasConfig = { ...this.canvasConfig, ...parsed.canvasConfig };
            } catch {}
        }

        // 初始化管理器
        this._toolManager = new DrawingBoardToolManager(this);
        this._layerManager = new DrawingBoardLayerManager(this);
        this._viewController = new DrawingBoardViewController(this);
        this._historyManager = new DrawingBoardHistoryManager(this);
        this._renderer = new DrawingBoardRenderer(this);
        this._inputHandler = new DrawingBoardInputHandler(this);

        // 从序列化数据恢复
        if (options.content) {
            this._restoreFromContent(options.content);
        }

        // 自动创建空图层
        if (this._layerManager.layers.length === 0) {
            this._layerManager.createLayer('背景');
        }

        // 文字编辑状态
        this._editingTextId = null;
        this._editingTextInput = null;
    }

    // 从内容恢复数据
    _restoreFromContent(content) {
        try {
            const parsed = JSON.parse(content);
            
            // 恢复图层
            if (parsed.layers) {
                this._layerManager.restore({
                    layers: parsed.layers,
                    selectedLayerIndex: parsed.selectedLayerIndex
                });
            }
            
            // 恢复视图
            this._viewController.restore({
                viewZoom: parsed.viewZoom,
                viewPanX: parsed.viewPanX,
                viewPanY: parsed.viewPanY
            });
            
            // 恢复工具设置
            this._toolManager.restore({
                brushSettings: parsed.brushSettings,
                eraserSettings: parsed.eraserSettings,
                textSettings: parsed.textSettings
            });
        } catch {}
    }

    getType() { return 'drawing-board'; }

    // ─────────────────────────────────────────
    // 契约声明
    // ─────────────────────────────────────────
    static getContract() {
        return {
            outputs: [{
                name: 'default',
                type: 'image',
                notifyOn: 'onApply'  // 画板只在点击"应用"时通知下游
            }],
            inputs: [{
                name: 'image',
                type: 'image',
                multiple: true,
                receivePolicy: 'append'
            }]
        };
    }

    getOutput(outputName = 'default') {
        if (outputName === 'default') {
            // 确保先渲染
            this._renderer.render();
            return this._renderer.toImage();
        }
        return null;
    }

    // ─────────────────────────────────────────
    // 画板只在"应用"时才通知下游
    // 同时发布 DATA_CHANGED 事件，确保下游（PreviewCard 等）能通过事件总线收到推送
    // ─────────────────────────────────────────
    notifyDownstream() {
        const downstreamCards = DataSource.getDownstreamCards(this.id);

        downstreamCards.forEach(downstream => {
            downstream?.onReceive?.('image', this.getOutput(), this.id);
        });

        if (window.CardEventBus && CardEventBus.EventTypes) {
            const output = this.getOutput ? this.getOutput() : null;
            if (output) {
                CardEventBus.emit(CardEventBus.EventTypes.DATA_CHANGED, {
                    cardId: this.id,
                    type:   'image',
                    data:   output,
                    source: 'manual'
                });
            }
        }
    }
    onReceive(type, data, source = 'upstream') {
        // 仅在卡片初始化且无自有图层时导入上游
        const hasOwnLayers = this._layerManager.layers.some(
            l => l.type === 'image' || l.drawings?.length > 0 || l.texts?.length > 0
        );
        if (!hasOwnLayers) {
            this._loadLayersFromConnections();
        }
    }

    /**
     * 接收上游推送的图片，添加到图层。
     * 注意：图片数据已经由 ConnectionRules 层解析好（data 是 dataUrl 字符串），
     * 无需再调用 API.loadLocalImage。
     * @param {string} type - 数据类型
     * @param {*} data - 图片 dataUrl
     * @param {string} source - 来源（'upstream'|'run'）
     */
    onReceive(type, data, source = 'upstream') {
        if (type === 'image' && data) {
            this._addImageLayer(data);
        }
    }

    refreshUpstream() {
        // 仅在卡片初始化且无自有图层时导入上游
        const hasOwnLayers = this._layerManager.layers.some(
            l => l.type === 'image' || l.drawings?.length > 0 || l.texts?.length > 0
        );
        if (!hasOwnLayers) {
            this._loadLayersFromConnections();
        }
    }

    /**
     * 添加图片图层（供 onReceive 调用）
     * @param {string} imageData - 图片 dataUrl
     */
    _addImageLayer(imageData) {
        const newLayer = {
            id: `layer-${Date.now()}`,
            type: 'image',
            name: `图片 ${this._layerManager.layers.length + 1}`,
            imageData: imageData,
            x: 0,
            y: 0,
            width: null,
            height: null,
            opacity: 1,
            visible: true,
            locked: false,
            drawings: [],
            texts: []
        };

        if (this._layerManager.layers.length > 0) {
            this._historyManager.save();
        }

        this._layerManager.layers.push(newLayer);
        this._layerManager.selectedIndex = this._layerManager.layers.length - 1;

        this._layerManager.preloadImages(() => {
            this._renderLayersList();
            this._renderer.render();
            this._viewController.fitToWindow();
        });
    }

    /**
     * 从当前连接的上游卡片加载图层（仅用于初始化阶段）。
     * 正常运行时图层由 onReceive 推送添加，此方法仅在卡片首次创建、
     * 从序列化恢复且无自有图层时调用一次。
     * @private
     */
    _loadLayersFromConnections() {
        // 使用 DataSource 获取上游图片数据
        const imageData = DataSource.getUpstreamImage(this.id);

        imageData.forEach(item => {
            if (item.data) {
                this._addImageLayer(item.data);
            }
        });
    }

    /** 若只有一张图且无绘画/文字则让画布等于图片尺寸；若图片比画布大则扩大画布，避免显示不全 */
    _ensureCanvasFitsImage(layer, img) {
        if (!img || !img.naturalWidth || !img.naturalHeight) return;
        const w = this.canvasConfig.width;
        const h = this.canvasConfig.height;
        const iw = img.naturalWidth;
        const ih = img.naturalHeight;
        const hasDrawings = layer.drawings && layer.drawings.length > 0;
        const hasTexts = layer.texts && layer.texts.length > 0;
        const singleImageLayer = this._layerManager.layers.length === 1 && !hasDrawings && !hasTexts;

        if (singleImageLayer) {
            if (w !== iw || h !== ih) {
                this.canvasConfig.width = iw;
                this.canvasConfig.height = ih;
                this._renderer.resize(iw, ih);
                this._viewController._apply();
                this._updateCanvasSizeDisplay();
                setTimeout(() => this._viewController.fitToWindow(), 50);
            }
            return;
        }
        if (iw <= w && ih <= h) return;
        const newW = Math.max(w, iw);
        const newH = Math.max(h, ih);
        this.canvasConfig.width = newW;
        this.canvasConfig.height = newH;
        this._renderer.resize(newW, newH);
        this._viewController._apply();
        this._updateCanvasSizeDisplay();
        setTimeout(() => this._viewController.fitToWindow(), 50);
    }

    _updateCanvasSizeDisplay() {
        const el = this.element?.querySelector('.canvas-size-display');
        if (el) el.textContent = `${this.canvasConfig.width} × ${this.canvasConfig.height}`;
    }

    // ─────────────────────────────────────────
    // 命中测试
    // ─────────────────────────────────────────
    _hitTestText(x, y) {
        for (let i = this._layerManager.layers.length - 1; i >= 0; i--) {
            const layer = this._layerManager.layers[i];
            if (!layer.visible || layer.locked) continue;

            if (layer.texts) {
                for (let j = layer.texts.length - 1; j >= 0; j--) {
                    const text = layer.texts[j];
                    const estimatedWidth = text.text.length * text.fontSize * 0.6;
                    const estimatedHeight = text.fontSize;

                    if (x >= text.x && x <= text.x + estimatedWidth &&
                        y >= text.y - estimatedHeight && y <= text.y + estimatedHeight * 0.3) {
                        return { layerIndex: i, textIndex: j };
                    }
                }
            }
        }
        return null;
    }

    _hitTestLayer(x, y) {
        for (let i = this._layerManager.layers.length - 1; i >= 0; i--) {
            const layer = this._layerManager.layers[i];
            if (!layer.visible || layer.locked) continue;

            if (layer.imageData) {
                const img = this._layerManager.getImage(layer.imageData);
                if (img && img.complete && img.naturalWidth) {
                    const width = layer.width || img.naturalWidth;
                    const height = layer.height || img.naturalHeight;
                    const inBounds = x >= layer.x && x <= layer.x + width
                                && y >= layer.y && y <= layer.y + height;
                    if (inBounds) return layer;
                }
            }

            if ((layer.drawings && layer.drawings.length > 0) ||
                (layer.texts && layer.texts.length > 0)) {
                return layer;
            }
        }
        return null;
    }

    // ─────────────────────────────────────────
    // 文字编辑
    // ─────────────────────────────────────────
    _startEditingText(layerIndex, textIndex) {
        const layer = this._layerManager.layers[layerIndex];
        if (!layer || !layer.texts || !layer.texts[textIndex]) return;

        const text = layer.texts[textIndex];
        this._editingTextId = text.id;

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'text-editor-input';
        input.value = text.text;
        
        this._updateTextInputPosition(input, text);

        const canvasWrap = this.element?.querySelector('.drawing-board-canvas-wrap');
        canvasWrap?.appendChild(input);
        input.focus();
        input.select();

        const finishEditing = () => {
            const newText = input.value.trim();
            if (newText && newText !== '双击编辑文字') {
                layer.texts[textIndex].text = newText;
                this._historyManager.save();
            } else if (!newText) {
                layer.texts.splice(textIndex, 1);
            }
            input.remove();
            this._editingTextId = null;
            this._editingTextInput = null;
            this._renderer.render();
        };

        input.addEventListener('blur', finishEditing);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                input.blur();
            } else if (e.key === 'Escape') {
                input.value = text.text;
                input.blur();
            }
        });

        this._editingTextInput = input;
    }

    _updateTextInputPosition(input, text) {
        const zoom = this._viewController.zoom;
        const panX = this._viewController.panX;
        const panY = this._viewController.panY;
        
        input.style.cssText = `
            position: absolute;
            left: ${text.x * zoom + panX}px;
            top: ${(text.y - text.fontSize) * zoom + panY}px;
            font-size: ${text.fontSize * zoom}px;
            color: ${text.color};
            font-family: ${text.fontFamily};
            background: transparent;
            border: 1px solid var(--pastel-mint);
            outline: none;
            padding: 2px 4px;
            min-width: 100px;
            z-index: 1000;
        `;
    }

    _updateTextEditorPosition() {
        if (!this._editingTextInput || !this._editingTextId) return;

        for (const layer of this._layerManager.layers) {
            if (layer.texts) {
                const text = layer.texts.find(t => t.id === this._editingTextId);
                if (text) {
                    this._updateTextInputPosition(this._editingTextInput, text);
                    break;
                }
            }
        }
    }

    // ─────────────────────────────────────────
    // 内容渲染
    // ─────────────────────────────────────────
    renderContent() {
        const ts = this._toolManager.textSettings;
        
        return `
            <div class="drawing-board-toolbar">
                <button class="draw-tool-btn" data-tool="pan" title="平移画布 (H)">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M5 9l-3 3 3 3"/>
                        <path d="M9 5l3-3 3 3"/>
                        <path d="M15 19l-3 3-3-3"/>
                        <path d="M19 9l3 3-3 3"/>
                        <path d="M2 12h20"/>
                        <path d="M12 2v20"/>
                    </svg>
                </button>
                <button class="draw-tool-btn" data-tool="select" title="选择/移动 (V)">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/>
                    </svg>
                </button>
                <button class="draw-tool-btn" data-tool="brush" title="画笔 (B)">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 19l7-7 3 3-7 7-3-3z"/>
                        <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/>
                        <path d="M2 2l7.586 7.586"/>
                    </svg>
                </button>
                <button class="draw-tool-btn" data-tool="eraser" title="橡皮擦 (E)">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M20 20H7L3 16c-.8-.8-.8-2 0-2.8l10-10c.8-.8 2-.8 2.8 0l6 6c.8.8.8 2 0 2.8L14 20"/>
                        <path d="M6 11l8 8"/>
                    </svg>
                </button>
                <button class="draw-tool-btn" data-tool="text" title="文字 (T)">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M4 7V4h16v3"/>
                        <path d="M12 4v16"/>
                        <path d="M8 20h8"/>
                    </svg>
                </button>
                <div class="draw-tool-divider"></div>
                <button class="draw-tool-btn" data-action="addLayer" title="新建图层">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="3" y="3" width="18" height="18" rx="2"/>
                        <path d="M12 8v8"/>
                        <path d="M8 12h8"/>
                    </svg>
                </button>
                <button class="draw-tool-btn" data-action="deleteLayer" title="删除图层">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M3 6h18"/>
                        <path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                        <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/>
                    </svg>
                </button>
                <div class="draw-tool-divider"></div>
                <button class="draw-tool-btn" data-action="undo" title="撤销 (Ctrl+Z)">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M3 7v6h6"/>
                        <path d="M21 17a9 9 0 00-9-9 9 9 0 00-6 2.3L3 13"/>
                    </svg>
                </button>
                <button class="draw-tool-btn" data-action="redo" title="重做 (Ctrl+Y)">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 7v6h-6"/>
                        <path d="M3 17a9 9 0 019-9 9 9 0 016 2.3l3 2.7"/>
                    </svg>
                </button>
                <div class="draw-tool-spacer"></div>
                <div class="canvas-size-display" title="画布尺寸" data-action="canvasSize">
                    ${this.canvasConfig.width} × ${this.canvasConfig.height}
                </div>
                <div class="zoom-control">
                    <button class="zoom-btn" data-action="zoomOut" title="缩小">-</button>
                    <span class="zoom-level">${Math.round(this._viewController.zoom * 100)}%</span>
                    <button class="zoom-btn" data-action="zoomIn" title="放大">+</button>
                    <button class="zoom-btn" data-action="zoomFit" title="适应窗口">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M8 3H5a2 2 0 00-2 2v3"/>
                            <path d="M21 8V5a2 2 0 00-2-2h-3"/>
                            <path d="M3 16v3a2 2 0 002 2h3"/>
                            <path d="M16 21h3a2 2 0 002-2v-3"/>
                        </svg>
                    </button>
                </div>
            </div>
            <div class="drawing-board-main">
                <div class="drawing-board-canvas-wrap" id="canvas-wrap-${this.id}">
                    <div class="drawing-board-canvas-content">
                        <div class="drawing-board-canvas-scaled">
                            <canvas class="drawing-board-canvas"
                                    id="canvas-${this.id}"
                                    width="${this.canvasConfig.width}"
                                    height="${this.canvasConfig.height}"></canvas>
                        </div>
                    </div>
                </div>
                <div class="drawing-board-sidebar">
                    <div class="layers-panel">
                        <div class="layers-header">
                            <span>图层</span>
                            <button class="add-layer-btn" data-action="addLayerFromPanel" title="添加图层">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M12 5v14"/>
                                    <path d="M5 12h14"/>
                                </svg>
                            </button>
                        </div>
                        <div class="layers-list" id="layers-list-${this.id}"></div>
                    </div>
                    <div class="brush-settings-panel" id="brush-panel">
                        <div class="panel-title">画笔设置</div>
                        <div class="brush-size-row">
                            <label>大小</label>
                            <input type="range" class="brush-size-slider"
                                   min="1" max="100" value="${this._toolManager.brushSettings.size}">
                            <span class="brush-size-value">${this._toolManager.brushSettings.size}px</span>
                        </div>
                        <div class="brush-color-row">
                            <label>颜色</label>
                            <input type="color" class="brush-color-picker"
                                   value="${this._toolManager.brushSettings.color}">
                        </div>
                        <div class="brush-opacity-row">
                            <label>不透明度</label>
                            <input type="range" class="brush-opacity-slider"
                                   min="0" max="100" value="${this._toolManager.brushSettings.opacity * 100}">
                            <span class="brush-opacity-value">${Math.round(this._toolManager.brushSettings.opacity * 100)}%</span>
                        </div>
                    </div>
                    <div class="eraser-settings-panel hidden" id="eraser-panel">
                        <div class="panel-title">橡皮擦设置</div>
                        <div class="eraser-size-row">
                            <label>大小</label>
                            <input type="range" class="eraser-size-slider"
                                   min="5" max="100" value="${this._toolManager.eraserSettings.size}">
                            <span class="eraser-size-value">${this._toolManager.eraserSettings.size}px</span>
                        </div>
                    </div>
                    <div class="text-settings-panel hidden" id="text-panel">
                        <div class="panel-title">文字设置</div>
                        <div class="text-size-row">
                            <label>字号</label>
                            <input type="range" class="text-size-slider"
                                   min="12" max="200" value="${ts.fontSize}">
                            <span class="text-size-value">${ts.fontSize}px</span>
                        </div>
                        <div class="text-color-row">
                            <label>颜色</label>
                            <input type="color" class="text-color-picker"
                                   value="${ts.color}">
                        </div>
                        <div class="text-font-row">
                            <label>字体</label>
                            <div class="text-font-select-container" data-font-value="${ts.fontFamily}"></div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="drawing-board-footer">
                <button class="apply-btn" data-action="apply">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M22 2L11 13"/>
                        <path d="M22 2l-7 20-4-9-9-4 20-7z"/>
                    </svg>
                    应用
                </button>
            </div>
        `;
    }

    createElement() {
        const el = super.createElement();
        el.classList.add('drawing-board-card');

        const body = el.querySelector('.card-body');
        body.style.cssText = 'padding:0; display:flex; flex-direction:column; overflow:hidden;';

        setTimeout(() => {
            this._init();
        }, 0);

        return el;
    }

    // 初始化
    _init() {
        // 初始化渲染器
        this._renderer.init();

        // 初始化工具管理器 UI
        this._toolManager.initUI();

        // 预加载图片并等待完成后渲染
        this._layerManager.preloadImages(() => {
            this._renderLayersList();
            this._renderer.render();
            this._renderer.syncDrawingLayerFromLayer(this._layerManager.getSelected());
            this._viewController.init();
            // 初始化阶段：若卡片已有图层数据（从序列化恢复），不重复导入
            const hasOwnLayers = this._layerManager.layers.some(
                l => l.type === 'image' || l.drawings?.length > 0 || l.texts?.length > 0
            );
            if (!hasOwnLayers) {
                this._loadLayersFromConnections();
            }
        });

        // 绑定事件
        this._bindToolbarEvents();
        this._bindLayerEvents();
        this._bindSettingsEvents();
        this._bindKeyboardShortcuts();

        // 初始化输入处理器
        this._inputHandler.init();
    }

    // ─────────────────────────────────────────
    // 绑定工具栏事件
    // ─────────────────────────────────────────
    _bindToolbarEvents() {
        const toolbar = this.element?.querySelector('.drawing-board-toolbar');
        if (!toolbar) return;

        toolbar.querySelectorAll('.draw-tool-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const tool = btn.dataset.tool;
                const action = btn.dataset.action;

                if (tool) {
                    if (this._isDrawing && this._isErasing) {
                        this._finishDrawing();
                    }
                    this._toolManager.setTool(tool);
                } else if (action === 'undo') {
                    this.undo();
                } else if (action === 'redo') {
                    this.redo();
                } else if (action) {
                    this._handleToolbarAction(action);
                }
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

    // ─────────────────────────────────────────
    // 处理工具栏操作
    // ─────────────────────────────────────────
    _handleToolbarAction(action) {
        switch (action) {
            case 'addLayer':
            case 'addLayerFromPanel':
                this._layerManager.createLayer(`图层 ${this._layerManager.layers.length + 1}`);
                this._historyManager.save();
                this._renderLayersList();
                break;
            case 'deleteLayer':
                if (this._layerManager.deleteLayer(this._layerManager.getSelectedIndex())) {
                    this._historyManager.save();
                    this._renderLayersList();
                    this._renderer.render();
                }
                break;
        }
    }

    apply() {
        this.notifyDownstream();
    }

    // ─────────────────────────────────────────
    // 绑定图层事件
    // ─────────────────────────────────────────
    _bindLayerEvents() {
        const list = this.element?.querySelector('.layers-list');
        if (!list) return;

        // 使用事件委托
        list.addEventListener('click', (e) => {
            const item = e.target.closest('.layer-item');
            if (item) {
                const index = parseInt(item.dataset.index, 10);
                this._layerManager.setSelected(index);
                this._renderer.syncDrawingLayerFromLayer(this._layerManager.getSelected());
                this._renderLayersList();
                this._renderer.render();
            }

            const visibilityBtn = e.target.closest('.layer-visibility-btn');
            if (visibilityBtn) {
                const index = parseInt(visibilityBtn.closest('.layer-item').dataset.index, 10);
                if (this._layerManager.toggleVisibility(index)) {
                    this._historyManager.save();
                    this._renderLayersList();
                    this._renderer.render();
                }
            }

            const lockBtn = e.target.closest('.layer-lock-btn');
            if (lockBtn) {
                const index = parseInt(lockBtn.closest('.layer-item').dataset.index, 10);
                if (this._layerManager.toggleLock(index)) {
                    this._historyManager.save();
                    this._renderLayersList();
                }
            }

            const deleteBtn = e.target.closest('.layer-delete-btn');
            if (deleteBtn) {
                const index = parseInt(deleteBtn.closest('.layer-item').dataset.index, 10);
                if (this._layerManager.deleteLayer(index)) {
                    this._historyManager.save();
                    this._renderLayersList();
                    this._renderer.render();
                }
            }
        });

        // 图层拖拽排序
        let draggedIndex = null;
        let draggedOverIndex = null;

        list.addEventListener('dragstart', (e) => {
            const item = e.target.closest('.layer-item');
            if (item) {
                draggedIndex = parseInt(item.dataset.index, 10);
                item.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
            }
        });

        list.addEventListener('dragend', (e) => {
            const item = e.target.closest('.layer-item');
            if (item) {
                item.classList.remove('dragging');
            }
            draggedIndex = null;
            draggedOverIndex = null;
        });

        list.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';

            const item = e.target.closest('.layer-item');
            if (item && draggedIndex !== null) {
                const overIndex = parseInt(item.dataset.index, 10);
                if (overIndex !== draggedIndex && overIndex !== draggedOverIndex) {
                    draggedOverIndex = overIndex;
                    this._layerManager.swapLayers(draggedIndex, overIndex);
                    draggedIndex = overIndex;
                    this._renderLayersList();
                }
            }
        });

        list.addEventListener('drop', (e) => {
            e.preventDefault();
            if (draggedIndex !== null && draggedOverIndex !== null) {
                this._historyManager.save();
            }
        });
    }

    // ─────────────────────────────────────────
    // 绑定设置事件
    // ─────────────────────────────────────────
    _bindSettingsEvents() {
        const panel = this.element;

        // 画笔大小
        const sizeSlider = panel?.querySelector('.brush-size-slider');
        sizeSlider?.addEventListener('input', (e) => {
            const value = parseInt(e.target.value, 10);
            this._toolManager.updateBrushSetting('size', value);
            panel.querySelector('.brush-size-value').textContent = value + 'px';
        });

        // 画笔颜色
        const colorPicker = panel?.querySelector('.brush-color-picker');
        colorPicker?.addEventListener('input', (e) => {
            this._toolManager.updateBrushSetting('color', e.target.value);
        });

        // 画笔不透明度
        const opacitySlider = panel?.querySelector('.brush-opacity-slider');
        opacitySlider?.addEventListener('input', (e) => {
            const value = parseInt(e.target.value, 10) / 100;
            this._toolManager.updateBrushSetting('opacity', value);
            panel.querySelector('.brush-opacity-value').textContent = Math.round(value * 100) + '%';
        });

        // 橡皮擦大小
        const eraserSlider = panel?.querySelector('.eraser-size-slider');
        eraserSlider?.addEventListener('input', (e) => {
            const value = parseInt(e.target.value, 10);
            this._toolManager.updateEraserSetting('size', value);
            panel.querySelector('.eraser-size-value').textContent = value + 'px';
        });

        // 文字大小
        const textSizeSlider = panel?.querySelector('.text-size-slider');
        textSizeSlider?.addEventListener('input', (e) => {
            const value = parseInt(e.target.value, 10);
            this._toolManager.updateTextSetting('fontSize', value);
            panel.querySelector('.text-size-value').textContent = value + 'px';
        });

        // 文字颜色
        const textColorPicker = panel?.querySelector('.text-color-picker');
        textColorPicker?.addEventListener('input', (e) => {
            this._toolManager.updateTextSetting('color', e.target.value);
        });

        // 文字字体
        const fontContainer = panel?.querySelector('.text-font-select-container');
        if (fontContainer) {
            const fontSelect = UISelect({
                value: fontContainer.dataset.fontValue || 'sans-serif',
                options: [
                    { value: 'sans-serif', label: '默认字体' },
                    { value: 'serif', label: '宋体' },
                    { value: 'Microsoft YaHei', label: '黑体' },
                    { value: 'cursive', label: '楷体' },
                    { value: 'monospace', label: '等宽' },
                ],
                onChange: (val) => {
                    this._toolManager.updateTextSetting('fontFamily', val);
                }
            });
            fontContainer.appendChild(fontSelect.element);
            this._fontSelectComponent = fontSelect;
        }
    }

    // ─────────────────────────────────────────
    // 绑定键盘快捷键
    // ─────────────────────────────────────────
    _bindKeyboardShortcuts() {
        const handleKeyDown = (e) => {
            // 如果正在编辑文字，不处理快捷键
            if (this._editingTextId) return;

            // 检查是否在当前卡片内
            if (!this.element?.contains(document.activeElement) &&
                document.activeElement !== document.body) {
                return;
            }

            // 注意：Ctrl+Z/Y 不再在这里处理，统一由 main.js 的全局处理器分发
            // 工具快捷键（保持不变）
            switch (e.key.toLowerCase()) {
                case 'v':
                case 'b':
                case 'e':
                case 't':
                case 'h':
                    // 如果正在橡皮擦，先保存历史再切换工具
                    if (this._isDrawing && this._isErasing) {
                        this._finishDrawing();
                    }
                    this._toolManager.setTool(e.key.toLowerCase());
                    break;
                case 'delete':
                case 'backspace':
                    this._deleteSelected();
                    break;
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        this._keyDownHandler = handleKeyDown;
    }

    // ─────────────────────────────────────────
    // 删除选中的图层或文字
    // ─────────────────────────────────────────
    _deleteSelected() {
        if (this._editingTextId) {
            for (const layer of this._layerManager.layers) {
                if (layer.texts) {
                    const idx = layer.texts.findIndex(t => t.id === this._editingTextId);
                    if (idx !== -1) {
                        layer.texts.splice(idx, 1);
                        this._historyManager.save();
                        this._renderer.render();
                        return;
                    }
                }
            }
        }
    }

    // ─────────────────────────────────────────
    // 渲染图层列表（列表从上到下 = 画布从顶到底：第一行是顶层图层）
    // ─────────────────────────────────────────
    _renderLayersList() {
        const list = this.element?.querySelector('.layers-list');
        if (!list) return;

        const layers = this._layerManager.layers;
        // 倒序显示：列表第一行 = 数组最后一个 = 画布最上层（与 Photoshop 一致）
        const reversed = layers.map((layer, index) => ({ layer, index })).reverse();

        list.innerHTML = reversed.map(({ layer, index }) => `
            <div class="layer-item ${index === this._layerManager.getSelectedIndex() ? 'selected' : ''}"
                 data-index="${index}" draggable="true">
                <button class="layer-visibility-btn" title="${layer.visible ? '隐藏' : '显示'}">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        ${layer.visible
                            ? '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'
                            : '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'}
                    </svg>
                </button>
                <button class="layer-lock-btn" title="${layer.locked ? '解锁' : '锁定'}">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        ${layer.locked
                            ? '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>'
                            : '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 019.9-1"/>'}
                    </svg>
                </button>
                <span class="layer-thumbnail">
                    ${layer.imageData ? `<img src="${layer.imageData}" alt="">` : '<div class="empty-thumbnail"></div>'}
                </span>
                <span class="layer-name">${layer.name}</span>
                ${layers.length > 1 ? `
                <button class="layer-delete-btn" title="删除图层">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"/>
                        <line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
                ` : ''}
                <input type="range" class="layer-opacity-slider" data-layer-index="${index}"
                       min="0" max="100" value="${layer.opacity * 100}"
                       title="不透明度">
            </div>
        `).join('');

        // 绑定透明度滑块事件（DOM 顺序已倒序，用 data-layer-index 取真实索引）
        list.querySelectorAll('.layer-opacity-slider').forEach((slider) => {
            const index = parseInt(slider.dataset.layerIndex, 10);
            slider.addEventListener('input', (e) => {
                const value = parseInt(e.target.value, 10) / 100;
                this._layerManager.setOpacity(index, value);
                this._renderer.requestRender();
            });
            slider.addEventListener('change', () => {
                this._historyManager.save();
            });
        });
    }

    // ─────────────────────────────────────────
    // 本地撤销/重做接口
    // ─────────────────────────────────────────

    /**
     * 检查卡片是否有自己的本地撤销/重做能力
     * 画板卡片有自己的图层历史管理
     * @returns {boolean}
     */
    hasLocalUndo() {
        return true;
    }

    /**
     * 执行本地撤销操作
     * @returns {boolean} - 是否成功执行了撤销
     */
    undo() {
        if (this._historyManager.undo()) {
            return true;
        }
        return false;
    }

    /**
     * 执行本地重做操作
     * @returns {boolean} - 是否成功执行了重做
     */
    redo() {
        if (this._historyManager.redo()) {
            return true;
        }
        return false;
    }

    // ─────────────────────────────────────────
    // 序列化
    // ─────────────────────────────────────────
    serialize() {
        return {
            ...super.serialize(),
            canvasConfig: this.canvasConfig,
            ...this._layerManager.export(),
            ...this._viewController.export(),
            ...this._toolManager.export()
        };
    }

    // ─────────────────────────────────────────
    // 销毁
    // ─────────────────────────────────────────
    destroy() {
        if (this._keyDownHandler) {
            document.removeEventListener('keydown', this._keyDownHandler);
        }
        if (this._editingTextInput) {
            this._editingTextInput.remove();
        }
        this._inputHandler.destroy();
        this._layerManager.clearCache();
        // 移除笔刷光标元素，避免内存泄漏
        if (this._renderer._brushCursor) {
            this._renderer._brushCursor.remove();
        }
        super.destroy();
    }

    // ═══════════════════════════════════════════════════════════════════
    // 静态方法
    // ═══════════════════════════════════════════════════════════════════
    static _addLayerFromPanel(cardId) {
        const card = CardFactory.getInstance(cardId);
        if (card) {
            card._layerManager.createLayer(`图层 ${card._layerManager.layers.length + 1}`);
            card._historyManager.save();
            card._renderLayersList();
        }
    }

    static apply(cardId) {
        const card = CardFactory.getInstance(cardId);
        if (card) {
            card.notifyDownstream();
        }
    }

    static _showCanvasSizeDialog(cardId) {
        const card = CardFactory.getInstance(cardId);
        if (!card) return;

        const currentWidth = card.canvasConfig.width;
        const currentHeight = card.canvasConfig.height;

        const dialog = document.createElement('div');
        dialog.className = 'canvas-size-dialog';
        dialog.innerHTML = `
            <div class="dialog-overlay"></div>
            <div class="dialog-content">
                <div class="dialog-title">设置画布尺寸</div>
                <div class="dialog-body">
                    <div class="size-row">
                        <label>宽度 (px)</label>
                        <div class="size-width-container" data-value="${currentWidth}"></div>
                    </div>
                    <div class="size-row">
                        <label>高度 (px)</label>
                        <div class="size-height-container" data-value="${currentHeight}"></div>
                    </div>
                    <div class="preset-sizes">
                        <button class="preset-btn" data-size="512,512">512×512</button>
                        <button class="preset-btn" data-size="1024,768">1024×768</button>
                        <button class="preset-btn" data-size="1024,1024">1024×1024</button>
                        <button class="preset-btn" data-size="1920,1080">1920×1080</button>
                    </div>
                </div>
                <div class="dialog-footer">
                    <button class="cancel-btn">取消</button>
                    <button class="confirm-btn">确定</button>
                </div>
            </div>
        `;

        document.body.appendChild(dialog);

        const overlay = dialog.querySelector('.dialog-overlay');
        const cancelBtn = dialog.querySelector('.cancel-btn');
        const confirmBtn = dialog.querySelector('.confirm-btn');
        const widthContainer = dialog.querySelector('.size-width-container');
        const heightContainer = dialog.querySelector('.size-height-container');
        const presetBtns = dialog.querySelectorAll('.preset-btn');

        const widthComp = UIInput({
            type: 'number',
            value: String(currentWidth),
            width: '100%',
        });
        widthComp.input.min = '100';
        widthComp.input.max = '4096';
        widthComp.input.classList.add('size-width');
        widthContainer.appendChild(widthComp.element);

        const heightComp = UIInput({
            type: 'number',
            value: String(currentHeight),
            width: '100%',
        });
        heightComp.input.min = '100';
        heightComp.input.max = '4096';
        heightComp.input.classList.add('size-height');
        heightContainer.appendChild(heightComp.element);

        const closeDialog = () => dialog.remove();

        overlay.addEventListener('click', closeDialog);
        cancelBtn.addEventListener('click', closeDialog);

        presetBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const [w, h] = btn.dataset.size.split(',').map(Number);
                widthComp.setValue(String(w));
                heightComp.setValue(String(h));
            });
        });

        confirmBtn.addEventListener('click', () => {
            const newWidth = parseInt(widthComp.value, 10);
            const newHeight = parseInt(heightComp.value, 10);

            if (newWidth >= 100 && newHeight >= 100 && newWidth <= 4096 && newHeight <= 4096) {
                card.canvasConfig.width = newWidth;
                card.canvasConfig.height = newHeight;
                card._renderer.resize(newWidth, newHeight);
                card._historyManager.save();
                card._renderer.render();
                card._viewController._apply();
                card._viewController.fitToWindow();

                const sizeDisplay = card.element?.querySelector('.canvas-size-display');
                if (sizeDisplay) {
                    sizeDisplay.textContent = `${newWidth} × ${newHeight}`;
                }

                closeDialog();
            }
        });
    }
}

window.DrawingBoardCard = DrawingBoardCard;
