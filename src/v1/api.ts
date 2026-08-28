// src/v1/api.ts
// backend 调用薄封装：基于 src/utils/api.ts 的 API 传输层扩展 + 错误映射
// 唯一允许拼接 backend options 的模块（nodes/* 只声明定义，engine 负责调用）

import { API } from '../utils/api';
import { DEFAULT_CHAT_MODEL_KEY } from './nodes/text-gen';

function isModelReady(provider: BackendProvider, key: BackendProviderKey, model: BackendModel, kind: 'chat' | 'drawing' | 'video'): boolean {
  const url = kind === 'chat' ? (provider.text_api_url || provider.api_url) : provider.api_url;
  // 密钥按能力类型取值：模型专用 → 同类型全局 → 旧配置迁移来的同类型账户通道。
  // 禁止直接回退 key.api_key，避免图像模型误用对话账户的通用 Key。
  const channel = key.channels?.[kind];
  const channelKey = channel?.enabled !== false ? channel?.api_key : '';
  const apiKey = model.api_key || provider.global_keys?.[kind] || channelKey;
  return Boolean(url?.trim()) && Boolean(apiKey?.trim());
}

/** 拉取可用绘图模型（三段 id 仅供路由；界面只展示模型名）。 */
export async function fetchImageModels(): Promise<Array<{ id: string; name: string }>> {
  try {
    const result = (await API.loadProviders()) as BackendProviderList;
    const providers = result?.providers || [];
    const models: Array<{ id: string; name: string }> = [];
    const seen = new Set<string>();
    providers.forEach(p => {
      if (!p.enabled) return;
      (p.keys || []).forEach(k => {
        if (k.enabled === false) return;
        (k.models || [])
          .filter(m => m.enabled !== false && m.type === 'drawing' && isModelReady(p, k, m, 'drawing'))
          .forEach(m => {
            // 相同模型只留一个可选项；完整路由 id 保留在 value，供后端优先命中并失败切换。
            if (seen.has(m.id)) return;
            seen.add(m.id);
            models.push({ id: `${p.id}:${k.id}:${m.id}`, name: m.name || m.id });
          });
      });
    });

    return models.length ? models : [{ id: '', name: '未找到绘图模型，请先在设置中配置' }];
  } catch {
    return [{ id: '', name: '加载失败' }];
  }
}

/** 拉取可用对话模型（三段 id 仅供路由；界面只展示模型名）。 */
export async function fetchChatModels(): Promise<Array<{ id: string; name: string }>> {
  try {
    const result = (await API.loadProviders()) as BackendProviderList;
    const providers = result?.providers || [];
    const models: Array<{ id: string; name: string }> = [];
    const seen = new Set<string>();
    providers.forEach(p => {
      if (!p.enabled) return;
      (p.keys || []).forEach(k => {
        if (k.enabled === false) return;
        (k.models || [])
          .filter(m => m.enabled !== false && m.type === 'chat' && isModelReady(p, k, m, 'chat'))
          .forEach(m => {
            if (seen.has(m.id)) return;
            seen.add(m.id);
            models.push({ id: `${p.id}:${k.id}:${m.id}`, name: m.name || m.id });
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

/** 拉取可用视频模型；只返回已启用且视频连接完整的三段路由 ID。 */
export async function fetchVideoModels(): Promise<Array<{ id: string; name: string }>> {
  try {
    const result = (await API.loadProviders()) as BackendProviderList;
    const models: Array<{ id: string; name: string }> = [];
    const seen = new Set<string>();
    (result?.providers || []).forEach(provider => {
      if (!provider.enabled) return;
      (provider.keys || []).forEach(key => {
        if (key.enabled === false) return;
        (key.models || []).filter(model => model.enabled !== false && model.type === 'video' && isModelReady(provider, key, model, 'video'))
          .forEach(model => {
            const id = `${provider.id}:${key.id}:${model.id}`;
            if (seen.has(id)) return;
            seen.add(id);
            models.push({ id, name: model.name || model.id });
          });
      });
    });
    return models.length ? models : [{ id: '', name: '未找到视频模型，请先在设置中配置' }];
  } catch {
    return [{ id: '', name: '加载失败' }];
  }
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
 * 三段 id 精确命中；旧两段 id 只在唯一匹配某把 Key 时才转换为三段，避免猜错账号组。
 * 未命中或有歧义时返回 ''。任何写回一律三段（惰性重写，旧 localStorage 逐步自愈）。
 */
function matchModelId(models: Array<{ id: string }>, saved: string): string {
  if (!saved) return '';
  if (models.some(m => m.id === saved)) return saved;
  const parts = saved.split(':');
  if (parts.length === 2) {
    const [pid, mid] = parts;
    const hits = models.filter(m => m.id.startsWith(`${pid}:`) && m.id.endsWith(`:${mid}`));
    if (hits.length === 1) return hits[0].id;
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

/**
 * 本地原图的浏览器直读地址。
 *
 * 预览大图不能再先把数十 MB 原图编码成 base64、穿过 pywebview 桥接后才交给
 * img 标签；WebView 与原图同为本地文件时，可直接让浏览器流式读取与解码。
 * 读取被宿主策略拦截时，调用方仍会回退 loadLocalImage 的旧桥接路径。
 */
export function localImageFileUrl(filePath: string, preferredUrl?: string): string {
  if (preferredUrl && preferredUrl.startsWith('file://')) return preferredUrl;
  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  return encodeURI(`file:///${normalized}`);
}

export const Backend = {
  // ── 提示词库 ──
  /** 读取持久化提示词库（由桌面端写入 prompts_library.json，而非浏览器临时存储）。 */
  async loadPromptsLibrary(): Promise<{ status?: string; data?: unknown; message?: string }> {
    return (await API.loadPromptsLibrary()) as { status?: string; data?: unknown; message?: string };
  },

  /** 保存提示词库。调用方需保留原有分类字段，避免覆盖内置素材。 */
  async savePromptsLibrary(data: unknown): Promise<{ status?: string; message?: string }> {
    return (await API.savePromptsLibrary(data)) as { status?: string; message?: string };
  },

  async savePromptCover(dataUrl: string, filename: string): Promise<{ status: string; path?: string; message?: string }> {
    return await API.savePromptCover(dataUrl, filename);
  },

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

  async generateImageEdit(prompt: string, options: Record<string, unknown>): Promise<BackendTaskCreate> {
    try {
      const res = await API.unifiedEditImage(prompt, options);
      if (!res || !res.task_id) throw new Error('图片编辑任务创建失败，未返回 task_id');
      return res as BackendTaskCreate;
    } catch (e) {
      throw new Error((e as Error).message || '图片编辑任务创建失败');
    }
  },

  async generateVideo(prompt: string, options: Record<string, unknown>): Promise<BackendVideoTaskCreate> {
    try {
      const res = await API.unifiedGenerateVideo(prompt, options);
      if (!res || !(res as BackendVideoTaskCreate).task_id) throw new Error('视频任务创建失败，未返回 task_id');
      return res as BackendVideoTaskCreate;
    } catch (e) {
      const err = e as { message?: string; error?: string };
      throw new Error(err.message || err.error || '视频任务创建失败');
    }
  },

  async getVideoTaskResult(taskId: string): Promise<BackendVideoTaskResult> {
    return (await API.unifiedGetVideoTaskResult(taskId)) as BackendVideoTaskResult;
  },

  // ── 本地图片（图片性能优化：查看大图按需取原图） ──
  /** 按本地绝对路径读取原图 → base64 data_url（pywebview 桥接；一次性，用完即弃不常驻） */
  async loadLocalImage(filePath: string): Promise<{ status: string; data_url?: string; message?: string }> {
    return (await API.loadLocalImage(filePath)) as { status: string; data_url?: string; message?: string };
  },

  /** 手动导入图片：原图落地、前端只保留缩略图；未设置保存目录时使用会话临时目录。 */
  async prepareImportedImage(imageData: string, filename?: string): Promise<{
    status: string; path?: string; url?: string; thumbnail_data_url?: string; saved_to_disk?: boolean; message?: string;
  }> {
    return await API.prepareImportedImage(imageData, filename);
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

  async loadProject(filePath: string): Promise<BackendProjectResult> {
    return (await API.loadProject(filePath)) as BackendProjectResult;
  },

  async revealProjectInFolder(filePath: string): Promise<{ status: string; message?: string }> {
    return await API.revealProjectInFolder(filePath);
  },

  // ── 全局工作流库（只存画布骨架，不属于任何单个项目） ──
  async loadWorkflows(): Promise<{ status: string; workflows?: unknown[]; message?: string }> {
    return await API.loadWorkflows();
  },

  async saveWorkflows(workflows: unknown[]): Promise<{ status: string; message?: string }> {
    return await API.saveWorkflows(workflows);
  },

  async appendHistory(entry: unknown): Promise<BackendHistoryResult> {
    return (await API.appendHistory(entry)) as BackendHistoryResult;
  },

  async loadHistory(): Promise<BackendHistoryResult> {
    return (await API.loadHistory()) as BackendHistoryResult;
  },

  // ── 资产库索引（添加素材/tags/category） ──
  async saveAssets(records: ImageAssetRecord[]): Promise<BackendAssetsResult> {
    return (await API.saveAssets(records)) as BackendAssetsResult;
  },

  async loadAssets(): Promise<BackendAssetsResult> {
    return (await API.loadAssets()) as BackendAssetsResult;
  },

  async previewBackup(options: Record<string, unknown> = {}): Promise<{ status: string; projects?: number; assets?: number; estimated_bytes?: number; threshold_bytes?: number; requires_media_choice?: boolean; message?: string }> {
    return await API.previewBackup(options);
  },
  async exportBackup(options: Record<string, unknown> = {}): Promise<{ status: string; path?: string; manifest?: unknown; message?: string }> {
    return await API.exportBackup(options);
  },
  async importBackup(options: Record<string, unknown> = {}): Promise<{ status: string; projects?: string[]; message?: string }> {
    return await API.importBackup(options);
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

  async loadRecentProjects(): Promise<{ status: string; projects?: RecentProject[]; message?: string }> {
    return await API.loadRecentProjects() as { status: string; projects?: RecentProject[]; message?: string };
  },
  async touchRecentProject(path: string, name: string, coverPath?: string): Promise<{ status: string; message?: string }> {
    return await API.touchRecentProject(path, name, coverPath);
  },
  async removeRecentProject(path: string): Promise<{ status: string; message?: string }> { return await API.removeRecentProject(path); },
  async renameRecentProject(path: string, name: string): Promise<{ status: string; message?: string }> { return await API.renameRecentProject(path, name); },
};
