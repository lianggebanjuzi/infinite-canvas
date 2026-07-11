// gui/js/cards/AIDrawCard.js
// UI组件版：prompt 使用 UITextarea
class AIDrawCard extends BaseCard {

    // ─────────────────────────────────────────
    // 静态方法：合并原图和遮罩
    // ─────────────────────────────────────────
    static async _mergeImageAndMask(imageBase64, maskBase64) {
        return new Promise((resolve) => {
            const img = new Image();
            const maskImg = new Image();
            let loaded = 0;

            const onBothLoaded = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');

                ctx.drawImage(img, 0, 0);
                ctx.drawImage(maskImg, 0, 0);
                ctx.globalCompositeOperation = 'source-atop';
                ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
                ctx.fillRect(0, 0, canvas.width, canvas.height);

                resolve(canvas.toDataURL('image/png'));
            };

            img.onload = () => { loaded++; if (loaded === 2) onBothLoaded(); };
            maskImg.onload = () => { loaded++; if (loaded === 2) onBothLoaded(); };

            img.src = imageBase64;
            maskImg.src = maskBase64;
        });
    }

    // ─────────────────────────────────────────
    // 构造函数
    // ─────────────────────────────────────────
    constructor(options = {}) {
        super({
            width:  '500px',
            height: '480px',
            title:  'AI Image',
            ...options
        });

        // 提示词
        this.prompt = '';

        // AI 配置
        this.config = {
            model:        '',
            aspectRatio:  'Auto',
            resolution:   '1k',
            count:        1,
            topP:         0.95
        };

        // 序列化恢复（兼容旧格式）
        if (options.content) {
            try {
                const parsed = JSON.parse(options.content);
                this.prompt = parsed.prompt || '';
                // 兼容旧格式：config 可能是嵌套 JSON 字符串
                if (parsed.config) {
                    const cfg = typeof parsed.config === 'string'
                        ? JSON.parse(parsed.config) : parsed.config;
                    this.config = { ...this.config, ...cfg };
                }
            } catch {}
        }

        // 兼容旧的 aiConfig 字段名
        if (options.aiConfig) {
            this.config = { ...this.config, ...options.aiConfig };
        }

        // 遮罩存储（Map，用于关联参考图和遮罩）
        this._maskStore = new Map();
        if (options.maskStore && typeof options.maskStore === 'object') {
            Object.entries(options.maskStore).forEach(([k, v]) => {
                if (k && v) this._maskStore.set(k, v);
            });
        }

        // 模型回退：从 localStorage 恢复上次选择
        if (!this.config.model) {
            this.config.model = localStorage.getItem('ai_draw_last_model') || '';
        }

        // 监听供应商更新
        this._onProvidersUpdated = () => {
            if (!this.config.model) {
                AIDrawCard._getImageModels().then(models => {
                    if (models.length > 0) {
                        this.config.model = models[0].id;
                        localStorage.setItem('ai_draw_last_model', this.config.model);
                        this._updateParamDisplay('model', models[0].id, models[0].name);
                    }
                });
            }
            this._restoreModelLabel();
        };

        // 初始加载模型
        if (!this.config.model) {
            AIDrawCard._getImageModels().then(models => {
                if (models.length > 0) {
                    this.config.model = models[0].id;
                    localStorage.setItem('ai_draw_last_model', this.config.model);
                    this._updateParamDisplay('model', models[0].id, models[0].name);
                }
            });
        }
    }

    getType() { return 'ai-image'; }

    // ─────────────────────────────────────────
    // 契约声明
    // ─────────────────────────────────────────
    static getContract() {
        return {
            outputs: [{
                name: 'default',
                type: 'image',
                notifyOn: 'onRun'
            }],
            inputs: [
                {
                    name: 'prompt',
                    type: 'text',
                    receivePolicy: 'replace'
                },
                {
                    name: 'reference',
                    type: 'image',
                    multiple: true,
                    receivePolicy: 'append'
                }
            ]
        };
    }

    // ─────────────────────────────────────────
    // 内容渲染
    // ─────────────────────────────────────────
    renderContent() {
        const container = document.createElement('div');
        container.style.cssText = 'display:flex;flex-direction:column;flex:1;overflow:hidden;';
        container.innerHTML = `
            <div class="ai-image-prompt-area">
                <div class="ai-ref-images"></div>
                <div class="ai-image-prompt-wrap">
                    <div data-replace="prompt"></div>
                </div>
            </div>
            <div class="ai-image-controls">
                <div class="ai-image-params">
                    <button class="ai-image-param-btn"
                            data-param="model"
                            data-label="${this._getModelDisplayName(this.config.model)}">
                        ${this._getModelDisplayName(this.config.model)}
                    </button>
                    <button class="ai-image-param-btn"
                            data-param="aspectRatio">
                        ${this.config.aspectRatio}
                    </button>
                    <button class="ai-image-param-btn"
                            data-param="resolution">
                        ${this.config.resolution}
                    </button>
                    <button class="ai-image-param-btn"
                            data-param="count">
                        ${this.config.count}张
                    </button>
                    <input type="number" class="ai-image-topp-input"
                           data-param="topP"
                           value="${this.config.topP}"
                           min="0" max="1" step="0.05"
                           placeholder="topP"
                           title="topP (0.0~1.0)">
                    <button class="ai-image-param-btn ai-prompt-lib-btn"
                            title="提示词库"
                            data-action="promptLib">
                        <i class="fas fa-book-open" style="font-size:11px;"></i>
                    </button>
                </div>
                <button class="ai-image-generate-btn"
                        data-action="generate">
                    ▶ 启动
                </button>
            </div>
        `;

        // Prompt — UITextarea
        this._promptComp = window.UITextarea({
            placeholder: '输入提示词...',
            value: this.prompt,
            rows: 3,
        });
        this._promptComp.element.querySelector('textarea').classList.add('ai-image-prompt');
        this._promptComp.element.querySelector('textarea').spellcheck = false;
        container.querySelector('[data-replace="prompt"]').replaceWith(this._promptComp.element);

        return container;
    }

    createElement() {
        const el = super.createElement();
        el.classList.add('ai-image-card');
        el.querySelector('.card-body').style.cssText =
            'padding:0; display:flex; flex-direction:column;';

        this._bindPromptInput(el);
        this._bindParamButtons(el);
        this._bindTopPInput(el);
        this._bindGenerateButton(el);

        setTimeout(() => this._restoreModelLabel(), 0);
        window.addEventListener('providers:updated', this._onProvidersUpdated);

        return el;
    }

    destroy() {
        window.removeEventListener('providers:updated', this._onProvidersUpdated);
        super.destroy();
    }

    // ─────────────────────────────────────────
    // 事件绑定
    // ─────────────────────────────────────────
    _bindPromptInput(el) {
        const textarea = el.querySelector('.ai-image-prompt');
        if (!textarea) return;

        textarea.addEventListener('input', () => {
            this.prompt = textarea.value;
        });
    }

    _bindParamButtons(el) {
        el.querySelectorAll('[data-param]').forEach(btn => {
            if (btn.tagName === 'INPUT') return; // topP input 单独处理

            const action = btn.dataset.action;

            if (action === 'promptLib') {
                btn.addEventListener('click', () => {
                    PromptLibrary.open(null, 'draw', (item) => {
                        const ta = this.element?.querySelector('.ai-image-prompt');
                        if (!ta) return;
                        const sep = ta.value ? ', ' : '';
                        ta.value += sep + item.content;
                        this.prompt = ta.value;
                    });
                });
                return;
            }

            const param = btn.dataset.param;
            if (param) {
                btn.addEventListener('click', (e) => {
                    AIDrawCard._showParamMenu(e, this.id, param);
                });
            }
        });
    }

    _bindTopPInput(el) {
        const input = el.querySelector('.ai-image-topp-input');
        if (!input) return;

        input.addEventListener('input', () => {
            const val = parseFloat(input.value);
            if (!isNaN(val)) {
                this.config.topP = Math.max(0, Math.min(1, val));
            }
        });

        input.addEventListener('change', () => {
            const val = parseFloat(input.value);
            if (isNaN(val) || val < 0 || val > 1) {
                input.value = this.config.topP;
                Toast.show('topP 值需在 0.0 ~ 1.0 范围内');
            }
        });

        // 阻止冒泡，避免触发画布拖拽
        input.addEventListener('mousedown', e => e.stopPropagation());
    }

    _bindGenerateButton(el) {
        const btn = el.querySelector('.ai-image-generate-btn');
        if (!btn) return;

        btn.addEventListener('click', () => {
            AIDrawCard.generate(this.id);
        });
    }

    // ─────────────────────────────────────────
    // 输出
    // ─────────────────────────────────────────
    getOutput(outputName = 'default') {
        if (outputName === 'default') {
            const imgs = this.element?.querySelectorAll('.preview-image-wrap img');
            if (imgs && imgs.length > 0) {
                return imgs[0].src;
            }
            return this.config.generatedImages?.[0] || null;
        }
        return null;
    }

    // ─────────────────────────────────────────
    // 根据契约获取输入数据
    // ─────────────────────────────────────────
    getInput(inputName) {
        if (inputName === 'prompt') {
            const textData = DataSource.getUpstreamText(this.id);
            return textData.map(t => t.data).filter(Boolean).join(', ');
        }
        if (inputName === 'reference') {
            const imageData = DataSource.getUpstreamImage(this.id);
            return imageData.map(i => i.data).filter(Boolean);
        }
        return null;
    }

    // ─────────────────────────────────────────
    // 上游数据处理
    // ─────────────────────────────────────────
    updateUpstreamTextHint() {
        const textarea = this.element?.querySelector('.ai-image-prompt');
        if (!textarea) return;

        const hasUpstreamText = DataSource.hasUpstreamOfType(this.id, 'text');

        if (hasUpstreamText) {
            textarea.disabled = true;
            textarea.placeholder = '提示词由上游文本卡片提供';
            const upstreamTexts = DataSource.getUpstreamText(this.id)
                .map(t => t.data).filter(Boolean);
            if (upstreamTexts.length > 0) {
                const combined = upstreamTexts.join(', ');
                textarea.value = combined;
                this.prompt = combined;
            }
        } else {
            textarea.disabled = false;
            textarea.placeholder = '输入提示词...';
        }
    }

    // ─────────────────────────────────────────
    // 参考图管理
    // ─────────────────────────────────────────
    addRefImage(src, sourceCardId) {
        const container = this.element?.querySelector('.ai-ref-images');
        if (!container) return;

        this.removeRefImage(sourceCardId);

        const wrappers = container.querySelectorAll('.ai-ref-image-wrapper');
        if (wrappers.length >= 10) {
            Toast.show('最多只能添加 10 张参考图片');
            return;
        }

        const wrapper = document.createElement('div');
        wrapper.className = 'ai-ref-image-wrapper';

        const img = document.createElement('img');
        img.className = 'ai-ref-image';
        img.src = src;
        img.dataset.cardId = sourceCardId;

        const removeBtn = document.createElement('button');
        removeBtn.className = 'ai-ref-image-remove';
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', () => {
            wrapper.remove();
            this._maskStore.delete(sourceCardId);
        });

        wrapper.appendChild(img);
        wrapper.appendChild(removeBtn);
        container.appendChild(wrapper);
    }

    removeRefImage(sourceCardId) {
        const wrapper = this.element
            ?.querySelector(`.ai-ref-image[data-card-id="${sourceCardId}"]`)
            ?.closest('.ai-ref-image-wrapper');
        wrapper?.remove();
        this._maskStore.delete(sourceCardId);
    }

    refreshUpstream() {
        const container = this.element?.querySelector('.ai-ref-images');
        if (!container) return;

        container.innerHTML = '';

        const imageData = DataSource.getUpstreamImage(this.id);
        imageData.forEach(item => {
            if (item.data) {
                this.addRefImage(item.data, item.sourceCardId);
            }
        });
    }

    updateRefMask(sourceCardId, maskBase64) {
        if (maskBase64) {
            this._maskStore.set(sourceCardId, maskBase64);
        } else {
            this._maskStore.delete(sourceCardId);
        }
    }

    // ─────────────────────────────────────────
    // 通用接收方法
    // ─────────────────────────────────────────
    onReceive(type, data, source = 'upstream') {
        if (!data) return;

        if (type === 'text') {
            this.prompt = data;
            const textarea = this.element?.querySelector('.ai-image-prompt');
            if (textarea) {
                textarea.value = data;
                textarea.disabled = true;
                textarea.placeholder = '提示词由上游文本卡片提供';
            }
        } else if (type === 'image') {
            const sourceCardId = (source === 'upstream' || source === 'run')
                ? `card-${source}` : source;
            this.addRefImage(data, sourceCardId);
        }
    }

    // ─────────────────────────────────────────
    // 参数更新
    // ─────────────────────────────────────────
    updateParam(paramType, value, displayText) {
        if (paramType === 'count') {
            this.config.count = parseInt(value);
        } else {
            this.config[paramType] = value;
        }

        this._updateParamDisplay(paramType, value, displayText);

        if (paramType === 'model' && value) {
            localStorage.setItem('ai_draw_last_model', value);
        }

        if (window.CmdManager) {
            CmdManager.execute(new PropertyChangeCommand(
                this.id, 'config', { ...this.config }, null, '修改AI参数'
            ));
        }
    }

    _updateParamDisplay(paramType, value, displayText) {
        const btn = this.element?.querySelector(`[data-param="${paramType}"]`);
        if (!btn) return;

        if (paramType === 'model') {
            btn.textContent = displayText || value;
            btn.dataset.label = displayText || value;
        } else if (paramType === 'count') {
            btn.textContent = `${value}张`;
        } else {
            btn.textContent = displayText || value;
        }
    }

    async _restoreModelLabel() {
        const btn = this.element?.querySelector('[data-param="model"]');
        if (!btn) return;

        try {
            const models = await AIDrawCard._getImageModels();

            if (!this.config.model && models.length > 0) {
                this.config.model = models[0].id;
                localStorage.setItem('ai_draw_last_model', this.config.model);
                btn.textContent = models[0].name;
                btn.dataset.label = models[0].name;
                return;
            }

            const match = models.find(m => m.id === this.config.model);
            if (match) {
                btn.textContent = match.name;
                btn.dataset.label = match.name;
            } else {
                const name = this._getModelDisplayName(this.config.model);
                btn.textContent = name;
                btn.dataset.label = name;
            }
        } catch {
            const name = this._getModelDisplayName(this.config.model);
            btn.textContent = name || '选择模型';
            btn.dataset.label = name || '选择模型';
        }
    }

    // ─────────────────────────────────────────
    // 序列化
    // ─────────────────────────────────────────
    serialize() {
        const base = super.serialize();

        const textarea = this.element?.querySelector('.ai-image-prompt');
        const currentPrompt = textarea?.value ?? this.prompt ?? '';

        const maskStoreObj = {};
        this._maskStore.forEach((v, k) => { maskStoreObj[k] = v; });

        return {
            ...base,
            content: JSON.stringify({
                prompt: currentPrompt,
                config: this.config
            }),
            maskStore: this._maskStore.size > 0 ? maskStoreObj : undefined
        };
    }

    // ─────────────────────────────────────────
    // 工具方法
    // ─────────────────────────────────────────
    _getModelDisplayName(modelStr) {
        if (!modelStr) return '选择模型';
        if (modelStr.includes(':')) {
            return modelStr.split(':').slice(1).join(':');
        }
        return modelStr;
    }

    _escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    _getRefImages() {
        const wrappers = this.element?.querySelectorAll('.ai-ref-image-wrapper') || [];
        const result = [];
        wrappers.forEach(wrapper => {
            const img = wrapper.querySelector('.ai-ref-image');
            if (img?.src) {
                result.push({
                    src: img.src,
                    cardId: img.dataset.cardId
                });
            }
        });
        return result;
    }

    _hasUpstreamText() {
        return DataSource.hasUpstreamOfType(this.id, 'text');
    }

    _showGeneratingStatus(count) {
        const area = this.element?.querySelector('.ai-image-prompt-area');
        if (!area) return null;

        let statusDiv = this.element.querySelector('.ai-generating-status');
        if (!statusDiv) {
            statusDiv = document.createElement('div');
            statusDiv.className = 'ai-generating-status';
            area.insertBefore(statusDiv, area.firstChild);
        }
        statusDiv.innerHTML = `
            <div class="ai-image-spinner"></div>
            <div>正在生成图片... (0/${count})</div>
        `;
        return statusDiv;
    }

    _updateGeneratingStatus(completed, total) {
        const statusDiv = this.element?.querySelector('.ai-generating-status');
        if (!statusDiv) return;
        statusDiv.querySelector('div:last-child').textContent =
            `正在生成图片... (${completed}/${total})`;
    }

    _clearGeneratingStatus() {
        this.element?.querySelector('.ai-generating-status')?.remove();
    }

    _updateGenerateButton(isGenerating) {
        const btn = this.element?.querySelector('.ai-image-generate-btn');
        if (!btn) return;

        if (isGenerating) {
            btn.innerHTML = '⏹ 停止';
        } else {
            btn.innerHTML = '▶ 启动';
        }
    }
}


// ─────────────────────────────────────────
// 静态方法
// ─────────────────────────────────────────

AIDrawCard._showParamMenu = async function (event, cardId, paramType) {
    event.stopPropagation();
    document.querySelector('.param-menu')?.remove();

    const btn = event.currentTarget;
    const rect = btn.getBoundingClientRect();

    const card = CardFactory.getInstance(cardId);
    if (!card) return;

    let items = [];

    switch (paramType) {
        case 'model':
            items = await AIDrawCard._getImageModels();
            break;
        case 'aspectRatio':
            items = [
                'Auto','1:1','16:9','9:16',
                '4:3','3:4','21:9','3:2','2:3'
            ];
            break;
        case 'resolution':
            items = ['1k','2k','4k'];
            break;
        case 'count':
            items = ['1张','2张','4张','9张'];
            break;
    }

    const menu = document.createElement('div');
    menu.className = 'param-menu';
    menu.style.left = rect.left + 'px';
    menu.style.top = (rect.bottom + 5) + 'px';

    const menuWidth = 160;
    if (rect.left + menuWidth > window.innerWidth - 12) {
        menu.style.left = (window.innerWidth - menuWidth - 12) + 'px';
    }

    items.forEach(item => {
        const isObj = typeof item === 'object';
        const displayText = isObj ? item.name : item;
        const value = isObj ? item.id : item;

        const menuItem = document.createElement('div');
        menuItem.className = 'param-menu-item';
        menuItem.textContent = displayText;

        if (paramType === 'model' && value === card.config.model) {
            menuItem.classList.add('selected');
        }

        menuItem.addEventListener('click', (e) => {
            e.stopPropagation();
            // count 参数去掉"张"后缀
            const rawValue = typeof value === 'string' && value.endsWith('张')
                ? value.slice(0, -1) : value;
            card.updateParam(paramType, rawValue, displayText);
            menu.remove();
        });

        menu.appendChild(menuItem);
    });

    document.body.appendChild(menu);

    setTimeout(() => {
        document.addEventListener('click', function close() {
            menu.remove();
            document.removeEventListener('click', close);
        });
    }, 0);
};

AIDrawCard._getImageModels = async function () {
    try {
        const result = await API.loadProviders();
        const providers = result.providers || [];
        const models = [];

        providers.forEach(p => {
            if (!p.enabled) return;
            const displayName = p.short_name || p.name.slice(0, 6);
            (p.models || [])
                .filter(m => m.enabled !== false && m.type === 'drawing')
                .forEach(m => {
                    models.push({
                        id:   `${p.id}:${m.id}`,
                        name: `${displayName} - ${m.name}`
                    });
                });
        });

        return models.length
            ? models
            : [{ id: '', name: '未找到绘图模型，请先在设置中配置' }];
    } catch {
        return [{ id: '', name: '加载失败' }];
    }
};

AIDrawCard._getConnectedPreviews = function (aiCardId) {
    return DataSource.getDownstreamPreviews(aiCardId);
};

AIDrawCard._getConnectedImageInputCards = function (aiCardId) {
    return DataSource.getDownstreamImageCards(aiCardId);
};

AIDrawCard._toBase64 = function (src) {
    return new Promise((resolve, reject) => {
        if (src.startsWith('data:')) { resolve(src); return; }
        const img = new Image();
        img.crossOrigin = 'Anonymous';
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            canvas.getContext('2d').drawImage(img, 0, 0);
            resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = reject;
        img.src = src;
    });
};

AIDrawCard._generateErrorImage = function (errorMessage) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');

    let icon = '✕';
    let iconColor = '#ef4444';
    let title = '生成失败';
    let bgColor = '#1a1a2e';
    let detail = errorMessage || '未知错误';

    const msg = (errorMessage || '').toLowerCase();

    if (msg.includes('timeout') || msg.includes('超时')) {
        icon = '⏱'; iconColor = '#f59e0b'; title = '请求超时';
        detail = '服务器响应超时，请稍后重试';
    } else if (msg.includes('connection') || msg.includes('连接')) {
        icon = '⚡'; iconColor = '#f59e0b'; title = '连接失败';
        detail = '无法连接到服务器，请检查网络';
    } else if (msg.includes('429') || msg.includes('rate limit') ||
               msg.includes('频率')  || msg.includes('频繁')) {
        icon = '🚫'; iconColor = '#a855f7'; title = '请求过于频繁';
        detail = '已触发限流，请稍等片刻再试';
    } else if (msg.includes('401') || msg.includes('api key') ||
               msg.includes('密钥') || msg.includes('unauthorized')) {
        icon = '🔑'; iconColor = '#ef4444'; title = 'API 密钥无效';
        detail = '请检查 API Key 是否正确';
    } else if (msg.includes('500') || msg.includes('server') || msg.includes('服务器')) {
        icon = '🛠'; iconColor = '#ef4444'; title = '服务器错误';
        detail = '服务端发生错误，请稍后重试';
    } else if (msg.includes('insufficient') || msg.includes('balance') ||
               msg.includes('余额')          || msg.includes('quota')) {
        icon = '💳'; iconColor = '#f59e0b'; title = '账户余额不足';
        detail = '请前往供应商平台充值';
    }

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, 512, 512);

    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 512; i += 32) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 512); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(512, i); ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(256, 160, 70, 0, Math.PI * 2);
    ctx.strokeStyle = iconColor;
    ctx.lineWidth = 4;
    ctx.stroke();

    ctx.font = '52px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(icon, 256, 178);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillText(title, 256, 278);

    ctx.fillStyle = '#9ca3af';
    ctx.font = '18px sans-serif';
    const maxWidth = 420;
    const lineHeight = 30;
    const lines = [];
    let current = '';

    for (const char of detail) {
        const test = current + char;
        if (ctx.measureText(test).width > maxWidth && current) {
            lines.push(current);
            current = char;
        } else {
            current = test;
        }
    }
    if (current) lines.push(current);

    lines.slice(0, 3).forEach((line, i) => {
        ctx.fillText(line, 256, 325 + i * lineHeight);
    });

    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.font = '14px sans-serif';
    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')}`;
    ctx.fillText(timeStr, 256, 480);

    return canvas.toDataURL('image/png');
};

AIDrawCard.generate = async function (cardId) {
    const card = CardFactory.getInstance(cardId);
    if (!card) return;

    const el = card.element;
    if (!el) return;

    // 停止生成
    if (AppState.ai.generatingCards.has(cardId)) {
        AppState.ai.generatingCards.get(cardId).aborted = true;
        AppState.ai.generatingCards.delete(cardId);
        card._updateGenerateButton(false);
        card._clearGeneratingStatus();
        return;
    }

    // 获取提示词
    let prompt = card.element?.querySelector('.ai-image-prompt')?.value?.trim() || '';
    if (card._hasUpstreamText()) {
        prompt = DataSource.getUpstreamTextMerged(cardId);
    }

    if (!prompt)              { Toast.show('请输入提示词'); return; }
    if (!card.config.model)   { Toast.show('请先选择模型'); return; }

    // 收集参考图
    const refImages = [];
    const refImageWrappers = card._getRefImages();

    for (const { src, cardId: srcCardId } of refImageWrappers) {
        const maskSrc = card._maskStore.get(srcCardId) || null;
        try {
            let base64 = await AIDrawCard._toBase64(src);
            if (maskSrc) {
                base64 = await AIDrawCard._mergeImageAndMask(base64, maskSrc);
            }
            refImages.push(base64);
        } catch (e) {
            console.warn('[AIDrawCard] 参考图转换失败，跳过:', e);
        }
    }

    if (refImages.length) {
        card.config.referenceImages = refImages;
        delete card.config.referenceMasks;
    } else {
        delete card.config.referenceImages;
        delete card.config.referenceMasks;
    }

    const count = card.config.count || 1;

    // 更新 UI
    AppState.ai.generatingCards.set(cardId, { aborted: false });
    card._updateGenerateButton(true);
    const statusDiv = card._showGeneratingStatus(count);

    // 准备预览卡片
    let previewCards = DataSource.getDownstreamPreviews(cardId);
    if (previewCards.length === 0) {
        const cardLeft  = parseFloat(el.style.left);
        const cardTop   = parseFloat(el.style.top);
        const cardWidth = parseFloat(el.style.width);

        for (let i = 0; i < count; i++) {
            const newCard = CardFactory.create('preview', {
                x: cardLeft + cardWidth + 50,
                y: cardTop  + i * 320
            }, false);
            ConnectionManager.create(cardId, newCard.id, false);
        }
        previewCards = DataSource.getDownstreamPreviews(cardId);
    }

    const generatedImages = [];
    const lockedCards = new Set();

    try {
        const state = AppState.ai.generatingCards.get(cardId);

        // 提交所有任务
        const taskIds = await Promise.all(
            Array.from({ length: count }, (_, i) => {
                const options = {
                    model: card.config.model || undefined,
                    resolution: card.config.resolution || '1k',
                    aspectRatio: card.config.aspectRatio || 'Auto',
                    topP: card.config.topP,
                    referenceImages: card.config.referenceImages || []
                };
                return API.generateImageV2(prompt, options)
                    .then(res => {
                        if (!res || !res.task_id) {
                            throw new Error(`任务[${i}] task_id 为空，启动失败`);
                        }
                        return res.task_id;
                    });
            })
        );

        // 轮询任务结果
        const pollTask = (taskId, index) => new Promise((resolve) => {
            if (!taskId) {
                resolve({ success: false, error: 'task_id 无效' });
                return;
            }

            const poll = async () => {
                if (state.aborted) { resolve(null); return; }

                try {
                    const res = await API.getTaskResult(taskId);

                    if (!res || res.status === 'not_found') {
                        resolve({ success: false, error: '任务结果已过期，请重新生成' });
                        return;
                    }

                    if (res.status === 'pending') {
                        setTimeout(poll, 2000);
                    } else if (res.status === 'done') {
                        resolve(res.result);
                    } else {
                        resolve({ success: false, error: `未知任务状态: ${res.status}` });
                    }
                } catch (e) {
                    resolve({ success: false, error: e.message });
                }
            };

            poll();
        });

        // 按完成顺序渲染
        const promises = taskIds.map((taskId, i) =>
            pollTask(taskId, i).then(result => ({ i, result }))
        );

        for (const promise of promises) {
            if (state.aborted) break;

            const { i, result } = await promise;

            const pc = previewCards[i];
            const previewInstance = pc ? CardFactory.getInstance(pc?.id) : null;

            if (!result) {
                if (previewInstance && !lockedCards.has(pc.id)) {
                    const errImg = AIDrawCard._generateErrorImage('任务结果获取失败');
                    previewInstance._renderImage(errImg);
                }
                continue;
            }

            const isValidImageUrl = (url) => {
                if (!url || typeof url !== 'string') return false;
                if (url.startsWith('data:image/')) return true;
                const lower = url.toLowerCase();
                return /\.(png|jpg|jpeg|gif|webp|bmp|svg|ico)(\?|$|#)/.test(lower)
                    || lower.includes('/image') || lower.includes('/img')
                    || lower.includes('/photo') || lower.includes('/picture');
            };

            if (result.success && isValidImageUrl(result.image_url)) {
                if (pc) lockedCards.add(pc.id);
                generatedImages[i] = result.image_url;

                const meta = {
                    resolution:  card.config.resolution  || '1k',
                    aspectRatio: card.config.aspectRatio || 'Auto',
                    generatedAt: Date.now()
                };

                previewInstance?.setImage(result.image_url, meta);

                if (i === 0) {
                    const imageInputCards = DataSource.getDownstreamImageCards(cardId);
                    imageInputCards.forEach(imgCard =>
                        imgCard.setImage?.(result.image_url)
                    );
                }

                HistorySidebar.addImage(result.image_url, meta);

                card._updateGeneratingStatus(
                    generatedImages.filter(Boolean).length,
                    count
                );

            } else {
                if (previewInstance && !lockedCards.has(pc.id)) {
                    const errMsg = result.error === 'only_text'
                        ? 'AI 仅返回了文本，未生成图片'
                        : (result.error || '生成失败');
                    const errImg = AIDrawCard._generateErrorImage(errMsg);
                    previewInstance._renderImage(errImg);
                }
            }
        }

        const successCount = generatedImages.filter(Boolean).length;
        if (!state.aborted && successCount === 0) {
            Toast.show('生成失败：AI 未返回有效图片');
        }

        if (generatedImages.length) {
            card.config.generatedImages = generatedImages;
        }

    } catch (error) {
        if (error.message !== '用户取消生成') {
            Toast.show('生成失败: ' + error.message);
            const errorImage = AIDrawCard._generateErrorImage(error.message);
            previewCards.forEach(pc => {
                if (lockedCards.has(pc.id)) return;
                const instance = CardFactory.getInstance(pc?.id);
                instance?._renderImage(errorImage);
            });
        }
    } finally {
        const wasAborted = AppState.ai.generatingCards.get(cardId)?.aborted ?? true;
        AppState.ai.generatingCards.delete(cardId);
        card._updateGenerateButton(false);
        card._clearGeneratingStatus();

        if (!wasAborted && generatedImages.length > 0) {
            if (window.CardEventBus && CardEventBus.EventTypes) {
                CardEventBus.emit(CardEventBus.EventTypes.RUN_COMPLETED, {
                    cardId,
                    type: 'image',
                    data: generatedImages[0] || null,
                });
            }
        }
    }
};

window.AIDrawCard = AIDrawCard;
