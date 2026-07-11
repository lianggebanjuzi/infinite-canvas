/**
 * 框选模块
 * 实现 Shift+左键 拖动框选多个卡片的功能
 * 支持选中多个后批量移动/删除
 */
window.SelectionBox = {
    start(e) {
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
        document.getElementById('transform-layer').appendChild(box);
        AppState.selection.selectionBox = box;
    },

    update(e) {
        if (!AppState.selection.isBoxSelecting) return;
        const box = AppState.selection.selectionBox;
        const pos = Canvas.toCanvasCoords(e.clientX, e.clientY);
        const { startX, startY } = AppState.selection;

        box.style.left   = Math.min(startX, pos.x) + 'px';
        box.style.top    = Math.min(startY, pos.y) + 'px';
        box.style.width  = Math.abs(pos.x - startX) + 'px';
        box.style.height = Math.abs(pos.y - startY) + 'px';
    },

    end() {
        if (!AppState.selection.isBoxSelecting) return;
        AppState.selection.isBoxSelecting = false;

        const box  = AppState.selection.selectionBox;
        const boxL = parseFloat(box.style.left);
        const boxT = parseFloat(box.style.top);
        const boxR = boxL + parseFloat(box.style.width);
        const boxB = boxT + parseFloat(box.style.height);

        AppState.cards.multiSelected = [];
        document.querySelectorAll('.card').forEach(card => {
            card.classList.remove('multi-selected');
            const l = parseFloat(card.style.left);
            const t = parseFloat(card.style.top);
            const r = l + card.offsetWidth;
            const b = t + card.offsetHeight;

            if (l < boxR && r > boxL && t < boxB && b > boxT) {
                card.classList.add('multi-selected');
                AppState.cards.multiSelected.push(card);
            }
        });

        box.remove();
        AppState.selection.selectionBox = null;
    }
};
