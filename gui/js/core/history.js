// js/core/history.js
// 历史记录管理：负责快照的保存、撤销、重做的数据操作
// 只操作数据，不操作 DOM，不知道卡片和连线的存在

const History = {

    // ─────────────────────────────────────────
    // 保存当前快照
    // ─────────────────────────────────────────

    /**
     * 保存一个状态快照到撤销栈
     * @param {object} snapshot - 当前画布的完整状态数据
     */
    push(snapshot) {
        const serialized = JSON.stringify(snapshot);

        AppState.history.undoStack.push(serialized);

        // 超出最大步数时，移除最旧的记录
        if (AppState.history.undoStack.length > AppState.history.maxSteps) {
            AppState.history.undoStack.shift();
        }

        // 每次新操作都清空重做栈
        AppState.history.redoStack = [];
    },

    // ─────────────────────────────────────────
    // 撤销：取出上一个状态
    // ─────────────────────────────────────────

    /**
     * 执行撤销，返回需要恢复的状态数据
     * @param {object} currentSnapshot - 执行撤销前的当前状态（用于保存到重做栈）
     * @returns {object|null} 需要恢复的状态，撤销栈为空时返回 null
     */
    undo(currentSnapshot) {
        if (AppState.history.undoStack.length === 0) return null;

        // 把当前状态压入重做栈
        AppState.history.redoStack.push(JSON.stringify(currentSnapshot));

        // 从撤销栈取出上一个状态
        const prev = AppState.history.undoStack.pop();
        return JSON.parse(prev);
    },

    // ─────────────────────────────────────────
    // 重做：取出下一个状态
    // ─────────────────────────────────────────

    /**
     * 执行重做，返回需要恢复的状态数据
     * @param {object} currentSnapshot - 执行重做前的当前状态（用于保存到撤销栈）
     * @returns {object|null} 需要恢复的状态，重做栈为空时返回 null
     */
    redo(currentSnapshot) {
        if (AppState.history.redoStack.length === 0) return null;

        // 把当前状态压回撤销栈
        AppState.history.undoStack.push(JSON.stringify(currentSnapshot));

        // 从重做栈取出下一个状态
        const next = AppState.history.redoStack.pop();
        return JSON.parse(next);
    },

    // ─────────────────────────────────────────
    // 查询
    // ─────────────────────────────────────────

    /** 是否可以撤销 */
    canUndo() {
        return AppState.history.undoStack.length > 0;
    },

    /** 是否可以重做 */
    canRedo() {
        return AppState.history.redoStack.length > 0;
    },

    // ─────────────────────────────────────────
    // 清空
    // ─────────────────────────────────────────

    /** 清空所有历史记录（新建项目时使用） */
    clear() {
        AppState.history.undoStack = [];
        AppState.history.redoStack = [];
    }
};

window.History = History;
