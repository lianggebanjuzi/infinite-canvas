// gui/js/components/settings.js
// 设置面板：打开/关闭、Tab 切换、存储路径管理

const SettingsPanel = {

    _storageForm: null,

    // ─────────────────────────────────────────
    // 打开设置面板
    // ─────────────────────────────────────────
    async open() {
        const modal = document.getElementById('settings-modal');
        modal.style.display = 'flex';

        // 用组件生成搜索框
        this._renderSearchInput();

        // 用组件生成存储设置表单
        await this._renderStorageForm();

        // 渲染供应商列表
        await ProviderPanel.renderList();
    },

    _renderSearchInput() {
        const wrap = document.getElementById('provider-search-wrap');
        if (!wrap || wrap.childElementCount > 0) return;

        const searchInput = UIInput({
            placeholder: '搜索...',
            width: '120px',
            onChange: (val) => {
                const kw = val.trim().toLowerCase();
                const filtered = AppState.providers.list.filter(p =>
                    p.name.toLowerCase().includes(kw)
                );
                ProviderPanel._renderFilteredList(filtered);
            },
        });
        searchInput.input.id = 'provider-search';
        searchInput.input.style.fontSize = 'var(--text-xs)';
        wrap.appendChild(searchInput.element);
    },

    async _renderStorageForm() {
        const wrap = document.getElementById('storage-settings-form');
        if (!wrap) return;
        wrap.innerHTML = '';

        let savePath = '';
        try {
            const result = await API.loadSettings();
            if (result && result.image_save_path) {
                savePath = result.image_save_path;
            }
        } catch (e) {
            console.warn('加载设置失败', e);
        }

        const pathInput = UIInput({
            label: '图片自动保存位置',
            placeholder: '点击右侧按钮选择文件夹',
            readonly: true,
            value: savePath,
            hint: '生成的图片会自动保存到此文件夹（留空则不自动保存）',
            actions: [
                { icon: 'fas fa-folder-open', title: '选择文件夹', onClick: async () => {
                    try {
                        const result = await API.selectFolder();
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
        pathInput.input.id = 'image-save-path';
        wrap.appendChild(pathInput.element);

        this._storageForm = { pathInput };
    },

    // ─────────────────────────────────────────
    // 关闭设置面板
    // ─────────────────────────────────────────
    close() {
        document.getElementById('settings-modal').style.display = 'none';
    },

    // ─────────────────────────────────────────
    // 切换 Tab
    // ─────────────────────────────────────────
    switchTab(tab) {
        // 切换按钮状态
        document.querySelectorAll('.settings-tab').forEach(btn => {
            btn.classList.remove('active');
        });
        event.currentTarget.classList.add('active');

        // 切换内容区
        document.querySelectorAll('.settings-tab-content').forEach(el => {
            el.style.display = 'none';
            el.classList.remove('active');
        });

        const target = document.getElementById(`settings-tab-${tab}`);
        if (target) {
            target.style.display = 'block';
            target.classList.add('active');
        }
    },

    // ─────────────────────────────────────────
    // 图片保存路径（保留兼容）
    // ─────────────────────────────────────────
    async selectSavePath() {
        try {
            const result = await API.selectFolder();
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

    async clearSavePath() {
        if (this._storageForm?.pathInput) {
            this._storageForm.pathInput.setValue('');
        }
        await this._savePath('');
        Toast.show('已清除保存路径');
    },

    async _savePath(path) {
        try {
            await API.saveSettings({ image_save_path: path });
        } catch (e) {
            Toast.show('保存设置失败');
        }
    }
};

window.SettingsPanel = SettingsPanel;
