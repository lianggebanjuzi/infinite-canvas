// src/v1/api.ts
// backend 调用薄封装：基于 src/utils/api.ts 的 API 传输层扩展 + 错误映射
// 唯一允许拼接 backend options 的模块（nodes/* 只声明定义，engine 负责调用）

import { API } from '../utils/api';

/** 拉取可用的绘图模型列表（原 src/cards/ai-draw-api._getImageModels 内联：API.loadProviders + enabled/drawing 过滤 + `${providerId}:${modelId}` 拼接） */
export async function fetchImageModels(): Promise<Array<{ id: string; name: string }>> {
  try {
    const result = (await API.loadProviders()) as BackendProviderList;
    const providers = result?.providers || [];
    const models: Array<{ id: string; name: string }> = [];

    providers.forEach(p => {
      if (!p.enabled) return;
      const displayName = p.short_name || p.name.slice(0, 6);
      (p.models || [])
        .filter(m => m.enabled !== false && m.type === 'drawing')
        .forEach(m => {
          models.push({ id: `${p.id}:${m.id}`, name: `${displayName} - ${m.name}` });
        });
    });

    return models.length ? models : [{ id: '', name: '未找到绘图模型，请先在设置中配置' }];
  } catch {
    return [{ id: '', name: '加载失败' }];
  }
}

const DEFAULT_MODEL_KEY = 'icv_default_model';

/** 解析默认绘图模型：优先 localStorage，否则取第一个可用模型并记忆 */
export async function resolveDefaultModel(): Promise<string> {
  const saved = localStorage.getItem(DEFAULT_MODEL_KEY);
  if (saved) return saved;
  const models = await fetchImageModels();
  if (models.length > 0 && models[0].id) {
    localStorage.setItem(DEFAULT_MODEL_KEY, models[0].id);
    return models[0].id;
  }
  return '';
}

export const Backend = {
  // ── 生成链路 ──
  async generateImage(prompt: string, options: Record<string, unknown>): Promise<BackendTaskCreate> {
    try {
      const res = await API.unifiedGenerateImage(prompt, options);
      // 后端失败响应形如 {success:false, error_code, message}
      if (res && (res as { success?: boolean }).success === false) {
        const err = res as { error_code?: number; message?: string; error?: string };
        throw new Error(err.message || err.error || '生成请求失败');
      }
      if (!res || !res.task_id) throw new Error('任务创建失败，未返回 task_id');
      return res as BackendTaskCreate;
    } catch (e) {
      const err = e as { error_code?: number; message?: string; error?: string };
      throw new Error(err.message || err.error || (e as Error).message || '生成请求失败');
    }
  },

  async getTaskResult(taskId: string): Promise<BackendTaskResult> {
    return (await API.unifiedGetTaskResult(taskId)) as BackendTaskResult;
  },

  // ── 项目 ──
  async saveProject(data: unknown): Promise<BackendProjectResult> {
    return (await API.saveProject(data)) as BackendProjectResult;
  },

  async saveProjectAs(data: unknown): Promise<BackendProjectResult> {
    return (await API.saveProjectAs(data)) as BackendProjectResult;
  },

  async openProject(): Promise<BackendProjectResult> {
    return (await API.openProject()) as BackendProjectResult;
  },

  // ── 供应商/设置 ──
  async loadProviders(): Promise<BackendProviderList> {
    return (await API.loadProviders()) as BackendProviderList;
  },

  async addProvider(name: string, type: string, shortName = ''): Promise<{
    status: string;
    id?: string;
    provider_id?: string;
    provider?: BackendProvider;
    message?: string;
  }> {
    return await API.addProvider(name, type, shortName);
  },

  async updateProvider(providerId: string, updates: Record<string, unknown>): Promise<{ status: string; message?: string }> {
    return await API.updateProvider(providerId, updates);
  },

  async deleteProvider(providerId: string): Promise<{ status: string; message?: string }> {
    return await API.deleteProvider(providerId);
  },

  async fetchModels(apiUrl: string, apiKey: string): Promise<{ status?: string; message?: string; models?: BackendModel[] }> {
    return (await API.fetchModels(apiUrl, apiKey)) as { status?: string; message?: string; models?: BackendModel[] };
  },

  async testConnection(apiUrl: string, apiKey: string): Promise<{ success: boolean; message: string }> {
    return await API.testConnection(apiUrl, apiKey);
  },

  async removeModel(providerId: string, modelId: string): Promise<{ status: string; message?: string }> {
    return await API.removeModel(providerId, modelId);
  },
};
