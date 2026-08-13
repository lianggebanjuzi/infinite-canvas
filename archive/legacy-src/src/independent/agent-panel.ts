// src/independent/agent-panel.ts
// Agent right-side conversation panel — component-based UI

import { AppState } from '../state/app-state';
import { API } from '../utils/api';
import { FormInput } from '../ui/form-input';
import type { FormInputInstance } from '../ui/form-input';
import { Select } from '../ui/select';
import type { SelectInstance } from '../ui/select';

declare const Toast: { show(message: string, duration?: number): void };
declare const CardFactory: { create(type: string, options: Record<string, unknown>): unknown };
declare const uid: (prefix: string) => string;
declare const PromptService: {
    load(): Promise<unknown>;
    getItems(cat: string): Promise<Array<{ name: string; content: string }>>;
};

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────

type MessageRole = 'user' | 'ai' | 'system';

interface AgentMessage {
    role: MessageRole;
    content: string;
    timestamp: number;
}

interface ProviderModel {
    id: string;
    name: string;
    category?: string;
}

interface Provider {
    id: string;
    name: string;
    type: string;
    short_name: string;
    enabled: boolean;
    api_key?: string;
    api_url?: string;
    use_proxy?: boolean;
    models?: ProviderModel[];
}

interface ChatResult {
    success?: boolean;
    content?: string;
    text?: string;
    reply?: string;
    error?: string;
    [key: string]: unknown;
}

// ─────────────────────────────────────────
// AgentPanel
// ─────────────────────────────────────────

const AgentPanel = {

    _isOpen: false as boolean,
    _messages: [] as AgentMessage[],
    _isLoading: false as boolean,
    _input: null as FormInputInstance | null,
    _modelSelect: null as SelectInstance | null,
    _selectedModel: '' as string,

    // ─────────────────────────────────────────
    // Initialization
    // ─────────────────────────────────────────
    init(): void {
        this._bindToggle();
        this._renderInputArea();
        this._renderModelSelect();
        this._showEmptyState();

        // Listen for provider updates to refresh the model list
        window.addEventListener('providers:updated', () => {
            this._renderModelSelect();
        });

        console.log('[AgentPanel] initialized');
    },

    // ─────────────────────────────────────────
    // Expand / Collapse
    // ─────────────────────────────────────────
    toggle(): void {
        if (this._isOpen) {
            this.collapse();
        } else {
            this.expand();
        }
    },

    expand(): void {
        const panel = document.querySelector<HTMLElement>('.agent-panel');
        const toggleBtn = document.querySelector<HTMLElement>('.agent-panel-toggle');
        if (panel) panel.classList.add('is-open');
        if (toggleBtn) toggleBtn.classList.add('is-open');
        this._isOpen = true;
        this._scrollToBottom();
    },

    collapse(): void {
        const panel = document.querySelector<HTMLElement>('.agent-panel');
        const toggleBtn = document.querySelector<HTMLElement>('.agent-panel-toggle');
        if (panel) panel.classList.remove('is-open');
        if (toggleBtn) toggleBtn.classList.remove('is-open');
        this._isOpen = false;
    },

    // ─────────────────────────────────────────
    // Render input area (FormInput component)
    // ─────────────────────────────────────────
    _renderInputArea(): void {
        const wrap = document.getElementById('agent-input-area');
        if (!wrap) return;

        const input: FormInputInstance = FormInput({
            placeholder: '输入指令，例如「画一只在月光下奔跑的狼」...',
        });

        input.element.style.flex = '1';
        input.element.style.minWidth = '0';

        // Enter to send
        input.element.addEventListener('keydown', (e: KeyboardEvent) => {
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
        sendBtn.addEventListener('click', (e: MouseEvent) => {
            e.stopPropagation();
            this.sendMessage();
        });

        wrap.appendChild(input.element);
        wrap.appendChild(sendBtn);

        this._input = input;
    },

    // ─────────────────────────────────────────
    // Bind toggle button
    // ─────────────────────────────────────────
    _bindToggle(): void {
        const btn = document.querySelector<HTMLElement>('.agent-panel-toggle');
        if (!btn) return;
        btn.addEventListener('click', (e: MouseEvent) => {
            e.stopPropagation();
            this.toggle();
        });
    },

    // ─────────────────────────────────────────
    // Send message
    // ─────────────────────────────────────────
    async sendMessage(): Promise<void> {
        if (this._isLoading) return;

        const input = this._input;
        if (!input) return;

        const text: string = input.value.trim();
        if (!text) return;

        // Auto-expand panel
        if (!this._isOpen) this.expand();

        // Add user message
        this.addMessage('user', text);

        // Clear input
        input.setValue('');

        // Show loading state
        this._setLoading(true);

        try {
            // Get selected model config
            const providerId: string = this._modelSelect?.value || this._selectedModel || '';

            let replyText = '';

            // Call AI through the API wrapper
            const options: Record<string, unknown> = providerId ? { provider: providerId } : {};
            const result: ChatResult = await API.unifiedChatV2(text, options);

            if (result && result.success !== false) {
                replyText = result.content || result.text || result.reply || JSON.stringify(result);
            } else {
                replyText = result?.error || '请求失败，请检查 API 配置';
            }

            if (replyText) {
                this.addMessage('ai', replyText);
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : '未知错误';
            console.error('[AgentPanel] 发送失败:', err);
            this.addMessage('system', '❌ 发送失败: ' + message);
        } finally {
            this._setLoading(false);
        }
    },

    // Internal alias
    async _sendMessage(): Promise<void> {
        return this.sendMessage();
    },

    // ─────────────────────────────────────────
    // Add message to conversation
    // ─────────────────────────────────────────
    addMessage(role: MessageRole, content: string): void {
        this._messages.push({
            role,
            content,
            timestamp: Date.now(),
        });

        this._renderMessages();
        this._scrollToBottom();
    },

    // ─────────────────────────────────────────
    // Render message list
    // ─────────────────────────────────────────
    _renderMessages(): void {
        const container = document.querySelector<HTMLElement>('.agent-messages');
        if (!container) return;

        // Clear existing messages and empty state
        container.innerHTML = '';

        if (this._messages.length === 0) {
            this._showEmptyState();
            return;
        }

        this._messages.forEach((msg: AgentMessage) => {
            const el: HTMLDivElement = this._renderMessage(msg);
            container.appendChild(el);
        });

        // Loading indicator
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
    // Render a single message element
    // ─────────────────────────────────────────
    _renderMessage(msg: AgentMessage): HTMLDivElement {
        const el = document.createElement('div');
        el.className = 'agent-msg agent-msg--' + msg.role;

        // Simple Markdown parsing (code blocks, inline code)
        let html: string = this._escapeHtml(msg.content);
        html = this._parseMarkdown(html);

        el.innerHTML = html;
        return el;
    },

    // Alias kept for backward compat with original naming
    _createMessageElement(msg: AgentMessage): HTMLDivElement {
        return this._renderMessage(msg);
    },

    // ─────────────────────────────────────────
    // Simple Markdown parsing
    // ─────────────────────────────────────────
    _parseMarkdown(text: string): string {
        // Code blocks ```
        text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_match: string, _lang: string, code: string): string => {
            return '<pre><code>' + code.trim() + '</code></pre>';
        });

        // Inline code `...`
        text = text.replace(/`([^`]+)`/g, '<code>$1</code>');

        // Bold **...**
        text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

        // Italic *...*
        text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');

        // Newlines
        text = text.replace(/\n/g, '<br>');

        return text;
    },

    // ─────────────────────────────────────────
    // HTML escape
    // ─────────────────────────────────────────
    _escapeHtml(str: string): string {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    },

    // ─────────────────────────────────────────
    // Show empty state
    // ─────────────────────────────────────────
    _showEmptyState(): void {
        const container = document.querySelector<HTMLElement>('.agent-messages');
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
    // Render model selector (Select component with groups)
    // ─────────────────────────────────────────
    _renderModelSelect(): void {
        const wrap = document.getElementById('agent-model-select-wrap');
        if (!wrap) return;

        // Clear
        wrap.innerHTML = '';

        // Build grouped options from providers
        const groups: Array<{ label: string; options: Array<{ value: string; label: string }> }> = [];
        const providers: Provider[] = AppState?.providers?.list || [];

        providers.forEach((p: Provider) => {
            if (!p.enabled || !p.models || p.models.length === 0) return;

            const group = {
                label: p.short_name || p.name || '供应商',
                options: p.models.map((m: ProviderModel) => ({
                    value: p.id + ':' + m.id,
                    label: m.name || m.id,
                })),
            };
            groups.push(group);
        });

        // Create custom dropdown
        const select: SelectInstance = Select({
            placeholder: '自动选择模型',
            groups,
            onChange: (value: string) => {
                this._selectedModel = value;
            },
        });

        select.element.style.minWidth = '120px';
        select.element.style.maxWidth = '200px';
        wrap.appendChild(select.element);
        this._modelSelect = select;
    },

    // ─────────────────────────────────────────
    // Refresh model list (called after provider changes)
    // ─────────────────────────────────────────
    refreshModels(): void {
        this._renderModelSelect();
    },

    // ─────────────────────────────────────────
    // Set loading state
    // ─────────────────────────────────────────
    _setLoading(loading: boolean): void {
        this._isLoading = loading;
        const sendBtn = document.querySelector<HTMLButtonElement>('.agent-send-btn');
        if (sendBtn) {
            sendBtn.disabled = loading;
        }
        this._renderMessages();
    },

    // ─────────────────────────────────────────
    // Scroll to bottom
    // ─────────────────────────────────────────
    _scrollToBottom(): void {
        requestAnimationFrame(() => {
            const container = document.querySelector<HTMLElement>('.agent-messages');
            if (container) {
                container.scrollTop = container.scrollHeight;
            }
        });
    },

    // ─────────────────────────────────────────
    // Clear conversation
    // ─────────────────────────────────────────
    clear(): void {
        this._messages = [];
        this._renderMessages();
        this._showEmptyState();
        console.log('[AgentPanel] 对话已清空');
    },
};

// Expose to global scope
(window as unknown as Record<string, unknown>).AgentPanel = AgentPanel;

export { AgentPanel };
export type { AgentMessage, MessageRole, ChatResult, Provider, ProviderModel };
