// src/independent/laser-cutter.ts
// 激光切割：Ctrl+右键 拖动切割连线

import { AppState } from '../state/app-state';
import { Dom } from '../utils/dom';

declare const Canvas: {
    toCanvasCoords(x: number, y: number): { x: number; y: number };
    container: HTMLElement | null;
};
declare const ConnectionManager: {
    getEndpoints(cardA: HTMLElement, cardB: HTMLElement): { p1: { x: number; y: number }; p2: { x: number; y: number } };
    remove(conn: { start: string; end: string; element?: SVGPathElement }): void;
};

export const Laser = {
    start(e: MouseEvent): void {
        AppState.laser.isCutting = true;
        AppState.laser.startX   = e.clientX;
        AppState.laser.startY   = e.clientY;
        AppState.laser.lastX    = e.clientX;
        AppState.laser.lastY    = e.clientY;

        const line = Dom.createSVG('path', { class: 'laser-line', d: '' });
        document.getElementById('svg-layer')?.appendChild(line);
        AppState.laser.laserLine = line as SVGPathElement;
        if (Canvas.container) Canvas.container.style.cursor = 'crosshair';
    },

    update(e: MouseEvent): void {
        if (!AppState.laser.isCutting) return;
        const { startX, startY, lastX, lastY } = AppState.laser;
        const p1 = Canvas.toCanvasCoords(startX, startY);
        const p2 = Canvas.toCanvasCoords(e.clientX, e.clientY);
        AppState.laser.laserLine?.setAttribute('d', `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`);
        this._checkCollision(lastX, lastY, e.clientX, e.clientY);
        AppState.laser.lastX = e.clientX;
        AppState.laser.lastY = e.clientY;
    },

    end(): void {
        if (!AppState.laser.isCutting) return;
        AppState.laser.isCutting    = false;
        AppState.laser.justFinished = true;
        AppState.laser.laserLine?.remove();
        AppState.laser.laserLine = null;
        if (Canvas.container) Canvas.container.style.cursor = 'default';
    },

    _checkCollision(x1: number, y1: number, x2: number, y2: number): void {
        const p1 = Canvas.toCanvasCoords(x1, y1);
        const p2 = Canvas.toCanvasCoords(x2, y2);

        AppState.connections.list.forEach(conn => {
            const cardA = document.getElementById(conn.start);
            const cardB = document.getElementById(conn.end);
            if (!cardA || !cardB) return;

            const pts = ConnectionManager.getEndpoints(cardA, cardB);
            if (this._intersects(p1, p2, pts.p1, pts.p2)) {
                ConnectionManager.remove(conn);
            }
        });
    },

    _intersects(
        a1: { x: number; y: number }, a2: { x: number; y: number },
        b1: { x: number; y: number }, b2: { x: number; y: number }
    ): boolean {
        const s1x = a2.x - a1.x, s1y = a2.y - a1.y;
        const s2x = b2.x - b1.x, s2y = b2.y - b1.y;
        const d   = -s2x * s1y + s1x * s2y;
        if (d === 0) return false;
        const s = (-s1y * (a1.x - b1.x) + s1x * (a1.y - b1.y)) / d;
        const t = ( s2x * (a1.y - b1.y) - s2y * (a1.x - b1.x)) / d;
        return s >= 0 && s <= 1 && t >= 0 && t <= 1;
    }
};

(window as unknown as Record<string, unknown>).Laser = Laser;
