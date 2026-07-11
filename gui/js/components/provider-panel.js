// gui/js/components/provider-panel.js

const ProviderPanel = {

    /** 当前选中的供应商类型（供 confirmAdd 读取） */
    _selectedProviderType: 'OpenAI',

    /** 设置列表图标：简称首字，无简称则用名称首字（支持中文等多字节字符） */
    _listIconChar(p) {
        const raw = (p.short_name && String(p.short_name).trim())
            || (p.name && String(p.name).trim())
            || '';
        if (!raw) return '?';
        const first = [...raw][0];
        return first || '?';
    },

    _emitProvidersUpdated() {
        window.dispatchEvent(new CustomEvent('providers:updated'));
    },

    /** 加载并渲染供应商列表 */
    async renderList() {
        const listEl = document.getElementById('provider-list');
        if (!listEl) return;

        listEl.innerHTML =
            '<div style="padding:12px;color:var(--text-tertiary);' +
            'text-align:center;font-size:13px;">加载中...</div>';

        const result = await ProviderService.loadProviders();
        if (result && result.status !== 'success' && !result.providers) {
            listEl.innerHTML =
                '<div style="padding:12px;color:var(--apple-red);' +
                'text-align:center;font-size:13px;">加载失败</div>';
            return;
        }

        this._renderFilteredList(AppState.providers.list);
        this._emitProvidersUpdated();

        const searchInput = document.getElementById('provider-search');
        if (searchInput) {
            searchInput.oninput = () => {
                const kw       = searchInput.value.trim().toLowerCase();
                const filtered = AppState.providers.list.filter(p =>
                    p.name.toLowerCase().includes(kw)
                );
                this._renderFilteredList(filtered);
            };
        }
    },

    _renderFilteredList(providers) {
        const listEl = document.getElementById('provider-list');
        if (!listEl) return;

        if (providers.length === 0) {
            listEl.innerHTML =
                '<div style="padding:16px;color:var(--text-tertiary);' +
                'text-align:center;font-size:13px;">暂无供应商，点击下方按钮添加</div>';
            return;
        }

        listEl.innerHTML = '';
        providers.forEach(p => {
            const item = Dom.create('div', { className: 'provider-item' });

            const icon = Dom.create('div', { className: 'provider-icon' });
            icon.textContent = this._listIconChar(p);

            const models    = p.models || [];
            const chatCount = models.filter(m => m.type === 'chat').length;
            const drawCount = models.filter(m => m.type === 'drawing').length;

            let metaParts = [p.type];
            if (chatCount > 0) metaParts.push(`${chatCount} 对话`);
            if (drawCount > 0) metaParts.push(`${drawCount} 绘图`);
            if (chatCount === 0 && drawCount === 0 && models.length > 0) {
                metaParts.push(`${models.length} 个模型`);
            }

            const info = Dom.create('div', { className: 'provider-info' });
            info.innerHTML = `
                <div class="provider-name">${p.name}</div>
                <div class="provider-meta">${metaParts.join(' · ')}</div>
            `;

            const status = Dom.create('div', {
                className: `provider-status ${p.enabled ? 'enabled' : 'disabled'}`
            });
            status.title = p.enabled ? '已启用' : '已禁用';

            item.appendChild(icon);
            item.appendChild(info);
            item.appendChild(status);
            item.addEventListener('click', () => this.openDetail(p.id));
            listEl.appendChild(item);
        });
    },

    /** 从字符串取首字（支持中文等多字节字符） */
    _firstChar(str) {
        const raw = str && String(str).trim() || '';
        if (!raw) return '?';
        return [...raw][0] || '?';
    },

    /** 同步设置图标首字 */
    _syncIcon(iconId, shortName, name) {
        const el = document.getElementById(iconId);
        if (el) el.textContent = this._firstChar(shortName || name);
    },

    openAddDialog() {
        // ── 用 UI 组件动态生成表单 ──
        const formWrap = document.getElementById('add-provider-form');
        if (formWrap) {
            formWrap.innerHTML = '';

            const nameInput = UIInput({
                label: '提供商名称',
                placeholder: '例如：我的Gemini中转站',
                onChange: () => {
                    this._syncIcon('add-provider-icon', shortInput.value, nameInput.value);
                },
            });
            nameInput.input.id = 'new-provider-name';
            formWrap.appendChild(nameInput.element);

            const shortInput = UIInput({
                label: '简称',
                labelHint: '（显示在模型选择菜单里，建议 6 字以内）',
                placeholder: '例如：Gemini',
                maxLength: 10,
                onChange: () => {
                    this._syncIcon('add-provider-icon', shortInput.value, nameInput.value);
                },
            });
            shortInput.input.id = 'new-provider-short-name';
            formWrap.appendChild(shortInput.element);

            const typeSelect = UISelect({
                label: '提供商类型',
                options: [
                    { value: 'OpenAI', label: 'OpenAI' },
                    { value: 'OpenAI-Response', label: 'OpenAI-Response' },
                    { value: 'Gemini', label: 'Gemini' },
                    { value: 'Anthropic', label: 'Anthropic' },
                    { value: 'Azure OpenAI', label: 'Azure OpenAI' },
                    { value: 'New API', label: 'New API' },
                    { value: 'CherryIN', label: 'CherryIN' },
                    { value: 'Ollama', label: 'Ollama' },
                ],
                value: 'OpenAI',
                onChange: (val) => { this._selectedProviderType = val; },
            });
            formWrap.appendChild(typeSelect.element);

            this._addDialogRefs = { nameInput, shortInput, typeSelect };
        }

        this._selectedProviderType = 'OpenAI';
        this._syncIcon('add-provider-icon', '', 'P');

        document.getElementById('add-provider-modal').style.display = 'flex';
    },

    closeAddDialog() {
        const shortInput = document.getElementById('new-provider-short-name');
        if (this._addIconHandler) {
            shortInput.removeEventListener('input', this._addIconHandler);
            this._addIconHandler = null;
        }
        if (this._providerTypeHandler) {
            document.removeEventListener('click', this._providerTypeHandler);
            this._providerTypeHandler = null;
        }
        document.getElementById('add-provider-modal').style.display = 'none';
    },

    /** 确认添加供应商 */
    async confirmAdd() {
        const refs = this._addDialogRefs;
        const name      = refs ? refs.nameInput.value.trim() : '';
        const shortName = refs ? refs.shortInput.value.trim() : '';
        const type      = this._selectedProviderType;

        if (!name) {
            Toast.show('请输入供应商名称');
            return;
        }

        const result = await ProviderService.addProvider(name, type, shortName);
        if (result.status === 'success') {
            this.closeAddDialog();
            await this.renderList();
            this._emitProvidersUpdated();
            Toast.show('添加成功');
            if (result.provider_id) {
                this.openDetail(result.provider_id);
            }
        } else {
            Toast.show('添加失败: ' + (result.message || '未知错误'));
        }
    },

    openDetail(providerId) {
        const provider = AppState.providers.list.find(p => p.id === providerId);
        if (!provider) return;

        AppState.providers.currentId = providerId;

        document.getElementById('provider-detail-title').textContent = provider.name;
        this._syncIcon('detail-provider-icon', provider.short_name, provider.name);

        // ── 启用开关（头部） ──
        const enabledWrap = document.getElementById('detail-enabled-wrap');
        enabledWrap.innerHTML = '';
        const enabledSwitch = UISwitch({
            value: !!provider.enabled,
            onChange: () => this.toggle(),
        });
        enabledSwitch.element.id = 'detail-enabled-switch';
        enabledWrap.appendChild(enabledSwitch.element);

        // ── 内容区用组件生成 ──
        const contentEl = document.getElementById('provider-detail-content');
        contentEl.innerHTML = '';

        const shortInput = UIInput({
            label: '简称',
            labelHint: '（显示在模型选择菜单里）',
            placeholder: '建议 6 字以内',
            maxLength: 10,
            value: provider.short_name || '',
            onChange: () => {
                this._syncIcon('detail-provider-icon', shortInput.value, provider.name);
            },
        });
        contentEl.appendChild(shortInput.element);

        const apiKeyInput = UIInput({
            label: 'API 密钥',
            type: 'password',
            placeholder: '输入你的 API 密钥',
            hint: '多个密钥使用逗号分隔',
            value: provider.api_key || '',
            actions: [
                { icon: 'fas fa-eye', title: '显示/隐藏', onClick: () => {
                    const inp = apiKeyInput.input;
                    const isHidden = inp.type === 'password';
                    inp.type = isHidden ? 'text' : 'password';
                }},
                { icon: 'fas fa-check', title: '测试连接', onClick: () => this.testConnection() },
            ],
        });
        contentEl.appendChild(apiKeyInput.element);

        const apiUrlInput = UIInput({
            label: 'API 地址',
            placeholder: 'https://api.example.com',
            hint: '示例：https://api.openai.com/v1',
            value: provider.api_url || '',
            actions: [
                { icon: 'fas fa-copy', title: '复制', onClick: () => {
                    if (apiUrlInput.value) {
                        navigator.clipboard.writeText(apiUrlInput.value)
                            .then(() => Toast.show('已复制'))
                            .catch(() => Toast.show('复制失败'));
                    }
                }},
            ],
        });
        contentEl.appendChild(apiUrlInput.element);

        const proxySwitch = UISwitch({
            label: '使用代理',
            hint: '关闭后请求将绕过系统代理直连（适合国内中转平台）',
            value: provider.use_proxy !== false,
            onChange: () => this.toggle(),
        });
        contentEl.appendChild(proxySwitch.element);

        // 模型区域
        const modelGroup = document.createElement('div');
        modelGroup.className = 'form-group';
        const modelLabel = document.createElement('label');
        modelLabel.innerHTML = '模型 <span class="model-count" id="provider-model-count">0</span>';
        modelGroup.appendChild(modelLabel);
        const modelList = document.createElement('div');
        modelList.id = 'provider-model-list';
        modelList.className = 'model-list';
        modelGroup.appendChild(modelList);
        const modelActions = document.createElement('div');
        modelActions.className = 'model-actions';
        modelActions.innerHTML = '<button class="btn-secondary" onclick="ModelPanel.open()"><i class="fas fa-list"></i> 管理</button>' +
                                 '<button class="btn-secondary" onclick="ModelPanel.refresh()"><i class="fas fa-sync-alt"></i> 刷新</button>';
        modelGroup.appendChild(modelActions);
        contentEl.appendChild(modelGroup);

        // 保存引用供 _saveCurrentProvider 使用
        this._detailRefs = { shortInput, apiKeyInput, apiUrlInput, enabledSwitch, proxySwitch };

        this._renderModelList(provider.models || []);
        document.getElementById('provider-detail-modal').style.display = 'flex';
    },

    closeDetail() {
        this._saveCurrentProvider();
        document.getElementById('provider-detail-modal').style.display = 'none';
        AppState.providers.currentId = null;
    },

    _renderModelList(models) {
        const listEl  = document.getElementById('provider-model-list');
        const countEl = document.getElementById('provider-model-count');
        if (!listEl) return;

        if (countEl) countEl.textContent = models.length;
        listEl.innerHTML = '';

        if (models.length === 0) {
            listEl.innerHTML =
                '<div style="color:var(--text-tertiary);font-size:12.5px;' +
                'padding:10px 0;text-align:center;">暂无模型</div>';
            return;
        }

        const preview = models.slice(0, 6);
        preview.forEach(m => {
            const row   = Dom.create('div', { className: 'model-row' });
            const badge = Dom.create('span', {
                className: `model-type-badge ${m.type === 'chat' ? 'chat' : 'drawing'}`
            }, m.type === 'chat' ? '对话' : '绘图');
            const nameEl = Dom.create('span', { className: 'model-row-name' },
                m.name || m.id
            );
            row.appendChild(badge);
            row.appendChild(nameEl);
            listEl.appendChild(row);
        });

        if (models.length > 6) {
            const more = Dom.create('div', {
                style: 'color:var(--text-tertiary);font-size:12px;' +
                       'padding:5px 0 2px;text-align:center;'
            }, `还有 ${models.length - 6} 个模型...`);
            listEl.appendChild(more);
        }
    },

    /** 保存当前编辑的供应商（从组件读取数据，调用 service） */
    async _saveCurrentProvider() {
        const id = AppState.providers.currentId;
        if (!id) return;

        const refs = this._detailRefs;
        if (!refs) return;

        const updates = {
            short_name: refs.shortInput.value.trim(),
            api_key:    refs.apiKeyInput.value,
            api_url:    refs.apiUrlInput.value,
            enabled:    refs.enabledSwitch.value,
            use_proxy:  refs.proxySwitch.value,
        };

        await ProviderService.updateProvider(id, updates);
        await this.renderList();
        this._emitProvidersUpdated();
    },

    async toggle() {
        await this._saveCurrentProvider();
    },

    /** 测试连接（从组件读取数据，调用 service） */
    async testConnection() {
        const refs = this._detailRefs;
        if (!refs) return;

        const apiUrl = refs.apiUrlInput.value.trim();
        const apiKey = refs.apiKeyInput.value.trim();

        if (!apiUrl || !apiKey) {
            Toast.show('请先填写 API 地址和密钥');
            return;
        }

        try {
            const result = await ProviderService.testConnection(apiUrl, apiKey);
            Toast.show(result.success ? '连接成功' : (result.message || '连接失败'));
        } catch (e) {
            Toast.show('测试失败: ' + (e.message || '未知错误'));
        }
    },

    toggleKeyVisibility() {
        // 保留兼容性，但实际功能已在 apiKeyInput 的 actions 中处理
    },

    copyApiUrl() {
        // 保留兼容性，但实际功能已在 apiUrlInput 的 actions 中处理
    },

    /** 删除当前供应商 */
    async deleteCurrent() {
        const id = AppState.providers.currentId;
        if (!id) return;

        const p = AppState.providers.list.find(p => p.id === id);
        if (!confirm(`确定删除供应商「${p?.name}」吗？`)) return;

        const result = await ProviderService.deleteProvider(id);
        if (result && result.status === 'success') {
            this.closeDetail();
            await this.renderList();
            this._emitProvidersUpdated();
            Toast.show('已删除');
        } else {
            Toast.show('删除失败: ' + (result.message || '未知错误'));
        }
    }
};

window.ProviderPanel = ProviderPanel;
