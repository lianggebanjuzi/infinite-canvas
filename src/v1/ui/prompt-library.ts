// 4.3-A：提示词资产的单一、本地持久化数据源。
// localStorage 只用于把旧收藏迁移到 prompt_library.json；不再充当事实源。

import { Backend } from '../api';
import { showToast } from './toast';

const LIB_KEY = 'icv_prompt_library';

export interface PromptCard {
  id: string;
  title: string;
  prompt: string;
  summary?: string;
  categoryId?: string;
  tags: string[];
  coverPath?: string;
  favorite: boolean;
  createdAt: number;
  updatedAt: number;
  source: 'builtin' | 'user';
}

interface PromptLibraryData {
  version: number;
  categories: Array<{ id: string; name: string }>;
  cards: PromptCard[];
  hiddenBuiltinIds: string[];
}

const emptyLibrary = (): PromptLibraryData => ({ version: 2, categories: [], cards: [], hiddenBuiltinIds: [] });
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const stringList = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.map(text).filter(Boolean))] : [];
const timestamp = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
const titleFor = (prompt: string): string => prompt.replace(/\s+/g, ' ').slice(0, 40) || '未命名提示词';

function normalizeCard(value: unknown, fallback: number): PromptCard | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>; const prompt = text(raw.prompt) || text(raw.content);
  if (!prompt) return null;
  const result: PromptCard = {
    id: text(raw.id) || crypto.randomUUID(), title: text(raw.title) || text(raw.name) || titleFor(prompt), prompt,
    tags: stringList(raw.tags), favorite: Boolean(raw.favorite), createdAt: timestamp(raw.createdAt, fallback),
    updatedAt: timestamp(raw.updatedAt, fallback), source: raw.source === 'builtin' ? 'builtin' : 'user',
  };
  const summary = text(raw.summary); const categoryId = text(raw.categoryId); const coverPath = text(raw.coverPath);
  if (summary) result.summary = summary; if (categoryId) result.categoryId = categoryId; if (coverPath) result.coverPath = coverPath;
  return result;
}

function normalizeData(value: unknown): PromptLibraryData {
  const fallback = Date.now();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyLibrary();
  const raw = value as Record<string, unknown>;
  const cards = Array.isArray(raw.cards) ? raw.cards.map(item => normalizeCard(item, fallback)).filter((item): item is PromptCard => Boolean(item)) : [];
  return {
    version: 2,
    categories: Array.isArray(raw.categories) ? raw.categories
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      .map(item => ({ id: text(item.id), name: text(item.name) })).filter(item => item.id && item.name) : [],
    cards, hiddenBuiltinIds: stringList(raw.hiddenBuiltinIds),
  };
}

class PromptLibraryStore {
  private data: PromptLibraryData = emptyLibrary();
  private readyPromise: Promise<void> | null = null;
  private listeners = new Set<() => void>();

  ready(): Promise<void> { if (!this.readyPromise) this.readyPromise = this.load(); return this.readyPromise; }
  /** 兼容旧命令面板调用；新 UI 使用 listCards。 */
  list(): string[] { return this.listCards().map(card => card.prompt); }
  listCards(): PromptCard[] {
    const hidden = new Set(this.data.hiddenBuiltinIds);
    return this.data.cards.filter(card => card.source !== 'builtin' || !hidden.has(card.id))
      .slice().sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.updatedAt - a.updatedAt);
  }
  categories(): Array<{ id: string; name: string }> { return [...this.data.categories]; }
  contains(value: string): boolean { const prompt = text(value); return Boolean(prompt && this.listCards().some(card => card.prompt === prompt)); }
  get(id: string): PromptCard | undefined { return this.data.cards.find(card => card.id === id); }
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private notify(): void { this.listeners.forEach(fn => { try { fn(); } catch { /* isolate UI listener */ } }); }

  async savePrompt(value: string): Promise<boolean> {
    await this.ready(); const prompt = text(value);
    if (!prompt) { showToast('先输入提示词，再收藏到库中', false); return false; }
    if (this.contains(prompt)) { showToast('这条提示词已在库中', false); return false; }
    const now = Date.now();
    const card: PromptCard = { id: crypto.randomUUID(), title: titleFor(prompt), prompt, tags: [], favorite: true, createdAt: now, updatedAt: now, source: 'user' };
    this.data.cards.unshift(card);
    if (!await this.persist()) { this.data.cards = this.data.cards.filter(item => item.id !== card.id); return false; }
    this.notify(); showToast('已收藏到提示词库'); return true;
  }

  async upsert(input: Partial<PromptCard> & Pick<PromptCard, 'title' | 'prompt'>): Promise<PromptCard | null> {
    await this.ready(); const prompt = text(input.prompt); const title = text(input.title);
    if (!prompt || !title) { showToast('请填写标题和提示词', false); return null; }
    const current = input.id ? this.get(input.id) : undefined;
    if (input.id && !current) return null;
    if (current?.source === 'builtin') { showToast('内置卡不可编辑，可复制后修改', false); return null; }
    const now = Date.now(); const card: PromptCard = {
      id: current?.id || crypto.randomUUID(), title: title.slice(0, 120), prompt, summary: text(input.summary) || undefined,
      categoryId: text(input.categoryId) || undefined, tags: stringList(input.tags), coverPath: text(input.coverPath) || current?.coverPath,
      favorite: typeof input.favorite === 'boolean' ? input.favorite : (current?.favorite ?? false),
      createdAt: current?.createdAt || now, updatedAt: now, source: 'user',
    };
    if (!card.summary) delete card.summary; if (!card.categoryId) delete card.categoryId; if (!card.coverPath) delete card.coverPath;
    if (current) this.data.cards = this.data.cards.map(item => item.id === card.id ? card : item); else this.data.cards.unshift(card);
    if (!await this.persist()) { if (current) this.data.cards = this.data.cards.map(item => item.id === card.id ? current : item); else this.data.cards = this.data.cards.filter(item => item.id !== card.id); return null; }
    this.notify(); return card;
  }

  async duplicate(id: string): Promise<PromptCard | null> {
    const original = this.get(id); if (!original) return null;
    return this.upsert({ title: `${original.title} 副本`, prompt: original.prompt, summary: original.summary, categoryId: original.categoryId, tags: original.tags, coverPath: original.coverPath, favorite: original.favorite });
  }
  async toggleFavorite(id: string): Promise<boolean> {
    await this.ready(); const current = this.get(id); if (!current) return false;
    const previous = current.favorite; current.favorite = !previous; current.updatedAt = Date.now();
    if (!await this.persist()) { current.favorite = previous; return false; } this.notify(); return true;
  }
  async remove(id: string): Promise<boolean> {
    await this.ready(); const current = this.get(id); if (!current) return false;
    if (current.source === 'builtin') { if (!this.data.hiddenBuiltinIds.includes(id)) this.data.hiddenBuiltinIds.push(id); }
    else this.data.cards = this.data.cards.filter(card => card.id !== id);
    if (!await this.persist()) return false; this.notify(); return true;
  }
  async restoreBuiltinDefaults(): Promise<boolean> {
    await this.ready(); if (!this.data.hiddenBuiltinIds.length) return true;
    const previous = [...this.data.hiddenBuiltinIds]; this.data.hiddenBuiltinIds = [];
    if (!await this.persist()) { this.data.hiddenBuiltinIds = previous; return false; } this.notify(); return true;
  }
  async saveCover(dataUrl: string, filename: string): Promise<string | null> {
    await this.ready(); const result = await Backend.savePromptCover(dataUrl, filename);
    if (result.status !== 'success' || !result.path) { showToast(result.message || '封面未保存', false); return null; }
    return result.path;
  }
  private legacy(): string[] { try { return stringList(JSON.parse(localStorage.getItem(LIB_KEY) || '[]')); } catch { return []; } }
  private async load(): Promise<void> {
    const legacy = this.legacy();
    try {
      const result = await Backend.loadPromptsLibrary(); if (result.status !== 'success') throw new Error(result.message || '读取提示词库失败');
      this.data = normalizeData(result.data); const existing = new Set(this.data.cards.map(card => card.prompt)); const migrated = legacy.filter(prompt => !existing.has(prompt));
      if (migrated.length) { const now = Date.now(); this.data.cards.push(...migrated.map(prompt => ({ id: crypto.randomUUID(), title: titleFor(prompt), prompt, tags: [], favorite: true, createdAt: now, updatedAt: now, source: 'user' as const }))); await this.persist(); }
    } catch (error) {
      console.warn('加载持久化提示词库失败:', error); const now = Date.now();
      this.data.cards = legacy.map(prompt => ({ id: crypto.randomUUID(), title: titleFor(prompt), prompt, tags: [], favorite: true, createdAt: now, updatedAt: now, source: 'user' }));
    }
    this.notify();
  }
  private async persist(): Promise<boolean> {
    localStorage.setItem(LIB_KEY, JSON.stringify(this.listCards().filter(card => card.favorite).map(card => card.prompt)));
    try { const result = await Backend.savePromptsLibrary(this.data); if (result.status !== 'success') throw new Error(result.message || '保存提示词库失败'); return true; }
    catch (error) { console.warn('保存持久化提示词库失败:', error); showToast('提示词库未保存，请检查桌面端服务后重试', false); return false; }
  }
}

export const promptLibraryStore = new PromptLibraryStore();
