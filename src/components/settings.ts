// src/components/settings.ts
// 设置面板：打开/关闭、Tab 切换、存储路径管理

import { AppState } from '../state/app-state';
import { API } from '../utils/api';
import { FormInput } from '../ui/form-input';

declare const ProviderPanel: {
    renderList(): Promise<void>;
    openAddDialog(): void;
    closeAddDialog(): void;
    confirmAdd(): void;
    deleteCurrent(): void;
    closeDetail(): void;
    _renderFilteredList(list: unknown[]): void;
    switchTab?(tab: string): void;
};

declare const Toast: { show(message: string, duration?: number): void };

export const SettingsPanel = {
    _storageForm: null as { pathInput: { setValue: (v: string) => void } } | null,

    async open(): Promise<void> {
        const modal = document.getElementById('settings-modal') as HTMLElement;
        if (modal) modal.style.display = 'flex';

        this._renderSearchInput();
        await this._renderStorageForm();
        await ProviderPanel.renderList();
    },

    _renderSearchInput(): void {
        const wrap = document.getElementById('provider-search-wrap');
        if (!wrap || wrap.childElementCount > 0) return;

        const searchInput = FormInput({
            placeholder: '搜索...',
            width: '120px',
            onChange: (val: string) => {
                const kw = val.trim().toLowerCase();
                const filtered = AppState.providers.list.filter(p =>
                    p.name.toLowerCase().includes(kw)
                );
                ProviderPanel._renderFilteredList(filtered);
            },
        });
        const inputEl = searchInput.element.querySelector('input');
        if (inputEl) {
            inputEl.id = 'provider-search';
            inputEl.style.fontSize = 'var(--text-xs)';
        }
        wrap.appendChild(searchInput.element);
    },

    async _renderStorageForm(): Promise<void> {
        const wrap = document.getElementById('storage-settings-form');
        if (!wrap) return;
        wrap.innerHTML = '';

        let savePath = '';
        try {
            const result = await API.loadSettings() as { image_save_path?: string };
            if (result && result.image_save_path) {
                savePath = result.image_save_path;
            }
        } catch (e) {
            console.warn('加载设置失败', e);
        }

        const pathInput = FormInput({
            label: '图片自动保存位置',
            placeholder: '点击右侧按钮选择文件夹',
            readonly: true,
            value: savePath,
            hint: '生成的图片会自动保存到此文件夹（留空则不自动保存）',
            actions: [
                { icon: 'fas fa-folder-open', title: '选择文件夹', onClick: async () => {
                    try {
                        const result = await API.selectFolder() as { path?: string };
                        if (result && result.path) {
                            pathInput.setValue(result.path);
                            await this._savePath(result.path);
                        }
                    } catch (e) {
                        Toast.show('选择文件夹失败');
                    }
                }},
                { icon: 'fas fa-times', title: '清除', onClick: async () => {
                    pathInput.setValue('');
                    await this._savePath('');
                    Toast.show('已清除保存路径');
                }},
            ],
        });
        const inputEl = pathInput.element.querySelector('input');
        if (inputEl) inputEl.id = 'image-save-path';
        wrap.appendChild(pathInput.element);

        this._storageForm = { pathInput };
    },

    close(): void {
        const modal = document.getElementById('settings-modal');
        if (modal) modal.style.display = 'none';
    },

    switchTab(tab: string): void {
        document.querySelectorAll('.settings-tab').forEach(btn => {
            btn.classList.remove('active');
        });
        // 激活当前 tab
        const activeTab = document.querySelector(`.settings-tab[data-tab="${tab}"]`);
        if (activeTab) activeTab.classList.add('active');

        document.querySelectorAll('.settings-tab-content').forEach(el => {
            (el as HTMLElement).style.display = 'none';
            el.classList.remove('active');
        });

        const target = document.getElementById(`settings-tab-${tab}`);
        if (target) {
            target.style.display = 'block';
            target.classList.add('active');
        }
    },

    async selectSavePath(): Promise<void> {
        try {
            const result = await API.selectFolder() as { path?: string };
            if (result && result.path) {
                if (this._storageForm?.pathInput) {
                    this._storageForm.pathInput.setValue(result.path);
                }
                await this._savePath(result.path);
            }
        } catch (e) {
            Toast.show('选择文件夹失败');
        }
    },

    async clearSavePath(): Promise<void> {
        if (this._storageForm?.pathInput) {
            this._storageForm.pathInput.setValue('');
        }
        await this._savePath('');
        Toast.show('已清除保存路径');
    },

    async _savePath(path: string): Promise<void> {
        try {
            await API.saveSettings({ image_save_path: path });
        } catch (e) {
            Toast.show('保存设置失败');
        }
    }
};

// 桥接到 window
(window as unknown as Record<string, unknown>).SettingsPanel = SettingsPanel;
