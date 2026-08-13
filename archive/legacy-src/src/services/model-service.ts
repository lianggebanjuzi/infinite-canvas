// src/services/model-service.ts
// 模型服务层：拉取模型、添加/删除对话模型、更新启用状态

import { API } from '../utils/api';
import { AppState } from '../state/app-state';

interface ModelInfo {
    id: string;
    name: string;
    type?: string;
    enabled?: boolean;
    category?: string;
}

interface FetchResult {
    status?: string;
    message?: string;
    models?: ModelInfo[];
}

export const ModelService = {

    async fetchDrawingModels(providerId: string): Promise<{
        status: string;
        models?: ModelInfo[];
        chatCount?: number;
        drawCount?: number;
        message?: string;
    }> {
        const provider = AppState.providers.list.find(p => p.id === providerId);
        if (!provider) {
            return { status: 'error', message: '供应商不存在' };
        }
        if (!provider.api_url || !provider.api_key) {
            return { status: 'error', message: '请先填写 API 地址和密钥' };
        }

        await API.updateProvider(providerId, {
            short_name: provider.short_name || '',
            api_key:    provider.api_key    || '',
            api_url:    provider.api_url    || '',
            enabled:    provider.enabled     || false,
            use_proxy:  provider.use_proxy   !== false
        });

        const result = await API.fetchModels(provider.api_url, provider.api_key) as FetchResult;

        if (result.status !== 'success') {
            return result as { status: string; message?: string };
        }

        const fetched     = (result.models || []) as Array<{ id: string; name: string; category?: string; type?: string; enabled?: boolean }>;
        const existing    = (provider.models || []) as Array<{ id: string; name: string; category?: string; type?: string; enabled?: boolean }>;
        const existingMap: Record<string, { id: string; name: string; category?: string; type?: string; enabled?: boolean }> = {};
        existing.forEach(m => { existingMap[m.id] = m; });

        const manualChatModels = existing.filter(m => m.type === 'chat');

        const mergedDrawing = fetched.map(m => ({
            id:      m.id,
            name:    m.name || m.id,
            type:    'drawing',
            enabled: existingMap[m.id]?.enabled ?? true
        }));

        const merged = [...manualChatModels, ...mergedDrawing];

        provider.models                  = merged;
        AppState.providers.fetchedModels = merged as unknown as typeof AppState.providers.fetchedModels;

        await API.updateProvider(providerId, { models: merged });

        return {
            status: 'success',
            models: merged,
            chatCount: manualChatModels.length,
            drawCount: mergedDrawing.length
        };
    },

    async addChatModel(providerId: string, modelId: string, modelName: string): Promise<{ status: string; message?: string }> {
        const provider = AppState.providers.list.find(p => p.id === providerId);
        if (!provider) {
            return { status: 'error', message: '供应商不存在' };
        }

        const result = await API.addChatModel(providerId, modelId, modelName);

        if (result.status === 'success') {
            if (!provider.models) provider.models = [];
            (provider.models as unknown as Array<{ id: string; name: string; type?: string; enabled?: boolean }>).unshift({
                id: modelId,
                name: modelName || modelId,
                type: 'chat',
                enabled: true
            });
        }

        return result;
    },

    async removeModel(providerId: string, modelId: string): Promise<{ status: string; message?: string }> {
        const provider = AppState.providers.list.find(p => p.id === providerId);
        if (!provider) {
            return { status: 'error', message: '供应商不存在' };
        }

        const result = await API.removeModel(providerId, modelId);

        if (result && result.status === 'success') {
            provider.models = (provider.models || []).filter(m => m.id !== modelId);
        }

        return result;
    },

    async updateModelEnabled(providerId: string, modelId: string, enabled: boolean): Promise<{ status: string; message?: string }> {
        const provider = AppState.providers.list.find(p => p.id === providerId);
        if (!provider || !provider.models) {
            return { status: 'error', message: '供应商不存在' };
        }

        const model = provider.models.find(m => m.id === modelId);
        if (!model) {
            return { status: 'error', message: '模型不存在' };
        }

        (model as unknown as { enabled?: boolean }).enabled = enabled;
        return await API.updateProvider(providerId, { models: provider.models });
    }
};

(window as unknown as { ModelService: typeof ModelService }).ModelService = ModelService;
