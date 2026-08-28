// 4.3-A 左侧资源抽屉的视觉提示词卡。与命令面板共用 promptLibraryStore，
// 不创建第二份收藏或浏览器数据源。

import { promptLibraryStore, type PromptCard } from './prompt-library';
import { cmdPanel } from './cmd-panel';
import { copyText } from './clipboard';
import { showToast } from './toast';
import { flowState } from '../state/flow-state';
import { flowHistory } from '../state/history';
import { selection } from '../state/selection';
import { canvasView } from '../canvas/canvas-view';

const coverUrl = (path?: string): string => path ? encodeURI(`file:///${path.replace(/\\/g, '/').replace(/^\/+/, '')}`) : '';

class PromptTab {
  private list: HTMLElement | null = null;
  private emptyEl: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private saveBtn: HTMLElement | null = null;
  private query = '';
  private inited = false;

  init(): void {
    if (this.inited) return; this.inited = true;
    this.list = document.getElementById('prompt-tab-list'); this.emptyEl = document.getElementById('prompt-tab-empty');
    this.searchInput = document.getElementById('prompt-search') as HTMLInputElement | null; this.saveBtn = document.getElementById('prompt-tab-save');
    this.searchInput?.addEventListener('input', () => { this.query = (this.searchInput?.value || '').trim().toLowerCase(); this.render(); });
    this.saveBtn?.addEventListener('click', () => void this.createFromCurrent());
    promptLibraryStore.subscribe(() => this.render()); this.render(); void promptLibraryStore.ready();
  }
  refresh(): void { this.render(); }
  count(): number { return this.filtered().length; }
  private filtered(): PromptCard[] {
    const cards = promptLibraryStore.listCards(); if (!this.query) return cards;
    return cards.filter(card => [card.title, card.prompt, card.summary || '', ...card.tags].join(' ').toLowerCase().includes(this.query));
  }
  private render(): void {
    if (!this.list) return; const cards = this.filtered(); this.list.replaceChildren();
    if (!cards.length) {
      this.list.style.display = 'none'; if (this.emptyEl) { this.emptyEl.textContent = this.query ? '没有找到匹配的提示词卡' : '还没有提示词卡\n收藏当前输入，或新建一张卡开始整理灵感。'; this.emptyEl.style.display = 'block'; } return;
    }
    this.list.style.display = 'flex'; if (this.emptyEl) this.emptyEl.style.display = 'none';
    cards.forEach(card => this.list!.appendChild(this.renderCard(card)));
  }
  private renderCard(card: PromptCard): HTMLElement {
    const item = document.createElement('article'); item.className = 'prompt-tab-item prompt-card'; item.title = card.prompt;
    const cover = document.createElement('div'); cover.className = 'prompt-card-cover';
    const url = coverUrl(card.coverPath); if (url) cover.style.backgroundImage = `url('${url.replace(/'/g, "%27")}')`; else cover.textContent = card.title.slice(0, 1).toUpperCase() || 'P';
    const body = document.createElement('div'); body.className = 'prompt-card-body';
    const title = document.createElement('strong'); title.className = 'prompt-card-title'; title.textContent = card.title;
    const summary = document.createElement('div'); summary.className = 'prompt-tab-item-text'; summary.textContent = card.summary || card.prompt;
    body.append(title, summary);
    if (card.tags.length) { const tags = document.createElement('div'); tags.className = 'prompt-card-tags'; card.tags.slice(0, 4).forEach(tag => { const chip = document.createElement('span'); chip.textContent = `#${tag}`; tags.appendChild(chip); }); body.appendChild(tags); }
    const actions = document.createElement('div'); actions.className = 'prompt-tab-item-actions prompt-card-actions';
    actions.append(
      this.button('替换', '替换当前提示词', () => this.replace(card.prompt)),
      this.button('追加', '追加到当前提示词', () => this.append(card.prompt)),
      this.button('文本节点', '作为静态文本节点放入画布', () => this.asTextNode(card)),
      this.button('复制', '复制提示词', () => void this.copy(card.prompt)),
      this.button(card.favorite ? '★' : '☆', '收藏', () => void promptLibraryStore.toggleFavorite(card.id)),
    );
    if (card.source === 'user') actions.append(this.button('编辑', '编辑卡片', () => void this.openEditor(card)));
    else actions.append(this.button('副本', '复制为可编辑用户卡', () => void promptLibraryStore.duplicate(card.id)));
    actions.append(this.button('删除', card.source === 'builtin' ? '隐藏内置卡' : '删除卡片', () => void this.remove(card)));
    item.append(cover, body, actions); return item;
  }
  private button(label: string, title: string, action: () => void): HTMLButtonElement {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'prompt-tab-act'; button.textContent = label; button.title = title;
    button.addEventListener('click', event => { event.stopPropagation(); action(); }); return button;
  }
  private replace(prompt: string): void { cmdPanel.insertPromptToCurrent(prompt); showToast('已替换当前提示词'); }
  private append(prompt: string): void {
    const prior = cmdPanel.getCurrentPrompt().trim(); cmdPanel.insertPromptToCurrent(prior ? `${prior}${prior.endsWith(',') ? ' ' : ', '}${prompt}` : prompt); showToast('已追加到当前提示词');
  }
  private asTextNode(card: PromptCard): void {
    const rect = canvasView.wrap?.getBoundingClientRect(); const point = rect ? canvasView.toWorldCoords(rect.left + rect.width / 2, rect.top + rect.height / 2) : { x: 480, y: 320 };
    flowHistory.record(); const node = flowState.addNode('text-gen', point.x - 180, point.y - 80, { title: card.title, outputText: card.prompt, status: 'done' }); selection.select(node.id); showToast('已放入画布；不会自动运行模型');
  }
  private async copy(prompt: string): Promise<void> { const ok = await copyText(prompt); showToast(ok ? '提示词已复制' : '复制失败', ok); }
  private async remove(card: PromptCard): Promise<void> {
    if (!window.confirm(card.source === 'builtin' ? '隐藏这张内置卡？可通过“恢复内置卡”找回。' : `删除“${card.title}”？`)) return;
    if (await promptLibraryStore.remove(card.id)) showToast(card.source === 'builtin' ? '已隐藏内置卡' : '已删除提示词卡');
  }
  private async createFromCurrent(): Promise<void> { const prompt = cmdPanel.getCurrentPrompt().trim(); await this.openEditor(undefined, prompt); }
  private async openEditor(card?: PromptCard, initialPrompt = ''): Promise<void> {
    const title = window.prompt('标题', card?.title || titleFor(initialPrompt)); if (title === null) return;
    const prompt = window.prompt('提示词内容', card?.prompt || initialPrompt); if (prompt === null) return;
    const summary = window.prompt('摘要（可选）', card?.summary || ''); if (summary === null) return;
    const tags = window.prompt('标签，以逗号分隔（可选）', card?.tags.join(', ') || ''); if (tags === null) return;
    let coverPath = card?.coverPath;
    if (window.confirm('要替换封面吗？（取消则保留现有封面）')) {
      const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp,image/gif';
      const selected = await new Promise<File | null>(resolve => { input.addEventListener('change', () => resolve(input.files?.[0] || null), { once: true }); input.click(); });
      if (selected) { const dataUrl = await readFile(selected); coverPath = await promptLibraryStore.saveCover(dataUrl, selected.name) || coverPath; }
    }
    const saved = await promptLibraryStore.upsert({ id: card?.id, title, prompt, summary, tags: tags.split(',').map(tag => tag.trim()).filter(Boolean), coverPath, favorite: card?.favorite ?? true });
    if (saved) showToast(card ? '提示词卡已更新' : '提示词卡已创建');
  }
}

function titleFor(prompt: string): string { return prompt.replace(/\s+/g, ' ').slice(0, 40) || '未命名提示词'; }
function readFile(file: File): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('封面读取失败')); reader.onerror = () => reject(reader.error || new Error('封面读取失败')); reader.readAsDataURL(file); }); }

export const promptTab = new PromptTab();
