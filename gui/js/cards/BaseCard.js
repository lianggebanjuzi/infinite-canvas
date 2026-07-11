// gui/js/cards/BaseCard.js

// ── 全局 ID 递增计数器（避免 Date.now() 毫秒碰撞）─
let _idCounter = (Date.now() % 1e6); // 随机起点，防止刷新后冲突
function uid(prefix) {
    return `${prefix}-${++_idCounter}-${Math.random().toString(36).slice(2, 9)}`;
}

class BaseCard {

    constructor(options = {}) {
        this.id = options.id || uid('card');

        this.x         = typeof options.x === 'number' ? options.x : 100;
        this.y         = typeof options.y === 'number' ? options.y : 100;
        this.width     = options.width  || '200px';
        this.height    = options.height || '160px';
        this.minWidth  = options.minWidth  != null ? options.minWidth  : 120;
        this.minHeight = options.minHeight != null ? options.minHeight : 80;
        this.title     = options.title  || 'Untitled';
        this.bg     = options.bg     || '';
        this.element = null;

        // 组相关属性
        this.groupId = options.groupId || null;   // 所属组 ID，null 表示不属于任何组
        this.bypass  = options.bypass  || false;   // 是否绕过组执行

        this._drag = {
            active:  false,
            offsetX: 0,
            offsetY: 0
        };
    }

    getType() {
        throw new Error(`${this.constructor.name} 必须实现 getType()`);
    }

    /**
     * 获取卡片输出的数据类型
     * 用于通用引擎按类型匹配
     * @returns {string} 'text' | 'image'
     */
    static getDataType() {
        const contract = this.getContract();
        if (!contract || !contract.outputs || contract.outputs.length === 0) {
            return null;
        }
        // 默认返回第一个输出端口的类型
        return contract.outputs[0].type;
    }

    renderContent() {
        return '';
    }

    createElement() {
        const el = document.createElement('div');
        el.className    = 'card';
        el.id           = this.id;
        el.dataset.type = this.getType();
        el.style.left   = this.x + 'px';
        el.style.top    = this.y + 'px';
        el.style.width  = this.width;
        el.style.height = this.height;
        if (this.bg) el.style.backgroundColor = this.bg;

        const portLeft = this._createPort('port-left', 'input');

        const header = document.createElement('div');
        header.className = 'card-header';

        const titleInput = document.createElement('input');
        titleInput.type       = 'text';
        titleInput.className  = 'card-title-input';
        titleInput.value      = this.title;
        titleInput.spellcheck = false;

        titleInput.addEventListener('blur', () => {
            const newVal = titleInput.value;
            const prevVal = this.title || '';
            // 只在值真正变化时记录命令
            if (newVal !== prevVal && window.CmdManager) {
                CmdManager.execute(new PropertyChangeCommand(this.id, 'title', newVal, prevVal, '修改标题'));
            }
            this.title = newVal;
        });
        titleInput.addEventListener('keydown', (e) => e.stopPropagation());
        titleInput.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            titleInput.focus();
            titleInput.select();
        });
        titleInput.addEventListener('mousedown', (e) => {
            if (document.activeElement !== titleInput) {
                e.preventDefault();
            }
        });

        const typeBadge = document.createElement('span');
        typeBadge.className = 'card-type-badge';
        const typeLabels = {
            'text':            'Text',
            'image':           'Image',
            'ai-image':       'AI Draw',
            'drawing-board':  '画板',
            'preview':        'Preview',
            'compare':        'Compare'
        };
        typeBadge.textContent = typeLabels[this.getType()] || this.getType();

        header.appendChild(titleInput);
        header.appendChild(typeBadge);

        const dragStrip = document.createElement('div');
        dragStrip.className = 'drag-strip';

        const body = document.createElement('div');
        body.className = 'card-body';

        const contentResult = this.renderContent();
        if (contentResult instanceof Element) {
            body.appendChild(contentResult);
        } else if (typeof contentResult === 'string' && contentResult.trim()) {
            body.innerHTML = contentResult;
        }

        const portRight = this._createPort('port-right', 'output');

        const resizeHandle = document.createElement('div');
        resizeHandle.className = 'resize-handle';

        el.appendChild(portLeft);
        el.appendChild(header);
        el.appendChild(dragStrip);
        el.appendChild(body);
        el.appendChild(portRight);
        el.appendChild(resizeHandle);

        this.element = el;

        this._bindDrag(el, header);
        this._bindSelect(el);
        this._bindPortDrag(portLeft,  'input');
        this._bindPortDrag(portRight, 'output');
        this._bindResize(el, resizeHandle);

        // 保存端口引用，用于后续更新显示状态
        this._portLeft = portLeft;
        this._portRight = portRight;
        this._updatePortsVisibility();

        return el;
    }

    /**
     * 更新端口显示状态：端口始终保留在 DOM 中（悬浮/选中时可见），
     * 不再因已有连线而 display:none，避免「一侧悬浮点突然没了」。
     * 已占用侧加 port--linked，便于以后做样式区分。
     */
    _updatePortsVisibility() {
        const cardId = this.element?.id;
        if (!cardId) return;

        const connections = AppState.connections.list;
        const hasInput  = connections.some(c => c.end   === cardId);
        const hasOutput = connections.some(c => c.start === cardId);

        if (this._portLeft) {
            this._portLeft.style.display = '';
            this._portLeft.classList.toggle('port--linked', hasInput);
        }
        if (this._portRight) {
            this._portRight.style.display = '';
            this._portRight.classList.toggle('port--linked', hasOutput);
        }
    }

    /** 钩子：下游卡片收到通知时调用，子类按需实现 */
    onUpstreamChanged(upstreamCard, endPort) {
        // 默认空实现，子类覆盖
    }

    /**
     * 通用接收方法：接收上游推送的数据（由事件总线调用）
     * @param {string} type - 数据类型 'text' | 'image'
     * @param {*} data - 数据内容
     * @param {string} source - 来源 'manual' | 'upstream' | 'run'
     */
    onReceive(type, data, source = 'upstream') {
        // 默认空实现，由子类覆盖
        // 通用引擎会根据契约和 receivePolicy 调用此方法
    }

    /**
     * 通用推送方法：向所有下游推送数据（由事件总线调用）
     * @param {string} type - 数据类型
     * @param {*} data - 数据内容
     */
    onPush(type, data) {
        // 默认空实现，由子类覆盖
    }

    /**
     * 获取可推送的数据（由通用引擎调用）
     * @param {string} type - 数据类型
     * @returns {*} 数据
     */
    getPushData(type) {
        // 子类可覆盖
        return this.getOutput ? this.getOutput() : null;
    }

    /**
     * 通知所有下游卡片：数据已变化
     * 统一通过 CardEventBus 发布事件，由事件总线统一推送给下游
     * @param {string} [source='manual'] - 变化来源：'manual'|'upstream'|'run'
     */
    notifyDownstream(source = 'manual') {
        if (!window.AppState?.connections?.list) return;

        const dataType = this.constructor.getDataType?.() || null;
        if (!dataType) return;

        if (window.CardEventBus && CardEventBus.EventTypes) {
            CardEventBus.emit(CardEventBus.EventTypes.DATA_CHANGED, {
                cardId: this.id,
                type: dataType,
                data: this.getOutput ? this.getOutput() : null,
                source: source
            });
        }
    }

    _createPort(extraClass, portRole) {
        const port = document.createElement('div');
        port.className        = `port ${extraClass}`;
        port.dataset.portRole = portRole;
        return port;
    }

    _bindDrag(el, handle) {
        handle.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.stopPropagation();

            if (!AppState.cards.multiSelected.includes(el)) {
                CardFactory.deselectAll();
                el.classList.add('selected');
                AppState.cards.activeCardId = this.id;
            }

            const startX = e.clientX;
            const startY = e.clientY;
            let dragStarted = false;

            const scale   = AppState.canvas.scale;
            const offsetX =
                (e.clientX - AppState.canvas.panX) / scale - parseFloat(el.style.left);
            const offsetY =
                (e.clientY - AppState.canvas.panY) / scale - parseFloat(el.style.top);

            const onMove = (e) => {
                const dx = Math.abs(e.clientX - startX);
                const dy = Math.abs(e.clientY - startY);

                if (!dragStarted && (dx > 4 || dy > 4)) {
                    dragStarted = true;
                    this._drag.active  = true;
                    this._drag.offsetX = offsetX;
                    this._drag.offsetY = offsetY;

                    el.classList.add('dragging');

                    if (!AppState.cards.multiSelected.includes(el)) {
                        CardFactory.deselectAll();
                        el.classList.add('selected');
                        AppState.cards.activeCardId = this.id;
                    }
                }

                if (!dragStarted) return;

                const s    = AppState.canvas.scale;
                const newX = (e.clientX - AppState.canvas.panX) / s - this._drag.offsetX;
                const newY = (e.clientY - AppState.canvas.panY) / s - this._drag.offsetY;

                if (AppState.cards.multiSelected.length > 1) {
                    const dx = newX - parseFloat(el.style.left);
                    const dy = newY - parseFloat(el.style.top);
                    AppState.cards.multiSelected.forEach(cardEl => {
                        cardEl.style.left = (parseFloat(cardEl.style.left) + dx) + 'px';
                        cardEl.style.top  = (parseFloat(cardEl.style.top)  + dy) + 'px';
                        ConnectionManager.scheduleUpdate(cardEl.id);
                    });
                } else {
                    el.style.left = newX + 'px';
                    el.style.top  = newY + 'px';
                    ConnectionManager.scheduleUpdate(this.id);
                }

                Minimap.scheduleUpdate();
            };

            const startLeft = parseFloat(el.style.left);
            const startTop  = parseFloat(el.style.top);

            const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup',   onUp);

                if (dragStarted) {
                    this._drag.active = false;
                    el.classList.remove('dragging');

                    // 计算总位移，创建移动命令
                    const endLeft = parseFloat(el.style.left);
                    const endTop  = parseFloat(el.style.top);
                    const dx      = Math.round((endLeft - startLeft) * 100) / 100;
                    const dy      = Math.round((endTop  - startTop) * 100) / 100;

                    if (dx !== 0 || dy !== 0) {
                        let movedIds;
                        if (AppState.cards.multiSelected.length > 1) {
                            movedIds = AppState.cards.multiSelected.map(e => e.id).filter(id => id);
                        } else {
                            movedIds = [this.id];
                        }
                        CmdManager.execute(new MoveCardsCommand(movedIds, dx, dy));
                    }

                    // 组内卡片：拖动结束后自动扩大组边界，或检查是否脱离组
                    if (this.groupId && window.GroupManager) {
                        GroupManager.expandBoundsByCards(this.groupId);
                        GroupManager.checkCardEscape(this.id);
                    }
                }
            };

            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup',   onUp);
        });
    }

    _bindSelect(el) {
        el.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            // 不在此处 stopPropagation，让事件继续向上传递
            // 标题栏的 _bindDrag 会处理拖动；canvas 层处理取消选中

            if (!AppState.cards.multiSelected.includes(el)) {
                CardFactory.deselectAll();
                el.classList.add('selected');
                AppState.cards.activeCardId = this.id;
            }
        });
    }

    _bindPortDrag(port, portRole) {
        port.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            ConnectionManager.startConnection(this.element, port, portRole);
        });
    }

    _bindResize(el, handle) {
        handle.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            e.preventDefault();

            const startX = e.clientX;
            const startY = e.clientY;
            const startW = el.offsetWidth;
            const startH = el.offsetHeight;
            const scale  = AppState.canvas.scale;

            const prevZ     = el.style.zIndex;
            el.style.zIndex = '200';

            const body = el.querySelector('.card-body');
            if (body) body.style.overflow = 'visible';

            const minW = this.minWidth != null ? this.minWidth : 120;
            const minH = this.minHeight != null ? this.minHeight : 80;
            let rafId = null;
            let lastX = startX;
            let lastY = startY;

            const onMove = (e) => {
                lastX = e.clientX;
                lastY = e.clientY;
                if (rafId !== null) return;
                rafId = requestAnimationFrame(() => {
                    rafId = null;
                    const newW = Math.max(
                        minW,
                        startW + (lastX - startX) / scale
                    );
                    const newH = Math.max(
                        minH,
                        startH + (lastY - startY) / scale
                    );
                    el.style.width  = newW + 'px';
                    el.style.height = newH + 'px';
                    ConnectionManager.scheduleUpdate(el.id);
                    Minimap.scheduleUpdate();
                });
            };

            const onUp = () => {
                if (rafId !== null) {
                    cancelAnimationFrame(rafId);
                    rafId = null;
                }
                // Apply final size
                const newW = Math.max(
                    minW,
                    startW + (lastX - startX) / scale
                );
                const newH = Math.max(
                    minH,
                    startH + (lastY - startY) / scale
                );
                el.style.width  = newW + 'px';
                el.style.height = newH + 'px';
                ConnectionManager.scheduleUpdate(el.id);
                Minimap.scheduleUpdate();

                if (body) body.style.overflow = '';
                el.style.zIndex = prevZ;

                // 记录缩放命令（尺寸变化时才记录）
                if (Math.abs(newW - startW) > 0.5 || Math.abs(newH - startH) > 0.5) {
                    if (window.CmdManager) {
                        CmdManager.execute(new PropertyChangeCommand(
                            this.id, 'size',
                            { width: newW + 'px', height: newH + 'px' },
                            { width: startW + 'px', height: startH + 'px' },
                            '调整大小'
                        ));
                    }
                }

                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup',   onUp);
            };

            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup',   onUp);
        });
    }

    destroy() {
        this.element?.remove();
        this.element = null;
    }

    // ── serialize：content 留空，子类负责填充自己的 content ──
    serialize() {
        const el = this.element;
        return {
            id:      this.id,
            type:    this.getType(),
            title:   el?.querySelector('.card-title-input')?.value ?? this.title,
            left:    el?.style.left   ?? (this.x  + 'px'),
            top:     el?.style.top    ?? (this.y  + 'px'),
            width:   el?.style.width  ?? this.width,
            height:  el?.style.height ?? this.height,
            bg:      el?.style.backgroundColor ?? this.bg,
            content: '',  // 子类覆盖此字段
            groupId: this.groupId || null,
            bypass:  this.bypass  || false
        };
    }

    // ─────────────────────────────────────────
    // 契约声明（子类必须重写）
    // ─────────────────────────────────────────

    /**
     * 获取卡片契约声明
     * @returns {Object} { outputs: [], inputs: [] }
     */
    static getContract() {
        return {
            outputs: [],  // 子类重写：[{ name: 'default', type: 'text' | 'image' }]
            inputs: []   // 子类重写：[{ name: 'default', type: 'text' | 'image' }]
        };
    }

    /**
     * 获取指定输出的数据
     * @param {string} outputName - 输出端口名称
     * @returns {any} 输出数据
     */
    getOutput(outputName = 'default') {
        // 子类重写实现
        return null;
    }

    /**
     * 获取所有输出的数据
     * @returns {Object} { [outputName]: data }
     */
    getAllOutputs() {
        const contract = this.constructor.getContract();
        const outputs = {};
        (contract.outputs || []).forEach(port => {
            outputs[port.name] = this.getOutput(port.name);
        });
        return outputs;
    }

    // ─────────────────────────────────────────
    // 本地撤销/重做接口（子类可覆盖）
    // ─────────────────────────────────────────

    /**
     * 检查卡片是否有自己的本地撤销/重做能力
     * @returns {boolean} - 默认返回 false，子类覆盖后返回 true
     */
    hasLocalUndo() {
        return false;
    }

    /**
     * 执行本地撤销操作
     * @returns {boolean} - 是否成功执行了撤销
     */
    undo() {
        return false;
    }

    /**
     * 执行本地重做操作
     * @returns {boolean} - 是否成功执行了重做
     */
    redo() {
        return false;
    }
}

window.BaseCard = BaseCard;
window.uid = uid;
