// src/core/history.ts
// 历史记录管理：快照的保存、撤销、重做的数据操作

import { AppState } from '../state/app-state';

export const History = {

    push(snapshot: unknown): void {
        const serialized = JSON.stringify(snapshot);

        AppState.history.undoStack.push(serialized);

        if (AppState.history.undoStack.length > AppState.history.maxSteps) {
            AppState.history.undoStack.shift();
        }

        AppState.history.redoStack = [];
    },

    undo(currentSnapshot: unknown): unknown | null {
        if (AppState.history.undoStack.length === 0) return null;

        AppState.history.redoStack.push(JSON.stringify(currentSnapshot));

        const prev = AppState.history.undoStack.pop();
        return JSON.parse(prev as string);
    },

    redo(currentSnapshot: unknown): unknown | null {
        if (AppState.history.redoStack.length === 0) return null;

        AppState.history.undoStack.push(JSON.stringify(currentSnapshot));

        const next = AppState.history.redoStack.pop();
        return JSON.parse(next as string);
    },

    canUndo(): boolean {
        return AppState.history.undoStack.length > 0;
    },

    canRedo(): boolean {
        return AppState.history.redoStack.length > 0;
    },

    clear(): void {
        AppState.history.undoStack = [];
        AppState.history.redoStack = [];
    }
};

(window as unknown as { History: typeof History }).History = History;
