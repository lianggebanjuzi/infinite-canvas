/**
 * UndoRedo 兼容层
 *
 * 旧接口保持不变，内部全部委托给 CmdManager（命令模式引擎）
 * 这样所有 31 个调用点不需要一次性全改，可以渐进迁移：
 *   - 保留 UndoRedo.save() 作为"保存当前快照到撤销栈"的兼容入口
 *   - 但实际行为改为：标记当前状态，undo 时通过命令反向操作
 *
 * 迁移完成后可删除此文件，调用方直接用 CmdManager.execute()
 */
const UndoRedo = {

    /**
     * 兼容入口：旧的 save() 调用
     *
     * ⚠️ 重要：这个方法不再做全量快照。
     * 它的存在只是为了向后兼容——让还没改造的模块不报错。
     *
     * 已改造的模块应该直接使用 CmdManager.execute(new XxxCommand(...))
     * 而不是调用 UndoRedo.save()
     */
    save() {
        // 兼容层：不再做快照
        // 如果某个地方还在调 save() 且尚未改造为 Command 模式，
        // 这里会打印警告提醒开发者迁移
        if (window._undoRedoCompatWarned !== true) {
            console.warn(
                '[UndoRedo] save() 已废弃。请使用 CmdManager.execute(new XxxCommand()) 替代。\n' +
                '调用栈:', new Error().stack?.split('\n').slice(1, 4).join('\n')
            );
            window._undoRedoCompatWarned = true;
        }
    },

    /** 撤销 → 委托给 CmdManager */
    undo() {
        return CmdManager.undo();
    },

    /** 重做 → 委托给 CmdManager */
    redo() {
        return CmdManager.redo();
    },

    /** 清空历史 → 委托给 CmdManager */
    clear() {
        CmdManager.clear();
    },

    // ── 向后兼容的查询接口 ──

    canUndo() { return CmdManager.canUndo(); },
    canRedo() { return CmdManager.canRedo(); }
};

window.UndoRedo = UndoRedo;
