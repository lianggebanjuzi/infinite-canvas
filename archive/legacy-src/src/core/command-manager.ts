// src/core/command-manager.ts
// 命令管理器：撤销/重做引擎

import { CompoundCommand, type Command } from './command-base';
import { AppState } from '../state/app-state';

export const CmdManager = {
    undoStack: [] as Command[],
    redoStack: [] as Command[],
    maxSteps: 50,

    execute(command: Command): void {
        command.execute();

        this.undoStack.push(command);

        if (this.undoStack.length > this.maxSteps) {
            this.undoStack.shift();
        }

        this.redoStack = [];
    },

    batch(label: string, fn: (compound: CompoundCommand) => void): CompoundCommand {
        const compound = new CompoundCommand(label);

        if (typeof fn === 'function') {
            fn(compound);
        }

        if (compound.size === 0) {
            return compound;
        }

        this.execute(compound);
        return compound;
    },

    undo(): boolean {
        if (!this.canUndo()) return false;

        const command = this.undoStack.pop()!;
        const label = command.label || '操作';
        command.undo();

        this.redoStack.push(command);

        const _Toast = (window as unknown as { Toast?: { show: (msg: string, dur?: number) => void } }).Toast;
        _Toast?.show(`↩ 已撤销：${label}`, 1200);
        return true;
    },

    redo(): boolean {
        if (!this.canRedo()) return false;

        const command = this.redoStack.pop()!;
        const label = command.label || '操作';

        try {
            command.redo();
        } catch (e) {
            command.execute();
        }

        this.undoStack.push(command);

        const _Toast = (window as unknown as { Toast?: { show: (msg: string, dur?: number) => void } }).Toast;
        _Toast?.show(`↪ 已重做：${label}`, 1200);
        return true;
    },

    canUndo(): boolean {
        return this.undoStack.length > 0;
    },

    canRedo(): boolean {
        return this.redoStack.length > 0;
    },

    getUndoLabel(): string | null {
        const cmd = this.undoStack[this.undoStack.length - 1];
        return cmd ? cmd.label : null;
    },

    getRedoLabel(): string | null {
        const cmd = this.redoStack[this.redoStack.length - 1];
        return cmd ? cmd.label : null;
    },

    clear(): void {
        this.undoStack = [];
        this.redoStack = [];
    },

    _pushCreateMarker(cardId: string): Command {
        const marker: Command = {
            type: 'create-marker',
            label: '创建',
            timestamp: Date.now(),
            execute() {},
            undo() {
                const el = document.getElementById(cardId);
                if (!el) return;
                const conns = AppState.connections.list.filter(
                    c => c.start === cardId || c.end === cardId
                );
                conns.forEach(c => c.element?.remove());
                AppState.connections.list = AppState.connections.list.filter(c => !conns.includes(c));
                AppState.cards.multiSelected = AppState.cards.multiSelected.filter(e => e.id !== cardId);
                if (AppState.cards.activeCardId === cardId) AppState.cards.activeCardId = null;
                (window as unknown as { CardFactory: { destroyInstance(id: string): void } }).CardFactory?.destroyInstance(cardId);
                el.remove();
                (window as unknown as { Minimap: { scheduleUpdate(): void } }).Minimap?.scheduleUpdate();
            },
            redo() {
                console.warn('[CmdManager] create-marker 不支持 redo');
            }
        };

        this.undoStack.push(marker);
        if (this.undoStack.length > this.maxSteps) this.undoStack.shift();
        this.redoStack = [];

        return marker;
    }
};

(window as unknown as { CmdManager: typeof CmdManager }).CmdManager = CmdManager;
