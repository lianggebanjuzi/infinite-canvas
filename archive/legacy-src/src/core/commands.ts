// src/core/commands.ts
// 具体命令类集合（可撤销操作）

import { Command, CompoundCommand } from './command-base';
import { AppState } from '../state/app-state';

// ── 占位声明（Phase 6 Cards 迁移后替换为真实 import）──
declare const CardFactory: {
    create(type: string, options: unknown, saveHistory?: boolean, extra?: unknown): { id: string; type: string; title?: string; content?: string; element: HTMLElement; maskData?: unknown; groupId?: string | null };
    getInstance(id: string): { type: string; title?: string; content?: string; maskData?: unknown; groupId?: string | null; setContent?(c: unknown): void; _updatePortsVisibility?(): void } | null;
    destroyInstance(id: string): void;
};

declare const ConnectionManager: {
    create(startId: string, endId: string, endPort: string | null, saveHistory: boolean): { id: string; start: string; end: string; endPort?: string | null; element?: SVGPathElement; isGroupPin?: boolean; groupId?: string; pinDirection?: string; pinId?: string } | null;
    updateCardConnections(id: string): void;
    scheduleUpdate(id: string): void;
};

declare const GroupManager: {
    createGroup(cardIds: string[], groupConfig?: unknown): void;
    deleteGroup(groupId: string): void;
    renameGroup(groupId: string, name: string): void;
    setGroupColor(groupId: string, colorIndex: number): void;
};

declare const GroupRenderer: {
    renderGroup(group: unknown): void;
};

declare const Minimap: {
    update(): void;
    scheduleUpdate(): void;
    updateViewportOnly(): void;
};

// ════════════════════════════════════════════
// 1. 创建卡片命令
// ════════════════════════════════════════════

export class CreateCardCommand extends Command {
    createdId: string | null = null;

    constructor(
        public type: string,
        public options: Record<string, unknown>
    ) {
        super('create-card', '创建卡片');
        this.options = { ...options };
    }

    execute(): void {
        const card = CardFactory.create(this.type, this.options, false);
        if (card) this.createdId = card.id;
    }

    undo(): void {
        if (!this.createdId) return;
        const el = document.getElementById(this.createdId);
        if (!el) return;

        const conns = AppState.connections.list.filter(
            c => c.start === this.createdId || c.end === this.createdId
        );
        conns.forEach(c => c.element?.remove());
        AppState.connections.list = AppState.connections.list.filter(c => !conns.includes(c));

        AppState.cards.multiSelected = AppState.cards.multiSelected.filter(
            el => el.id !== this.createdId
        );
        if (AppState.cards.activeCardId === this.createdId) {
            AppState.cards.activeCardId = null;
        }

        CardFactory.destroyInstance(this.createdId);
        el.remove();

        Minimap.scheduleUpdate();
    }
}

// ════════════════════════════════════════════
// 2. 删除卡片命令
// ════════════════════════════════════════════

export class DeleteCardsCommand extends Command {
    savedData: Array<{
        id: string; type: string; left: string; top: string;
        width: string; height: string; title: string; content: string;
        bg: string; maskData?: unknown; groupId?: string | null;
    }> = [];
    savedConnections: Array<{
        start: string; end: string; endPort: string | null;
        isGroupPin: boolean; groupId: string | null;
        pinDirection: string | null; pinId: string | null;
    }> = [];

    constructor(public cardIds: string[]) {
        super('delete-cards', `删除 ${cardIds.length} 个元素`);
        this.cardIds = [...cardIds];
    }

    execute(): void {
        this._saveState();
        this._removeCards();
    }

    undo(): void {
        this.savedData.forEach(d => {
            CardFactory.create(d.type, {
                id: d.id,
                x: parseFloat(d.left),
                y: parseFloat(d.top),
                width: d.width,
                height: d.height,
                title: d.title,
                content: d.content,
                bg: d.bg,
                maskData: d.maskData || null,
                groupId: d.groupId || null,
            }, false);
        });

        requestAnimationFrame(() => {
            this.savedConnections.forEach(c => {
                const conn = ConnectionManager.create(c.start, c.end, c.endPort, false);
                if (conn && c.isGroupPin) {
                    conn.isGroupPin = c.isGroupPin;
                    conn.groupId = c.groupId || undefined;
                    conn.pinDirection = c.pinDirection || undefined;
                    conn.pinId = c.pinId || undefined;
                }
            });
            Minimap.scheduleUpdate();
        });
    }

    _saveState(): void {
        this.savedData = [];
        this.savedConnections = [];
        const idSet = new Set(this.cardIds);

        this.cardIds.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;

            const instance = CardFactory.getInstance(id);
            if (!instance) return;

            this.savedData.push({
                id,
                type: instance.type,
                left: el.style.left,
                top: el.style.top,
                width: el.style.width,
                height: el.style.height,
                title: instance.title || '',
                content: instance.content || '',
                bg: el.style.backgroundColor || '',
                maskData: instance.maskData || null,
                groupId: instance.groupId || null,
            });
        });

        AppState.connections.list.forEach(c => {
            if (idSet.has(c.start) && idSet.has(c.end)) {
                this.savedConnections.push({
                    start: c.start, end: c.end,
                    endPort: c.endPort || null,
                    isGroupPin: c.isGroupPin || false,
                    groupId: c.groupId || null,
                    pinDirection: c.pinDirection || null,
                    pinId: c.pinId || null
                });
            }
        });
    }

    _removeCards(): void {
        this.cardIds.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;

            const related = AppState.connections.list.filter(c => c.start === id || c.end === id);
            related.forEach(c => c.element?.remove());
            AppState.connections.list = AppState.connections.list.filter(c => !related.includes(c));

            AppState.cards.multiSelected = AppState.cards.multiSelected.filter(e => e.id !== id);

            CardFactory.destroyInstance(id);
            el.remove();
        });

        AppState.cards.activeCardId = null;
        Minimap.scheduleUpdate();
    }
}

// ════════════════════════════════════════════
// 3. 移动卡片命令
// ════════════════════════════════════════════

export class MoveCardsCommand extends Command {
    constructor(
        public cardIds: string[],
        public dx: number,
        public dy: number
    ) {
        super('move-cards', '移动');
        this.cardIds = [...cardIds];
    }

    execute(): void {
        // 拖拽结束时位置已更新，这里只做标记
    }

    undo(): void {
        this.cardIds.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;

            const currentLeft = parseFloat(el.style.left) || 0;
            const currentTop  = parseFloat(el.style.top)  || 0;

            el.style.left = (currentLeft - this.dx) + 'px';
            el.style.top  = (currentTop  - this.dy) + 'px';

            ConnectionManager.updateCardConnections(id);
        });

        Minimap.scheduleUpdate();
    }

    redo(): void {
        this.cardIds.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;

            const currentLeft = parseFloat(el.style.left) || 0;
            const currentTop  = parseFloat(el.style.top)  || 0;

            el.style.left = (currentLeft + this.dx) + 'px';
            el.style.top  = (currentTop  + this.dy) + 'px';

            ConnectionManager.updateCardConnections(id);
        });

        Minimap.scheduleUpdate();
    }
}

// ════════════════════════════════════════════
// 4. 属性变更命令
// ════════════════════════════════════════════

export class PropertyChangeCommand extends Command {
    oldValue: unknown;

    constructor(
        public targetId: string,
        public property: string,
        public newValue: unknown,
        oldValue?: unknown,
        label?: string
    ) {
        super('property-change', label || '修改属性');
        this.oldValue = oldValue !== undefined ? oldValue : this._readCurrentValue(targetId, property);
    }

    _readCurrentValue(id: string, prop: string): unknown {
        const el = document.getElementById(id);
        if (!el) return undefined;

        switch (prop) {
            case 'title': {
                const input = el.querySelector('.card-title-input') as HTMLInputElement | null;
                return input ? input.value : '';
            }
            case 'backgroundColor':
                return el.style.backgroundColor || '';
            default:
                return (el.style as unknown as Record<string, unknown>)[prop] as string || '';
        }
    }

    execute(): void { this._applyValue(this.targetId, this.property, this.newValue); }
    undo(): void { this._applyValue(this.targetId, this.property, this.oldValue); }

    _applyValue(id: string, prop: string, value: unknown): void {
        const el = document.getElementById(id);
        if (!el) return;

        switch (prop) {
            case 'title': {
                const input = el.querySelector('.card-title-input') as HTMLInputElement | null;
                if (input) {
                    input.value = value as string;
                    const instance = CardFactory.getInstance(id);
                    if (instance) (instance as Record<string, unknown>).title = value;
                }
                break;
            }
            case 'backgroundColor':
                el.style.backgroundColor = value as string;
                break;
            case 'size': {
                if (value && typeof value === 'object') {
                    const v = value as { width?: string; height?: string };
                    el.style.width  = v.width || el.style.width;
                    el.style.height = v.height || el.style.height;
                    ConnectionManager.scheduleUpdate(id);
                }
                break;
            }
            default:
                (el.style as unknown as Record<string, unknown>)[prop] = value;
        }

        Minimap.scheduleUpdate();
    }
}

// ════════════════════════════════════════════
// 5. 项目名修改命令
// ════════════════════════════════════════════

export class ProjectNameCommand extends Command {
    constructor(
        public newName: string,
        public oldName: string = ''
    ) {
        super('project-name', '修改项目名');
    }

    execute(): void {
        const input = document.getElementById('project-name-input') as HTMLInputElement | null;
        if (input) input.value = this.newName;
    }

    undo(): void {
        const input = document.getElementById('project-name-input') as HTMLInputElement | null;
        if (input) input.value = this.oldName;
    }
}

// ════════════════════════════════════════════
// 6. 内容修改命令
// ════════════════════════════════════════════

export class ModifyContentCommand extends Command {
    oldContent: unknown;

    constructor(
        public cardId: string,
        public newContent: unknown,
        oldContent?: unknown
    ) {
        super('modify-content', '编辑内容');
        this.oldContent = oldContent !== undefined ? oldContent : this._readCurrent(cardId);
    }

    _readCurrent(id: string): unknown {
        const instance = CardFactory.getInstance(id);
        return instance ? instance.content : undefined;
    }

    execute(): void { this._setContent(this.cardId, this.newContent); }
    undo(): void { this._setContent(this.cardId, this.oldContent); }

    _setContent(id: string, content: unknown): void {
        const instance = CardFactory.getInstance(id);
        if (!instance) return;
        instance.setContent?.(content);
        Minimap.scheduleUpdate();
    }
}

// ════════════════════════════════════════════
// 7. 连线命令
// ════════════════════════════════════════════

export class CreateConnectionCommand extends Command {
    connId: string | null = null;

    constructor(
        public startId: string,
        public endId: string,
        public endPort: string | null,
        public extraFields: Record<string, unknown> = {}
    ) {
        super('create-connection', '创建连线');
        this.endPort = endPort || null;
    }

    execute(): void {
        const conn = ConnectionManager.create(this.startId, this.endId, this.endPort, false);
        if (conn) {
            this.connId = conn.id;
            if (this.extraFields.isGroupPin) {
                conn.isGroupPin = true;
                conn.groupId = this.extraFields.groupId as string | undefined;
                conn.pinDirection = this.extraFields.pinDirection as string | undefined;
                conn.pinId = this.extraFields.pinId as string | undefined;
            }
        }
    }

    undo(): void {
        if (!this.connId) return;
        const idx = AppState.connections.list.findIndex(c => c.id === this.connId);
        if (idx === -1) return;

        const [conn] = AppState.connections.list.splice(idx, 1);
        if (conn.element) conn.element.remove();
        Minimap.scheduleUpdate();
    }
}

export class RemoveConnectionCommand extends Command {
    savedData: {
        start: string; end: string; endPort: string | null;
        isGroupPin: boolean; groupId: string | null;
        pinDirection: string | null; pinId: string | null;
    } | null = null;

    constructor(public connId: string) {
        super('remove-connection', '删除连线');
    }

    execute(): void {
        const conn = AppState.connections.list.find(c => c.id === this.connId);
        if (!conn) return;

        this.savedData = {
            start: conn.start, end: conn.end,
            endPort: conn.endPort || null,
            isGroupPin: conn.isGroupPin || false,
            groupId: conn.groupId || null,
            pinDirection: conn.pinDirection || null,
            pinId: conn.pinId || null
        };

        if (conn.element) conn.element.remove();
        AppState.connections.list = AppState.connections.list.filter(c => c.id !== this.connId);
        Minimap.scheduleUpdate();
    }

    undo(): void {
        if (!this.savedData) return;
        const d = this.savedData;

        const conn = ConnectionManager.create(d.start, d.end, d.endPort, false);
        if (conn && d.isGroupPin) {
            conn.isGroupPin = d.isGroupPin;
            conn.groupId = d.groupId || undefined;
            conn.pinDirection = d.pinDirection || undefined;
            conn.pinId = d.pinId || undefined;
        }
        Minimap.scheduleUpdate();
    }
}

// ════════════════════════════════════════════
// 8. 分组命令
// ════════════════════════════════════════════

export class CreateGroupCommand extends Command {
    groupId: string | null = null;

    constructor(
        public cardIds: string[],
        public groupConfig: Record<string, unknown> = {}
    ) {
        super('create-group', '创建分组');
        this.cardIds = [...cardIds];
    }

    execute(): void {
        GroupManager.createGroup(this.cardIds, this.groupConfig);
        if (AppState.groups.list.length > 0) {
            this.groupId = AppState.groups.list[AppState.groups.list.length - 1].id;
        }
    }

    undo(): void {
        if (!this.groupId) return;
        GroupManager.deleteGroup(this.groupId);
        Minimap.scheduleUpdate();
    }
}

export class DeleteGroupCommand extends Command {
    savedData: Record<string, unknown> | null = null;

    constructor(public groupId: string) {
        super('delete-group', '删除分组');
    }

    execute(): void {
        const group = AppState.groups.list.find(g => g.id === this.groupId);
        if (!group) return;

        this.savedData = JSON.parse(JSON.stringify(group));
        GroupManager.deleteGroup(this.groupId);
        Minimap.scheduleUpdate();
    }

    undo(): void {
        if (!this.savedData) return;

        if (GroupManager && GroupRenderer) {
            AppState.groups.list.push(this.savedData as typeof AppState.groups.list[number]);
            GroupRenderer.renderGroup(this.savedData);

            ((this.savedData as Record<string, unknown>).cardIds as string[] || []).forEach(cardId => {
                const inst = CardFactory.getInstance(cardId);
                if (inst) (inst as Record<string, unknown>).groupId = this.groupId;
            });
        }
        Minimap.scheduleUpdate();
    }
}

export class GroupPropertyCommand extends Command {
    constructor(
        public groupId: string,
        public property: string,
        public newValue: unknown,
        public oldValue: unknown
    ) {
        super('group-property', '修改分组');
    }

    execute(): void { this._apply(this.newValue); }
    undo(): void { this._apply(this.oldValue); }

    _apply(value: unknown): void {
        const group = AppState.groups.list.find(g => g.id === this.groupId);
        if (!group) return;

        switch (this.property) {
            case 'name':
                GroupManager.renameGroup(this.groupId, value as string);
                break;
            case 'colorIndex':
                GroupManager.setGroupColor(this.groupId, value as number);
                break;
            default:
                (group as Record<string, unknown>)[this.property] = value;
                GroupRenderer.renderGroup(group);
        }
        Minimap.scheduleUpdate();
    }
}

// ════════════════════════════════════════════
// 9. 粘贴命令
// ════════════════════════════════════════════

export class PasteCommand extends Command {
    newCardIds: Record<string, string> = {};
    commands: Command[] = [];
    private _built = false;

    constructor(
        public cardsData: Array<{
            id: string; type: string; left: string; top: string;
            width: string; height: string; title: string; content: string;
            bg: string; maskData?: unknown;
        }>,
        public connectionsData: Array<{
            start: string; end: string; endPort?: string;
        }> = []
    ) {
        super('paste', `粘贴 ${cardsData.length} 个元素`);
        this.cardsData = cardsData;
        this.connectionsData = connectionsData;
    }

    _buildCommands(baseX: number, baseY: number): void {
        const commands: Command[] = [];

        let minX = Infinity, minY = Infinity;
        this.cardsData.forEach(c => {
            minX = Math.min(minX, parseFloat(c.left));
            minY = Math.min(minY, parseFloat(c.top));
        });

        this.cardsData.forEach(cardData => {
            const offsetX = parseFloat(cardData.left) - minX;
            const offsetY = parseFloat(cardData.top)  - minY;
            const newId   = `card-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
            this.newCardIds[cardData.id] = newId;

            commands.push(new CreateCardCommand(cardData.type, {
                id: newId,
                x: baseX + offsetX,
                y: baseY + offsetY,
                width: cardData.width,
                height: cardData.height,
                title: cardData.title,
                content: cardData.content,
                bg: cardData.bg,
                maskData: cardData.maskData || null
            }));
        });

        this.connectionsData.forEach(conn => {
            const newStart = this.newCardIds[conn.start];
            const newEnd   = this.newCardIds[conn.end];
            if (newStart && newEnd) {
                commands.push(new CreateConnectionCommand(newStart, newEnd, conn.endPort || null));
            }
        });

        this.commands = commands;
        this._built = true;
    }

    execute(baseX: number, baseY: number): void {
        if (!this._built) this._buildCommands(baseX, baseY);
        this.commands.forEach(cmd => cmd.execute());
    }

    undo(): void {
        for (let i = this.commands.length - 1; i >= 0; i--) {
            this.commands[i].undo();
        }
        AppState.ai.pasteOffsetX -= AppState.ai.pasteOffsetStep;
        AppState.ai.pasteOffsetY -= AppState.ai.pasteOffsetStep;
        if (AppState.ai.pasteOffsetX < 0) {
            AppState.ai.pasteOffsetX = 0;
            AppState.ai.pasteOffsetY = 0;
        }
    }
}

// ── 导出到 window ──
(window as unknown as Record<string, unknown>).CreateCardCommand = CreateCardCommand;
(window as unknown as Record<string, unknown>).DeleteCardsCommand = DeleteCardsCommand;
(window as unknown as Record<string, unknown>).MoveCardsCommand = MoveCardsCommand;
(window as unknown as Record<string, unknown>).PropertyChangeCommand = PropertyChangeCommand;
(window as unknown as Record<string, unknown>).ProjectNameCommand = ProjectNameCommand;
(window as unknown as Record<string, unknown>).ModifyContentCommand = ModifyContentCommand;
(window as unknown as Record<string, unknown>).CreateConnectionCommand = CreateConnectionCommand;
(window as unknown as Record<string, unknown>).RemoveConnectionCommand = RemoveConnectionCommand;
(window as unknown as Record<string, unknown>).CreateGroupCommand = CreateGroupCommand;
(window as unknown as Record<string, unknown>).DeleteGroupCommand = DeleteGroupCommand;
(window as unknown as Record<string, unknown>).GroupPropertyCommand = GroupPropertyCommand;
(window as unknown as Record<string, unknown>).PasteCommand = PasteCommand;
