// gui/js/components/model-panel.js
// UI组件版：toggle 使用 UISwitch，输入框使用 UIInput

const ModelPanel = {

    _emitProvidersUpdated() {
        window.dispatchEvent(new CustomEvent('providers:updated'));
    },

    // ─────────────────────────────────────────
    // 打开 / 关闭
    // ─────────────────────────────────────────
    open() {
        const providerId = AppState.providers.currentId;
        if (!providerId) return;

        const provider = AppState.providers.list.find(p => p.id === providerId);
        if (!provider) return;

        document.getElementById('model-manager-title').textContent =
            `${provider.name} · 模型管理`;
        document.getElementById('model-manager-modal').style.display = 'flex';

        this._renderCategories(provider.models || []);
    },

    close() {
        this._hideAddForm();
        document.getElementById('model-manager-modal').style.display = 'none';
    },

    // ─────────────────────────────────────────
    // 拉取绘图模型（刷新按钮）
    // ─────────────────────────────────────────
    async refresh() {
        const providerId = AppState.providers.currentId;
        if (!providerId) return;

        const provider = AppState.providers.list.find(p => p.id === providerId);
        if (!provider) return;

        Toast.show('正在拉取模型列表...');

        const result = await ModelService.fetchDrawingModels(providerId);

        if (result.status !== 'success') {
            Toast.show('拉取失败: ' + (result.message || ''));
            return;
        }

        ProviderPanel._renderModelList(result.models);
        this._renderCategories(result.models);
        this._emitProvidersUpdated();

        Toast.show(
            `已加载 ${result.drawCount} 个绘图模型，` +
            `保留 ${result.chatCount} 个对话模型`
        );
    },

    // ─────────────────────────────────────────
    // 渲染分类列表
    // ─────────────────────────────────────────
    _renderCategories(models) {
        const container = document.getElementById('model-categories');
        if (!container) return;

        container.innerHTML = '';

        const chatModels    = models.filter(m => m.type === 'chat');
        const drawingModels = models.filter(m => m.type === 'drawing');
        const otherModels   = models.filter(
            m => m.type !== 'chat' && m.type !== 'drawing'
        );

        if (models.length === 0) {
            container.innerHTML =
                '<div style="padding:32px;color:var(--text-tertiary);' +
                'text-align:center;font-size:13px;">' +
                '暂无模型<br>' +
                '<span style="font-size:12px;margin-top:6px;display:block;">' +
                '点击「刷新」拉取绘图模型，或手动添加对话模型</span></div>';
            return;
        }

        if (chatModels.length > 0 || true) {
            container.appendChild(
                this._buildSection('chat', '💬 对话模型', chatModels, true)
            );
        }

        if (drawingModels.length > 0) {
            container.appendChild(
                this._buildSection('drawing', '🎨 绘图模型', drawingModels, false)
            );
        }

        if (otherModels.length > 0) {
            container.appendChild(
                this._buildSection('other', '📦 其他模型', otherModels, false)
            );
        }
    },

    // ─────────────────────────────────────────
    // 构建单个分组 section
    // ─────────────────────────────────────────
    _buildSection(type, label, models, showAddBtn) {
        const section = Dom.create('div', { className: 'model-category-section' });

        // ── section header ──
        const header = Dom.create('div', { className: 'model-category-header' });

        const titleWrap = Dom.create('div', { className: 'model-category-title' });
        titleWrap.innerHTML = `
            <span class="model-category-label">${label}</span>
            <span class="category-count">${models.length}</span>
        `;

        header.appendChild(titleWrap);

        if (showAddBtn) {
            const addBtn = Dom.create('button', {
                className: 'add-model-btn',
                title:     '手动添加对话模型'
            }, '＋');
            addBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._toggleAddForm(section, type);
            });
            header.appendChild(addBtn);
        }

        section.appendChild(header);

        // ── 添加表单占位容器（默认隐藏） ──
        const formWrap = Dom.create('div', {
            className: 'add-chat-model-form-wrap',
            style:     'display:none;'
        });
        section.appendChild(formWrap);

        // ── 模型条目列表 ──
        if (models.length === 0 && type === 'chat') {
            const empty = Dom.create('div', {
                className: 'model-category-empty'
            }, '还没有对话模型，点击 ＋ 手动添加');
            section.appendChild(empty);
        }

        models.forEach(m => {
            section.appendChild(this._buildModelRow(m));
        });

        return section;
    },

    // ─────────────────────────────────────────
    // 构建单条模型行
    // ─────────────────────────────────────────
    _buildModelRow(m) {
        const providerId = AppState.providers.currentId;
        const row        = Dom.create('div', { className: 'model-manager-row' });

        const badge = Dom.create('span', {
            className: `model-type-badge ${m.type === 'chat' ? 'chat' : 'drawing'}`
        }, m.type === 'chat' ? '对话' : '绘图');

        const nameEl = Dom.create('span', { className: 'model-manager-name' },
            m.name || m.id
        );

        const idEl = Dom.create('span', { className: 'model-manager-id' },
            m.name && m.name !== m.id ? m.id : ''
        );

        const infoWrap = Dom.create('div', { className: 'model-manager-info' });
        infoWrap.appendChild(nameEl);
        if (idEl.textContent) infoWrap.appendChild(idEl);

        // 启用 Toggle
        const switchComp = UISwitch({
            label: '',
            value: m.enabled !== false,
            onChange: async (checked) => {
                await ModelService.updateModelEnabled(providerId, m.id, checked);
                ProviderPanel._renderModelList(
                    AppState.providers.list.find(p => p.id === providerId)?.models || []
                );
                this._emitProvidersUpdated();
            }
        });
        const toggle = switchComp.element;

        // 删除按钮（对话模型才显示）
        const actions = Dom.create('div', { className: 'model-manager-row-actions' });
        if (m.type === 'chat') {
            const delBtn = Dom.create('button', {
                className: 'remove-model-btn',
                title:     '删除此模型'
            });
            delBtn.innerHTML = '<i class="fas fa-times"></i>';
            delBtn.addEventListener('click', async () => {
                if (!confirm(`确定删除模型「${m.name || m.id}」吗？`)) return;
                const result = await ModelService.removeModel(providerId, m.id);
                if (result && result.status === 'success') {
                    const provider = AppState.providers.list.find(
                        p => p.id === providerId
                    );
                    if (provider) {
                        this._renderCategories(provider.models);
                        ProviderPanel._renderModelList(provider.models);
                        this._emitProvidersUpdated();
                    }
                    Toast.show('已删除');
                } else {
                    Toast.show('删除失败: ' + (result.message || ''));
                }
            });
            actions.appendChild(toggle);
            actions.appendChild(delBtn);
        } else {
            actions.appendChild(toggle);
        }

        row.appendChild(badge);
        row.appendChild(infoWrap);
        row.appendChild(actions);

        return row;
    },

    // ─────────────────────────────────────────
    // 展开 / 收起添加表单
    // ─────────────────────────────────────────
    _toggleAddForm(section, type) {
        const formWrap = section.querySelector('.add-chat-model-form-wrap');
        if (!formWrap) return;

        const isVisible = formWrap.style.display !== 'none';
        if (isVisible) {
            this._hideAddForm();
            return;
        }

        this._hideAddForm();

        formWrap.style.display = 'block';
        formWrap.innerHTML     = '';

        const form = Dom.create('div', { className: 'add-chat-model-form' });

        const idInputComp = UIInput({
            placeholder: '模型 ID，例如：gemini-3.1-pro-preview',
            onEnter: () => this._confirmAddChatModel(idInputComp, nameInputComp)
        });
        idInputComp.input.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this._hideAddForm();
        });

        const nameInputComp = UIInput({
            placeholder: '显示名称，例如：Gemini 3.1 Pro（留空则同 ID）',
            onEnter: () => this._confirmAddChatModel(idInputComp, nameInputComp)
        });
        nameInputComp.input.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this._hideAddForm();
        });

        const actionsRow = Dom.create('div', {
            className: 'add-chat-model-form-actions'
        });

        const cancelBtn = Dom.create('button', { className: 'btn-cancel' }, '取消');
        cancelBtn.addEventListener('click', () => this._hideAddForm());

        const confirmBtn = Dom.create('button', { className: 'btn-confirm' }, '添加');
        confirmBtn.addEventListener('click', () =>
            this._confirmAddChatModel(idInputComp, nameInputComp)
        );

        actionsRow.appendChild(cancelBtn);
        actionsRow.appendChild(confirmBtn);

        form.appendChild(idInputComp.element);
        form.appendChild(nameInputComp.element);
        form.appendChild(actionsRow);
        formWrap.appendChild(form);

        setTimeout(() => idInputComp.focus(), 60);
    },

    _hideAddForm() {
        document.querySelectorAll('.add-chat-model-form-wrap').forEach(el => {
            el.style.display = 'none';
            el.innerHTML     = '';
        });
    },

    // ─────────────────────────────────────────
    // 确认添加对话模型
    // ─────────────────────────────────────────
    async _confirmAddChatModel(idInput, nameInput) {
        const modelId   = idInput.value.trim();
        const modelName = nameInput.value.trim() || modelId;

        if (!modelId) {
            Toast.show('请输入模型 ID');
            idInput.focus();
            return;
        }

        const providerId = AppState.providers.currentId;
        if (!providerId) return;

        const confirmBtn = document.querySelector(
            '.add-chat-model-form .btn-confirm'
        );
        if (confirmBtn) {
            confirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
            confirmBtn.disabled  = true;
        }

        try {
            const result = await ModelService.addChatModel(providerId, modelId, modelName);

            if (result.status === 'success') {
                this._hideAddForm();
                const provider = AppState.providers.list.find(
                    p => p.id === providerId
                );
                if (provider) {
                    this._renderCategories(provider.models);
                    ProviderPanel._renderModelList(provider.models);
                    this._emitProvidersUpdated();
                }
                Toast.show(`已添加：${modelName}`);
            } else {
                Toast.show('添加失败: ' + (result.message || ''));
                if (confirmBtn) {
                    confirmBtn.innerHTML = '添加';
                    confirmBtn.disabled  = false;
                }
            }
        } catch (e) {
            Toast.show('添加失败');
            if (confirmBtn) {
                confirmBtn.innerHTML = '添加';
                confirmBtn.disabled  = false;
            }
        }
    }
};

window.ModelPanel = ModelPanel;
