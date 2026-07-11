// gui/js/cards/AgentCard.js
// UI组件版：meta-prompt 和 user-input 使用 UITextarea

class AgentCard extends BaseCard {

    constructor(options = {}) {
        super({
            width:    '460px',
            height:   '520px',
            minWidth:  360,
            minHeight: 420,
            title:    'Agent',
            ...options
        });

        const w = parseFloat(String(this.width));
        const h = parseFloat(String(this.height));
        if (!isNaN(w) && w < this.minWidth) this.width = this.minWidth + 'px';
        if (!isNaN(h) && h < this.minHeight) this.height = this.minHeight + 'px';

        this.agentConfig = {
            model:      '',
            metaPrompt: '',
            userInput:  '',
            output:     '',
            ...(options.agentConfig || {})
        };

        if (options.content) {
            try {
                const parsed = JSON.parse(options.content);
                this.agentConfig = { ...this.agentConfig, ...parsed };
            } catch {}
        }

        if (!this.agentConfig.model) {
            this.agentConfig.model = localStorage.getItem('agent_last_model') || '';
        }

        this._running      = false;
        this._chatModels   = [];
        this._providersSub = () => { this._populateModelSelect(); };
    }

    getType() { return 'agent'; }

    // ─────────────────────────────────────────
    // 契约声明
    // ─────────────────────────────────────────
    static getContract() {
        return {
            outputs: [{
                name:      'default',
                type:      'text',
                notifyOn:  'onRun'
            }],
            inputs: [
                {
                    name:           'prompt',
                    type:           'text',
                    multiple:       true,
                    receivePolicy:  'append'
                },
                {
                    name:           'reference',
                    type:           'image',
                    multiple:       true,
                    receivePolicy:  'append'
                }
            ]
        };
    }

    getOutput(outputName = 'default') {
        if (outputName === 'default') {
            return this.agentConfig.output || '';
        }
        return null;
    }

    // ─────────────────────────────────────────
    // 根据契约获取输入数据
    // ─────────────────────────────────────────
    getInput(inputName) {
        if (inputName === 'prompt') {
            return DataSource.getUpstreamText(this.id)
                .map(t => t.data).filter(Boolean);
        }
        if (inputName === 'reference') {
            return DataSource.getUpstreamImage(this.id)
                .map(i => i.data).filter(Boolean);
        }
        return null;
    }

    // ─────────────────────────────────────────
    // 内容渲染（无内联事件处理器）
    // ─────────────────────────────────────────
    renderContent() {
        const cfg = this.agentConfig;
        const container = document.createElement('div');
        container.style.cssText = 'display:flex;flex-direction:column;flex:1;overflow:hidden;';
        container.innerHTML = `
            <div class="agent-section">
                <div class="agent-section-header">
                    <span class="agent-section-label">Meta Prompt</span>
                    <div class="agent-model-select-wrap">
                        <button class="agent-model-btn" data-action="model">
                            选择模型
                        </button>
                    </div>
                </div>
                <div class="agent-meta-prompt-wrap">
                    <div data-replace="metaPrompt"></div>
                    <div class="agent-meta-actions">
                        <button class="agent-lib-btn" data-action="libCommon">
                            <i class="fas fa-book-open" style="font-size:10px;margin-right:3px;"></i>
                            常用提示词库
                        </button>
                        <button class="agent-lib-btn" data-action="libSkill">
                            <i class="fas fa-bolt" style="font-size:10px;margin-right:3px;"></i>
                            Skill 库
                        </button>
                    </div>
                </div>
            </div>

            <div class="agent-section">
                <div class="agent-section-header">
                    <span class="agent-section-label">用户需求</span>
                </div>
                <div class="agent-user-input-wrap">
                    <div data-replace="userInput"></div>
                    <div class="agent-upstream-hint" id="agent-upstream-hint-${this.id}">
                        <i class="fas fa-link"></i>
                        <span id="agent-upstream-hint-text-${this.id}">
                            已连接上游内容，执行时将自动拼接
                        </span>
                    </div>
                    <div class="agent-upstream-preview" id="agent-upstream-preview-${this.id}"></div>
                </div>
            </div>

            <div class="agent-output-section">
                <div class="agent-section-header">
                    <span class="agent-section-label">输出内容</span>
                </div>
                <div class="agent-output-wrap" id="agent-output-wrap-${this.id}">
                    ${cfg.output
                        ? `<div class="agent-output-text">${this._escapeHtml(cfg.output)}</div>`
                        : `<div class="agent-output-placeholder">
                               # 输出执行后的文字内容，<br>
                               # 每次执行后新结果覆盖旧的结果
                           </div>`
                    }
                </div>
            </div>

            <div class="agent-footer">
                <button class="agent-run-btn" data-action="run">
                    <i class="fas fa-play"></i> 运行
                </button>
                <button class="agent-copy-btn" data-action="copy" title="复制输出内容">
                    <i class="fas fa-copy"></i>
                </button>
            </div>
        `;

        // Meta Prompt — UITextarea
        this._metaPromptComp = window.UITextarea({
            placeholder: '输入元提示词...（设定身份、风格等）',
            value: cfg.metaPrompt || '',
            rows: 3,
        });
        this._metaPromptComp.element.querySelector('textarea').classList.add('agent-meta-prompt');
        this._metaPromptComp.element.querySelector('textarea').spellcheck = false;
        container.querySelector('[data-replace="metaPrompt"]').replaceWith(this._metaPromptComp.element);

        // User Input — UITextarea
        this._userInputComp = window.UITextarea({
            placeholder: '输入文字内容...',
            value: cfg.userInput || '',
            rows: 3,
        });
        this._userInputComp.element.querySelector('textarea').classList.add('agent-user-input');
        this._userInputComp.element.querySelector('textarea').spellcheck = false;
        container.querySelector('[data-replace="userInput"]').replaceWith(this._userInputComp.element);

        return container;
    }

    // ─────────────────────────────────────────
    // DOM 创建后统一绑定事件
    // ─────────────────────────────────────────
    createElement() {
        const el = super.createElement();
        el.classList.add('agent-card');
        el.querySelector('.card-body').style.cssText =
            'padding:0; display:flex; flex-direction:column; overflow:hidden;';

        this._bindModelButton(el);
        this._bindMetaPrompt(el);
        this._bindLibButtons(el);
        this._bindUserInput(el);
        this._bindFooterButtons(el);

        setTimeout(() => this._populateModelSelect(), 0);
        setTimeout(() => this.updateUpstreamHint(), 0);
        window.addEventListener('providers:updated', this._providersSub);

        return el;
    }

    destroy() {
        window.removeEventListener('providers:updated', this._providersSub);
        super.destroy();
    }

    // ─────────────────────────────────────────
    // 事件绑定
    // ─────────────────────────────────────────
    _bindModelButton(el) {
        const btn = el.querySelector('[data-action="model"]');
        if (!btn) return;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            AgentCard._showModelMenu(e, this.id);
        });
    }

    _bindMetaPrompt(el) {
        const ta = el.querySelector('.agent-meta-prompt');
        if (!ta) return;
        ta.addEventListener('input', () => {
            this.agentConfig.metaPrompt = ta.value;
        });
    }

    _bindLibButtons(el) {
        el.querySelectorAll('[data-action^="lib"]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const category = btn.dataset.action === 'libSkill' ? 'skill' : 'common';
                AgentCard._openLib(e, this.id, category);
            });
        });
    }

    _bindUserInput(el) {
        const ta = el.querySelector('.agent-user-input');
        if (!ta) return;
        ta.addEventListener('input', () => {
            this.agentConfig.userInput = ta.value;
        });
    }

    _bindFooterButtons(el) {
        const runBtn  = el.querySelector('[data-action="run"]');
        const copyBtn = el.querySelector('[data-action="copy"]');

        if (runBtn) {
            runBtn.addEventListener('click', () => {
                AgentCard._run(this.id);
            });
        }

        if (copyBtn) {
            copyBtn.addEventListener('click', () => {
                AgentCard._copyOutput(this.id);
            });
        }
    }

    // ─────────────────────────────────────────
    // 模型选择
    // ─────────────────────────────────────────
    async _populateModelSelect() {
        const btn = this.element?.querySelector('[data-action="model"]');
        if (!btn) return;

        this._chatModels = await AgentCard._getChatModels();

        if (!this.agentConfig.model) {
            btn.textContent = this._chatModels.length > 0 ? '选择模型' : '暂无对话模型';
            return;
        }

        const hit = this._chatModels.find(m => m.id === this.agentConfig.model);
        btn.textContent = hit ? hit.name : this._getModelDisplayName(this.agentConfig.model);
    }

    _getModelDisplayName(modelStr) {
        if (!modelStr) return '选择模型';
        if (modelStr.includes(':')) {
            return modelStr.split(':').slice(1).join(':');
        }
        return modelStr;
    }

    _setModel(modelId, displayText) {
        this.agentConfig.model = modelId;

        const btn = this.element?.querySelector('[data-action="model"]');
        if (btn) {
            btn.textContent = displayText || this._getModelDisplayName(modelId);
        }

        if (modelId) {
            localStorage.setItem('agent_last_model', modelId);
        }

        if (window.CmdManager) {
            CmdManager.execute(new ModifyContentCommand(
                this.id, this._getPromptContent(), null
            ));
        }
    }

    _getPromptContent() {
        return JSON.stringify({
            ...this.agentConfig,
            metaPrompt: this.element?.querySelector('.agent-meta-prompt')?.value
                        ?? this.agentConfig.metaPrompt,
            userInput:  this.element?.querySelector('.agent-user-input')?.value
                        ?? this.agentConfig.userInput
        });
    }

    // ─────────────────────────────────────────
    // 上游提示
    // ─────────────────────────────────────────
    updateUpstreamHint() {
        const hint     = this.element?.querySelector(`#agent-upstream-hint-${this.id}`);
        const hintText = this.element?.querySelector(`#agent-upstream-hint-text-${this.id}`);
        if (!hint) return;

        const content   = this._getUpstreamContent();
        const hasText   = content.texts.length  > 0;
        const hasImages = content.images.length > 0;

        hint.classList.toggle('visible', hasText || hasImages);

        if (hintText) {
            if (hasImages && hasText) {
                hintText.textContent = `已连接 ${content.images.length} 张图片和文字内容`;
            } else if (hasImages) {
                hintText.textContent = `已连接 ${content.images.length} 张图片`;
            } else {
                hintText.textContent = '已连接上游内容，执行时将自动拼接';
            }
        }

        const previewEl = this.element?.querySelector(`#agent-upstream-preview-${this.id}`);
        if (previewEl) {
            if (content.images.length === 0) {
                previewEl.innerHTML = '';
                previewEl.classList.remove('visible');
            } else {
                previewEl.classList.add('visible');
                previewEl.innerHTML = content.images.map(src => {
                    const safe = String(src).replace(/"/g, '&quot;');
                    return `<img class="agent-upstream-thumb" src="${safe}" alt="">`;
                }).join('');
            }
        }
    }

    refreshUpstream() {
        this.updateUpstreamHint();
    }

    _getUpstreamContent() {
        return DataSource.getUpstreamContent(this.id);
    }

    // ─────────────────────────────────────────
    // 通用接收
    // ─────────────────────────────────────────
    onReceive(type, data, source = 'upstream') {
        this.updateUpstreamHint?.();
    }

    // ─────────────────────────────────────────
    // 序列化
    // ─────────────────────────────────────────
    serialize() {
        const base = super.serialize();
        return {
            ...base,
            content: this._getPromptContent()
        };
    }

    // ─────────────────────────────────────────
    // 工具方法
    // ─────────────────────────────────────────
    _escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    _setOutput(text) {
        this.agentConfig.output = text;
        const wrap = this.element?.querySelector(`#agent-output-wrap-${this.id}`);
        if (!wrap) return;

        if (text) {
            wrap.innerHTML = `<div class="agent-output-text">${this._escapeHtml(text)}</div>`;
        } else {
            wrap.innerHTML = `<div class="agent-output-placeholder">
                                  # 输出执行后的文字内容，<br>
                                  # 每次执行后新结果覆盖旧的结果
                              </div>`;
        }

        this.notifyDownstream();

        if (window.CardEventBus && CardEventBus.EventTypes) {
            CardEventBus.emit(CardEventBus.EventTypes.RUN_COMPLETED, {
                cardId: this.id,
                type:   'text',
                data:   text
            });
        }
    }

    _setLoading(loading) {
        this._running = loading;
        const btn  = this.element?.querySelector('[data-action="run"]');
        const wrap = this.element?.querySelector(`#agent-output-wrap-${this.id}`);
        if (!btn) return;

        if (loading) {
            btn.classList.add('running');
            btn.innerHTML = '<i class="fas fa-stop"></i> 停止';
            if (wrap) {
                wrap.innerHTML = `<div class="agent-output-loading">
                                      <div class="agent-spinner"></div>
                                      <span>正在思考中...</span>
                                  </div>`;
            }
        } else {
            btn.classList.remove('running');
            btn.innerHTML = '<i class="fas fa-play"></i> 运行';
        }
    }

    static _isDisplayableImageSrc(src) {
        if (!src || typeof src !== 'string') return false;
        const s = src.trim();
        return (
            s.startsWith('data:image') ||
            s.startsWith('file://') ||
            s.startsWith('http://') ||
            s.startsWith('https://') ||
            s.startsWith('blob:')
        );
    }

    static async _compressImage(dataUrl, maxSize = 1024, quality = 0.85) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                let { width, height } = img;
                if (width > maxSize || height > maxSize) {
                    if (width >= height) {
                        height = Math.round(height * maxSize / width);
                        width  = maxSize;
                    } else {
                        width  = Math.round(width * maxSize / height);
                        height = maxSize;
                    }
                }
                const canvas = document.createElement('canvas');
                canvas.width  = width;
                canvas.height = height;
                canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', quality));
            };
            img.onerror = () => resolve(dataUrl);
            img.src     = dataUrl;
        });
    }
}


// ─────────────────────────────────────────
// 静态方法
// ─────────────────────────────────────────

AgentCard._showModelMenu = async function (event, cardId) {
    event.stopPropagation();
    event.preventDefault();
    document.querySelector('.param-menu')?.remove();

    const btn  = event.currentTarget;
    const rect = btn.getBoundingClientRect();

    const card = CardFactory.getInstance(cardId);
    if (!card) return;

    card._chatModels = await AgentCard._getChatModels();

    const menu       = Dom.create('div', { className: 'param-menu agent-model-menu' });
    menu.style.left  = rect.left + 'px';
    menu.style.top   = (rect.bottom + 5) + 'px';
    menu.style.minWidth = Math.max(rect.width, 220) + 'px';

    if (card._chatModels.length === 0) {
        menu.appendChild(Dom.create(
            'div',
            { className: 'param-menu-item', style: 'opacity:.72;cursor:default;' },
            '暂无对话模型，请先到设置添加'
        ));
    } else {
        card._chatModels.forEach(item => {
            const row = Dom.create(
                'div',
                { className: 'param-menu-item' },
                `${item.providerName} · ${item.name}`
            );
            if (item.id === card.agentConfig.model) {
                row.classList.add('selected');
            }
            row.addEventListener('click', (e) => {
                e.stopPropagation();
                card._setModel(item.id, item.name);
                menu.remove();
            });
            menu.appendChild(row);
        });
    }

    document.body.appendChild(menu);

    const menuRect = menu.getBoundingClientRect();
    if (menuRect.right > window.innerWidth - 12) {
        menu.style.left = Math.max(12, window.innerWidth - menuRect.width - 12) + 'px';
    }

    setTimeout(() => {
        const close = () => { menu.remove(); document.removeEventListener('click', close); };
        document.addEventListener('click', close);
    }, 0);
};

AgentCard._openLib = function (event, cardId, category) {
    const card = CardFactory.getInstance(cardId);
    if (!card) return;

    PromptLibrary.open(event, category, (item) => {
        const selector = category === 'skill' ? '.agent-meta-prompt' : '.agent-user-input';
        const textarea  = card.element?.querySelector(selector);
        if (!textarea) return;

        const sep = textarea.value ? '\n' : '';
        textarea.value += sep + item.content;

        if (category === 'skill') {
            card.agentConfig.metaPrompt = textarea.value;
        } else {
            card.agentConfig.userInput = textarea.value;
        }
    });
};

AgentCard._run = async function (cardId) {
    const card = CardFactory.getInstance(cardId);
    if (!card) return;

    if (card._running) {
        card._setLoading(false);
        card._setOutput(card.agentConfig.output || '');
        return;
    }

    if (!card.agentConfig.model) {
        Toast.show('请先选择模型');
        return;
    }

    const upstreamContent = card._getUpstreamContent();
    const upstreamText    = upstreamContent.texts.join('\n\n');
    const rawImages       = upstreamContent.images;

    const localInput = card.element
        ?.querySelector('.agent-user-input')?.value?.trim() || '';

    let finalUserInput = localInput;
    if (upstreamText) {
        finalUserInput = localInput ? `${localInput}\n\n${upstreamText}` : upstreamText;
    }

    if (!finalUserInput && rawImages.length === 0) {
        Toast.show('请输入用户需求或连接图片/文本卡片');
        return;
    }

    if (!finalUserInput && rawImages.length > 0) {
        finalUserInput = '请描述这张图片';
    }

    const metaPrompt = card.element
        ?.querySelector('.agent-meta-prompt')?.value?.trim() || '';

    card._setLoading(true);

    try {
        let resolvedImages = [];
        if (rawImages.length > 0) {
            resolvedImages = await Promise.all(
                rawImages.map(async (src) => {
                    if (src.startsWith('file://')) {
                        try {
                            const res = await API.loadLocalImage(src);
                            return (res && res.data_url) ? res.data_url : src;
                        } catch (e) {
                            console.warn('[AgentCard] loadLocalImage failed:', src, e);
                            return null;
                        }
                    }
                    return src;
                })
            );
            resolvedImages = resolvedImages.filter(Boolean);
        }

        const compressedImages = resolvedImages.length > 0
            ? await Promise.all(resolvedImages.map(src => AgentCard._compressImage(src)))
            : [];

        const result = await API.agentChatV2(finalUserInput, {
            metaPrompt: metaPrompt,
            model:      card.agentConfig.model || undefined,
            images:     compressedImages.length > 0 ? compressedImages : undefined
        });

        if (result.success) {
            card._setOutput(result.text);
        } else {
            Toast.show('执行失败: ' + result.error);
            card._setOutput('');
        }
    } catch (e) {
        Toast.show('执行失败');
        console.error('[AgentCard] run error:', e);
        card._setOutput('');
    } finally {
        card._setLoading(false);
    }
};

AgentCard._copyOutput = function (cardId) {
    const card = CardFactory.getInstance(cardId);
    if (!card) return;

    const text = card.agentConfig.output;
    if (!text) { Toast.show('暂无输出内容'); return; }

    navigator.clipboard.writeText(text)
        .then(() => Toast.show('已复制'))
        .catch(() => Toast.show('复制失败'));
};

AgentCard._getChatModels = async function () {
    try {
        const result    = await API.loadProviders();
        const providers = result.providers || [];
        const models    = [];

        providers.forEach(p => {
            if (!p.enabled) return;
            const displayName = p.short_name || p.name.slice(0, 6);
            (p.models || [])
                .filter(m => m.type === 'chat' && m.enabled !== false)
                .forEach(m => {
                    models.push({
                        id:           `${p.id}:${m.id}`,
                        name:         m.name || m.id,
                        providerName: displayName
                    });
                });
        });

        return models;
    } catch (e) {
        console.error('[AgentCard] 获取模型失败:', e);
        return [];
    }
};

window.AgentCard = AgentCard;
