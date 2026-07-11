/**
 * 激光切割模块
 * 实现 Ctrl+右键 拖动切割连线功能
 * 使用线段相交算法判断哪条连线被切割
 */
window.Laser = {
    start(e) {
        AppState.laser.isCutting = true;
        AppState.laser.startX    = e.clientX;
        AppState.laser.startY    = e.clientY;
        AppState.laser.lastX     = e.clientX;
        AppState.laser.lastY     = e.clientY;

        const line = Dom.createSVG('path', { class: 'laser-line', d: '' });
        document.getElementById('svg-layer').appendChild(line);
        AppState.laser.laserLine          = line;
        Canvas.container.style.cursor     = 'crosshair';
    },

    update(e) {
        if (!AppState.laser.isCutting) return;
        const { startX, startY, lastX, lastY } = AppState.laser;
        const p1 = Canvas.toCanvasCoords(startX, startY);
        const p2 = Canvas.toCanvasCoords(e.clientX, e.clientY);
        AppState.laser.laserLine?.setAttribute(
            'd', `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`
        );
        this._checkCollision(lastX, lastY, e.clientX, e.clientY);
        AppState.laser.lastX = e.clientX;
        AppState.laser.lastY = e.clientY;
    },

    end() {
        if (!AppState.laser.isCutting) return;
        AppState.laser.isCutting    = false;
        AppState.laser.justFinished = true;
        AppState.laser.laserLine?.remove();
        AppState.laser.laserLine      = null;
        Canvas.container.style.cursor = 'default';
    },

    _checkCollision(x1, y1, x2, y2) {
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

    _intersects(a1, a2, b1, b2) {
        const s1x = a2.x - a1.x, s1y = a2.y - a1.y;
        const s2x = b2.x - b1.x, s2y = b2.y - b1.y;
        const d   = -s2x * s1y + s1x * s2y;
        if (d === 0) return false;
        const s = (-s1y * (a1.x - b1.x) + s1x * (a1.y - b1.y)) / d;
        const t = ( s2x * (a1.y - b1.y) - s2y * (a1.x - b1.x)) / d;
        return s >= 0 && s <= 1 && t >= 0 && t <= 1;
    }
};
