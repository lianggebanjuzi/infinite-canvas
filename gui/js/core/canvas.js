// js/core/canvas.js
// 画布引擎：缩放、平移、坐标转换
// 不知道卡片的存在，只管画布本身的变换

const Canvas = {

    // ─────────────────────────────────────────
    // DOM 引用
    // ─────────────────────────────────────────
    container:      null,
    transformLayer: null,
    svgLayer:       null,

    // ─────────────────────────────────────────
    // 初始化
    // ─────────────────────────────────────────
    init() {
        this.container      = document.getElementById('canvas-container');
        this.transformLayer = document.getElementById('transform-layer');
        this.svgLayer       = document.getElementById('svg-layer');

        this._initSVGMarkers();
        this._bindEvents();
    },

    // ─────────────────────────────────────────
    // 初始化 SVG 箭头标记
    // ─────────────────────────────────────────
    _initSVGMarkers() {
        const defs   = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
        marker.setAttribute('id',           'dot-marker');
        marker.setAttribute('markerWidth',  '8');
        marker.setAttribute('markerHeight', '8');
        marker.setAttribute('refX',         '4');
        marker.setAttribute('refY',         '4');
        marker.setAttribute('orient',       'auto');

        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx',   '4');
        circle.setAttribute('cy',   '4');
        circle.setAttribute('r',    '3');
        circle.setAttribute('fill', 'var(--connection-color)');

        marker.appendChild(circle);
        defs.appendChild(marker);
        this.svgLayer.appendChild(defs);
    },

    // ─────────────────────────────────────────
    // 更新画布变换
    // ─────────────────────────────────────────
    updateTransform() {
        const { panX, panY, scale } = AppState.canvas;
        this.transformLayer.style.transform =
            `translate(${panX}px, ${panY}px) scale(${scale})`;

        // 同步更新点阵背景：让背景跟随画布世界坐标移动和缩放
        // background-size 使点阵格子随缩放缩放
        // background-position 使点阵起始点跟随平移（与 transform-layer 同步）
        const gridSize = 22;
        this.container.style.backgroundSize     = `${gridSize * scale}px ${gridSize * scale}px`;
        this.container.style.backgroundPosition = `${panX}px ${panY}px`;
    },

    // ─────────────────────────────────────────
    // 坐标转换：屏幕坐标 → 画布坐标
    // ─────────────────────────────────────────
    toCanvasCoords(screenX, screenY) {
        const rect  = this.container.getBoundingClientRect();
        const { panX, panY, scale } = AppState.canvas;
        return {
            x: (screenX - rect.left - panX) / scale,
            y: (screenY - rect.top  - panY) / scale
        };
    },

    // ─────────────────────────────────────────
    // 缩放（以鼠标位置为中心）
    // ─────────────────────────────────────────
    zoom(delta, mouseX, mouseY) {
        const { scale, panX, panY } = AppState.canvas;
        const newScale = Math.min(
            Math.max(0.1, scale * delta),
            5
        );

        const rect = this.container.getBoundingClientRect();
        const mx   = mouseX - rect.left;
        const my   = mouseY - rect.top;

        AppState.canvas.panX  = mx - (mx - panX) * (newScale / scale);
        AppState.canvas.panY  = my - (my - panY) * (newScale / scale);
        AppState.canvas.scale = newScale;

        this.updateTransform();

        // 触发 GPU composite（替代旧版 display:none 强制重排）
        const layer = document.getElementById('transform-layer');
        if (layer) layer.style.transform = `${layer.style.transform} translateZ(0)`;
    },

    // ─────────────────────────────────────────
    // 事件绑定
    // ─────────────────────────────────────────
    _bindEvents() {
        // 滚轮缩放
        this.container.addEventListener('wheel', (e) => {
            // 如果事件来自可滚动的输入框，不处理缩放
            const target = e.target;
            if (target && (
                target.tagName === 'TEXTAREA' ||
                target.tagName === 'INPUT' ||
                target.classList.contains('textarea') ||
                target.isContentEditable
            )) {
                // 检查元素是否可以滚动
                const canScroll = (
                    target.scrollHeight > target.clientHeight ||
                    target.scrollWidth > target.clientWidth
                );
                if (canScroll) return; // 让输入框的滚动事件正常传播
            }
            // 只有选中卡片时才阻止全局缩放（让卡片内部处理）
            const wheelCard = target?.closest('.drawing-board-card');
            if (wheelCard && wheelCard.classList.contains('selected')) {
                return;
            }
            // 未选中 → 滚轮缩放走全局（漫游时缩放全局视图）
            e.preventDefault();
            const delta = e.deltaY > 0 ? 0.9 : 1.1;
            this.zoom(delta, e.clientX, e.clientY);
            Minimap.updateViewportOnly();  // 即时响应
            Minimap.scheduleUpdate();       // 节流修正（mapScale 变化需全量重建）
        }, { passive: false });

        // 中键拖动
        this.container.addEventListener('mousedown', (e) => {
            if (e.button === 1) {
                // 只有当画板卡片处于「选中态」时，才让卡片内部处理中键
                const drawingCard = e.target?.closest('.drawing-board-card');
                if (drawingCard && drawingCard.classList.contains('selected')) {
                    // 卡片已选中 → 让卡片内部处理中键漫游
                    return;
                }
                // 卡片未选中 → 继续交给 Canvas 全局处理
                AppState.canvas.isPanning  = true;
                AppState.canvas.startPanX  = e.clientX - AppState.canvas.panX;
                AppState.canvas.startPanY  = e.clientY - AppState.canvas.panY;
                this.container.style.cursor = 'grabbing';
            }
        });

        window.addEventListener('mousemove', (e) => {
            if (!AppState.canvas.isPanning) return;
            AppState.canvas.panX = e.clientX - AppState.canvas.startPanX;
            AppState.canvas.panY = e.clientY - AppState.canvas.startPanY;
            this.updateTransform();
            Minimap.updateViewportOnly();  // 轻量：只移视口框，不重建标记
        });

        window.addEventListener('mouseup', (e) => {
            if (AppState.canvas.isPanning) {
                AppState.canvas.isPanning   = false;
                this.container.style.cursor = 'default';
                // 拖动结束做一次全量更新（修正可能的累积误差）
                Minimap.update();
            }
        });
    }
};

window.Canvas = Canvas;
