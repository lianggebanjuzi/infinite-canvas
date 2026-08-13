// src/components/minimap.ts
// 小地图：显示画布全局视图，支持点击/拖拽导航

import { AppState } from '../state/app-state';
import { Dom } from '../utils/dom';
import { Canvas } from '../core/canvas';

declare const CardFactory: {
    getInstances?(): Map<string, { id: string; el?: HTMLElement }> | unknown;
};

/** Metadata saved after each full update, reused by navigate & viewport-only refresh. */
interface MapMeta {
    minX: number;
    minY: number;
    mapScale: number;
}

interface MinimapInstance {
    minimap: HTMLElement | null;
    content: HTMLElement | null;
    viewport: HTMLElement | null;
    container: HTMLElement | null;
    _isDragging: boolean;
    _padding: number;
    _minCanvasSize: number;
    _mapMeta: MapMeta | null;

    init(): void;
    update(): void;
    updateViewportOnly(): void;
    scheduleUpdate(): void;
    toggle(): void;
    _navigate(e: MouseEvent): void;
    _bindEvents(): void;
    _observeCards(): void;
}

export const Minimap: MinimapInstance = {

    // ─────────────────────────────────────────
    // 实例属性（init 中赋初值）
    // ─────────────────────────────────────────
    minimap: null,
    content: null,
    viewport: null,
    container: null,
    _isDragging: false,
    _padding: 10,
    _minCanvasSize: 2000,
    _mapMeta: null,

    // ─────────────────────────────────────────
    // 初始化
    // ─────────────────────────────────────────

    init(): void {
        this.minimap         = document.getElementById('minimap');
        this.content         = document.getElementById('minimap-content');
        this.viewport        = document.getElementById('minimap-viewport');
        this.container       = document.getElementById('canvas-container');
        this._isDragging     = false;
        this._padding        = 10;
        this._minCanvasSize  = 2000;

        this._bindEvents();
        this._observeCards();
        setTimeout(() => this.update(), 100);
    },

    // ─────────────────────────────────────────
    // 更新小地图
    // ─────────────────────────────────────────

    update(): void {
        if (!this.content) return;
        if (this.minimap!.classList.contains('collapsed')) return;

        // 清除旧卡片标记
        this.content.querySelectorAll('.minimap-card').forEach(el => el.remove());

        const cards         = document.querySelectorAll<HTMLElement>('.card');
        const containerRect = this.container!.getBoundingClientRect();
        const { scale, panX, panY } = AppState.canvas;

        // 当前视口的画布坐标范围
        const vpLeft   = -panX / scale;
        const vpTop    = -panY / scale;
        const vpRight  = vpLeft + containerRect.width  / scale;
        const vpBottom = vpTop  + containerRect.height / scale;

        // 计算边界（包含所有卡片和视口）
        let minX = vpLeft, minY = vpTop;
        let maxX = vpRight, maxY = vpBottom;

        cards.forEach(card => {
            const l = parseFloat(card.style.left) || 0;
            const t = parseFloat(card.style.top)  || 0;
            const r = l + (card.offsetWidth  || 200);
            const b = t + (card.offsetHeight || 120);
            minX = Math.min(minX, l);
            minY = Math.min(minY, t);
            maxX = Math.max(maxX, r);
            maxY = Math.max(maxY, b);
        });

        // 添加边距
        minX -= 100; minY -= 100;
        maxX += 100; maxY += 100;

        // 确保最小范围
        const cw = Math.max(maxX - minX, this._minCanvasSize);
        const ch = Math.max(maxY - minY, this._minCanvasSize);

        if (maxX - minX < this._minCanvasSize) {
            const cx = (minX + maxX) / 2;
            minX = cx - this._minCanvasSize / 2;
            maxX = cx + this._minCanvasSize / 2;
        }
        if (maxY - minY < this._minCanvasSize) {
            const cy = (minY + maxY) / 2;
            minY = cy - this._minCanvasSize / 2;
            maxY = cy + this._minCanvasSize / 2;
        }

        // 计算缩放比
        const mapW    = this.content.offsetWidth  - this._padding * 2;
        const mapH    = this.content.offsetHeight - this._padding * 2;
        const mapScale = Math.min(mapW / (maxX - minX), mapH / (maxY - minY));

        // 绘制卡片标记
        cards.forEach(card => {
            const l = parseFloat(card.style.left) || 0;
            const t = parseFloat(card.style.top)  || 0;
            const w = card.offsetWidth  || 200;
            const h = card.offsetHeight || 120;
            const type = card.getAttribute('data-type') || 'text';

            const marker = Dom.create('div', {
                className: `minimap-card ${type}`
            });
            marker.style.left   = ((l - minX) * mapScale + this._padding) + 'px';
            marker.style.top    = ((t - minY) * mapScale + this._padding) + 'px';
            marker.style.width  = Math.max(4, w * mapScale) + 'px';
            marker.style.height = Math.max(3, h * mapScale) + 'px';

            this.content!.appendChild(marker);
        });

        // 更新视口框
        this.viewport!.style.left   = ((vpLeft   - minX) * mapScale + this._padding) + 'px';
        this.viewport!.style.top    = ((vpTop    - minY) * mapScale + this._padding) + 'px';
        this.viewport!.style.width  = ((containerRect.width  / scale) * mapScale)    + 'px';
        this.viewport!.style.height = ((containerRect.height / scale) * mapScale)    + 'px';

        // 保存边界信息供导航使用
        this._mapMeta = { minX, minY, mapScale };
    },

    // ─────────────────────────────────────────
    // 轻量视口框更新 — 仅移动视口框，不重建标记
    // 适用于画布拖动/缩放等高频场景
    // ─────────────────────────────────────────

    updateViewportOnly(): void {
        if (!this.viewport || !this._mapMeta) return;
        if (this.minimap!.classList.contains('collapsed')) return;

        const containerRect = this.container!.getBoundingClientRect();
        const { minX, minY, mapScale } = this._mapMeta;
        const { scale, panX, panY } = AppState.canvas;

        const vpLeft   = -panX / scale;
        const vpTop    = -panY / scale;

        this.viewport.style.left   = ((vpLeft   - minX) * mapScale + this._padding) + 'px';
        this.viewport.style.top    = ((vpTop    - minY) * mapScale + this._padding) + 'px';
        this.viewport.style.width  = ((containerRect.width  / scale) * mapScale)    + 'px';
        this.viewport.style.height = ((containerRect.height / scale) * mapScale)    + 'px';
    },

    // ─────────────────────────────────────────
    // 节流全量更新
    // ─────────────────────────────────────────

    scheduleUpdate(): void {
        if (AppState.performance.minimapUpdateTimer) return;
        AppState.performance.minimapUpdateTimer = setTimeout(() => {
            this.update();
            AppState.performance.minimapUpdateTimer = null;
        }, 100);
    },

    // ─────────────────────────────────────────
    // 折叠/展开
    // ─────────────────────────────────────────

    toggle(): void {
        this.minimap!.classList.toggle('collapsed');
        const icon = this.minimap!.querySelector<HTMLElement>('.minimap-toggle i');
        if (icon) {
            icon.className = this.minimap!.classList.contains('collapsed')
                ? 'fas fa-plus'
                : 'fas fa-minus';
        }
        if (!this.minimap!.classList.contains('collapsed')) {
            this.update();
        }
    },

    // ─────────────────────────────────────────
    // 点击/拖拽导航
    // ─────────────────────────────────────────

    _navigate(e: MouseEvent): void {
        if (!this._mapMeta) return;

        const rect     = this.content!.getBoundingClientRect();
        const clickX   = e.clientX - rect.left - this._padding;
        const clickY   = e.clientY - rect.top  - this._padding;
        const { minX, minY, mapScale } = this._mapMeta;

        // 转换为画布坐标
        const canvasX = clickX / mapScale + minX;
        const canvasY = clickY / mapScale + minY;

        // 居中显示
        const containerRect      = this.container!.getBoundingClientRect();
        AppState.canvas.panX = -canvasX * AppState.canvas.scale + containerRect.width  / 2;
        AppState.canvas.panY = -canvasY * AppState.canvas.scale + containerRect.height / 2;

        Canvas.updateTransform();
        this.update();
    },

    // ─────────────────────────────────────────
    // 事件绑定
    // ─────────────────────────────────────────

    _bindEvents(): void {
        if (!this.content) return;

        this.content.addEventListener('mousedown', (e: MouseEvent) => {
            if (e.target === this.viewport) return;
            e.preventDefault();
            this._isDragging = true;
            this._navigate(e);
        });

        window.addEventListener('mousemove', (e: MouseEvent) => {
            if (this._isDragging) this._navigate(e);
        });

        window.addEventListener('mouseup', () => {
            this._isDragging = false;
        });
    },

    // ─────────────────────────────────────────
    // 监听卡片变化自动更新
    // ─────────────────────────────────────────

    _observeCards(): void {
        const target = document.getElementById('cards-container')
            || document.getElementById('transform-layer');

        const observer = new MutationObserver(() => this.scheduleUpdate());
        observer.observe(target!, {
            childList:       true,
            subtree:         true,
            attributes:      true,
            attributeFilter: ['style']
        });
    }
};

(window as unknown as Record<string, unknown>).Minimap = Minimap;
