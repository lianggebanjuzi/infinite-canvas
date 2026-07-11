// gui/js/groups/GroupManager.js

/**
 * 组管理器
 * 负责组的创建、删除、属性更新、边界计算、桩生成
 * 不负责渲染，渲染由 GroupRenderer 负责
 */
const GroupManager = {

    // 五种预设配色方案
    PRESET_COLORS: [
        { name: '深海蓝', border: '#4a90d9', headerBg: 'rgba(74,144,217,0.15)', inputPin: '#3498db', outputPin: '#2ecc71' },
        { name: '紫罗兰', border: '#9b59b6', headerBg: 'rgba(155,89,182,0.15)', inputPin: '#9b59b6', outputPin: '#e74c3c' },
        { name: '森林绿', border: '#27ae60', headerBg: 'rgba(39,174,96,0.15)',   inputPin: '#27ae60', outputPin: '#f39c12' },
        { name: '珊瑚红', border: '#e74c3c', headerBg: 'rgba(231,76,60,0.15)',   inputPin: '#e67e22', outputPin: '#e74c3c' },
        { name: '琥珀黄', border: '#f39c12', headerBg: 'rgba(243,156,18,0.15)', inputPin: '#f39c12', outputPin: '#1abc9c' },
    ],

    // 最小宽高
    MIN_GROUP_WIDTH:  240,
    MIN_GROUP_HEIGHT: 120,

    /** 组框顶边高于卡片顶边的距离（标题栏约 32px + 与内容区间距），与 group.css .group-header 一致 */
    GROUP_HEADER_TOP_INSET: 40,

    // ─────────────────────────────────────────
    // 创建组
    // ─────────────────────────────────────────

    /**
     * 根据选中的卡片 ID 列表创建组
     * @param {string[]} cardIds - 卡片 ID 数组（至少 2 张）
     * @param {object} options - 可选配置 { name, colorIndex }
     * @returns {object|null} 组的实例或 null
     */
    createGroup(cardIds, options = {}) {
        if (!cardIds || cardIds.length < 1) {
            console.warn('[GroupManager] 创建组需要至少 1 张卡片');
            return null;
        }

        const id = 'group-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
        const colorIndex = options.colorIndex ?? 0;
        const preset = this.PRESET_COLORS[colorIndex] || this.PRESET_COLORS[0];

        // 计算初始边界
        const bounds = this._calculateBoundsFromCardIds(cardIds);
        const eb0 = this._expandedBoundsFromCardBounds(bounds);

        const group = {
            id,
            name: options.name || '未命名组',
            colorIndex,
            color: preset.border,
            headerBg: preset.headerBg,
            inputPinColor: preset.inputPin,
            outputPinColor: preset.outputPin,

            cardIds: [...cardIds],

            inputPins: [],
            outputPins: [],

            expandedBounds: { ...eb0 },

            position: { x: eb0.x, y: eb0.y },

            // 手动拉伸标记（为 true 时卡片移动不会自动扩大组边界）
            _userResized: false,

            createdAt: Date.now(),
            updatedAt: Date.now()
        };

        // 生成桩
        this._generatePins(group);

        // 将卡片加入组（设置 groupId）
        this._applyGroupIdToCards(group);

        // 加入状态列表
        AppState.groups.list.push(group);

        // 渲染组
        if (window.GroupRenderer) {
            GroupRenderer.renderGroup(group);
        }

        // 创建组的撤销记录由外部调用方（group-actions.js）处理
        if (window.Minimap) Minimap.scheduleUpdate();

        return group;
    },

    // ─────────────────────────────────────────
    // 删除组
    // ─────────────────────────────────────────

    /**
     * 删除组
     * @param {string} groupId
     * @param {boolean} keepCards - 是否保留组内卡片（默认 true）
     */
    deleteGroup(groupId, keepCards = true) {
        const group = this.getGroup(groupId);
        if (!group) return;

        if (keepCards) {
            // 卡片脱离组
            this._removeGroupIdFromCards(group);
        } else {
            // 删除组内所有卡片
            group.cardIds.forEach(cardId => {
                const el = document.getElementById(cardId);
                if (el) CardFactory.deleteSelected();
            });
        }

        // 从列表移除
        const index = AppState.groups.list.findIndex(g => g.id === groupId);
        if (index !== -1) AppState.groups.list.splice(index, 1);

        // 清除激活状态
        if (AppState.groups.activeGroupId === groupId) {
            AppState.groups.activeGroupId = null;
        }

        // 移除 DOM
        if (window.GroupRenderer) {
            GroupRenderer.removeGroupDOM(groupId);
        }

        // 删除组的撤销记录由调用方处理
        if (window.Minimap) Minimap.scheduleUpdate();
    },

    // ─────────────────────────────────────────
    // 添加/移除卡片
    // ─────────────────────────────────────────

    /**
     * 将卡片加入组
     * @param {string} groupId
     * @param {string} cardId
     */
    addCardToGroup(groupId, cardId) {
        const group = this.getGroup(groupId);
        if (!group) return;
        if (group.cardIds.includes(cardId)) return;

        // 检查目标卡片是否已在其他组（不支持嵌套）
        const cardInstance = CardFactory.getInstance(cardId);
        if (cardInstance?.groupId && cardInstance.groupId !== groupId) {
            // 先从原组移除
            this.removeCardFromGroup(cardId);
        }

        group.cardIds.push(cardId);
        if (cardInstance) cardInstance.groupId = groupId;

        this._regenerate(groupId);
    },

    /**
     * 将卡片从组中移除
     * @param {string} cardId
     */
    removeCardFromGroup(cardId) {
        const cardInstance = CardFactory.getInstance(cardId);
        if (!cardInstance?.groupId) return;

        const group = this.getGroup(cardInstance.groupId);
        if (!group) return;

        group.cardIds = group.cardIds.filter(id => id !== cardId);
        cardInstance.groupId = null;

        // 如果组只剩 0 或 1 张卡片，自动删除组
        if (group.cardIds.length <= 1) {
            this.deleteGroup(group.id, true);
        } else {
            this._regenerate(group.id);
        }
    },

    // ─────────────────────────────────────────
    // 更新组属性
    // ─────────────────────────────────────────

    renameGroup(groupId, newName) {
        const group = this.getGroup(groupId);
        if (!group) return;

        group.name = newName || '未命名组';
        group.updatedAt = Date.now();

        if (window.GroupRenderer) {
            GroupRenderer.updateGroupName(group);
        }
    },

    setGroupColor(groupId, colorIndex) {
        const group = this.getGroup(groupId);
        if (!group) return;

        const preset = this.PRESET_COLORS[colorIndex] ?? this.PRESET_COLORS[0];
        group.colorIndex = colorIndex;
        group.color = preset.border;
        group.headerBg = preset.headerBg;
        group.inputPinColor = preset.inputPin;
        group.outputPinColor = preset.outputPin;
        group.updatedAt = Date.now();

        if (window.GroupRenderer) {
            GroupRenderer.updateGroupColor(group);
        }
    },

    /**
     * 移动组（标题栏拖动）
     * @param {string} groupId
     * @param {number} deltaX
     * @param {number} deltaY
     * @param {{ skipCardMove?: boolean }} [opts] - 拖动过程中已在 DOM 上移动过卡片时传 true，避免位移叠加双倍
     */
    moveGroup(groupId, deltaX, deltaY, opts = {}) {
        const group = this.getGroup(groupId);
        if (!group) return;

        group.position.x += deltaX;
        group.position.y += deltaY;
        group.expandedBounds.x += deltaX;
        group.expandedBounds.y += deltaY;

        // 同步移动组内所有卡片（若拖动时已跟手移动过，则跳过）
        if (!opts.skipCardMove) {
            group.cardIds.forEach(cardId => {
                const el = document.getElementById(cardId);
                if (el) {
                    el.style.left = (parseFloat(el.style.left) + deltaX) + 'px';
                    el.style.top  = (parseFloat(el.style.top)  + deltaY) + 'px';
                }
            });
        }

        if (window.GroupRenderer) {
            GroupRenderer.updateGroupPosition(group);
        }

        if (window.Minimap) Minimap.scheduleUpdate();
    },

    // ─────────────────────────────────────────
    // 组的桩（Pin）
    // ─────────────────────────────────────────

    /**
     * 重新生成组的桩（卡片增删后调用）
     * @param {string} groupId
     */
    regeneratePins(groupId) {
        this._regenerate(groupId);
    },

    // ─────────────────────────────────────────
    // 拉伸组
    // ─────────────────────────────────────────

    /**
     * 用户手动拉伸组边界
     * @param {string} groupId
     * @param {number} newWidth
     * @param {number} newHeight
     * @param {number} newX  - 拉伸左边/上边时 x/y 也可能变
     * @param {number} newY
     */
    resizeGroup(groupId, newWidth, newHeight, newX, newY) {
        const group = this.getGroup(groupId);
        if (!group) return;

        group.expandedBounds.width  = Math.max(newWidth,  this.MIN_GROUP_WIDTH);
        group.expandedBounds.height = Math.max(newHeight, this.MIN_GROUP_HEIGHT);
        group.expandedBounds.x = newX;
        group.expandedBounds.y = newY;
        group.position.x = newX;
        group.position.y = newY;
        group._userResized = true;
        group.updatedAt = Date.now();

        if (window.GroupRenderer) {
            GroupRenderer.updateGroupSize(group);
        }
        if (window.Minimap) Minimap.scheduleUpdate();
    },

    /**
     * 根据卡片位置自动扩大组边界（当用户拖动卡片时调用）
     * @param {string} groupId
     */
    expandBoundsByCards(groupId) {
        const group = this.getGroup(groupId);
        if (!group || group._userResized) return;

        const padding = 40;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

        group.cardIds.forEach(cardId => {
            const el = document.getElementById(cardId);
            if (!el) return;
            const l = parseFloat(el.style.left);
            const t = parseFloat(el.style.top);
            const r = l + el.offsetWidth;
            const b = t + el.offsetHeight;
            if (l < minX) minX = l;
            if (t < minY) minY = t;
            if (r > maxX) maxX = r;
            if (b > maxY) maxY = b;
        });

        if (minX === Infinity) return;

        // 只有当卡片超出当前边界时才扩展
        const eb = group.expandedBounds;
        let changed = false;
        const inset = this.GROUP_HEADER_TOP_INSET;

        if (minX < eb.x) { eb.x = minX; changed = true; }
        if (minY - inset < eb.y) { eb.y = minY - inset; changed = true; }
        if (maxX > eb.x + eb.width) {
            eb.width = maxX - eb.x + padding;
            changed = true;
        }
        if (maxY > eb.y + eb.height) {
            eb.height = maxY - eb.y + padding;
            changed = true;
        }

        if (changed) {
            group.position.x = eb.x;
            group.position.y = eb.y;
            group.updatedAt = Date.now();

            if (window.GroupRenderer) {
                GroupRenderer.updateGroupSize(group);
            }
            if (window.Minimap) Minimap.scheduleUpdate();
        }
    },

    /**
     * 检查卡片是否已拖出组边界，是则自动脱离
     * @param {string} cardId
     * @returns {boolean} 是否脱离了组
     */
    checkCardEscape(cardId) {
        const instance = CardFactory.getInstance(cardId);
        if (!instance?.groupId) return false;

        const group = this.getGroup(instance.groupId);
        if (!group) return false;

        const el = document.getElementById(cardId);
        if (!el) return false;

        const cardL = parseFloat(el.style.left);
        const cardT = parseFloat(el.style.top);
        const cardR = cardL + el.offsetWidth;
        const cardB = cardT + el.offsetHeight;
        const eb = group.expandedBounds;

        // 卡片完全在组外部（允许稍微超出一点点）
        const threshold = 10;
        if (cardL < eb.x - threshold || cardT < eb.y - threshold ||
            cardR > eb.x + eb.width + threshold || cardB > eb.y + eb.height + threshold) {
            this.removeCardFromGroup(cardId);
            return true;
        }
        return false;
    },

    // ─────────────────────────────────────────
    // 查询
    // ─────────────────────────────────────────

    getGroup(groupId) {
        return AppState.groups.list.find(g => g.id === groupId) || null;
    },

    getGroupByCardId(cardId) {
        return AppState.groups.list.find(g => g.cardIds.includes(cardId)) || null;
    },

    getGroupCount() {
        return AppState.groups.list.length;
    },

    // ─────────────────────────────────────────
    // 验证封闭性
    // ─────────────────────────────────────────

    /**
     * 验证组的封闭性，返回跨组连线信息
     * @param {string} groupId
     * @returns {{ inputs: object[], outputs: object[] }}
     */
    validateGroup(groupId) {
        const group = this.getGroup(groupId);
        if (!group) return { inputs: [], outputs: [] };

        const cardIdSet = new Set(group.cardIds);
        const inputs = [];
        const outputs = [];

        group.cardIds.forEach(cardId => {
            // 检查入站连线
            AppState.connections.list.forEach(conn => {
                if (conn.end !== cardId) return;
                if (cardIdSet.has(conn.start)) return;

                // 跨组连线 → 输入桩
                if (!inputs.some(p => p.cardId === cardId && p.portName === (conn.endPort || 'default'))) {
                    inputs.push({
                        cardId,
                        portName: conn.endPort || 'default',
                        sourceCardId: conn.start
                    });
                }
            });

            // 检查出站连线
            AppState.connections.list.forEach(conn => {
                if (conn.start !== cardId) return;
                if (cardIdSet.has(conn.end)) return;

                // 跨组连线 → 输出桩
                if (!outputs.some(p => p.cardId === cardId && p.portName === (conn.endPort || 'default'))) {
                    outputs.push({
                        cardId,
                        portName: conn.endPort || 'default',
                        targetCardId: conn.end
                    });
                }
            });
        });

        return { inputs, outputs };
    },

    // ─────────────────────────────────────────
    // 私有方法
    // ─────────────────────────────────────────

    /**
     * 根据卡片 ID 列表计算边界
     */
    _calculateBoundsFromCardIds(cardIds) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

        cardIds.forEach(cardId => {
            const el = document.getElementById(cardId);
            if (!el) return;
            const l = parseFloat(el.style.left);
            const t = parseFloat(el.style.top);
            const r = l + el.offsetWidth;
            const b = t + el.offsetHeight;
            if (l < minX) minX = l;
            if (t < minY) minY = t;
            if (r > maxX) maxX = r;
            if (b > maxY) maxY = b;
        });

        if (minX === Infinity) return { x: 0, y: 0, width: 300, height: 200 };

        return {
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY
        };
    },

    /**
     * 卡片包围盒 → 组 expandedBounds（组顶在卡片顶之上，留出标题栏区域）
     */
    _expandedBoundsFromCardBounds(bounds) {
        const inset = this.GROUP_HEADER_TOP_INSET;
        return {
            x: bounds.x,
            y: bounds.y - inset,
            width: Math.max(bounds.width + 80, 300),
            height: Math.max(bounds.height + 100 + inset, 200 + inset)
        };
    },

    /**
     * 将组 ID 写入所有组内卡片的实例
     */
    _applyGroupIdToCards(group) {
        group.cardIds.forEach(cardId => {
            const instance = CardFactory.getInstance(cardId);
            if (instance) {
                instance.groupId = group.id;
            }
        });
    },

    /**
     * 将组内卡片的 groupId 清空
     */
    _removeGroupIdFromCards(group) {
        group.cardIds.forEach(cardId => {
            const instance = CardFactory.getInstance(cardId);
            if (instance) {
                instance.groupId = null;
            }
        });
    },

    /**
     * 生成组的输入桩和输出桩
     */
    _generatePins(group) {
        group.inputPins = [];
        group.outputPins = [];

        const cardIdSet = new Set(group.cardIds);
        const seenInputs = new Map();
        const seenOutputs = new Map();

        AppState.connections.list.forEach(conn => {
            const startInGroup = cardIdSet.has(conn.start);
            const endInGroup = cardIdSet.has(conn.end);
            const portName = conn.endPort || 'default';

            if (startInGroup && !endInGroup) {
                // 输出桩
                const key = conn.start + '|' + portName;
                if (!seenOutputs.has(key)) {
                    seenOutputs.set(key, true);
                    group.outputPins.push({
                        id: 'pin-out-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5),
                        name: portName === 'default' ? '输出' : portName,
                        dataType: 'text',
                        cardId: conn.start,
                        portName,
                        visible: true
                    });
                }
            } else if (!startInGroup && endInGroup) {
                // 输入桩
                const key = conn.end + '|' + portName;
                if (!seenInputs.has(key)) {
                    seenInputs.set(key, true);
                    group.inputPins.push({
                        id: 'pin-in-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5),
                        name: portName === 'default' ? '输入' : portName,
                        dataType: 'text',
                        cardId: conn.end,
                        portName,
                        visible: true
                    });
                }
            }
        });
    },

    /**
     * 重新计算边界并更新桩
     */
    _regenerate(groupId) {
        const group = this.getGroup(groupId);
        if (!group) return;

        const bounds = this._calculateBoundsFromCardIds(group.cardIds);

        // 用户手动拉伸过 → 只更新 x/y，保留宽高
        if (group._userResized) {
            const inset = this.GROUP_HEADER_TOP_INSET;
            group.expandedBounds.x = bounds.x;
            group.expandedBounds.y = bounds.y - inset;
            group.position.x = bounds.x;
            group.position.y = bounds.y - inset;
        } else {
            // 自动模式 → 完整重新计算
            const eb = this._expandedBoundsFromCardBounds(bounds);
            group.expandedBounds = { ...eb };
            group.position = { x: eb.x, y: eb.y };
        }

        this._generatePins(group);
        group.updatedAt = Date.now();

        if (window.GroupRenderer) {
            GroupRenderer.refreshGroup(group);
        }

        if (window.Minimap) Minimap.scheduleUpdate();
    }
};

window.GroupManager = GroupManager;
