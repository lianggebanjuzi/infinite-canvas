// src/core/snapshot.ts
// 快照收集器 + 恢复器（画布序列化统一逻辑）

import { SnapshotUtils } from '../utils/snapshot';
import { AppState } from '../state/app-state';

declare const Canvas: {
    updateTransform(): void;
};

declare const Minimap: {
    update(): void;
    scheduleUpdate(): void;
    updateViewportOnly(): void;
};

declare const CardFactory: {
    create(type: string, options: Record<string, unknown>, saveHistory?: boolean, extra?: unknown): { id: string; type: string; title?: string; content?: string; maskData?: unknown; groupId?: string | null };
    getInstance(id: string): { id: string; type: string; title?: string; content?: string; maskData?: unknown; groupId?: string | null; _updatePortsVisibility?(): void } | null;
    destroyInstance(id: string): void;
};

declare const ConnectionManager: {
    create(startId: string, endId: string, endPort: string | null, saveHistory: boolean): { id: string; start: string; end: string; endPort?: string | null; element?: SVGPathElement; isGroupPin?: boolean; groupId?: string; pinDirection?: string; pinId?: string } | null;
};

declare const GroupManager: unknown;

declare const GroupRenderer: {
    renderGroup(group: Record<string, unknown>): void;
};

export interface SnapshotData {
    cards: Array<Record<string, unknown>>;
    connections: Array<Record<string, unknown>>;
    canvas: { scale: number; panX: number; panY: number } | null;
    groups: Array<Record<string, unknown>>;
}

export const SnapshotCollector = {

    collect(options: {
        sanitizeBase64?: boolean;
        includeCanvas?: boolean;
        selectedIds?: string[] | null;
    } = {}): SnapshotData {
        const {
            sanitizeBase64 = false,
            includeCanvas = true,
            selectedIds = null
        } = options;

        const snapshot: SnapshotData = {
            cards: [],
            connections: [],
            canvas: null,
            groups: []
        };

        let cards: Element[] = [];
        if (selectedIds) {
            selectedIds.forEach(id => {
                const el = document.getElementById(id);
                if (el) cards.push(el);
            });
        } else {
            cards = Array.from(document.querySelectorAll('.card'));
        }

        cards.forEach(card => {
            const instance = CardFactory.getInstance(card.id);
            if (!instance) {
                console.warn('[SnapshotCollector] 卡片实例丢失:', card.id);
                return;
            }

            // 使用 card.serialize() 方法（与 JS 版一致），而非对象展开
            const data = (instance as unknown as { serialize?: () => Record<string, unknown> }).serialize?.() || { ...(instance as Record<string, unknown>) };

            if (sanitizeBase64 && typeof data.content === 'string') {
                data.content = SnapshotUtils.sanitizeContent(data.content);
            }

            snapshot.cards.push(data);
        });

        let connections = AppState.connections.list;
        if (selectedIds) {
            connections = connections.filter(c =>
                selectedIds.includes(c.start) &&
                selectedIds.includes(c.end)
            );
        }

        snapshot.connections = connections.map(c => ({
            start: c.start,
            end: c.end,
            endPort: c.endPort || null,
            isGroupPin: c.isGroupPin || false,
            groupId: c.groupId || null,
            pinDirection: c.pinDirection || null,
            pinId: c.pinId || null
        }));

        if (includeCanvas) {
            snapshot.canvas = {
                scale: AppState.canvas.scale,
                panX: AppState.canvas.panX,
                panY: AppState.canvas.panY
            };
        }

        if (AppState.groups && AppState.groups.list) {
            snapshot.groups = AppState.groups.list.map(group => ({
                id: group.id,
                name: group.name,
                colorIndex: group.colorIndex,
                color: (group as Record<string, unknown>)['color'],
                headerBg: (group as Record<string, unknown>)['headerBg'],
                inputPinColor: (group as Record<string, unknown>)['inputPinColor'],
                outputPinColor: (group as Record<string, unknown>)['outputPinColor'],
                cardIds: group.cardIds,
                inputPins: (group as Record<string, unknown>)['inputPins'],
                outputPins: (group as Record<string, unknown>)['outputPins'],
                expandedBounds: (group as Record<string, unknown>)['expandedBounds'],
                position: (group as Record<string, unknown>)['position'],
                createdAt: (group as Record<string, unknown>)['createdAt'],
                updatedAt: (group as Record<string, unknown>)['updatedAt']
            }));
        }

        return snapshot;
    },

    restore(
        snapshot: SnapshotData,
        options: {
            restoreBase64?: boolean;
            clearCanvas?: boolean;
            onComplete?: (() => void) | null;
        } = {}
    ): void {
        const {
            restoreBase64 = true,
            clearCanvas = true,
            onComplete = null
        } = options;

        if (clearCanvas) {
            document.querySelectorAll('.card').forEach(c => c.remove());
            AppState.connections.list.forEach(c => c.element?.remove());
            AppState.connections.list = [];

            AppState.groups.list = [];
            AppState.groups.activeGroupId = null;
            document.querySelectorAll('.group-box').forEach(el => el.remove());
        }

        if (snapshot.canvas) {
            AppState.canvas.scale = snapshot.canvas.scale || 1;
            AppState.canvas.panX  = snapshot.canvas.panX  || 0;
            AppState.canvas.panY  = snapshot.canvas.panY  || 0;
            Canvas.updateTransform();
        }

        snapshot.cards.forEach(cardData => {
            let content = cardData['content'] as string;

            if (restoreBase64 && typeof content === 'string') {
                content = SnapshotUtils.restoreContent(content);
            }

            CardFactory.create(cardData['type'] as string, {
                id: cardData['id'],
                x: parseFloat(cardData['left'] as string),
                y: parseFloat(cardData['top'] as string),
                width: cardData['width'],
                height: cardData['height'],
                title: cardData['title'],
                content,
                bg: cardData['bg'],
                maskData: cardData['maskData'] || null,
                groupId: cardData['groupId'] || null,
                bypass: cardData['bypass']  || false
            }, false);
        });

        setTimeout(() => {
            snapshot.connections.forEach(c => {
                const conn = ConnectionManager.create(c.start as string, c.end as string, (c.endPort as string | null) || null, false);
                if (conn && c.isGroupPin) {
                    conn.isGroupPin = true;
                    conn.groupId = c.groupId as string | undefined;
                    conn.pinDirection = c.pinDirection as string | undefined;
                    conn.pinId = c.pinId as string | undefined;
                }
            });

            document.querySelectorAll('.card').forEach(el => {
                const card = CardFactory.getInstance(el.id);
                card?._updatePortsVisibility?.();
            });

            if (snapshot.groups && snapshot.groups.length > 0) {
                this._restoreGroups(snapshot.groups);
            }

            Minimap.scheduleUpdate();

            if (onComplete) onComplete();
        }, 50);
    },

    _restoreGroups(groupsData: Array<Record<string, unknown>>): void {
        if (!GroupManager || !GroupRenderer) return;

        groupsData.forEach(groupData => {
            const validCardIds = (groupData['cardIds'] as string[] || []).filter(id => document.getElementById(id));

            if (validCardIds.length === 0) return;

            const group: Record<string, unknown> = {
                id: groupData['id'],
                name: groupData['name'] || '未命名组',
                colorIndex: groupData['colorIndex'] ?? 0,
                color: groupData['color'] || '#4a90d9',
                headerBg: groupData['headerBg'] || 'rgba(74,144,217,0.15)',
                inputPinColor: groupData['inputPinColor'] || '#3498db',
                outputPinColor: groupData['outputPinColor'] || '#2ecc71',
                cardIds: validCardIds,
                inputPins: groupData['inputPins'] || [],
                outputPins: groupData['outputPins'] || [],
                expandedBounds: groupData['expandedBounds'] || { x: 0, y: 0, width: 300, height: 200 },
                position: groupData['position'] || { x: 0, y: 0 },
                _userResized: false,
                createdAt: groupData['createdAt'] || Date.now(),
                updatedAt: Date.now()
            };

            AppState.groups.list.push(group as typeof AppState.groups.list[number]);

            GroupRenderer.renderGroup(group);

            validCardIds.forEach(cardId => {
                const instance = CardFactory.getInstance(cardId);
                if (instance) (instance as Record<string, unknown>).groupId = group['id'] as string;
            });
        });
    }
};

(window as unknown as { SnapshotCollector: typeof SnapshotCollector }).SnapshotCollector = SnapshotCollector;
