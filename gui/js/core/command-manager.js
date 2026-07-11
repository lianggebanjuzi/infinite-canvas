/**
 * 命令管理器（Command Manager）
 * 撤销/重做引擎，替代旧的 Memento 快照模式
 *
 * 核心职责：
 * 1. 维护 undoStack / redoStack
 * 2. 提供 execute(command) 统一入口（自动清空 redoStack）
 * 3. 提供 undo() / redo() / clear() 操作接口
 * 4. 支持 batch() 批量操作（自动打包为 CompoundCommand）
 *
 * 使用方式：
 *   // 方式1：直接执行并压栈
 *   CmdManager.execute(new MoveCardsCommand(ids, dx, dy));
 *
 *   // 方式2：批量操作（粘贴等场景）
 *   CmdManager.batch(label => {
 *       label.add(new CreateCardCommand(...));
 *       label.add(new ConnectionCommand(...));
 *   });
 */
const CmdManager = {

    /** 撤销栈 */
    undoStack: [],

    /** 重做栈 */
    redoStack: [],

    /** 最大撤销步数 */
    maxSteps: 50,

    // ────────────────────────────────────────
    // 核心：执行命令
    // ────────────────────────────────────────

    /**
     * 执行一个命令并压入撤销栈
     * @param {Command} command - 要执行的命令对象
     */
    execute(command) {
        command.execute();

        this.undoStack.push(command);

        // 超出上限时移除最旧记录
        if (this.undoStack.length > this.maxSteps) {
            this.undoStack.shift();
        }

        // 每次新操作都清空重做栈
        this.redoStack = [];
    },

    /**
     * 批量执行多个命令（自动包装为 CompoundCommand）
     * @param {string} label - 复合操作标签
     * @param {function(CompoundCommand): void} fn - 回调，接收 compound 对象用于 add 子命令
     * @returns {CompoundCommand} 创建的复合命令
     */
    batch(label, fn) {
        const compound = new CompoundCommand(label);

        if (typeof fn === 'function') {
            fn(compound);
        }

        // 空复合命令不压栈
        if (compound.size === 0) {
            return compound;
        }

        this.execute(compound);
        return compound;
    },

    // ────────────────────────────────────────
    // 撤销 / 重做
    // ────────────────────────────────────────

    /** 撤销最后一个命令 */
    undo() {
        if (!this.canUndo()) return false;

        const command = this.undoStack.pop();
        const label = command.label || '操作';
        command.undo();

        this.redoStack.push(command);

        // 微型反馈提示
        if (window.Toast) {
            Toast.show(`↩ 已撤销：${label}`, 1200);
        }
        return true;
    },

    /** 重做下一个命令 */
    redo() {
        if (!this.canRedo()) return false;

        const command = this.redoStack.pop();
        const label = command.label || '操作';

        try {
            command.redo();
        } catch (e) {
            // 如果 redo 抛异常（某些命令覆写了 redo），fallback 到 execute
            command.execute();
        }

        this.undoStack.push(command);

        if (window.Toast) {
            Toast.show(`↪ 已重做：${label}`, 1200);
        }
        return true;
    },

    // ────────────────────────────────────────
    // 查询
    // ────────────────────────────────────────

    canUndo() {
        return this.undoStack.length > 0;
    },

    canRedo() {
        return this.redoStack.length > 0;
    },

    /** 获取当前撤销栈顶部的命令描述（用于调试/UI） */
    getUndoLabel() {
        const cmd = this.undoStack[this.undoStack.length - 1];
        return cmd ? cmd.label : null;
    },

    getRedoLabel() {
        const cmd = this.redoStack[this.redoStack.length - 1];
        return cmd ? cmd.label : null;
    },

    // ────────────────────────────────────────
    // 清空
    // ────────────────────────────────────────

    /** 清空所有历史（新建/打开项目时调用） */
    clear() {
        this.undoStack = [];
        this.redoStack = [];
    },

    // ────────────────────────────────────────
    // 轻量级标记（供 CardFactory 等内部模块使用）
    // ────────────────────────────────────────

    /**
     * 记录一个"已创建"标记（用于卡片创建的撤销）
     * 比 CreateCommandCommand 更轻量——不需要重新创建，
     * undo 时直接删除该卡片即可
     */
    _pushCreateMarker(cardId) {
        const marker = {
            type: 'create-marker',
            id: cardId,
            label: '创建',
            timestamp: Date.now(),
            execute() {},  // 创建已在调用方完成
            undo() {
                const el = document.getElementById(cardId);
                if (!el) return;
                // 移除关联连线
                const conns = AppState.connections.list.filter(
                    c => c.start === cardId || c.end === cardId
                );
                conns.forEach(c => c.element?.remove());
                AppState.connections.list = AppState.connections.list.filter(c => !conns.includes(c));
                // 清理选中
                AppState.cards.multiSelected = AppState.cards.multiSelected.filter(e => e.id !== cardId);
                if (AppState.cards.activeCardId === cardId) AppState.cards.activeCardId = null;
                // 销毁
                CardFactory.destroyInstance(cardId);
                el.remove();
                Minimap.scheduleUpdate();
            },
            redo() {
                // 创建操作无法简单重做（需要完整的创建参数）
                // 所以重做时不做任何事——这是一个单向操作标记
                console.warn('[CmdManager] create-marker 不支持 redo');
            }
        };

        this.undoStack.push(marker);
        if (this.undoStack.length > this.maxSteps) this.undoStack.shift();
        this.redoStack = [];

        return marker;
    }
};

window.CmdManager = CmdManager;
