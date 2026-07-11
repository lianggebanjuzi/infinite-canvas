// src/groups/GroupRenderer.ts

/**
 * 组渲染器
 * 负责组的 DOM 渲染、桩渲染、选择框绘制
 * 数据管理由 GroupManager 负责
 */

import { AppState } from '../state/app-state';
import type { Group, GroupPin } from './GroupManager';

// ── 全局声明 ──

declare const GroupManager: {
    moveGroup(groupId: string, deltaX: number, deltaY: number, opts?: { skipCardMove?: boolean }): void;
    renameGroup(groupId: string, newName: string): void;
    resizeGroup(groupId: string, newWidth: number, newHeight: number, newX: number, newY: number): void;
    getGroup(groupId: string): Group | null;
    deleteGroup(groupId: string, keepCards: boolean): void;
    MIN_GROUP_WIDTH: number;
    MIN_GROUP_HEIGHT: number;
};

declare const GroupExecutor: {
    executeGroup(groupId: string): void;
    pauseGroup(groupId: string): void;
    stopGroup(groupId: string): void;
};

declare const ConnectionManager: {
    startConnection(cardEl: HTMLElement, pinEl: HTMLElement, role: string): void;
    scheduleUpdate(cardId: string): void;
};

declare const CmdManager: {
    execute(cmd: unknown): void;
};

declare const GroupPropertyCommand: new (
    groupId: string, prop: string, newVal: unknown, oldVal: unknown, label?: string
) => unknown;

declare const CardFactory: {
    getInstance(id: string): { run?(): void; [key: string]: unknown } | null;
};

declare const Minimap: {
    scheduleUpdate(): void;
};

declare const Toast: {
    show(msg: string, dur?: number): void;
};

// ── 执行状态接口（与 GroupExecutor 共享） ──

interface ExecutionState {
    paused: boolean;
    stopRequested: boolean;
    continueSignal: { resolve(): void } | null;
    currentLevelIdx: number;
}

interface ExecutionUIOptions {
    phase?: 'idle' | 'running' | 'paused';
    level?: number;
    total?: number;
    state?: ExecutionState | null;
    levels?: string[][];
    levelInfo?: string;
}

// ─────────────────────────────────────────

export const GroupRenderer = {

    // 存储所有组 DOM 元素引用
    _groupEls: new Map<string, HTMLElement>(),

    // ─────────────────────────────────────────
    // 渲染组方框
    // ─────────────────────────────────────────

    /**
     * 渲染一个组（创建 DOM）
     * @param group
     */
    renderGroup(group: Group): void {
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
    _buildGroupHTML(group: Group): string {
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
    refreshGroup(group: Group): void {
        this.renderGroup(group);
    },

    /**
     * 更新组的位置（移动后）
     */
    updateGroupPosition(group: Group): void {
        const el = this._groupEls.get(group.id);
        if (!el) return;
        el.style.left = group.expandedBounds.x + 'px';
        el.style.top  = group.expandedBounds.y + 'px';
    },

    /**
     * 更新组的尺寸（拉伸或自动扩大后）
     */
    updateGroupSize(group: Group): void {
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
    updateGroupName(group: Group): void {
        const el = this._groupEls.get(group.id);
        if (!el) return;
        const nameEl = el.querySelector('.group-name');
        if (nameEl) nameEl.textContent = group.name;
    },

    /**
     * 更新组颜色
     */
    updateGroupColor(group: Group): void {
        const el = this._groupEls.get(group.id);
        if (!el) return;
        el.style.borderColor = group.color;
        el.style.setProperty('--group-color', group.color);
        el.style.setProperty('--group-header-bg', group.headerBg);
    },

    /**
     * 移除组的 DOM
     */
    removeGroupDOM(groupId: string): void {
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
    _renderPins(group: Group): void {
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
            this._bindPinConnection(pinEl as HTMLElement, group);
        });
        rightContainer.querySelectorAll('.group-pin').forEach(pinEl => {
            this._bindPinConnection(pinEl as HTMLElement, group);
        });
    },

    /**
     * 构建单个桩的 DOM
     */
    _buildPinElement(pin: GroupPin, direction: string, group: Group): HTMLElement {
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
    _bindPinConnection(pinEl: HTMLElement, group: Group): void {
        pinEl.addEventListener('mousedown', (e: MouseEvent) => {
            if (e.button !== 0) return;
            e.stopPropagation();

            const direction = pinEl.dataset.direction;
            const cardId = pinEl.dataset.cardId;

            if (direction === 'output') {
                const cardEl = document.getElementById(cardId!);
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

    _bindGroupEvents(group: Group, el: HTMLElement): void {
        // ── 组整体拖动（标题栏色条 + 拖动图标都支持）──
        const header    = el.querySelector('.group-header') as HTMLElement;
        const dragHandle = el.querySelector('.group-drag-handle') as HTMLElement;

        const _startDrag = (e: MouseEvent) => {
            if (e.button !== 0) return;
            // 点在可交互按钮上不拖组
            if ((e.target as HTMLElement).closest('.group-btn, .group-btn-play')) return;
            e.stopPropagation();

            let lastX = e.clientX;
            let lastY = e.clientY;
            let dragStarted = false;

            const onMove = (ev: MouseEvent) => {
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

                if ((window as any).Minimap) Minimap.scheduleUpdate();

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
        const nameEl = el.querySelector('.group-name') as HTMLElement;
        nameEl.addEventListener('blur', () => {
            const oldName = (group && group.name) || '';
            const newName = nameEl.textContent!.trim();
            GroupManager.renameGroup(group.id, newName);
            if ((window as any).CmdManager && newName !== oldName) {
                CmdManager.execute(new GroupPropertyCommand(group.id, 'name', newName, oldName));
            }
        });
        nameEl.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                nameEl.blur();
            }
            e.stopPropagation();
        });

        // ── 菜单按钮 ──
        const menuBtn = el.querySelector('.group-btn-menu') as HTMLElement;
        menuBtn.addEventListener('click', (e: MouseEvent) => {
            e.stopPropagation();
            const dropdown = el.querySelector('.group-menu-dropdown') as HTMLElement;
            dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
        });

        // ── 菜单项 ──
        el.querySelectorAll('.group-menu-item').forEach(item => {
            (item as HTMLElement).addEventListener('click', (e: MouseEvent) => {
                e.stopPropagation();
                const action = (item as HTMLElement).dataset.action;

                if (action === 'delete-keep') {
                    GroupManager.deleteGroup(group.id, true);
                } else if (action === 'delete-cards') {
                    GroupManager.deleteGroup(group.id, false);
                }

                (el.querySelector('.group-menu-dropdown') as HTMLElement).style.display = 'none';
            });
        });

        // ── 播放按钮 ──
        (el.querySelector('.group-btn-play') as HTMLElement).addEventListener('click', (e: MouseEvent) => {
            e.stopPropagation();
            this._executeGroup(group.id);
        });

        // ── 组右键菜单 ──
        el.addEventListener('contextmenu', (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            // 暂用简易实现，后续可扩展
        });

        // ── 点击组外区域关闭菜单 ──
        document.addEventListener('click', () => {
            (el.querySelector('.group-menu-dropdown') as HTMLElement).style.display = 'none';
        });
    },

    /**
     * 绑定组拉伸把手拖拽
     */
    _bindGroupResize(group: Group, el: HTMLElement): void {
        const handle = el.querySelector('.group-resize-handle') as HTMLElement | null;
        if (!handle) return;

        handle.addEventListener('mousedown', (e: MouseEvent) => {
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

            let rafId: number | null = null;

            const onMove = (e: MouseEvent) => {
                if (rafId !== null) return;
                rafId = requestAnimationFrame(() => {
                    rafId = null;
                    const dx = (e.clientX - startX) / scale;
                    const dy = (e.clientY - startY) / scale;
                    const newW = Math.max(GroupManager.MIN_GROUP_WIDTH, startW + dx);
                    const newH = Math.max(GroupManager.MIN_GROUP_HEIGHT, startH + dy);
                    el.style.width  = newW + 'px';
                    el.style.height = newH + 'px';
                    if ((window as any).Minimap) Minimap.scheduleUpdate();
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

                if ((window as any).CmdManager) {
                    // NOTE: original JS used undeclared `groupId` here — corrected to `group.id`
                    CmdManager.execute(new GroupPropertyCommand(
                        group.id, 'size',
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
    updateExecutionUI(groupId: string, { phase, level, total, state }: ExecutionUIOptions = {}): void {
        const el = this._groupEls.get(groupId) || document.getElementById(groupId);
        if (!el) return;

        const header = el.querySelector('.group-header') as HTMLElement | null;
        const actions = el.querySelector('.group-actions') as HTMLElement | null;
        if (!header || !actions) return;

        if (phase === 'idle') {
            actions.innerHTML = `
                <button class="group-btn group-btn-play" title="一键执行">▶</button>
                <button class="group-btn group-btn-menu" title="菜单">≡</button>
            `;
            (actions.querySelector('.group-btn-play') as HTMLElement)
                ?.addEventListener('click', (e: MouseEvent) => {
                    e.stopPropagation();
                    this._executeGroup(groupId);
                });
            (actions.querySelector('.group-btn-menu') as HTMLElement)
                ?.addEventListener('click', (e: MouseEvent) => {
                    e.stopPropagation();
                    const dropdown = el.querySelector('.group-menu-dropdown') as HTMLElement;
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
            (actions.querySelector('.group-btn-pause') as HTMLElement)
                ?.addEventListener('click', (e: MouseEvent) => {
                    e.stopPropagation();
                    GroupExecutor.pauseGroup(groupId);
                });
            (actions.querySelector('.group-btn-stop') as HTMLElement)
                ?.addEventListener('click', (e: MouseEvent) => {
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
            (actions.querySelector('.group-btn-continue') as HTMLElement)
                ?.addEventListener('click', (e: MouseEvent) => {
                    e.stopPropagation();
                    if (state) {
                        state.paused = false;
                        if (state.continueSignal) state.continueSignal.resolve();
                    }
                });
            (actions.querySelector('.group-btn-stop') as HTMLElement)
                ?.addEventListener('click', (e: MouseEvent) => {
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
    _executeGroup(groupId: string): void {
        if ((window as any).GroupExecutor) {
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
     * HTML 转义
     */
    _escapeHtml(str: string): string {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    },

    getGroupElement(groupId: string): HTMLElement | null {
        return this._groupEls.get(groupId) || document.getElementById(groupId);
    }
};

(window as unknown as Record<string, unknown>).GroupRenderer = GroupRenderer;
