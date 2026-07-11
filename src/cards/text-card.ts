// src/cards/text-card.ts
// 文本卡片 输入提示

import { BaseCard } from './base-card';
import { CardContract } from '../types/cards';

declare const CmdManager: { execute(cmd: unknown): void };
declare const ModifyContentCommand: any;
declare const CardEventBus: { EventTypes: { DATA_CHANGED: string }; emit(type: string, payload: unknown): void };

export class TextCard extends BaseCard {
  declare content: string;

  constructor(options: { content?: string } = {}) {
    super({ width: '200px', height: '120px', title: 'Text Note', ...options });
    this.content = options.content || '';
  }

  getType(): string { return 'text'; }

  static override getContract(): CardContract {
    return {
      outputs: [{ name: 'default', type: 'text' }],
      inputs: []
    };
  }

  override renderContent(): string {
    const text = this.content || '';
    return `<textarea class="text-content"
                      placeholder="输入文字..."
                      spellcheck="false">${this._escapeHtml(text)}</textarea>`;
  }

  override createElement(): HTMLElement {
    const el = super.createElement();
    el.classList.add('text-card');

    const textarea = el.querySelector('textarea') as HTMLTextAreaElement | null;
    if (!textarea) return el;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    textarea.addEventListener('input', () => {
      this.content = textarea.value;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        this._pushToDownstream();
      }, 300);
    });

    textarea.addEventListener('blur', () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      const newVal = textarea.value;
      if (newVal !== this.content && CmdManager) {
        CmdManager.execute(new ModifyContentCommand( this.id, newVal, this.content));
      }
      this.content = newVal;
    });

    return el;
  }

  override getOutput(outputName = 'default'): unknown {
    if (outputName === 'default') {
      const textarea = this.element?.querySelector('textarea') as HTMLTextAreaElement | null;
      return textarea?.value?.trim() || this.content || '';
    }
    return null;
  }

  setText(text: string): void {
    this.content = text;
    const textarea = this.element?.querySelector('textarea') as HTMLTextAreaElement | null;
    if (textarea) textarea.value = text;
    this._pushToDownstream();
  }

  override onReceive(type: 'text' | 'image', data: unknown, source = 'upstream'): void {
    if (type === 'text' && data) {
      if (source === 'run') {
        const existing = (this.element?.querySelector('textarea') as HTMLTextAreaElement)?.value?.trim() || '';
        const newContent = existing ? `${existing}\n\n---\n\n${data}` : String(data);
        this.setText(newContent);
      } else {
        this.setText(String(data));
      }
    }
  }

  override serialize() {
    const base = super.serialize();
    const textarea = this.element?.querySelector('textarea') as HTMLTextAreaElement | null;
    return {
      ...base,
      content: textarea?.value ?? this.content ?? ''
    };
  }

  private _pushToDownstream(): void {
    const text = this.getOutput() as string;
    if (!text && text !== '') return;

    if (CardEventBus && CardEventBus.EventTypes) {
      CardEventBus.emit(CardEventBus.EventTypes.DATA_CHANGED, {
        cardId: this.id,
        type: 'text',
        data: text,
        source: 'upstream'
      });
    }
  }

  private _escapeHtml(str: string): string {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

