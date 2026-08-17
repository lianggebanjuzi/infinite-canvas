// src/v1/api.ts
// backend 调用薄封装：基于 src/utils/api.ts 的 API 传输层扩展 + 错误映射
// 唯一允许拼接 backend options 的模块（nodes/* 只声明定义，engine 负责调用）

import { API } from '../utils/api';
import { DEFAULT_CHAT_MODEL_KEY } from './nodes/text-gen';

/** 拉取可用的绘图模型列表（三层遍历：enabled provider → enabled key → enabled drawing model；三段 id）。
 * label 简化：`${供应商短名} - ${模型名}`（去 key 名）；跨 key 重名模型按 `${p.id}:${m.id}` 去重，
 * 只保留第一个 enabled key 条目（id 路由到该 key；后端 keys[] 与三段解析零改动）。 */
export async function fetchImageModels(): Promise<Array<{ id: string; name: string }>> {
  try {
    const result = (await API.loadProviders()) as BackendProviderList;
    const providers = result?.providers || [];
    const models: Array<{ id: string; name: string }> = [];
    const seen = new Set<string>();
    providers.forEach(p => {
      if (!p.enabled) return;
      const displayName = p.short_name || p.name.slice(0, 6);
      (p.keys || []).forEach(k => {
        if (k.enabled === false) return;
        (k.models || [])
          .filter(m => m.enabled !== false && m.type === 'drawing')
          .forEach(m => {
            const dedupeKey = `${p.id}:${m.id}`;
            if (seen.has(dedupeKey)) return; // 跨 key 重名去重：保留第一个 enabled key 条目
            seen.add(dedupeKey);
            // 三段式完整 id：${providerId}:${keyId}:${modelId}；label 去 key 名
            models.push({ id: `${p.id}:${k.id}:${m.id}`, name: `${displayName} - ${m.name}` });
          });
      });
    });

    return models.length ? models : [{ id: '', name: '未找到绘图模型，请先在设置中配置' }];
  } catch {
    return [{ id: '', name: '加载失败' }];
  }
}

/** 拉取可用的对话模型列表（text-gen 专用：与 fetchImageModels 同构，过滤 type==='chat'；label 简化 + 重名去重） */
export async function fetchChatModels(): Promise<Array<{ id: string; name: string }>> {
  try {
    const result = (await API.loadProviders()) as BackendProviderList;
    const providers = result?.providers || [];
    const models: Array<{ id: string; name: string }> = [];
    const seen = new Set<string>();
    providers.forEach(p => {
      if (!p.enabled) return;
      const displayName = p.short_name || p.name.slice(0, 6);
      (p.keys || []).forEach(k => {
        if (k.enabled === false) return;
        (k.models || [])
          .filter(m => m.enabled !== false && m.type === 'chat')
          .forEach(m => {
            const dedupeKey = `${p.id}:${m.id}`;
            if (seen.has(dedupeKey)) return; // 跨 key 重名去重：保留第一个 enabled key 条目
            seen.add(dedupeKey);
            models.push({ id: `${p.id}:${k.id}:${m.id}`, name: `${displayName} - ${m.name}` });
          });
      });
    });

    return models.length ? models : [{ id: '', name: '未找到对话模型，请先在设置中配置' }];
  } catch {
    return [{ id: '', name: '加载失败' }];
  }
}

const DEFAULT_MODEL_KEY = 'icv_default_model';

/** gemini / nano-banana / seedream 系模型判定（小写包含匹配）：扩图必须走 gemini_native 系（gpt-image/dall-e 忽略参考图，不能用） */
function isGeminiFamily(text: string): boolean {
  const t = (text || '').toLowerCase();
  return /gemini/.test(t) || /nano[-_]?banana/.test(t) || /seedream/.test(t);
}

/**
 * 判定完整模型 id（"provider:key:model" / 旧两段 "provider:model" / 裸 model id）是否属于
 * gemini/nano-banana/seedream 系。只检查冒号后的模型段，避免 provider id 误命中。
 */
export function isGeminiImageModel(modelId: string): boolean {
  if (!modelId) return false;
  const bare = modelId.split(':').pop() || '';
  return isGeminiFamily(bare);
}

/** 拉取可用的扩图模型（gemini/nano-banana/seedream 系 drawing 模型；不暴露选择 UI，自动解析用） */
export async function fetchOutpaintModels(): Promise<Array<{ id: string; name: string }>> {
  const models = await fetchImageModels();
  return models.filter(m => isGeminiImageModel(m.id) || isGeminiFamily(m.name));
}

/**
 * 解析扩图模型（不暴露选择 UI，弹层打开时调用）：
 * ① 节点当前 params.model（若属 gemini/nano-banana/seedream 系）→ ② fetchOutpaintModels() 第一个
 * → ③ 返回 ''（调用方 toast「请先在设置中配置 Nano Banana 系列模型」并禁用确认按钮）。
 */
export async function resolveOutpaintModel(node: FlowNode | null | undefined): Promise<string> {
  if (node) {
    const cur = (node.params?.model as string | undefined) || '';
    if (cur && isGeminiImageModel(cur)) return cur;
  }
  const models = await fetchOutpaintModels();
  return models.length > 0 && models[0].id ? models[0].id : '';
}

/**
 * 宽容匹配模型 id（multi-key）：
 * 三段 id 精确命中；旧两段 id（provider:model）在已过滤的模型列表中找同名模型并返回三段 id；
 * 未命中返回 ''。任何写回一律三段（惰性重写，旧 localStorage 逐步自愈）。
 */
function matchModelId(models: Array<{ id: string }>, saved: string): string {
  if (!saved) return '';
  if (models.some(m => m.id === saved)) return saved;
  const parts = saved.split(':');
  if (parts.length === 2) {
    const [pid, mid] = parts;
    const hit = models.find(m => m.id.startsWith(`${pid}:`) && m.id.endsWith(`:${mid}`));
    if (hit) return hit.id;
  }
  return '';
}

/** 解析默认绘图模型：localStorage 宽容解析（旧两段 id 惰性重写为三段）+ 回退第一个可用模型并记忆 */
export async function resolveDefaultModel(): Promise<string> {
  const models = await fetchImageModels();
  const fallback = models.length > 0 && models[0].id ? models[0].id : '';
  const saved = localStorage.getItem(DEFAULT_MODEL_KEY);
  if (saved) {
    const resolved = matchModelId(models, saved);
    if (resolved) {
      if (resolved !== saved) localStorage.setItem(DEFAULT_MODEL_KEY, resolved);
      return resolved;
    }
  }
  if (fallback) localStorage.setItem(DEFAULT_MODEL_KEY, fallback);
  return fallback;
}

/** 解析默认对话模型（text-gen 专用）：与 resolveDefaultModel 同构（icv_default_chat_model） */
export async function resolveDefaultChatModel(): Promise<string> {
  const models = await fetchChatModels();
  const fallback = models.length > 0 && models[0].id ? models[0].id : '';
  const saved = localStorage.getItem(DEFAULT_CHAT_MODEL_KEY);
  if (saved) {
    const resolved = matchModelId(models, saved);
    if (resolved) {
      if (resolved !== saved) localStorage.setItem(DEFAULT_CHAT_MODEL_KEY, resolved);
      return resolved;
    }
  }
  if (fallback) localStorage.setItem(DEFAULT_CHAT_MODEL_KEY, fallback);
  return fallback;
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

  // ── 本地图片（图片性能优化：查看大图按需取原图） ──
  /** 按本地绝对路径读取原图 → base64 data_url（pywebview 桥接；一次性，用完即弃不常驻） */
  async loadLocalImage(filePath: string): Promise<{ status: string; data_url?: string; message?: string }> {
    return (await API.loadLocalImage(filePath)) as { status: string; data_url?: string; message?: string };
  },

  // ── 对话链路（text-gen 专用：同步阻塞，无 task 轮询） ──
  /**
   * 统一对话（chat_v2）：同步调用，直接返回反推文本。
   * 成功响应 {success:true, text}；失败响应 {success:false, error_code, message} 抛 Error(message)。
   * images 只传 data:image 前缀（后端 chat_v2 会静默丢弃其它引用，前端防御性过滤）。
   */
  async chatV2(userInput: string, options: Record<string, unknown> = {}): Promise<{ success: boolean; text: string }> {
    try {
      const safeOptions: Record<string, unknown> = { ...options };
      if (Array.isArray(safeOptions.images)) {
        safeOptions.images = (safeOptions.images as unknown[]).filter(
          img => typeof img === 'string' && img.startsWith('data:image'),
        );
      }
      const res = await API.unifiedChatV2(userInput, safeOptions);
      if (res && (res as { success?: boolean }).success === false) {
        const err = res as { error_code?: number; message?: string; error?: string };
        throw new Error(err.message || err.error || '对话请求失败');
      }
      const text = ((res as { text?: unknown } | undefined)?.text as string) || '';
      return { success: true, text };
    } catch (e) {
      const err = e as { error_code?: number; message?: string; error?: string };
      throw new Error(err.message || err.error || (e as Error).message || '对话请求失败');
    }
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

  async appendHistory(entry: unknown): Promise<BackendHistoryResult> {
    return (await API.appendHistory(entry)) as BackendHistoryResult;
  },

  async loadHistory(): Promise<BackendHistoryResult> {
    return (await API.loadHistory()) as BackendHistoryResult;
  },

  // ── 可变资产索引（采纳/锁定/tags/category） ──
  async saveAssets(records: ImageAssetRecord[]): Promise<BackendAssetsResult> {
    return (await API.saveAssets(records)) as BackendAssetsResult;
  },

  async loadAssets(): Promise<BackendAssetsResult> {
    return (await API.loadAssets()) as BackendAssetsResult;
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

  // ── 多 Key（multi-key：每个 Key 独立模型组） ──
  async addKey(providerId: string, keyName = ''): Promise<{
    status: string;
    key_id?: string;
    key?: BackendProviderKey;
    keys?: BackendProviderKey[];
    message?: string;
  }> {
    return (await API.addKey(providerId, keyName)) as {
      status: string;
      key_id?: string;
      key?: BackendProviderKey;
      keys?: BackendProviderKey[];
      message?: string;
    };
  },

  async deleteKey(providerId: string, keyId: string): Promise<{
    status: string;
    keys?: BackendProviderKey[];
    message?: string;
  }> {
    return (await API.deleteKey(providerId, keyId)) as {
      status: string;
      keys?: BackendProviderKey[];
      message?: string;
    };
  },

  async updateKey(providerId: string, keyId: string, updates: Record<string, unknown>): Promise<{
    status: string;
    key?: BackendProviderKey;
    keys?: BackendProviderKey[];
    message?: string;
  }> {
    return (await API.updateKey(providerId, keyId, updates)) as {
      status: string;
      key?: BackendProviderKey;
      keys?: BackendProviderKey[];
      message?: string;
    };
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

  async removeModel(providerId: string, keyId: string, modelId: string): Promise<{ status: string; message?: string }> {
    return await API.removeModel(providerId, keyId, modelId);
  },

  // ── 设置（incremental-3：图片保存路径配置区用；settings-panel.ts 调用） ──
  async loadSettings(): Promise<BackendSettings> {
    return (await API.loadSettings()) as BackendSettings;
  },

  async saveSettings(settings: Record<string, unknown>): Promise<{ status: string; message?: string }> {
    return (await API.saveSettings(settings)) as { status: string; message?: string };
  },

  async selectFolder(): Promise<{ status: string; path?: string; message?: string }> {
    return (await API.selectFolder()) as { status: string; path?: string; message?: string };
  },
};
