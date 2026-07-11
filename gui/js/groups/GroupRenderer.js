// gui/js/groups/GroupRenderer.js

/**
 * 组渲染器
 * 负责组的 DOM 渲染、桩渲染、选择框绘制
 * 数据管理由 GroupManager 负责
 */
const GroupRenderer = {

    // 存储所有组 DOM 元素引用
    _groupEls: new Map(),

    // ─────────────────────────────────────────
    // 渲染组方框
    // ─────────────────────────────────────────

    /**
     * 渲染一个组（创建 DOM）
     * @param {object} group
     */
    renderGroup(group) {
        const container = document.getElementById('transform-layer');
        if (!container) return;

        // 移除已存在的 DOM
        this.removeGroupDOM(group.id);

        const el = document.createElement('div');
        el.className = 'group-box';
        el.id = group.id;
        el.style.left = group.expandedBounds.x + 'px';
        el.style.top = group.expandedBounds.y + 'px';
        el.style.width = group.expandedBounds.width + 'px';
        el.style.height = group.expandedBounds.height + 'px';
        el.style.borderColor = group.color;
        el.style.setProperty('--group-color', group.color);
        el.style.setProperty('--group-header-bg', group.headerBg);

        el.innerHTML = this._buildGroupHTML(group);

        container.appendChild(el);
        this._groupEls.set(group.id, el);

        this._bindGroupEvents(group, el);
        this._bindGroupResize(group, el);
        this._renderPins(group);
    },

    /**
     * 构建组的 HTML 结构
     */
    _buildGroupHTML(group) {
        return `
            <div class="group-header">
                <span class="group-drag-handle">▣</span>
                <span class="group-name" contenteditable="true">${this._escapeHtml(group.name)}</span>
                <div class="group-actions">
                    <button class="group-btn group-btn-play" title="一键执行">▶</button>
                    <button class="group-btn group-btn-menu" title="菜单">≡</button>
                </div>
            </div>
            <div class="group-content"></div>
            <div class="group-pins-row">
                <div class="group-pins-left"></div>
                <div class="group-pins-right"></div>
            </div>
            <div class="group-resize-handle" title="拖动拉伸"></div>
            <div class="group-menu-dropdown" style="display:none">
                <div class="group-menu-item group-menu-item-delete" data-action="delete-keep">
                    <span class="group-menu-item-icon" aria-hidden="true">❌</span>
                    <span>删除组（保留卡片）</span>
                </div>
                <div class="group-menu-item danger group-menu-item-delete" data-action="delete-cards">
                    <span class="group-menu-item-icon" aria-hidden="true">🗑</span>
                    <span>删除组（并删除卡片）</span>
                </div>
            </div>
        `;
    },

    /**
     * 刷新整个组（边界/桩变化后）
     */
    refreshGroup(group) {
        this.renderGroup(group);
    },

    /**
     * 更新组的位置（移动后）
     */
    updateGroupPosition(group) {
        const el = this._groupEls.get(group.id);
        if (!el) return;
        el.style.left = group.expandedBounds.x + 'px';
        el.style.top  = group.expandedBounds.y + 'px';
    },

    /**
     * 更新组的尺寸（拉伸或自动扩大后）
     */
    updateGroupSize(group) {
        const el = this._groupEls.get(group.id);
        if (!el) return;
        el.style.left  = group.expandedBounds.x + 'px';
        el.style.top   = group.expandedBounds.y + 'px';
        el.style.width  = group.expandedBounds.width + 'px';
        el.style.height = group.expandedBounds.height + 'px';
    },

    /**
     * 更新组名显示
     */
    updateGroupName(group) {
        const el = this._groupEls.get(group.id);
        if (!el) return;
        const nameEl = el.querySelector('.group-name');
        if (nameEl) nameEl.textContent = group.name;
    },

    /**
     * 更新组颜色
     */
    updateGroupColor(group) {
        const el = this._groupEls.get(group.id);
        if (!el) return;
        el.style.borderColor = group.color;
        el.style.setProperty('--group-color', group.color);
        el.style.setProperty('--group-header-bg', group.headerBg);
    },

    /**
     * 移除组的 DOM
     */
    removeGroupDOM(groupId) {
        const el = this._groupEls.get(groupId);
        if (el) {
            el.remove();
            this._groupEls.delete(groupId);
        }
        const domEl = document.getElementById(groupId);
        if (domEl) domEl.remove();
    },

    // ─────────────────────────────────────────
    // 渲染桩
    // ─────────────────────────────────────────

    /**
     * 渲染组的输入/输出桩
     */
    _renderPins(group) {
        const el = this._groupEls.get(group.id);
        if (!el) return;

        const leftContainer = el.querySelector('.group-pins-left');
        const rightContainer = el.querySelector('.group-pins-right');

        if (!leftContainer || !rightContainer) return;

        leftContainer.innerHTML = '';
        rightContainer.innerHTML = '';

        group.inputPins.forEach(pin => {
            leftContainer.appendChild(this._buildPinElement(pin, 'input', group));
        });

        group.outputPins.forEach(pin => {
            rightContainer.appendChild(this._buildPinElement(pin, 'output', group));
        });

        // 绑定桩的连接事件
        leftContainer.querySelectorAll('.group-pin').forEach(pinEl => {
            this._bindPinConnection(pinEl, group);
        });
        rightContainer.querySelectorAll('.group-pin').forEach(pinEl => {
            this._bindPinConnection(pinEl, group);
        });
    },

    /**
     * 构建单个桩的 DOM
     */
    _buildPinElement(pin, direction, group) {
        const pinEl = document.createElement('div');
        pinEl.className = `group-pin group-pin-${direction}`;
        pinEl.dataset.pinId = pin.id;
        pinEl.dataset.direction = direction;
        pinEl.dataset.cardId = pin.cardId;
        pinEl.dataset.portName = pin.portName;
        if (pin.portName) pinEl.dataset.inputName = pin.portName;

        const color = direction === 'input' ? group.inputPinColor : group.outputPinColor;

        pinEl.innerHTML = `
            <div class="group-pin-connector" style="border-color: ${color}"></div>
            <div class="group-pin-label" style="color: ${color}">${this._escapeHtml(pin.name)}</div>
        `;

        return pinEl;
    },

    /**
     * 绑定桩的连线拖拽事件
     */
    _bindPinConnection(pinEl, group) {
        pinEl.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.stopPropagation();

            const direction = pinEl.dataset.direction;
            const cardId = pinEl.dataset.cardId;

            if (direction === 'output') {
                const cardEl = document.getElementById(cardId);
                if (cardEl) {
                    ConnectionManager.startConnection(cardEl, pinEl, 'output');
                }
            }
            // 输入桩的连线由 ConnectionManager 在 endConnection 时处理
        });
    },

    // ─────────────────────────────────────────
    // 组事件绑定
    // ─────────────────────────────────────────

    _bindGroupEvents(group, el) {
        // ── 组整体拖动（标题栏色条 + 拖动图标都支持）──
        const header    = el.querySelector('.group-header');
        const dragHandle = el.querySelector('.group-drag-handle');

        const _startDrag = (e) => {
            if (e.button !== 0) return;
            // 点在可交互按钮上不拖组
            if (e.target.closest('.group-btn, .group-btn-play')) return;
            e.stopPropagation();

            let lastX = e.clientX;
            let lastY = e.clientY;
            let dragStarted = false;

            const onMove = (ev) => {
                const dx = ev.clientX - lastX;
                const dy = ev.clientY - lastY;
                if (!dragStarted && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
                    dragStarted = true;
                    el.classList.add('dragging');
                }
                if (!dragStarted) return;

                const scale = AppState.canvas.scale;
                const realDx = dx / scale;
                const realDy = dy / scale;

                el.style.left = (parseFloat(el.style.left) + realDx) + 'px';
                el.style.top  = (parseFloat(el.style.top)  + realDy) + 'px';

                // 组内卡片跟随移动
                group.cardIds.forEach(cardId => {
                    const cardEl = document.getElementById(cardId);
                    if (!cardEl) return;
                    cardEl.style.left = (parseFloat(cardEl.style.left) + realDx) + 'px';
                    cardEl.style.top  = (parseFloat(cardEl.style.top)  + realDy) + 'px';
                    ConnectionManager.scheduleUpdate(cardId);
                });

                if (window.Minimap) Minimap.scheduleUpdate();

                lastX = ev.clientX;
                lastY = ev.clientY;
            };

            const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);

                if (dragStarted) {
                    const dx = parseFloat(el.style.left) - group.expandedBounds.x;
                    const dy = parseFloat(el.style.top)  - group.expandedBounds.y;

                    // 拖动过程中卡片已跟手移动过，这里只提交数据层位移，不可再对卡片加一遍 dx/dy
                    GroupManager.moveGroup(group.id, dx, dy, { skipCardMove: true });
                    el.classList.remove('dragging');
                    // 分组拖动位移——记录移动命令（由 GroupManager.moveGroup 处理）
                }
            };

            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        };

        // 标题栏色条整体可拖
        header.addEventListener('mousedown', _startDrag);
        // 小图标也保留拖动（两者都走同一逻辑）
        dragHandle.addEventListener('mousedown', _startDrag);

        // ── 组名编辑 ──
        const nameEl = el.querySelector('.group-name');
        nameEl.addEventListener('blur', () => {
            const oldName = (group && group.name) || '';
            const newName = nameEl.textContent.trim();
            GroupManager.renameGroup(group.id, newName);
            if (window.CmdManager && newName !== oldName) {
                CmdManager.execute(new GroupPropertyCommand(group.id, 'name', newName, oldName));
            }
        });
        nameEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                nameEl.blur();
            }
            e.stopPropagation();
        });

        // ── 菜单按钮 ──
        const menuBtn = el.querySelector('.group-btn-menu');
        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const dropdown = el.querySelector('.group-menu-dropdown');
            dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
        });

        // ── 菜单项 ──
        el.querySelectorAll('.group-menu-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = item.dataset.action;

                if (action === 'delete-keep') {
                    GroupManager.deleteGroup(group.id, true);
                } else if (action === 'delete-cards') {
                    GroupManager.deleteGroup(group.id, false);
                }

                el.querySelector('.group-menu-dropdown').style.display = 'none';
            });
        });

        // ── 播放按钮 ──
        el.querySelector('.group-btn-play').addEventListener('click', (e) => {
            e.stopPropagation();
            this._executeGroup(group.id);
        });

        // ── 组右键菜单 ──
        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            // 暂用简易实现，后续可扩展
        });

        // ── 点击组外区域关闭菜单 ──
        document.addEventListener('click', () => {
            el.querySelector('.group-menu-dropdown').style.display = 'none';
        });
    },

    /**
     * 绑定组拉伸把手拖拽
     */
    _bindGroupResize(group, el) {
        const handle = el.querySelector('.group-resize-handle');
        if (!handle) return;

        handle.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            e.preventDefault();

            const startX = e.clientX;
            const startY = e.clientY;
            const startW = el.offsetWidth;
            const startH = el.offsetHeight;
            const startL = parseFloat(el.style.left);
            const startT = parseFloat(el.style.top);
            const scale = AppState.canvas.scale;

            let rafId = null;

            const onMove = (e) => {
                if (rafId !== null) return;
                rafId = requestAnimationFrame(() => {
                    rafId = null;
                    const dx = (e.clientX - startX) / scale;
                    const dy = (e.clientY - startY) / scale;
                    const newW = Math.max(GroupManager.MIN_GROUP_WIDTH, startW + dx);
                    const newH = Math.max(GroupManager.MIN_GROUP_HEIGHT, startH + dy);
                    el.style.width  = newW + 'px';
                    el.style.height = newH + 'px';
                    if (window.Minimap) Minimap.scheduleUpdate();
                });
            };

            const onUp = () => {
                if (rafId !== null) cancelAnimationFrame(rafId);
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);

                const finalW = parseFloat(el.style.width);
                const finalH = parseFloat(el.style.height);

                // 同步更新 expandedBounds（位置不变，只更新宽高）
                GroupManager.resizeGroup(
                    group.id,
                    finalW,
                    finalH,
                    startL,
                    startT
                );

                if (window.CmdManager) {
                    CmdManager.execute(new GroupPropertyCommand(
                        groupId, 'size',
                        { width: finalW, height: finalH },
                        { width: startL, height: startT },
                        '调整分组大小'
                    ));
                }
            };

            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        });
    },

    /**
     * 更新组标题栏的执行状态 UI
     * phase: 'idle' | 'running' | 'paused'
     * paused 时 onContinue/onStop 回调由调用方提供
     */
    updateExecutionUI(groupId, { phase, level, total, state } = {}) {
        const el = this._groupEls.get(groupId) || document.getElementById(groupId);
        if (!el) return;

        const header = el.querySelector('.group-header');
        const actions = el.querySelector('.group-actions');
        if (!header || !actions) return;

        if (phase === 'idle') {
            actions.innerHTML = `
                <button class="group-btn group-btn-play" title="一键执行">▶</button>
                <button class="group-btn group-btn-menu" title="菜单">≡</button>
            `;
            actions.querySelector('.group-btn-play')
                ?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this._executeGroup(groupId);
                });
            actions.querySelector('.group-btn-menu')
                ?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const dropdown = el.querySelector('.group-menu-dropdown');
                    dropdown.style.display =
                        dropdown.style.display === 'none' ? 'block' : 'none';
                });
            el.classList.remove('paused');
            return;
        }

        if (phase === 'running') {
            actions.innerHTML = `
                <button class="group-btn group-btn-pause" title="暂停（层间）">⏸</button>
                <button class="group-btn group-btn-stop"  title="停止">⏹</button>
            `;
            el.classList.remove('paused');
            actions.querySelector('.group-btn-pause')
                ?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    GroupExecutor.pauseGroup(groupId);
                });
            actions.querySelector('.group-btn-stop')
                ?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    GroupExecutor.stopGroup(groupId);
                });
            return;
        }

        if (phase === 'paused') {
            const progress = (typeof level === 'number' && typeof total === 'number')
                ? `（${level + 1}/${total}层已完成）` : '';
            actions.innerHTML = `
                <button class="group-btn group-btn-continue" title="继续执行">▶</button>
                <button class="group-btn group-btn-stop"    title="停止">⏹</button>
            `;
            el.classList.add('paused');
            if (typeof Toast !== 'undefined') {
                Toast.show(`组已暂停 ${progress}，点继续从下一层恢复`);
            }
            actions.querySelector('.group-btn-continue')
                ?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (state) {
                        state.paused = false;
                        if (state.continueSignal) state.continueSignal.resolve();
                    }
                });
            actions.querySelector('.group-btn-stop')
                ?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (state) {
                        state.stopRequested = true;
                        if (state.continueSignal) state.continueSignal.resolve();
                    }
                });
        }
    },

    /**
     * 执行整个组
     */
    _executeGroup(groupId) {
        if (window.GroupExecutor) {
            GroupExecutor.executeGroup(groupId);
        } else {
            const group = GroupManager.getGroup(groupId);
            if (group) {
                group.cardIds.forEach(cardId => {
                    CardFactory.getInstance(cardId)?.run?.();
                });
            }
        }
    },

    /**
     * 构建组的 HTML 结构
     */

    _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    },

    getGroupElement(groupId) {
        return this._groupEls.get(groupId) || document.getElementById(groupId);
    }
};

window.GroupRenderer = GroupRenderer;
