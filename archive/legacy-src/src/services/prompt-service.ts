// src/services/prompt-service.ts
// 提示词库服务层：加载、保存、增删查

import { API } from '../utils/api';

declare const Toast: { show(message: string, duration?: number): void };

interface PromptLibrary {
    common: Array<{ id: string; name: string; content: string }>;
    skill:  Array<{ id: string; name: string; content: string }>;
    draw:   Array<{ id: string; name: string; content: string }>;
    [category: string]: Array<{ id: string; name: string; content: string }>;
}

type Category = 'common' | 'skill' | 'draw';

export const PromptService = {

    _data: null as PromptLibrary | null,

    async load(): Promise<PromptLibrary> {
        if (this._data) return this._data;
        try {
            const result = await API.loadPromptsLibrary() as unknown as { status?: string; data?: PromptLibrary };
            if (result.status === 'success') {
                this._data = result.data as PromptLibrary;
            } else {
                this._data = { common: [], skill: [], draw: [] };
            }
        } catch (e) {
            console.error('[PromptService] 加载失败:', e);
            this._data = { common: [], skill: [], draw: [] };
        }
        return this._data;
    },

    async save(): Promise<void> {
        if (!this._data) return;
        try {
            await API.savePromptsLibrary(this._data);
        } catch (e) {
            console.error('[PromptService] 保存失败:', e);
            Toast.show('提示词库保存失败');
        }
    },

    async addItem(category: Category, name: string, content: string): Promise<string> {
        const data = await this.load();
        if (!data[category]) data[category] = [];
        const id = `${category[0]}${Date.now()}`;
        data[category].push({ id, name, content });
        await this.save();
        return id;
    },

    async removeItem(category: Category, id: string): Promise<void> {
        const data = await this.load();
        if (!data[category]) return;
        data[category] = data[category].filter(item => item.id !== id);
        await this.save();
    },

    async getItems(category: Category): Promise<Array<{ id: string; name: string; content: string }>> {
        const data = await this.load();
        return data[category] || [];
    }
};

(window as unknown as { PromptService: typeof PromptService }).PromptService = PromptService;
