// src/groups/group-actions.ts

/**
 * 组操作辅助函数
 */

import { AppState } from '../state/app-state';
import type { Group } from './GroupManager';

// ── 全局声明 ──

declare const GroupManager: {
    createGroup(cardIds: string[], options?: { name?: string; colorIndex?: number }): Group | null;
    getGroup(groupId: string): Group | null;
    setGroupColor(groupId: string, colorIndex: number): void;
    PRESET_COLORS: Array<{ name: string; border: string; headerBg: string; inputPin: string; outputPin: string }>;
};

declare const CmdManager: {
    execute(cmd: unknown): void;
};

declare const CreateGroupCommand: new (cardIds: string[]) => unknown;

declare const GroupPropertyCommand: new (
    groupId: string, prop: string, newVal: unknown, oldVal: unknown, label?: string
) => unknown;

declare const Toast: {
    show(msg: string, dur?: number): void;
};

// ─────────────────────────────────────────

export const GroupActions = {

    /**
     * 从当前多选创建组（直接用默认色，不弹颜色选择）
     */
    createFromSelection(): void {
        const selected = AppState.cards.multiSelected;
        if (!selected || selected.length < 1) {
            Toast.show('请先框选至少 1 张卡片');
            return;
        }

        const cardIds = selected.map(el => el.id);

        // 直接创建组（颜色使用默认预设）
        GroupManager.createGroup(cardIds);
        if ((window as any).CmdManager) {
            CmdManager.execute(new CreateGroupCommand(cardIds));
        }

        if ((window as any).hideAllMenus) (window as any).hideAllMenus();
    },

    /**
     * 打开组颜色选择器（预留，当前无菜单入口）
     * @param groupId
     */
    openColorPicker(groupId: string): void {
        const existing = document.getElementById('group-color-picker');
        if (existing) existing.remove();

        const group = GroupManager.getGroup(groupId);
        if (!group) return;

        // ── 遮罩层 ──
        const overlay = document.createElement('div');
        overlay.className = 'group-color-overlay';

        // ── 弹窗主体 ──
        const picker = document.createElement('div');
        picker.id = 'group-color-picker';
        picker.className = 'group-color-picker';

        const presets = GroupManager.PRESET_COLORS;

        picker.innerHTML = `
            <div class="group-color-picker__header">
                <i class="fas fa-palette"></i>
                <span>选择分组颜色</span>
            </div>
            <div class="group-color-picker__swatches">
                ${presets.map((c, i) => `
                    <button class="group-color-swatch ${group.colorIndex === i ? 'is-active' : ''}"
                            data-color-index="${i}"
                            data-color="${c.border}"
                            title="${c.name}"
                            aria-label="选择颜色 ${c.name}">
                        <span class="group-color-swatch__inner" style="background:${c.border}"></span>
                    </button>
                `).join('')}
            </div>
            <div class="group-color-picker__footer">
                <button class="group-color-cancel">取消</button>
            </div>
        `;

        overlay.addEventListener('click', close);
        (picker.querySelector('.group-color-cancel') as HTMLElement).addEventListener('click', close);

        // 色块点击
        picker.querySelectorAll('.group-color-swatch').forEach(btn => {
            btn.addEventListener('click', () => {
                const colorIndex = parseInt((btn as HTMLElement).dataset.colorIndex!, 10);
                GroupManager.setGroupColor(groupId, colorIndex);
                close();
                if ((window as any).CmdManager) {
                    CmdManager.execute(new GroupPropertyCommand(
                        groupId, 'colorIndex', colorIndex,
                        (GroupManager.getGroup(groupId)?.colorIndex ?? 0)
                    ));
                }
            });
        });

        // ESC 关闭
        const escHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') close();
        };
        window.addEventListener('keydown', escHandler);

        function close(): void {
            picker.remove();
            overlay.remove();
            window.removeEventListener('keydown', escHandler);
        }

        document.body.appendChild(overlay);
        document.body.appendChild(picker);
    }
};

(window as unknown as Record<string, unknown>).GroupActions = GroupActions;
