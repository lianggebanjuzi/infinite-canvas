// js/agent/agent-panel.js
// Agent 右侧对话面板 — UI 组件版（UISelect/UITextarea）

const AgentPanel = {

    _isOpen: false,
    _messages: [],       // { role: 'user'|'ai'|'system', content: string, timestamp: number }
    _isLoading: false,

    // ─────────────────────────────────────────
    // 初始化
    // ─────────────────────────────────────────
    init() {
        this._bindToggle();
        this._renderInputArea();
        this._renderModelSelect();
        this._showEmptyState();

        // 监听供应商更新事件，刷新模型列表
        window.addEventListener('providers:updated', () => {
            this._renderModelSelect();
        });

        console.log('[AgentPanel] 初始化完成');
    },

    // ─────────────────────────────────────────
    // 展开/折叠
    // ─────────────────────────────────────────
    toggle() {
        if (this._isOpen) {
            this.collapse();
        } else {
            this.expand();
        }
    },

    expand() {
        const panel  = document.querySelector('.agent-panel');
        const toggle = document.querySelector('.agent-panel-toggle');
        if (panel)  panel.classList.add('is-open');
        if (toggle) toggle.classList.add('is-open');
        this._isOpen = true;
        this._scrollToBottom();
    },

    collapse() {
        const panel  = document.querySelector('.agent-panel');
        const toggle = document.querySelector('.agent-panel-toggle');
        if (panel)  panel.classList.remove('is-open');
        if (toggle) toggle.classList.remove('is-open');
        this._isOpen = false;
    },

    // ─────────────────────────────────────────
    // 渲染输入区（使用组件）
    // ─────────────────────────────────────────
    _renderInputArea() {
        const wrap = document.getElementById('agent-input-area');
        if (!wrap) return;

        const ta = UITextarea({
            placeholder: '输入指令，例如「画一只在月光下奔跑的狼」...',
            rows: 1,
            autoResize: true,
        });
        ta.element.style.flex = '1';
        ta.element.style.minWidth = '0';
        ta.element.querySelector('textarea').style.minHeight = '38px';
        ta.element.querySelector('textarea').style.maxHeight = '120px';

        // Enter 发送，Shift+Enter 换行
        ta.element.querySelector('textarea').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
            e.stopPropagation();
        });

        const sendBtn = document.createElement('button');
        sendBtn.className = 'agent-send-btn';
        sendBtn.title = '发送 (Enter)';
        sendBtn.innerHTML = '<i class="fas fa-paper-plane"></i>';
        sendBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.sendMessage();
        });

        wrap.appendChild(ta.element);
        wrap.appendChild(sendBtn);

        this._textarea = ta;
    },

    // ─────────────────────────────────────────
    // 绑定折叠按钮
    // ─────────────────────────────────────────
    _bindToggle() {
        const btn = document.querySelector('.agent-panel-toggle');
        if (!btn) return;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggle();
        });
    },

    // ─────────────────────────────────────────
    // 发送消息
    // ─────────────────────────────────────────
    async sendMessage() {
        if (this._isLoading) return;

        const textarea = this._textarea;
        if (!textarea) return;

        const text = textarea.value.trim();
        if (!text) return;

        // 自动展开面板
        if (!this._isOpen) this.expand();

        // 添加用户消息
        this.addMessage('user', text);

        // 清空输入框
        textarea.setValue('');
        textarea.element.querySelector('textarea').style.height = 'auto';

        // 显示加载状态
        this._setLoading(true);

        try {
            // 获取选中的模型配置
            const providerId = this._modelSelect?.value || this._selectedModel || '';

            let replyText = '';

            if (window.pywebview && window.pywebview.api) {
                // 通过 Python 后端调用 AI
                const options = providerId ? { provider: providerId } : {};
                const result = await window.pywebview.api.unified_chat_v2(text, options);

                if (result && result.success !== false) {
                    replyText = result.content || result.text || result.reply || JSON.stringify(result);
                } else {
                    replyText = result?.error || '请求失败，请检查 API 配置';
                }
            } else {
                // 开发模式：模拟回复
                replyText = '已收到你的消息：「' + text + '」\n\n> 💡 这是 UI 测试模式，已连接后端后将接入真实 AI 对话。';
            }

            if (replyText) {
                this.addMessage('ai', replyText);
            }
        } catch (err) {
            console.error('[AgentPanel] 发送失败:', err);
            this.addMessage('system', '❌ 发送失败: ' + (err.message || '未知错误'));
        } finally {
            this._setLoading(false);
        }
    },

    // ─────────────────────────────────────────
    // 添加消息到对话
    // ─────────────────────────────────────────
    addMessage(role, content) {
        this._messages.push({
            role,
            content,
            timestamp: Date.now()
        });

        this._renderMessages();
        this._scrollToBottom();
    },

    // ─────────────────────────────────────────
    // 渲染消息列表
    // ─────────────────────────────────────────
    _renderMessages() {
        const container = document.querySelector('.agent-messages');
        if (!container) return;

        // 清除现有消息和空状态
        container.innerHTML = '';

        if (this._messages.length === 0) {
            this._showEmptyState();
            return;
        }

        this._messages.forEach((msg) => {
            const el = this._createMessageElement(msg);
            container.appendChild(el);
        });

        // 加载中指示器
        if (this._isLoading) {
            const loadingEl = document.createElement('div');
            loadingEl.className = 'agent-msg agent-msg--loading';
            loadingEl.id = 'agent-loading-indicator';
            loadingEl.innerHTML = `
                <span class="agent-loading-dot"></span>
                <span class="agent-loading-dot"></span>
                <span class="agent-loading-dot"></span>
            `;
            container.appendChild(loadingEl);
        }
    },

    // ─────────────────────────────────────────
    // 创建单条消息元素
    // ─────────────────────────────────────────
    _createMessageElement(msg) {
        const el = document.createElement('div');
        el.className = 'agent-msg agent-msg--' + msg.role;

        // 简单 Markdown 解析（代码块、行内代码）
        let html = this._escapeHtml(msg.content);
        html = this._parseMarkdown(html);

        el.innerHTML = html;
        return el;
    },

    // ─────────────────────────────────────────
    // 简单 Markdown 解析
    // ─────────────────────────────────────────
    _parseMarkdown(text) {
        // 代码块 ```
        text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
            return '<pre><code>' + code.trim() + '</code></pre>';
        });

        // 行内代码 `...`
        text = text.replace(/`([^`]+)`/g, '<code>$1</code>');

        // 粗体 **...**
        text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

        // 斜体 *...*
        text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');

        // 换行
        text = text.replace(/\n/g, '<br>');

        return text;
    },

    // ─────────────────────────────────────────
    // HTML 转义
    // ─────────────────────────────────────────
    _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    },

    // ─────────────────────────────────────────
    // 显示空状态
    // ─────────────────────────────────────────
    _showEmptyState() {
        const container = document.querySelector('.agent-messages');
        if (!container) return;

        container.innerHTML = `
            <div class="agent-empty-state">
                <div class="empty-icon">🧠</div>
                <div class="empty-title">Agent 对话</div>
                <div class="empty-hint">
                    输入指令，AI 将帮你操作画布<br>生成图片、创建卡片、批量处理
                </div>
            </div>
        `;
    },

    // ─────────────────────────────────────────
    // 渲染模型选择器（使用自定义下拉组件）
    // ─────────────────────────────────────────
    _renderModelSelect() {
        const wrap = document.getElementById('agent-model-select-wrap');
        if (!wrap) return;

        // 清空
        wrap.innerHTML = '';

        // 构建分组选项
        const groups = [];
        const providers = window.AppState?.providers?.list || [];

        providers.forEach((p) => {
            if (!p.enabled || !p.models || p.models.length === 0) return;

            const group = {
                label: p.short_name || p.name || '供应商',
                options: p.models.map(m => ({
                    value: p.id + ':' + m.id,
                    label: m.name || m.id,
                })),
            };
            groups.push(group);
        });

        // 创建自定义下拉
        const select = UISelect({
            placeholder: '自动选择模型',
            groups: groups,
            onChange: (value) => {
                this._selectedModel = value;
            },
        });

        select.element.style.minWidth = '120px';
        select.element.style.maxWidth = '200px';
        wrap.appendChild(select.element);
        this._modelSelect = select;
    },

    // ─────────────────────────────────────────
    // 刷新模型列表（供应商变更后调用）
    // ─────────────────────────────────────────
    refreshModels() {
        this._renderModelSelect();
    },

    // ─────────────────────────────────────────
    // 设置加载状态
    // ─────────────────────────────────────────
    _setLoading(loading) {
        this._isLoading = loading;
        const sendBtn = document.querySelector('.agent-send-btn');
        if (sendBtn) {
            sendBtn.disabled = loading;
        }
        this._renderMessages();
    },

    // ─────────────────────────────────────────
    // 滚动到底部
    // ─────────────────────────────────────────
    _scrollToBottom() {
        requestAnimationFrame(() => {
            const container = document.querySelector('.agent-messages');
            if (container) {
                container.scrollTop = container.scrollHeight;
            }
        });
    },

    // ─────────────────────────────────────────
    // 清空对话
    // ─────────────────────────────────────────
    clear() {
        this._messages = [];
        this._renderMessages();
        this._showEmptyState();
        console.log('[AgentPanel] 对话已清空');
    }

};

// 挂到全局
window.AgentPanel = AgentPanel;
