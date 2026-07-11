/**
 * 快照收集器
 * 统一管理画布数据的序列化逻辑
 * 解决 storage.js、undo-redo.js、clipboard.js 中的重复代码问题
 */
const SnapshotCollector = {

    /**
     * 收集当前画布的完整快照
     * @param {Object} options - 配置选项
     * @param {boolean} options.sanitizeBase64 - 是否将 base64 替换为占位符（用于撤销快照）
     * @param {boolean} options.includeCanvas - 是否包含画布变换状态
     * @param {Array} options.selectedIds - 多选时的选中卡片 ID 列表（用于复制）
     * @returns {Object} 快照数据
     */
    collect(options = {}) {
        const {
            sanitizeBase64 = false,
            includeCanvas = true,
            selectedIds = null
        } = options;

        const snapshot = {
            cards: [],
            connections: [],
            canvas: null,
            groups: []   // 组数据
        };

        let cards = [];
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

            const data = instance.serialize();

            if (sanitizeBase64) {
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
            start:       c.start,
            end:         c.end,
            endPort:     c.endPort || null,
            isGroupPin:  c.isGroupPin || false,
            groupId:     c.groupId || null,
            pinDirection: c.pinDirection || null,
            pinId:       c.pinId || null
        }));

        if (includeCanvas) {
            snapshot.canvas = {
                scale: AppState.canvas.scale,
                panX:  AppState.canvas.panX,
                panY:  AppState.canvas.panY
            };
        }

        // 收集组数据
        if (AppState.groups && AppState.groups.list) {
            snapshot.groups = AppState.groups.list.map(group => ({
                id:             group.id,
                name:           group.name,
                colorIndex:     group.colorIndex,
                color:          group.color,
                headerBg:       group.headerBg,
                inputPinColor:  group.inputPinColor,
                outputPinColor: group.outputPinColor,
                cardIds:        group.cardIds,
                inputPins:      group.inputPins,
                outputPins:     group.outputPins,
                expandedBounds: group.expandedBounds,
                position:       group.position,
                createdAt:      group.createdAt,
                updatedAt:      group.updatedAt
            }));
        }

        return snapshot;
    },

    /**
     * 恢复快照到画布
     * @param {Object} snapshot - 快照数据
     * @param {Object} options - 配置选项
     * @param {boolean} options.restoreBase64 - 是否还原 base64 占位符
     * @param {boolean} options.clearCanvas - 是否清除现有画布（默认 true）
     * @param {Function} options.onComplete - 恢复完成后的回调
     */
    restore(snapshot, options = {}) {
        const {
            restoreBase64 = true,
            clearCanvas = true,
            onComplete = null
        } = options;

        if (clearCanvas) {
            document.querySelectorAll('.card').forEach(c => c.remove());
            AppState.connections.list.forEach(c => c.element?.remove());
            AppState.connections.list = [];

            // 清理所有组
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
            let content = cardData.content;

            if (restoreBase64) {
                content = SnapshotUtils.restoreContent(content);
            }

            CardFactory.create(cardData.type, {
                id:       cardData.id,
                x:        parseFloat(cardData.left),
                y:        parseFloat(cardData.top),
                width:    cardData.width,
                height:   cardData.height,
                title:    cardData.title,
                content,
                bg:       cardData.bg,
                maskData: cardData.maskData || null,
                groupId:  cardData.groupId || null,
                bypass:   cardData.bypass  || false
            }, false);
        });

        setTimeout(() => {
            snapshot.connections.forEach(c => {
                const conn = ConnectionManager.create(c.start, c.end, c.endPort || null, false);
                // 恢复桩连线扩展字段
                if (conn && c.isGroupPin) {
                    conn.isGroupPin   = c.isGroupPin;
                    conn.groupId      = c.groupId;
                    conn.pinDirection = c.pinDirection;
                    conn.pinId       = c.pinId;
                }
            });

            document.querySelectorAll('.card').forEach(el => {
                const card = CardFactory.getInstance(el.id);
                card?._updatePortsVisibility();
            });

            // 恢复组数据
            if (snapshot.groups && snapshot.groups.length > 0) {
                this._restoreGroups(snapshot.groups);
            }

            Minimap.scheduleUpdate();

            if (onComplete) onComplete();
        }, 50);
    },

    /**
     * 恢复组数据
     * @param {Array} groupsData
     */
    _restoreGroups(groupsData) {
        if (!window.GroupManager || !window.GroupRenderer) return;

        groupsData.forEach(groupData => {
            // 检查所有 cardId 是否仍存在
            const validCardIds = groupData.cardIds.filter(id => document.getElementById(id));

            if (validCardIds.length === 0) return; // 组内无有效卡片，跳过

            // 直接添加到状态列表（避免重复渲染）
            const group = {
                id:             groupData.id,
                name:           groupData.name || '未命名组',
                colorIndex:     groupData.colorIndex ?? 0,
                color:          groupData.color || '#4a90d9',
                headerBg:       groupData.headerBg || 'rgba(74,144,217,0.15)',
                inputPinColor:  groupData.inputPinColor || '#3498db',
                outputPinColor: groupData.outputPinColor || '#2ecc71',
                cardIds:        validCardIds,
                inputPins:      groupData.inputPins || [],
                outputPins:     groupData.outputPins || [],
                expandedBounds: groupData.expandedBounds || { x: 0, y: 0, width: 300, height: 200 },
                position:       groupData.position || { x: 0, y: 0 },
                _userResized:   false,
                createdAt:      groupData.createdAt || Date.now(),
                updatedAt:      Date.now()
            };

            AppState.groups.list.push(group);

            // 渲染组
            GroupRenderer.renderGroup(group);

            // 恢复卡片的 groupId 引用
            validCardIds.forEach(cardId => {
                const instance = CardFactory.getInstance(cardId);
                if (instance) instance.groupId = group.id;
            });
        });
    }
};

window.SnapshotCollector = SnapshotCollector;
