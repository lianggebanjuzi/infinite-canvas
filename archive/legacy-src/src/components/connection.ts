// src/components/connection.ts
// 连线管理：创建、更新、删除画布连线

import { AppState } from '../state/app-state';
import { Dom } from '../utils/dom';
import { SnapshotCollector } from '../core/snapshot';

// ─────────────────────────────────────────
// 全局声明（浏览器全局变量）
// ─────────────────────────────────────────

declare const Toast: { show(message: string, duration?: number): void };
declare const uid: (prefix: string) => string;
declare const Minimap: { scheduleUpdate(): void };
declare const CardFactory: {
    create(...args: unknown[]): unknown;
    getInstance(id: string): unknown;
    deleteSelected(): void;
    deselectAll(): void;
    destroyInstance(id: string): void;
};
declare const CmdManager: { execute(cmd: unknown): void };
declare const CreateConnectionCommand: new (startId: string, endId: string, endPort: string | null) => unknown;
declare const RemoveConnectionCommand: new (connId: string) => unknown;
declare const Canvas: {
    toCanvasCoords(x: number, y: number): { x: number; y: number };
    scale: number;
    panX: number;
    panY: number;
};
declare const PipelineEngine: { trigger(cardId: string, dataType: string): void };
declare const ConnectionRules: {
    applyOnConnect(source: unknown, target: unknown, endPort: string | null): void;
    applyOnDisconnect(source: unknown, target: unknown, endPort: string | null): void;
};
declare const GroupManager: { getById?(id: string): unknown } | null;
declare const CardEventBus: {
    EventTypes: {
        CONNECTED: string;
        DISCONNECTED: string;
        DATA_CHANGED: string;
        RUN_COMPLETED: string;
    };
    emit(eventType: string, data: unknown): void;
};

// ─────────────────────────────────────────
// 接口
// ─────────────────────────────────────────

interface Connection {
    id: string;
    start: string;
    end: string;
    endPort: string | null;
    element: SVGPathElement;
    isGroupPin: boolean;
    groupId: string | null;
    pinDirection: string | null;
    pinId: string | null;
}

interface SnapTarget {
    cardEl: HTMLElement;
    portEl: Element;
    worldX: number;
    worldY: number;
}

interface StartPort {
    cardId: string;
    portRole: string;
    inputName: string | null;
    x: number;
    y: number;
}

interface Point {
    x: number;
    y: number;
}

interface CardInstance {
    getType?(): string;
    refreshUpstream?(): void;
}

// 对比卡片端口位置常量（与 card.css 中的注释保持一致）
const COMPARE_PORT_A_RATIO = 0.35;  // 端口 A 位于卡片高度的 35%
const COMPARE_PORT_B_RATIO = 0.65;  // 端口 B 位于卡片高度的 65%

export const ConnectionManager = {

    /** 拖拽连线时磁吸到的目标（mouseup 时用于落点） */
    _snapTarget: null as SnapTarget | null,

    // ─────────────────────────────────────────
    // 初始化
    // ─────────────────────────────────────────

    init(): void {
        this._bindEvents();
        this._setupMenuCleanup();
    },

    /**
     * 连线锚点：只按卡片矩形边框计算，与 DOM 端口圆点（悬浮显示）解耦。
     * 端口仍用于拖拽命中与对比卡 A/B 识别。
     * @param {'left'|'right'} edge
     */
    _wirePointOnCard(cardEl: HTMLElement, edge: 'left' | 'right', portEl: HTMLElement | null = null): Point {
        const L = parseFloat(cardEl.style.left) || 0;
        const T = parseFloat(cardEl.style.top) || 0;
        const W = cardEl.offsetWidth;
        const H = cardEl.offsetHeight;
        const midY = T + H / 2;

        if (edge === 'right') {
            return { x: L + W, y: midY };
        }
        if (edge === 'left') {
            if (cardEl.dataset.type === 'compare' && portEl?.dataset?.inputName) {
                const ep = portEl.dataset.inputName;
                const ratio = ep === 'A' ? COMPARE_PORT_A_RATIO
                    : ep === 'B' ? COMPARE_PORT_B_RATIO : 0.5;
                return { x: L, y: T + H * ratio };
            }
            return { x: L, y: midY };
        }
        return { x: L, y: midY };
    },

    _wireDragStart(cardEl: HTMLElement, portRole: string, portEl: HTMLElement): Point {
        if (portRole === 'output') {
            return this._wirePointOnCard(cardEl, 'right', null);
        }
        return this._wirePointOnCard(cardEl, 'left', portEl);
    },

    _wireDragTargetEnd(cardEl: HTMLElement, portEl: HTMLElement | null, draggingFromOutput: boolean): Point {
        return draggingFromOutput
            ? this._wirePointOnCard(cardEl, 'left', portEl)
            : this._wirePointOnCard(cardEl, 'right', null);
    },

    /**
     * 用端口 DOM 做近邻检测；返回的坐标为卡片边上的连线锚点（非圆点中心）。
     */
    _findNearestSnapTarget(clientX: number, clientY: number, startPort: StartPort): SnapTarget | null {
        const SNAP_PX = 44;
        const role = startPort.portRole;
        const excludeId = startPort.cardId;
        const selector = role === 'output' ? '.port-left' : '.port-right';

        let best: { cardEl: HTMLElement; portEl: Element } | null = null;
        let bestDist = Infinity;

        document.querySelectorAll('#cards-container .card').forEach(cardEl => {
            if ((cardEl as HTMLElement).id === excludeId) return;
            cardEl.querySelectorAll(selector).forEach(portEl => {
                const r = portEl.getBoundingClientRect();
                if (!r.width && !r.height) return;
                const cx = r.left + r.width / 2;
                const cy = r.top + r.height / 2;
                const d = Math.hypot(clientX - cx, clientY - cy);
                if (d < SNAP_PX && d < bestDist) {
                    bestDist = d;
                    best = { cardEl: cardEl as HTMLElement, portEl };
                }
            });
        });

        if (!best) return null;

        const found = best as { cardEl: HTMLElement; portEl: Element };
        const anchor = this._wireDragTargetEnd(
            found.cardEl,
            found.portEl as HTMLElement,
            startPort.portRole === 'output'
        );
        return {
            cardEl: found.cardEl,
            portEl: found.portEl,
            worldX: anchor.x,
            worldY: anchor.y
        };
    },

    /** 监听菜单关闭，清理 pendingConnection */
    _setupMenuCleanup(): void {
        const menu = document.getElementById('canvas-menu');
        if (!menu) return;

        const observer = new MutationObserver(() => {
            if (menu.style.display === 'none' && (AppState.connections as Record<string, unknown>).pendingConnection) {
                (AppState.connections as Record<string, unknown>).pendingConnection = null;
            }
        });
        observer.observe(menu, { attributes: true, attributeFilter: ['style'] });
    },

    // ─────────────────────────────────────────
    // 创建连线
    // ─────────────────────────────────────────

    create(startId: string, endId: string, endPort: string | null = null, saveHistory = true): Connection | null {
        const t0 = performance.now();

        // 如果目标端口已存在连接，先移除旧连接
        if (endPort) {
            const existingConn = AppState.connections.list
                .find(c => c.end === endId && c.endPort === endPort);
            if (existingConn) {
                this.remove(existingConn as unknown as Connection);
            }
        }

        const exists = AppState.connections.list
            .some(c => c.start === startId && c.end === endId && c.endPort === endPort);
        if (exists) return null;

        if (startId === endId) return null;

        const path = Dom.createSVG('path', {
            stroke:         'var(--pastel-mint-mid)',
            'stroke-width': '2',
            fill:           'none',
            'marker-start': 'url(#dot-marker)',
            'marker-end':   'url(#dot-marker)'
        });

        document.getElementById('svg-layer')!.appendChild(path);

        const conn: Connection = {
            id:           uid('conn'),
            start:        startId,
            end:          endId,
            endPort:      endPort,
            element:      path as unknown as SVGPathElement,
            // 桩连线扩展字段
            isGroupPin:   false,
            groupId:      null,
            pinDirection: null,
            pinId:        null
        };

        AppState.connections.list.push(conn as unknown as typeof AppState.connections.list[number]);

        const t1 = performance.now();
        this._updatePath(conn);

        const t2 = performance.now();
        this._onConnectionCreated(startId, endId, endPort);

        const t3 = performance.now();
        if (saveHistory && (window as unknown as Record<string, unknown>).CmdManager) {
            CmdManager.execute(new CreateConnectionCommand(startId, endId, endPort));
        }

        const t4 = performance.now();
        Minimap.scheduleUpdate();

        const t5 = performance.now();
        if (t5 - t0 > 16) {
            console.warn(`[ConnectionManager] ⚠️ create 总耗时 ${(t5-t0).toFixed(1)}ms | SVG+list:${(t1-t0).toFixed(1)}ms _updatePath:${(t2-t1).toFixed(1)}ms _onConnect:${(t3-t2).toFixed(1)}ms UndoRedo:${(t4-t3).toFixed(1)}ms minimap:${(t5-t4).toFixed(1)}ms`);
        }
        if (t5 - t0 > 50) {
            console.error(`[ConnectionManager] 🔴 create 严重卡顿 ${(t5-t0).toFixed(1)}ms，_onConnect=${(t3-t2).toFixed(1)}ms`);
        }

        return conn;
    },

    // ─────────────────────────────────────────
    // 删除连线
    // ─────────────────────────────────────────

    // ★ 修复：先从列表删掉，再触发副作用
    // 这样 _onConnectionRemoved 里查连线状态时，已经是删除后的状态
    remove(conn: Connection): void {
        conn.element?.remove();
        AppState.connections.list =
            AppState.connections.list.filter(c => c !== conn);
        this._onConnectionRemoved(conn.start, conn.end);
        Minimap.scheduleUpdate();
    },

    removeByCardId(cardId: string): void {
        const toRemove = AppState.connections.list
            .filter(c => c.start === cardId || c.end === cardId);
        toRemove.forEach(c => this.remove(c as unknown as Connection));
    },

    clearAll(): void {
        [...AppState.connections.list].forEach(c => this.remove(c as unknown as Connection));
    },

    // ─────────────────────────────────────────
    // 更新连线路径
    // ─────────────────────────────────────────

    _updatePath(conn: Connection): void {
        const cardA = document.getElementById(conn.start);
        const cardB = document.getElementById(conn.end);

        if (!cardA || !cardB) {
            this.remove(conn);
            return;
        }

        const { p1, p2 } = this.getEndpoints(cardA, cardB, conn);
        const dist   = Math.abs(p2.x - p1.x);
        const offset = Math.max(dist * 0.5, 50);
        const d = `M ${p1.x} ${p1.y} C ${p1.x + offset} ${p1.y}, ${p2.x - offset} ${p2.y}, ${p2.x} ${p2.y}`;
        conn.element.setAttribute('d', d);
    },

    getEndpoints(cardA: HTMLElement, cardB: HTMLElement, conn: Connection | null = null): { p1: Point; p2: Point } {
        const LA = parseFloat(cardA.style.left) || 0;
        const TA = parseFloat(cardA.style.top) || 0;
        const WA = cardA.offsetWidth;
        const HA = cardA.offsetHeight;
        const p1: Point = { x: LA + WA, y: TA + HA / 2 };

        const LB = parseFloat(cardB.style.left) || 0;
        const TB = parseFloat(cardB.style.top) || 0;
        const HB = cardB.offsetHeight;
        let p2y = TB + HB / 2;
        if (cardB.dataset.type === 'compare') {
            const ep = conn?.endPort;
            if (ep === 'A') p2y = TB + HB * COMPARE_PORT_A_RATIO;
            else if (ep === 'B') p2y = TB + HB * COMPARE_PORT_B_RATIO;
        }
        const p2: Point = { x: LB, y: p2y };

        return { p1, p2 };
    },

    // ─────────────────────────────────────────
    // 节流更新
    // ─────────────────────────────────────────

    scheduleUpdate(cardId: string): void {
        (AppState.performance.connectionUpdateQueue as Set<string>).add(cardId);

        if (AppState.performance.connectionUpdateTimer) return;

        AppState.performance.connectionUpdateTimer =
            requestAnimationFrame(() => {
                (AppState.performance.connectionUpdateQueue as Set<string>).forEach(id => {
                    AppState.connections.list.forEach(c => {
                        if (c.start === id || c.end === id) {
                            this._updatePath(c as unknown as Connection);
                        }
                    });
                });
                (AppState.performance.connectionUpdateQueue as Set<string>).clear();
                AppState.performance.connectionUpdateTimer = null;
            });
    },

    updateCardConnections(cardId: string): void {
        AppState.connections.list.forEach(c => {
            if (c.start === cardId || c.end === cardId) {
                this._updatePath(c as unknown as Connection);
            }
        });
    },

    // ─────────────────────────────────────────
    // 拖拽创建连线（从端口 / 组桩）
    // ─────────────────────────────────────────

    startConnection(card: HTMLElement, port: HTMLElement, portRole: string): void {
        AppState.connections.isConnecting = true;
        ConnectionManager._snapTarget = null;
        document.getElementById('canvas-container')?.classList.add('is-dragging-connection');

        const p0 = ConnectionManager._wireDragStart(card, portRole, port);

        (AppState.connections.startPort as unknown as StartPort) = {
            cardId:    card.id,
            portRole:  portRole,
            inputName: port.dataset.inputName || null, // 对比卡片端口 A/B，用于连线时记录 endPort
            x:         p0.x,
            y:         p0.y
        };

        const tempLine = Dom.createSVG('path', {
            stroke:             'var(--pastel-mint)',
            'stroke-width':     '2',
            fill:               'none',
            'stroke-dasharray': '5,5'
        });

        document.getElementById('svg-layer')!.appendChild(tempLine);
        AppState.connections.tempLine = tempLine as unknown as SVGPathElement;

        window.addEventListener('mousemove', ConnectionManager._onDragMove);
        window.addEventListener('mouseup',   ConnectionManager._onDragEnd);
    },

    _onDragMove(e: MouseEvent): void {
        const { tempLine, startPort } = AppState.connections;
        if (!tempLine || !startPort) return;

        let endX = (e.clientX - AppState.canvas.panX) / AppState.canvas.scale;
        let endY = (e.clientY - AppState.canvas.panY) / AppState.canvas.scale;

        const snap = ConnectionManager._findNearestSnapTarget(e.clientX, e.clientY, startPort as unknown as StartPort);
        ConnectionManager._snapTarget = snap;
        if (snap) {
            endX = snap.worldX;
            endY = snap.worldY;
        }

        tempLine.setAttribute('d',
            `M ${(startPort as unknown as StartPort).x} ${(startPort as unknown as StartPort).y} L ${endX} ${endY}`
        );
    },

    _onDragEnd(e: MouseEvent): void {
        const t0 = performance.now();

        // 先保存 startPort，因为后面会被清空
        const startPort = AppState.connections.startPort as unknown as StartPort | null;
        const tempLine  = AppState.connections.tempLine;

        AppState.connections.isConnecting = false;

        document.getElementById('canvas-container')?.classList.remove('is-dragging-connection');

        const snap = ConnectionManager._snapTarget;
        ConnectionManager._snapTarget = null;

        window.removeEventListener('mousemove', ConnectionManager._onDragMove);
        window.removeEventListener('mouseup',   ConnectionManager._onDragEnd);

        tempLine?.remove();
        AppState.connections.tempLine = null;

        const t1 = performance.now();
        if (t1 - t0 > 16) console.warn(`[ConnectionManager] ⚠️ 清理耗时 ${(t1-t0).toFixed(1)}ms`);

        // 如果没有 startPort（不应该发生），直接返回
        if (!startPort) {
            AppState.connections.startPort = null;
            return;
        }

        // 优先使用磁吸到的端口所在卡片；否则按鼠标位置查找
        let targetCard: HTMLElement | null = snap?.cardEl || (e.target as HTMLElement).closest('.card');
        if (!targetCard) {
            const mouseX = e.clientX;
            const mouseY = e.clientY;
            const cards = document.querySelectorAll('#cards-container .card');
            for (const card of cards) {
                const rect = card.getBoundingClientRect();
                if (mouseX >= rect.left && mouseX <= rect.right &&
                    mouseY >= rect.top && mouseY <= rect.bottom) {
                    targetCard = card as HTMLElement;
                    break;
                }
            }
        }

        const t2 = performance.now();
        if (t2 - t1 > 16) console.warn(`[ConnectionManager] ⚠️ 查找卡片耗时 ${(t2-t1).toFixed(1)}ms`);

        const startRole = startPort.portRole;

        if (targetCard && targetCard.id !== startPort.cardId) {
            const t3 = performance.now();

            // 连接到现有卡片
            const targetType = targetCard.dataset.type;

            if (targetType === 'compare') {
                let endPort: string | null = snap?.portEl?.getAttribute('data-input-name') || null;
                if (!endPort && startRole === 'output') {
                    const cardRect = targetCard.getBoundingClientRect();
                    const relativeY = (e.clientY - cardRect.top) / cardRect.height;
                    endPort = relativeY < 0.5 ? 'A' : 'B';
                } else if (!endPort && startRole === 'input') {
                    endPort = startPort.inputName || null;
                }

                if (startRole === 'output') {
                    ConnectionManager.create(startPort.cardId, targetCard.id, endPort);
                } else {
                    ConnectionManager.create(targetCard.id, startPort.cardId, endPort);
                }

                const card = CardFactory.getInstance(targetCard.id) as CardInstance | null;
                if (card && card.refreshUpstream) card.refreshUpstream();
            } else {
                const endPort: string | null = (startRole === 'input' && startPort.inputName) ? startPort.inputName : null;

                if (startRole === 'output') {
                    ConnectionManager.create(startPort.cardId, targetCard.id, endPort);
                } else {
                    ConnectionManager.create(targetCard.id, startPort.cardId, endPort);
                }

                if (startRole === 'input') {
                    const card = CardFactory.getInstance(startPort.cardId) as CardInstance | null;
                    if (card && card.refreshUpstream) card.refreshUpstream();
                }
            }

            const t4 = performance.now();
            if (t4 - t3 > 16) console.warn(`[ConnectionManager] ⚠️ create + 卡片操作耗时 ${(t4-t3).toFixed(1)}ms`);
            if (t4 - t0 > 50) console.warn(`[ConnectionManager] 🔴 _onDragEnd 严重卡顿 ${(t4-t0).toFixed(1)}ms`);
        } else if (!targetCard) {
            const canvasMenu = document.getElementById('canvas-menu');
            if (canvasMenu) {
                const pos: Point = {
                    x: (e.clientX - AppState.canvas.panX) / AppState.canvas.scale,
                    y: (e.clientY - AppState.canvas.panY) / AppState.canvas.scale
                };
                (AppState.connections as Record<string, unknown>).pendingConnection = {
                    startPort: startPort,
                    createPos: pos
                };

                setTimeout(() => {
                    canvasMenu.style.left    = e.clientX + 'px';
                    canvasMenu.style.top     = e.clientY + 'px';
                    canvasMenu.style.display = 'block';
                }, 10);

                e.preventDefault();
                e.stopPropagation();
            }
        }

        AppState.connections.startPort = null;
    },

    /** 从连线创建菜单创建卡片后自动连线 */
    createCardAndConnect(type: string): void {
        const pending = AppState.connections.pendingConnection as unknown as {
            startPort: StartPort;
            createPos: Point;
        } | null;

        // 有 pendingConnection：连线拖拽时创建卡片并连线
        if (pending && pending.createPos) {
            const card = CardFactory.create(type, {
                x: pending.createPos.x,
                y: pending.createPos.y
            }, true) as CardInstance & { id: string } | null;

            if (card && pending.startPort) {
                const startRole = pending.startPort.portRole;

                if (type === 'compare') {
                    // 对比卡片：根据起点 Y 位置决定连接到 A 还是 B
                    const endPort: string | null = pending.startPort.y <= pending.createPos.y ? 'A' : 'B';

                    if (startRole === 'output') {
                        ConnectionManager.create(pending.startPort.cardId, card.id, endPort);
                    } else {
                        ConnectionManager.create(card.id, pending.startPort.cardId, endPort);
                    }

                    // 通知对比卡片刷新
                    if (card.refreshUpstream) {
                        card.refreshUpstream();
                    }
                } else {
                    // 普通卡片
                    if (startRole === 'output') {
                        ConnectionManager.create(pending.startPort.cardId, card.id);
                    } else {
                        ConnectionManager.create(card.id, pending.startPort.cardId);
                    }
                }
            }

            this.clearPendingConnection();
            return;
        }

        // 没有 pendingConnection：普通右键菜单，只创建卡片
        const pos = (AppState.canvas as Record<string, unknown>).contextClickPos as Point | null;
        if (pos) {
            CardFactory.create(type, { x: pos.x, y: pos.y }, true);
        }

        // 隐藏菜单
        const menu = document.getElementById('canvas-menu');
        if (menu) menu.style.display = 'none';
    },

    /** 清理待连接的挂起状态 */
    clearPendingConnection(): void {
        (AppState.connections as Record<string, unknown>).pendingConnection = null;
        const menu = document.getElementById('canvas-menu');
        if (menu) menu.style.display = 'none';
    },

    // ─────────────────────────────────────────
    // 连线创建/删除时的副作用（使用契约规则系统）
    // ─────────────────────────────────────────

    _onConnectionCreated(startId: string, endId: string, endPort: string | null = null): void {
        const startCard = CardFactory.getInstance(startId);
        const endCard   = CardFactory.getInstance(endId);

        // 使用新的契约规则系统
        ConnectionRules.applyOnConnect(startCard, endCard, endPort);

        // 发布连接建立事件
        if (startCard && endCard) {
            CardEventBus.emit(CardEventBus.EventTypes.CONNECTED, {
                startId,
                endId,
                endPort,
                sourceType: (startCard as CardInstance).getType?.(),
                targetType: (endCard as CardInstance).getType?.(),
            });
        }
    },

    _onConnectionRemoved(startId: string, endId: string): void {
        const startCard = CardFactory.getInstance(startId);
        const endCard   = CardFactory.getInstance(endId);

        // 使用新的契约规则系统
        ConnectionRules.applyOnDisconnect(startCard, endCard, null);

        // 发布连接断开事件
        if (startCard && endCard) {
            CardEventBus.emit(CardEventBus.EventTypes.DISCONNECTED, {
                startId,
                endId,
                sourceType: (startCard as CardInstance).getType?.(),
                targetType: (endCard as CardInstance).getType?.(),
            });
        }
    },

    // ─────────────────────────────────────────
    // 绑定连线点击删除
    // ─────────────────────────────────────────

    _bindEvents(): void {
        document.getElementById('svg-layer')!
            .addEventListener('click', (e: MouseEvent) => {
                const path = (e.target as HTMLElement).closest('path');
                if (!path) return;

                const conn = AppState.connections.list
                    .find(c => c.element === path) as unknown as Connection | undefined;
                if (conn) {
                    const connId = conn.id;
                    this.remove(conn);
                    if ((window as unknown as Record<string, unknown>).CmdManager) {
                        CmdManager.execute(new RemoveConnectionCommand(connId));
                    }
                }
            });
    }
};

(window as unknown as Record<string, unknown>).ConnectionManager = ConnectionManager;
