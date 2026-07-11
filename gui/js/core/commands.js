/**
 * 具体命令类集合
 * 覆盖 Infinite Canvas 所有可撤销的操作
 *
 * 设计原则：
 * - 每个命令在 execute() 之前先"记住旧状态"
 * - undo() 用保存的旧状态精确还原（不碰其他东西）
 * - 不依赖 SnapshotCollector / 全量快照
 */

// ════════════════════════════════════════════
// 1. 创建卡片命令
// ════════════════════════════════════════════

class CreateCardCommand extends Command {
    /**
     * @param {string} type       - 卡片类型 (text/image/ai-image/drawing-board/preview/agent/compare)
     * @param {object} options    - CardFactory.create 的参数
     */
    constructor(type, options) {
        super('create-card', '创建卡片');
        this.type = type;
        this.options = { ...options };
        this.createdId = null;  // execute 后填充
    }

    execute() {
        const card = CardFactory.create(this.type, this.options, false);
        if (card) this.createdId = card.id;
    }

    undo() {
        if (!this.createdId) return;
        const el = document.getElementById(this.createdId);
        if (!el) return;

        // 移除关联连线
        const conns = AppState.connections.list.filter(
            c => c.start === this.createdId || c.end === this.createdId
        );
        conns.forEach(c => c.element?.remove());
        AppState.connections.list = AppState.connections.list.filter(
            c => !conns.includes(c)
        );

        // 从多选中移除
        AppState.cards.multiSelected = AppState.cards.multiSelected.filter(
            el => el.id !== this.createdId
        );
        if (AppState.cards.activeCardId === this.createdId) {
            AppState.cards.activeCardId = null;
        }

        // 销毁实例并移除 DOM
        CardFactory.destroyInstance(this.createdId);
        el.remove();

        Minimap.scheduleUpdate();
    }
}

// ════════════════════════════════════════════
// 2. 删除卡片命令
// ════════════════════════════════════════════

class DeleteCardsCommand extends Command {
    constructor(cardIds) {
        super('delete-cards', `删除 ${cardIds.length} 个元素`);
        this.cardIds = [...cardIds];
        this.savedData = [];  // 序列化的卡片数据 + 连线数据
    }

    execute() {
        this._saveState();
        this._removeCards();
    }

    undo() {
        // 按顺序恢复卡片
        this.savedData.forEach(d => {
            CardFactory.create(d.type, {
                id:       d.id,
                x:        d.left,
                y:        d.top,
                width:    d.width,
                height:   d.height,
                title:    d.title,
                content:  d.content,
                bg:       d.bg,
                maskData: d.maskData || null,
                groupId:  d.groupId || null,
            }, false);
        });

        // 恢复连线（等一帧让 DOM 就绪）
        setTimeout(() => {
            this.savedConnections.forEach(c => {
                const conn = ConnectionManager.create(c.start, c.end, c.endPort || null, false);
                if (conn && c.isGroupPin) {
                    conn.isGroupPin   = c.isGroupPin;
                    conn.groupId      = c.groupId;
                    conn.pinDirection = c.pinDirection;
                    conn.pinId       = c.pinId;
                }
            });
            Minimap.scheduleUpdate();
        }, 50);
    }

    _saveState() {
        this.savedData = [];
        this.savedConnections = [];

        // 获取涉及这些卡片的连线（含两端都在删除列表中的）
        const idSet = new Set(this.cardIds);

        this.cardIds.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;

            const instance = CardFactory.getInstance(id);
            if (!instance) return;

            this.savedData.push({
                id:       id,
                type:     instance.type,
                left:     el.style.left,
                top:      el.style.top,
                width:    el.style.width,
                height:   el.style.height,
                title:    instance.title || '',
                content:  instance.content || '',
                bg:       el.style.backgroundColor || '',
                maskData: instance.maskData || null,
                groupId:  instance.groupId || null,
            });
        });

        // 保存相关连线
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

    _removeCards() {
        this.cardIds.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;

            // 移除关联连线
            const related = AppState.connections.list.filter(
                c => c.start === id || c.end === id
            );
            related.forEach(c => c.element?.remove());
            AppState.connections.list = AppState.connections.list.filter(
                c => !related.includes(c)
            );

            // 清理选中状态
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

class MoveCardsCommand extends Command {
    /**
     * @param {string[]} cardIds - 移动的卡片 ID 列表
     * @param {number} dx       - X 方向位移量（画布坐标）
     * @param {number} dy       - Y 方向位移量（画布坐标）
     */
    constructor(cardIds, dx, dy) {
        super('move-cards', '移动');
        this.cardIds = [...cardIds];
        this.dx = dx;
        this.dy = dy;
    }

    execute() {
        // execute 在拖拽结束时调用，此时位置已经是新的了
        // 这里只做标记，实际位移由 drag handler 完成
        // 但为了完整性，还是执行一次移动（防止边缘情况）
    }

    undo() {
        this.cardIds.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;

            const currentLeft = parseFloat(el.style.left) || 0;
            const currentTop  = parseFloat(el.style.top)  || 0;

            el.style.left = (currentLeft - this.dx) + 'px';
            el.style.top  = (currentTop  - this.dy) + 'px';

            // 更新连线
            ConnectionManager.updateCardConnections(id);
        });

        Minimap.scheduleUpdate();
    }

    redo() {
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
// 4. 属性变更命令（标题、颜色、背景等）
// ════════════════════════════════════════════

class PropertyChangeCommand extends Command {
    /**
     * 通用属性修改命令
     *
     * @param {string} targetId   - 目标元素 ID
     * @param {string} property   - CSS 属性名 或 'title'/'content' 等特殊属性
     * @param {*}      newValue   - 新值
     * @param {*}      [oldValue] - 旧值（不传则自动从 DOM 读取）
     * @param {string} [label]    - 操作描述
     */
    constructor(targetId, property, newValue, oldValue, label) {
        super('property-change', label || '修改属性');
        this.targetId = targetId;
        this.property = property;
        this.newValue = newValue;
        this.oldValue = oldValue !== undefined ? oldValue : this._readCurrentValue(targetId, property);
    }

    _readCurrentValue(id, prop) {
        const el = document.getElementById(id);
        if (!el) return undefined;

        switch (prop) {
            case 'title': {
                const input = el.querySelector('.card-title-input');
                return input ? input.value : '';
            }
            case 'backgroundColor':
                return el.style.backgroundColor || '';
            default:
                return el.style[prop] || '';
        }
    }

    execute() {
        this._applyValue(this.targetId, this.property, this.newValue);
    }

    undo() {
        this._applyValue(this.targetId, this.property, this.oldValue);
    }

    _applyValue(id, prop, value) {
        const el = document.getElementById(id);
        if (!el) return;

        switch (prop) {
            case 'title': {
                const input = el.querySelector('.card-title-input');
                if (input) {
                    input.value = value;
                    const instance = CardFactory.getInstance(id);
                    if (instance) instance.title = value;
                }
                break;
            }
            case 'backgroundColor':
                el.style.backgroundColor = value;
                break;
            case 'size': {
                // value 是 { width, height } 对象
                if (value && typeof value === 'object') {
                    el.style.width  = value.width || el.style.width;
                    el.style.height = value.height || el.style.height;
                    ConnectionManager.scheduleUpdate(id);
                }
                break;
            }
            default:
                el.style[prop] = value;
        }

        Minimap.scheduleUpdate();
    }
}

/**
 * 项目名修改命令（特殊处理：目标不是卡片而是输入框）
 */
class ProjectNameCommand extends Command {
    constructor(newName, oldName) {
        super('project-name', '修改项目名');
        this.newName = newName;
        this.oldName = oldName || '';
    }

    execute() {
        const input = document.getElementById('project-name-input');
        if (input) input.value = this.newName;
    }

    undo() {
        const input = document.getElementById('project-name-input');
        if (input) input.value = this.oldName;
    }
}

// ════════════════════════════════════════════
// 5. 内容修改命令（文本、图片、AI 输出等）
// ════════════════════════════════════════════

class ModifyContentCommand extends Command {
    /**
     * 卡片内容变更
     *
     * @param {string} cardId    - 卡片 ID
     * @param {*}      newContent- 新内容
     * @param {*}      [oldContent]- 旧内容（不传则自动读取）
     */
    constructor(cardId, newContent, oldContent) {
        super('modify-content', '编辑内容');
        this.cardId = cardId;
        this.newContent = newContent;
        this.oldContent = oldContent !== undefined ? oldContent : this._readCurrent(cardId);
    }

    _readCurrent(id) {
        const instance = CardFactory.getInstance(id);
        return instance ? instance.content : undefined;
    }

    execute() {
        this._setContent(this.cardId, this.newContent);
    }

    undo() {
        this._setContent(this.cardId, this.oldContent);
    }

    _setContent(id, content) {
        const instance = CardFactory.getInstance(id);
        if (!instance) return;

        instance.setContent(content);
        Minimap.scheduleUpdate();
    }
}

// ════════════════════════════════════════════
// 6. 连线命令
// ════════════════════════════════════════════

class CreateConnectionCommand extends Command {
    constructor(startId, endId, endPort, extraFields = {}) {
        super('create-connection', '创建连线');
        this.startId    = startId;
        this.endId      = endId;
        this.endPort    = endPort || null;
        this.extraFields = extraFields;
        this.connId     = null;
    }

    execute() {
        const conn = ConnectionManager.create(this.startId, this.endId, this.endPort, false);
        if (conn) {
            this.connId = conn.id;
            if (this.extraFields.isGroupPin) {
                conn.isGroupPin   = true;
                conn.groupId      = this.extraFields.groupId;
                conn.pinDirection = this.extraFields.pinDirection;
                conn.pinId       = this.extraFields.pinId;
            }
        }
    }

    undo() {
        if (!this.connId) return;
        const idx = AppState.connections.list.findIndex(c => c.id === this.connId);
        if (idx === -1) return;

        const [conn] = AppState.connections.list.splice(idx, 1);
        if (conn.element) conn.element.remove();
        Minimap.scheduleUpdate();
    }
}

class RemoveConnectionCommand extends Command {
    constructor(connId) {
        super('remove-connection', '删除连线');
        this.connId    = connId;
        this.savedData = null;  // execute 时填充
    }

    execute() {
        const conn = AppState.connections.list.find(c => c.id === this.connId);
        if (!conn) return;

        this.savedData = {
            start:       conn.start,
            end:         conn.end,
            endPort:     conn.endPort || null,
            isGroupPin:  conn.isGroupPin || false,
            groupId:     conn.groupId || null,
            pinDirection: conn.pinDirection || null,
            pinId:       conn.pinId || null
        };

        if (conn.element) conn.element.remove();
        AppState.connections.list = AppState.connections.list.filter(c => c.id !== this.connId);
        Minimap.scheduleUpdate();
    }

    undo() {
        if (!this.savedData) return;
        const d = this.savedData;

        const conn = ConnectionManager.create(d.start, d.end, d.endPort, false);
        if (conn && d.isGroupPin) {
            conn.isGroupPin   = d.isGroupPin;
            conn.groupId      = d.groupId;
            conn.pinDirection = d.pinDirection;
            conn.pinId       = d.pinId;
        }
        Minimap.scheduleUpdate();
    }
}

// ════════════════════════════════════════════
// 7. 分组命令
// ════════════════════════════════════════════

class CreateGroupCommand extends Command {
    constructor(cardIds, groupConfig = {}) {
        super('create-group', '创建分组');
        this.cardIds      = [...cardIds];
        this.groupConfig  = groupConfig;
        this.groupId      = null;  // execute 后填充
    }

    execute() {
        GroupManager.createGroup(this.cardIds, this.groupConfig);
        // createGroup 会生成一个新 groupId，我们需要获取它
        if (AppState.groups.list.length > 0) {
            this.groupId = AppState.groups.list[AppState.groups.list.length - 1].id;
        }
    }

    undo() {
        if (!this.groupId) return;
        GroupManager.deleteGroup(this.groupId);
        Minimap.scheduleUpdate();
    }
}

class DeleteGroupCommand extends Command {
    constructor(groupId) {
        super('delete-group', '删除分组');
        this.groupId    = groupId;
        this.savedData  = null;
    }

    execute() {
        const group = AppState.groups.list.find(g => g.id === this.groupId);
        if (!group) return;

        this.savedData = JSON.parse(JSON.stringify(group));

        GroupManager.deleteGroup(this.groupId);
        Minimap.scheduleUpdate();
    }

    undo() {
        if (!this.savedData) return;

        // 恢复组
        if (window.GroupManager && window.GroupRenderer) {
            AppState.groups.list.push(this.savedData);
            GroupRenderer.renderGroup(this.savedData);

            // 恢复卡片引用
            (this.savedData.cardIds || []).forEach(cardId => {
                const inst = CardFactory.getInstance(cardId);
                if (inst) inst.groupId = this.savedData.id;
            });
        }
        Minimap.scheduleUpdate();
    }
}

class GroupPropertyCommand extends Command {
    constructor(groupId, property, newValue, oldValue) {
        super('group-property', '修改分组');
        this.groupId   = groupId;
        this.property  = property;
        this.newValue  = newValue;
        this.oldValue  = oldValue;
    }

    execute() {
        this._apply(this.newValue);
    }

    undo() {
        this._apply(this.oldValue);
    }

    _apply(value) {
        const group = AppState.groups.list.find(g => g.id === this.groupId);
        if (!group) return;

        switch (this.property) {
            case 'name':
                GroupManager.renameGroup(this.groupId, value);
                break;
            case 'colorIndex':
                GroupManager.setGroupColor(this.groupId, value);
                break;
            default:
                group[this.property] = value;
                GroupRenderer.renderGroup(group);
        }
        Minimap.scheduleUpdate();
    }
}

// ════════════════════════════════════════════
// 8. 粘贴命令
// ════════════════════════════════════════════

class PasteCommand extends Compound {
    constructor(cardsData, connectionsData) {
        super('paste', `粘贴 ${cardsData.length} 个元素`);
        this.cardsData       = cardsData;
        this.connectionsData = connectionsData || [];
        this.newCardIds      = {};  // 旧ID → 新ID 映射

        // 延迟到实际粘贴时构建子命令
        this._built = false;
    }

    /** 构建子命令列表 */
    _buildCommands(baseX, baseY) {
        const commands = [];

        // 计算偏移
        let minX = Infinity, minY = Infinity;
        this.cardsData.forEach(c => {
            minX = Math.min(minX, parseFloat(c.left));
            minY = Math.min(minY, parseFloat(c.top));
        });

        this.cardsData.forEach(cardData => {
            const offsetX = parseFloat(cardData.left) - minX;
            const offsetY = parseFloat(cardData.top)  - minY;
            const newId   = `card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            this.newCardIds[cardData.id] = newId;

            commands.push(new CreateCardCommand(cardData.type, {
                id:       newId,
                x:        baseX + offsetX,
                y:        baseY + offsetY,
                width:    cardData.width,
                height:   cardData.height,
                title:    cardData.title,
                content:  cardData.content,
                bg:       cardData.bg,
                maskData: cardData.maskData || null
            }));
        });

        // 连线映射到新 ID
        this.connectionsData?.forEach(conn => {
            const newStart = this.newCardIds[conn.start];
            const newEnd   = this.newCardIds[conn.end];
            if (newStart && newEnd) {
                commands.push(new CreateConnectionCommand(newStart, newEnd, conn.endPort));
            }
        });

        this.commands = commands;
        this._built    = true;
    }

    execute(baseX, baseY) {
        if (!this._built) this._buildCommands(baseX, baseY);
        super.execute();
    }

    undo() {
        super.undo();
        // 重置粘贴偏移（反向操作后需要回退）
        AppState.ai.pasteOffsetX -= AppState.ai.pasteOffsetStep;
        AppState.ai.pasteOffsetY -= AppState.ai.pasteOffsetStep;
        if (AppState.ai.pasteOffsetX < 0) {
            AppState.ai.pasteOffsetX = 0;
            AppState.ai.pasteOffsetY = 0;
        }
    }
}

// ── 导出到全局 ──
window.CreateCardCommand        = CreateCardCommand;
window.DeleteCardsCommand       = DeleteCardsCommand;
window.MoveCardsCommand         = MoveCardsCommand;
window.PropertyChangeCommand    = PropertyChangeCommand;
window.ProjectNameCommand       = ProjectNameCommand;
window.ModifyContentCommand     = ModifyContentCommand;
window.CreateConnectionCommand  = CreateConnectionCommand;
window.RemoveConnectionCommand  = RemoveConnectionCommand;
window.CreateGroupCommand       = CreateGroupCommand;
window.DeleteGroupCommand       = DeleteGroupCommand;
window.GroupPropertyCommand     = GroupPropertyCommand;
window.PasteCommand             = PasteCommand;
