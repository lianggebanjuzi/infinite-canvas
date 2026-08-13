// src/independent/selection-box.ts
// 框选：Shift+左键 拖动选择多个卡片

import { AppState } from '../state/app-state';

declare const Canvas: { toCanvasCoords(x: number, y: number): { x: number; y: number } };

export const SelectionBox = {
    start(e: MouseEvent): void {
        AppState.selection.isBoxSelecting = true;
        const pos = Canvas.toCanvasCoords(e.clientX, e.clientY);
        AppState.selection.startX = pos.x;
        AppState.selection.startY = pos.y;

        const box = document.createElement('div');
        box.className    = 'selection-box';
        box.style.left   = pos.x + 'px';
        box.style.top    = pos.y + 'px';
        box.style.width  = '0px';
        box.style.height = '0px';
        document.getElementById('transform-layer')?.appendChild(box);
        AppState.selection.selectionBox = box;
    },

    update(e: MouseEvent): void {
        if (!AppState.selection.isBoxSelecting) return;
        const box = AppState.selection.selectionBox;
        if (!box) return;
        const pos = Canvas.toCanvasCoords(e.clientX, e.clientY);
        const { startX, startY } = AppState.selection;

        box.style.left   = Math.min(startX, pos.x) + 'px';
        box.style.top    = Math.min(startY, pos.y) + 'px';
        box.style.width  = Math.abs(pos.x - startX) + 'px';
        box.style.height = Math.abs(pos.y - startY) + 'px';
    },

    end(): void {
        if (!AppState.selection.isBoxSelecting) return;
        AppState.selection.isBoxSelecting = false;

        const box = AppState.selection.selectionBox;
        if (!box) return;

        const boxL = parseFloat(box.style.left);
        const boxT = parseFloat(box.style.top);
        const boxR = boxL + parseFloat(box.style.width);
        const boxB = boxT + parseFloat(box.style.height);

        AppState.cards.multiSelected = [];
        document.querySelectorAll('.card').forEach(card => {
            const el = card as HTMLElement;
            el.classList.remove('multi-selected');
            const l = parseFloat(el.style.left);
            const t = parseFloat(el.style.top);
            const r = l + el.offsetWidth;
            const b = t + el.offsetHeight;

            if (l < boxR && r > boxL && t < boxB && b > boxT) {
                el.classList.add('multi-selected');
                AppState.cards.multiSelected.push(el);
            }
        });

        box.remove();
        AppState.selection.selectionBox = null;
    }
};

(window as unknown as Record<string, unknown>).SelectionBox = SelectionBox;
