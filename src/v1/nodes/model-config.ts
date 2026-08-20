// src/v1/nodes/model-config.ts
// 模型配置：定义每个绘图模型支持的比例和分辨率

export interface ModelCapabilities {
  /** 模型支持的比例列表 */
  aspectRatios: string[];
  /** 模型支持的分辨率列表 */
  resolutions: string[];
  /** 默认比例 */
  defaultAspectRatio: string;
  /** 默认分辨率 */
  defaultResolution: string;
}

/** 模型名称关键词 -> 能力配置的映射 */
const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  // BananaPro (Gemini 3 Pro Image) - 支持10种比例 + Auto
  'gemini-3-pro-image': {
    aspectRatios: ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', 'Auto'],
    resolutions: ['1k', '2k', '4k'],
    defaultAspectRatio: '3:4',
    defaultResolution: '2k',
  },
  // Banana2 (Gemini 3.1 Flash Image) - 支持14种比例 + Auto
  'gemini-3.1-flash-image': {
    aspectRatios: ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '1:4', '4:1', '1:8', '8:1', 'Auto'],
    resolutions: ['512', '1k', '2k', '4k'],
    defaultAspectRatio: '3:4',
    defaultResolution: '2k',
  },
  // GPT Image 2：官方长短边比不得超过 3:1，故不暴露 1:4 / 4:1 / 1:8 / 8:1。
  'gpt-image': {
    aspectRatios: ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', 'Auto'],
    resolutions: ['1k', '2k', '4k'],
    defaultAspectRatio: '3:4',
    defaultResolution: '2k',
  },
  // Grok 图片模型 - 使用 OpenAI 协议，支持比例与 GPT 类似 + Auto
  'grok-imagine-image': {
    aspectRatios: ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '1:4', '4:1', '1:8', '8:1', 'Auto'],
    resolutions: ['1k', '2k', '4k'],
    defaultAspectRatio: '3:4',
    defaultResolution: '2k',
  },
};

/** 默认能力配置（未匹配到具体模型时使用） */
const DEFAULT_CAPABILITIES: ModelCapabilities = {
  aspectRatios: ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9', '2:3', '3:2', '4:5', '5:4', 'Auto'],
  resolutions: ['1k', '2k', '4k'],
  defaultAspectRatio: '3:4',
  defaultResolution: '2k',
};

/**
 * 根据模型ID获取该模型支持的能力配置
 * @param modelId 模型ID（如 "gemini-3-pro-image-preview" 或 "gpt-image-2"）
 * @returns 模型支持的比例和分辨率配置
 */
export function getModelCapabilities(modelId: string): ModelCapabilities {
  if (!modelId) return DEFAULT_CAPABILITIES;

  const lowerModelId = modelId.toLowerCase();

  // 精确匹配或前缀匹配
  for (const [keyword, capabilities] of Object.entries(MODEL_CAPABILITIES)) {
    if (lowerModelId.includes(keyword)) {
      return capabilities;
    }
  }

  // 未匹配到，返回默认配置
  return DEFAULT_CAPABILITIES;
}

/**
 * 检查模型是否支持指定的比例
 */
export function isAspectRatioSupported(modelId: string, aspectRatio: string): boolean {
  const capabilities = getModelCapabilities(modelId);
  return capabilities.aspectRatios.includes(aspectRatio);
}

/**
 * 检查模型是否支持指定的分辨率
 */
export function isResolutionSupported(modelId: string, resolution: string): boolean {
  const capabilities = getModelCapabilities(modelId);
  return capabilities.resolutions.includes(resolution);
}

/**
 * 获取模型支持的所有比例（按常用程度排序）
 */
export function getSupportedAspectRatios(modelId: string): string[] {
  return getModelCapabilities(modelId).aspectRatios;
}

/**
 * 获取模型支持的所有分辨率
 */
export function getSupportedResolutions(modelId: string): string[] {
  return getModelCapabilities(modelId).resolutions;
}
