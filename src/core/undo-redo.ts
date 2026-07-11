// src/core/undo-redo.ts
// 撤销/重做兼容层，内部委托给 CmdManager

import { CmdManager } from './command-manager';

export const UndoRedo = {
    save(): void {
        // 兼容层：已废弃，迁移到命令模式后不再调用
        if ((window as unknown as Record<string, unknown>)['_undoRedoCompatWarned'] !== true) {
            console.warn(
                '[UndoRedo] save() 已废弃。请使用 CmdManager.execute(new XxxCommand()) 替代。\n' +
                '调用栈:', new Error().stack?.split('\n').slice(1, 4).join('\n')
            );
            (window as unknown as Record<string, boolean>)['_undoRedoCompatWarned'] = true;
        }
    },

    undo(): boolean {
        return CmdManager.undo();
    },

    redo(): boolean {
        return CmdManager.redo();
    },

    clear(): void {
        CmdManager.clear();
    },

    canUndo(): boolean {
        return CmdManager.canUndo();
    },

    canRedo(): boolean {
        return CmdManager.canRedo();
    }
};

(window as unknown as { UndoRedo: typeof UndoRedo }).UndoRedo = UndoRedo;
