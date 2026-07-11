// js/cards/CardFactory.js
// 卡片工厂：统一创建、删除、查找卡片的入口
// 外部代码不直接 new 卡片类，统一通过 CardFactory 操作

const CardFactory = {

    // 实例注册表：cardId → 卡片实例
    _instances: {},

    // ─────────────────────────────────────────
    // 创建卡片
    // ─────────────────────────────────────────

    /**
     * @param {string}  type        - 卡片类型
     * @param {object}  options     - 卡片参数
     * @param {boolean} saveHistory - 是否保存历史记录（默认 true）
     * @param {object}  animOptions - 动画选项：{ isPaste, pasteIndex }
     */
    create(type, options = {}, saveHistory = true, animOptions = {}) {
        let card;

        switch (type) {
            case 'text':
                card = new TextCard(options);
                break;
            case 'image':
                card = new ImageInputCard(options);
                break;
            case 'ai-image':
                card = new AIDrawCard(options);
                break;
            case 'drawing-board':
                card = new DrawingBoardCard(options);
                break;
            case 'preview':
                card = new PreviewCard(options);
                break;
            case 'agent':
                card = new AgentCard(options);
                break;
            case 'compare':
                card = new CompareCard(options);
                break;
            default:
                console.warn(`未知卡片类型: ${type}`);
                return null;
        }

        // 创建 DOM 并挂载
        const el        = card.createElement();
        const container = document.getElementById('cards-container');
        container.appendChild(el);

        // 粘贴错峰动画
        if (animOptions.isPaste && animOptions.pasteIndex !== undefined) {
            el.classList.add('paste-stagger');
            el.style.setProperty('--stagger-delay', `${animOptions.pasteIndex * 30}ms`);
        }

        // 注册实例
        this._instances[card.id] = card;

        // 选中新建的卡片
        this.deselectAll();
        el.classList.add('selected');
        AppState.cards.activeCardId = card.id;

        if (saveHistory && window.CmdManager) {
            // 命令模式：记录创建操作（轻量级——undo 只需销毁这个卡片）
            CmdManager._pushCreateMarker(card.id);
        }

        Minimap.scheduleUpdate();
        return card;
    },

    // ─────────────────────────────────────────
    // 在右键菜单位置创建卡片
    // ─────────────────────────────────────────

    createAtPos(type) {
        const pos = AppState.canvas.contextClickPos;
        this.create(type, { x: pos.x, y: pos.y });
        document.querySelectorAll('.context-menu').forEach(m => {
            m.style.display = 'none';
        });
    },

    // ─────────────────────────────────────────
    // 触发图片上传
    // ─────────────────────────────────────────

    triggerImageUpload(cardId) {
        if (cardId) {
            AppState.cards.targetUploadCardId = cardId;
        } else {
            const pos  = AppState.canvas.contextClickPos;
            const card = this.create('image', { x: pos.x, y: pos.y }, false);
            AppState.cards.targetUploadCardId = card.id;
        }
        document.getElementById('image-upload').click();
    },

    // ─────────────────────────────────────────
    // 删除选中的卡片
    // ─────────────────────────────────────────

    deleteSelected() {
        const toDelete = [];

        if (AppState.cards.multiSelected.length > 0) {
            toDelete.push(...AppState.cards.multiSelected);
        } else {
            const selected = document.querySelector('.card.selected');
            if (selected) toDelete.push(selected);
        }

        if (toDelete.length === 0) return;

        const cardIdsToDelete = toDelete.map(el => el.id);

        // 命令模式：记录删除操作（包含完整状态用于撤销）
        if (window.CmdManager) {
            CmdManager.execute(new DeleteCardsCommand(cardIdsToDelete));
            return;  // DeleteCardsCommand.execute 内部已处理所有删除逻辑
        }

        // fallback：无命令管理器时的直接删除
        toDelete.forEach(el => {
            const cardId   = el.id;
            const instance = this._instances[cardId];

            if (window.GroupManager && instance?.groupId) {
                GroupManager.removeCardFromGroup(cardId);
            }
            ConnectionManager.removeByCardId(cardId);

            if (instance instanceof ImageInputCard) {
                Object.values(this._instances).forEach(c => {
                    if (c instanceof AIDrawCard) c.removeRefImage(cardId);
                });
            }

            instance?.notifyDownstream?.();
            instance?.destroy();
            delete this._instances[cardId];
        });

        AppState.cards.multiSelected = [];
        AppState.cards.activeCardId  = null;
        Minimap.scheduleUpdate();
    },

    // ─────────────────────────────────────────
    // 取消所有选中
    // ─────────────────────────────────────────

    deselectAll() {
        document.querySelectorAll('.card.selected, .card.multi-selected')
            .forEach(c => c.classList.remove('selected', 'multi-selected'));
        AppState.cards.multiSelected = [];
        AppState.cards.activeCardId  = null;
    },

    // ─────────────────────────────────────────
    // 查找实例
    // ─────────────────────────────────────────

    getInstance(cardId) {
        return this._instances[cardId] || null;
    },

    getAllInstances() {
        return Object.values(this._instances);
    },

    /** 销毁单个卡片实例（供命令模式撤销使用） */
    async destroyInstance(cardId) {
        const instance = this._instances[cardId];
        if (!instance) return;
        // 退场动画
        if (instance.el) {
            instance.el.classList.add('removing');
        }
        await new Promise(r => setTimeout(r, 120));  // 等待 shrink-out 动画
        instance.destroy();
        delete this._instances[cardId];
    },

    // ★ 修复：新增 ConnectionManager.clearAll() 调用，确保连线一并清除
    clearAll() {
        Object.values(this._instances).forEach(c => c.destroy());
        this._instances = {};
        AppState.cards.multiSelected = [];
        AppState.cards.activeCardId  = null;
        ConnectionManager.clearAll();

        // 清理所有组
        if (AppState.groups) {
            AppState.groups.list = [];
            AppState.groups.activeGroupId = null;
            document.querySelectorAll('.group-box').forEach(el => el.remove());
        }
    },

    // ─────────────────────────────────────────
    // 包装运行完成回调，发布 RUN_COMPLETED 事件
    // 用于统一发布运行完成事件（未来可扩展到其他卡片类型）
    // ─────────────────────────────────────────
    wrapRunCallback(cardId, onComplete) {
        if (!onComplete) return null;
        return (...args) => {
            onComplete(...args);
            const card = CardFactory.getInstance(cardId);
            if (card && window.CardEventBus && CardEventBus.EventTypes) {
                const dataType = card.constructor.getDataType?.() || null;
                if (dataType) {
                    CardEventBus.emit(CardEventBus.EventTypes.RUN_COMPLETED, {
                        cardId,
                        type: dataType,
                        data: card.getOutput?.() || null,
                    });
                }
            }
        };
    }
};

window.CardFactory = CardFactory;
