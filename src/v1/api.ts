// src/v1/api.ts
// backend 调用薄封装：基于 src/utils/api.ts 的 API 传输层扩展 + 错误映射
// 唯一允许拼接 backend options 的模块（nodes/* 只声明定义，engine 负责调用）

import { API } from '../utils/api';
import { _getImageModels } from '../cards/ai-draw-api';

/** 拉取可用的绘图模型列表（复用 ai-draw-api 核心资产） */
export function fetchImageModels(): Promise<Array<{ id: string; name: string }>> {
  return _getImageModels();
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

/** 把 backend 响应映射为 FlowError（对应 backend/api/errors.py 分层） */
export function toFlowError(response: unknown): FlowError {
  const r = (response || {}) as { error_code?: number; message?: string; error?: string; success?: boolean };
  const code = r.error_code ?? 500;
  const message = r.message || r.error || '操作失败，请重试';
  return { code, message };
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

  // ── 图片落盘 ──
  async saveImageToLocal(imageData: string): Promise<BackendSaveImageResult> {
    return (await API.saveImageToLocal(imageData)) as BackendSaveImageResult;
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

  async loadProject(path: string): Promise<BackendProjectResult> {
    return (await API.loadProject(path)) as BackendProjectResult;
  },

  async getCurrentProjectPath(): Promise<{ path?: string }> {
    return (await API.getCurrentProjectPath()) as { path?: string };
  },

  // ── 供应商/设置 ──
  async loadProviders(): Promise<BackendProviderList> {
    return (await API.loadProviders()) as BackendProviderList;
  },

  async addProvider(name: string, type: string, shortName = ''): Promise<{ status: string; id?: string }> {
    return await API.addProvider(name, type, shortName);
  },

  async updateProvider(providerId: string, updates: Record<string, unknown>): Promise<{ status: string }> {
    return await API.updateProvider(providerId, updates);
  },

  async deleteProvider(providerId: string): Promise<{ status: string }> {
    return await API.deleteProvider(providerId);
  },

  async loadSettings(): Promise<BackendSettings> {
    return (await API.loadSettings()) as BackendSettings;
  },

  async saveSettings(settings: Record<string, unknown>): Promise<{ status: string }> {
    return await API.saveSettings(settings);
  },
};
