// src/cards/ai-draw-bindings.ts
// AIDrawCard 事件绑定工具（与 this 解耦，纯函数）
// 4 个函数：prompt input / param buttons / topP input / generate button
// 每个函数接收 el（卡片 DOM 根）+ 必要的回调或 id 引用，不访问 this

import * as api from './ai-draw-api';

declare const PromptLibrary: { open(event: unknown, category: string, cb: (item: { content: string }) => void): void };
declare const Toast: { show(msg: string, dur?: number): void };

export function bindPromptInput(el: HTMLElement, onPromptChange: (val: string) => void): void {
  const textarea = el.querySelector('.ai-image-prompt') as HTMLTextAreaElement | null;
  if (!textarea) return;
  textarea.addEventListener('input', () => {
    onPromptChange(textarea.value);
  });
}

export function bindParamButtons(
  el: HTMLElement,
  cardId: string,
  onPromptAppend: (val: string) => void
): void {
  el.querySelectorAll('[data-param]').forEach(btn => {
    const b = btn as HTMLElement & { tagName: string };
    if (b.tagName === 'INPUT') return;

    const action = (btn as HTMLElement).dataset.action;

    if (action === 'promptLib') {
      btn.addEventListener('click', () => {
        PromptLibrary.open(null, 'draw', (item) => {
          const ta = el.querySelector('.ai-image-prompt') as HTMLTextAreaElement | null;
          if (!ta) return;
          const sep = ta.value ? ', ' : '';
          ta.value += sep + item.content;
          onPromptAppend(ta.value);
        });
      });
      return;
    }

    const param = (btn as HTMLElement).dataset.param;
    if (param) {
      btn.addEventListener('click', (e) => {
        api._showParamMenu(e as MouseEvent, cardId, param);
      });
    }
  });
}

export function bindTopPInput(el: HTMLElement, getCurrentTopP: () => number, onTopPChange: (val: number) => void): void {
  const input = el.querySelector('.ai-image-topp-input') as HTMLInputElement | null;
  if (!input) return;

  input.addEventListener('input', () => {
    const val = parseFloat(input.value);
    if (!isNaN(val)) {
      onTopPChange(Math.max(0, Math.min(1, val)));
    }
  });

  input.addEventListener('change', () => {
    const val = parseFloat(input.value);
    if (isNaN(val) || val < 0 || val > 1) {
      input.value = String(getCurrentTopP());
      Toast.show('topP 值需在 0.0 ~ 1.0 范围内');
    }
  });

  input.addEventListener('mousedown', e => e.stopPropagation());
}

export function bindGenerateButton(el: HTMLElement, cardId: string): void {
  const btn = el.querySelector('.ai-image-generate-btn') as HTMLElement | null;
  if (!btn) return;
  btn.addEventListener('click', () => {
    api.generate(cardId);
  });
}