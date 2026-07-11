// gui/js/cards/TextCard.js
// UI组件版：内容 textarea 使用 UITextarea
class TextCard extends BaseCard {

    constructor(options = {}) {
        super({
            width:  '200px',
            height: '120px',
            title:  'Text Note',
            ...options
        });
        this.content = options.content || '';
    }

    getType() { return 'text'; }

    // ─────────────────────────────────────────
    // 契约声明
    // ─────────────────────────────────────────
    static getContract() {
        return {
            outputs: [{ name: 'default', type: 'text' }],
            inputs: []
        };
    }

    renderContent() {
        const text = this.content || '';
        this._textareaComp = window.UITextarea({
            placeholder: '输入文字...',
            value: text,
            rows: 3,
        });
        this._textareaComp.element.querySelector('textarea').classList.add('text-content');
        return this._textareaComp.element;
    }

    createElement() {
        const el = super.createElement();
        el.classList.add('text-card');

        const textarea = el.querySelector('textarea');

        // 文本修改时实时推送给下游（防抖 300ms）
        let debounceTimer = null;
        textarea.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                this.content = textarea.value;
                this._pushToDownstream();
            }, 300);
        });

        textarea.addEventListener('blur', () => {
            clearTimeout(debounceTimer);
            const newVal = textarea.value;
            if (newVal !== this.content && window.CmdManager) {
                CmdManager.execute(new ModifyContentCommand(this.id, newVal, this.content));
            }
            this.content = newVal;
        });

        return el;
    }

    getOutput(outputName = 'default') {
        if (outputName === 'default') {
            const textarea = this.element?.querySelector('textarea');
            return textarea?.value?.trim() || this.content || '';
        }
        return null;
    }

    _pushToDownstream() {
        const text = this.getOutput();
        if (!text && text !== '') return;

        if (window.CardEventBus && CardEventBus.EventTypes) {
            CardEventBus.emit(CardEventBus.EventTypes.DATA_CHANGED, {
                cardId: this.id,
                type: 'text',
                data: text,
                source: 'upstream'
            });
        }
    }

    setText(text) {
        this.content = text;
        const textarea = this.element?.querySelector('textarea');
        if (textarea) textarea.value = text;
        this._pushToDownstream();
    }

    onReceive(type, data, source = 'upstream') {
        if (type === 'text' && data) {
            if (source === 'run') {
                const existing = this.element?.querySelector('textarea')?.value?.trim() || '';
                const newContent = existing
                    ? `${existing}\n\n---\n\n${data}`
                    : data;
                this.setText(newContent);
            } else {
                this.setText(data);
            }
        }
    }

    serialize() {
        const base = super.serialize();
        const textarea = this.element?.querySelector('textarea');
        return {
            ...base,
            content: textarea?.value ?? this.content ?? ''
        };
    }
}

window.TextCard = TextCard;
