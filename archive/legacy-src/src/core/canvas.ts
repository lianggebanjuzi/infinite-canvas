// src/core/canvas.ts
// 画布引擎：缩放、平移、坐标转换

import { AppState } from '../state/app-state';

declare const Minimap: {
    updateViewportOnly(): void;
    scheduleUpdate(): void;
    update(): void;
};

export const Canvas = {
    container: null as HTMLElement | null,
    transformLayer: null as HTMLElement | null,
    svgLayer: null as SVGSVGElement | null,

    init(): void {
        this.container      = document.getElementById('canvas-container');
        this.transformLayer = document.getElementById('transform-layer');
        this.svgLayer       = document.getElementById('svg-layer') as SVGSVGElement | null;

        if (this.svgLayer) this._initSVGMarkers();
        this._bindEvents();
    },

    _initSVGMarkers(): void {
        if (!this.svgLayer) return;

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

    updateTransform(): void {
        if (!this.transformLayer) return;

        const { panX, panY, scale } = AppState.canvas;
        this.transformLayer.style.transform =
            `translate(${panX}px, ${panY}px) scale(${scale})`;

        const gridSize = 22;
        if (this.container) {
            this.container.style.backgroundSize     = `${gridSize * scale}px ${gridSize * scale}px`;
            this.container.style.backgroundPosition = `${panX}px ${panY}px`;
        }
    },

    toCanvasCoords(screenX: number, screenY: number): { x: number; y: number } {
        const rect  = this.container?.getBoundingClientRect() ?? { left: 0, top: 0 };
        const { panX, panY, scale } = AppState.canvas;
        return {
            x: (screenX - rect.left - panX) / scale,
            y: (screenY - rect.top  - panY) / scale
        };
    },

    zoom(delta: number, mouseX: number, mouseY: number): void {
        const { scale, panX, panY } = AppState.canvas;
        const newScale = Math.min(Math.max(0.1, scale * delta), 5);

        const rect = this.container?.getBoundingClientRect() ?? { left: 0, top: 0 };
        const mx   = mouseX - rect.left;
        const my   = mouseY - rect.top;

        AppState.canvas.panX   = mx - (mx - panX) * (newScale / scale);
        AppState.canvas.panY   = my - (my - panY) * (newScale / scale);
        AppState.canvas.scale = newScale;

        this.updateTransform();

        const layer = document.getElementById('transform-layer');
        if (layer) layer.style.transform = `${layer.style.transform} translateZ(0)`;
    },

    _bindEvents(): void {
        if (!this.container) return;

        // 滚轮缩放
        this.container.addEventListener('wheel', (e) => {
            const target = e.target as Element;
            if (target && (
                target.tagName === 'TEXTAREA' ||
                target.tagName === 'INPUT' ||
                target.classList.contains('textarea') ||
                (target as HTMLElement).isContentEditable
            )) {
                const canScroll = (
                    (target as HTMLElement).scrollHeight > (target as HTMLElement).clientHeight ||
                    (target as HTMLElement).scrollWidth > (target as HTMLElement).clientWidth
                );
                if (canScroll) return;
            }

            const wheelCard = target?.closest('.drawing-board-card');
            if (wheelCard && wheelCard.classList.contains('selected')) {
                return;
            }

            e.preventDefault();
            const delta = e.deltaY > 0 ? 0.9 : 1.1;
            this.zoom(delta, e.clientX, e.clientY);
            Minimap.updateViewportOnly();
            Minimap.scheduleUpdate();
        }, { passive: false });

        // 中键拖动
        this.container.addEventListener('mousedown', (e) => {
            if (e.button === 1) {
                const drawingCard = (e.target as Element)?.closest('.drawing-board-card');
                if (drawingCard && drawingCard.classList.contains('selected')) {
                    return;
                }
                AppState.canvas.isPanning = true;
                AppState.canvas.startPanX = e.clientX - AppState.canvas.panX;
                AppState.canvas.startPanY = e.clientY - AppState.canvas.panY;
                if (this.container) this.container.style.cursor = 'grabbing';
            }
        });

        window.addEventListener('mousemove', (e) => {
            if (!AppState.canvas.isPanning) return;
            AppState.canvas.panX = e.clientX - AppState.canvas.startPanX;
            AppState.canvas.panY = e.clientY - AppState.canvas.startPanY;
            this.updateTransform();
            Minimap.updateViewportOnly();
        });

        window.addEventListener('mouseup', () => {
            if (AppState.canvas.isPanning) {
                AppState.canvas.isPanning = false;
                if (this.container) this.container.style.cursor = 'default';
                Minimap.update();
            }
        });
    }
};

(window as unknown as { Canvas: typeof Canvas }).Canvas = Canvas;
