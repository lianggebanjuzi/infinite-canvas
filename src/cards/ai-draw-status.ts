// src/cards/ai-draw-status.ts
// AIDrawCard 生成状态 UI 工具（与 this 解耦，纯函数）
// 4 个函数：show / update / clear status + update generate button
// 调用方只需传入 el（卡片 DOM 根），函数内部用选择器找子节点

export function showGeneratingStatus(el: HTMLElement, count: number): HTMLElement | null {
  const area = el.querySelector('.ai-image-prompt-area') as HTMLElement | null;
  if (!area) return null;

  let statusDiv = el.querySelector('.ai-generating-status') as HTMLElement | null;
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

export function updateGeneratingStatus(el: HTMLElement, completed: number, total: number): void {
  const div = el.querySelector('.ai-generating-status div:last-child') as HTMLElement | null;
  if (div) div.textContent = `正在生成图片... (${completed}/${total})`;
}

export function clearGeneratingStatus(el: HTMLElement): void {
  el.querySelector('.ai-generating-status')?.remove();
}

export function updateGenerateButton(el: HTMLElement, isGenerating: boolean): void {
  const btn = el.querySelector('.ai-image-generate-btn') as HTMLElement | null;
  if (!btn) return;
  btn.innerHTML = isGenerating ? '停止' : '生成';
}