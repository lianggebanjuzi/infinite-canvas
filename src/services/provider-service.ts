// src/services/provider-service.ts
// 供应商服务层：加载、添加、更新、删除、连接测试

import { API } from '../utils/api';
import { AppState } from '../state/app-state';

declare const Toast: { show(message: string, duration?: number): void };

export interface ProviderUpdate {
    short_name?: string;
    api_key?: string;
    api_url?: string;
    enabled?: boolean;
    use_proxy?: boolean;
    models?: unknown[];
    [key: string]: unknown;
}

export const ProviderService = {

    async loadProviders() {
        const result = await API.loadProviders();
        if (result && result.providers) {
            AppState.providers.list = result.providers as typeof AppState.providers.list;
        }
        return result;
    },

    async addProvider(name: string, type: string, shortName = ''): Promise<{ status: string; id?: string }> {
        const result = await API.addProvider(name, type, shortName);
        if (result.status === 'success') {
            await this.loadProviders();
        }
        return result;
    },

    async updateProvider(providerId: string, updates: ProviderUpdate): Promise<{ status: string }> {
        const result = await API.updateProvider(providerId, updates);
        if (result && result.status === 'success') {
            const provider = AppState.providers.list.find(p => p.id === providerId);
            if (provider) {
                Object.assign(provider, updates);
            }
        }
        return result;
    },

    async deleteProvider(providerId: string): Promise<{ status: string }> {
        const result = await API.deleteProvider(providerId);
        if (result && result.status === 'success') {
            AppState.providers.list = AppState.providers.list.filter(p => p.id !== providerId);
        }
        return result;
    },

    async testConnection(apiUrl: string, apiKey: string): Promise<{ success: boolean; message: string }> {
        return await API.testConnection(apiUrl, apiKey);
    }
};

(window as unknown as { ProviderService: typeof ProviderService }).ProviderService = ProviderService;
