// src/cards/agent-bindings.ts
// AgentCard 事件绑定 + UI 渲染工具（与 this 解耦）
// 5 个 _bindXxx + 1 个 _populateModelSelect 渲染
// 每个函数接收 el（卡片 DOM 根）+ 必要的回调或 id 引用，不访问 this

import * as api from './agent-api';

export function bindModelButton(el: HTMLElement, cardId: string): void {
  const btn = el.querySelector('[data-action="model"]');
  if (!btn) return;
  btn.addEventListener('click', (e) => { api._showModelMenu(e as unknown as MouseEvent, cardId); });
}

export function bindMetaPrompt(el: HTMLElement, onMetaPromptChange: (val: string) => void): void {
  const ta = el.querySelector('.agent-meta-prompt') as HTMLTextAreaElement | null;
  if (!ta) return;
  ta.addEventListener('input', () => { onMetaPromptChange(ta.value); });
}

export function bindLibButtons(el: HTMLElement, cardId: string): void {
  el.querySelectorAll('[data-action^="lib"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const category = (btn as HTMLElement).dataset.action === 'libSkill' ? 'skill' : 'common';
      api._openLib(e as unknown as MouseEvent, cardId, category);
    });
  });
}

export function bindUserInput(el: HTMLElement, onUserInputChange: (val: string) => void): void {
  const ta = el.querySelector('.agent-user-input') as HTMLTextAreaElement | null;
  if (!ta) return;
  ta.addEventListener('input', () => { onUserInputChange(ta.value); });
}

export function bindFooterButtons(el: HTMLElement, cardId: string): void {
  const runBtn = el.querySelector('[data-action="run"]');
  const copyBtn = el.querySelector('[data-action="copy"]');
  if (runBtn) runBtn.addEventListener('click', () => { api._run(cardId); });
  if (copyBtn) copyBtn.addEventListener('click', () => { api._copyOutput(cardId); });
}

export function populateModelSelect(
  el: HTMLElement,
  currentModel: string,
  chatModels: Array<{ id: string; name: string }>,
  fallbackDisplayName: (modelId: string) => string,
  setChatModels: (models: Array<{ id: string; name: string; providerName: string }>) => void
): Promise<void> {
  return (async () => {
    const btn = el.querySelector('[data-action="model"]');
    if (!btn) return;

    const models = await api._getChatModels();
    setChatModels(models);

    if (!currentModel) {
      btn.textContent = models.length > 0 ? '选择模型' : '暂无对话模型';
      return;
    }

    const hit = models.find(m => m.id === currentModel);
    btn.textContent = hit ? hit.name : fallbackDisplayName(currentModel);
  })();
}