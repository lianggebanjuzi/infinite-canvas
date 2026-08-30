// src/v1/nodes/model-config.ts
// 模型配置：定义每个绘图模型支持的比例和分辨率（4.3-D 起为「声明式能力 schema」驱动）。
//
// 能力门控唯一来源（4.0 总控 §3.4）：
//   1. 内置规则 = 下方硬编码表（IMAGE_EDIT_CAPABILITIES / VIDEO_CAPABILITIES /
//      AUDIO_CAPABILITIES / MODEL_CAPABILITIES），对已知模型保持原有行为；
//   2. 用户 schema 覆盖层 = capability_schemas.json（后端存储，随设置备份、不含 Key），
//      经 loadCapabilitySchemas() 载入内存缓存；getXxxCapabilities 一律先查用户 schema，
//      未命中再回退内置规则；
//   3. UI 不得写关键字判断副本；设置页 schema 编辑是唯一用户入口。

import { API } from '../../utils/api';

// ─────────────────────────────────────────
// 4.3-D 声明式能力 schema 类型
// ─────────────────────────────────────────

export type ModelKind = 'chat' | 'drawing' | 'video' | 'audio';

export type RequestAdapterKind =
  | 'openai-image'
  | 'gemini-native'
  | 'fluxport-video'
  | 'custom-declarative';

/**
 * custom-declarative 的声明式 adapter 描述：只允许描述 URL path、字段映射、
 * 状态字段、结果字段白名单；禁止 eval / 任意脚本 / 任意 Header 注入。
 * 与 backend/api/model_rules.validate_capability_schema 的字段白名单保持一致。
 */
export interface CustomDeclarativeAdapter {
  /** 相对 API base 的 URL path，必须以 / 开头，例如 /v1/video/generations */
  urlPath: string;
  /** 请求体字段映射：本应用参数名 → 供应商字段名（值必须是合法标识符/点路径） */
  fieldMapping: {
    prompt?: string;
    model?: string;
    seconds?: string;
    format?: string;
    aspectRatio?: string;
    resolution?: string;
    referenceImages?: string;
    startFrame?: string;
    endFrame?: string;
    audio?: string;
  };
  /** 异步任务协议描述（可选；同步生成模型可不填 task） */
  task?: {
    taskIdField?: string;        // 创建响应中任务 id 字段（点路径）
    pollUrlField?: string;       // 创建响应中轮询 URL 字段（status_url / poll_url / result_url）
    statusField?: string;        // 轮询响应中状态字段名
    completedValues?: string[];  // 视为完成的 status 值
    failedValues?: string[];     // 视为失败的 status 值
    resultUrlFields?: string[];  // 完成响应中结果 URL 字段（点路径白名单）
    pollIntervalMs?: number;     // 轮询间隔（毫秒）
  };
  /** 同步生成模式：直接返回结果 URL 的字段（点路径白名单） */
  syncResultUrlFields?: string[];
}

/** 4.3-D §D1：模型能力 schema（内置规则保留；用户可添加/覆盖，但不能执行任意 JS） */
export interface ModelCapabilitySpec {
  modelId: string;
  kinds: ModelKind[];
  image?: { referenceImages?: number; maskEdit?: boolean; angle?: boolean; aspectRatios?: string[] };
  video?: { imageReference?: boolean; startEndFrame?: boolean; audioInput?: boolean; seconds?: number[] };
  audio?: { duration?: number[]; formats?: string[] };
  requestAdapter: RequestAdapterKind;
  /** 仅 requestAdapter === 'custom-declarative' 时必须提供 */
  adapter?: CustomDeclarativeAdapter;
}

// ─────────────────────────────────────────
// 用户 schema 覆盖层（内存缓存）
// ─────────────────────────────────────────

let userSchemas: ModelCapabilitySpec[] = [];
let schemasLoaded = false;

/** 从后端读取用户 schema（capability_schemas.json）；失败时静默回退内置规则。 */
export async function loadCapabilitySchemas(): Promise<void> {
  try {
    const res = (await API.loadCapabilitySchemas()) as { status?: string; schemas?: unknown[] };
    const list = Array.isArray(res?.schemas) ? res.schemas : [];
    userSchemas = list.filter((s): s is ModelCapabilitySpec => isValidSpecShape(s));
  } catch {
    userSchemas = [];
  }
  schemasLoaded = true;
}

/** 保存用户 schema 并刷新缓存（节点能力门控实时更新）。 */
export async function saveCapabilitySchema(schema: ModelCapabilitySpec): Promise<{ status: string; message?: string }> {
  const res = (await API.saveCapabilitySchema(schema as unknown as Record<string, unknown>)) as {
    status: string;
    message?: string;
  };
  if (res?.status === 'success') await loadCapabilitySchemas();
  return res;
}

/** 删除用户 schema 并刷新缓存。 */
export async function deleteCapabilitySchema(modelId: string): Promise<{ status: string; message?: string }> {
  const res = (await API.deleteCapabilitySchema(modelId)) as { status: string; message?: string };
  if (res?.status === 'success') await loadCapabilitySchemas();
  return res;
}

/** 受限测试：connection（连接/模型列表，无费用）/ preview（请求结构预览）/ generate（需确认费用，不自动触发）。 */
export async function testCustomAdapter(
  modelId: string,
  options: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return (await API.testCustomAdapter(modelId, options)) as Record<string, unknown>;
}

/** 当前已加载的用户 schema 列表（设置页编辑用）。 */
export function getUserCapabilitySchemas(): ModelCapabilitySpec[] {
  return [...userSchemas];
}

/** 用户 schema 是否已加载（启动早期 getter 回退内置规则属预期行为）。 */
export function isCapabilitySchemasLoaded(): boolean {
  return schemasLoaded;
}

/** 取指定模型的 custom-declarative adapter（未命中/非 custom 返回 null）。 */
export function getCustomAdapter(modelId: string): CustomDeclarativeAdapter | null {
  const bare = bareModelId(modelId);
  const spec = findUserSchema(bare);
  if (spec && spec.requestAdapter === 'custom-declarative' && spec.adapter) return spec.adapter;
  return null;
}

/**
 * custom-declarative 的校验/预览已实现，但请求执行器尚未接入其 URL 与字段映射。
 * 统一把它视为不可运行，避免能力控件和真实后端协议发生分叉。
 */
export function isModelRuntimeSupported(modelId: string, kind: ModelKind): boolean {
  const spec = findUserSchema(bareModelId(modelId));
  return !spec || !spec.kinds.includes(kind) || spec.requestAdapter !== 'custom-declarative';
}

function isValidSpecShape(value: unknown): value is ModelCapabilitySpec {
  if (!value || typeof value !== 'object') return false;
  const spec = value as ModelCapabilitySpec;
  if (typeof spec.modelId !== 'string' || !spec.modelId.trim()) return false;
  if (!Array.isArray(spec.kinds) || spec.kinds.length === 0) return false;
  if (spec.kinds.some(k => !['chat', 'drawing', 'video', 'audio'].includes(k))) return false;
  if (!['openai-image', 'gemini-native', 'fluxport-video', 'custom-declarative'].includes(spec.requestAdapter)) return false;
  return true;
}

function bareModelId(modelId: string): string {
  return (modelId || '').split(':').pop()?.toLowerCase().trim() || '';
}

function findUserSchema(bareId: string): ModelCapabilitySpec | null {
  if (!bareId) return null;
  return userSchemas.find(s => (s.modelId || '').toLowerCase().trim() === bareId) || null;
}

// ─────────────────────────────────────────
// 内置规则（保留原有硬编码表；用户 schema 优先）
// ─────────────────────────────────────────

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

/** 图片编辑动作唯一能力来源；未知模型默认全部拒绝，避免展示必失败入口。 */
export interface ImageEditCapabilities {
  mask: boolean;
  imageReference: boolean;
}

const UNKNOWN_IMAGE_EDIT: ImageEditCapabilities = { mask: false, imageReference: false };
const IMAGE_EDIT_CAPABILITIES: Array<[string, ImageEditCapabilities]> = [
  ['gpt-image', { mask: true, imageReference: true }],
  ['gemini-3-pro-image', { mask: true, imageReference: true }],
  ['gemini-3.1-flash-image', { mask: true, imageReference: true }],
  ['grok-imagine-image-edit', { mask: true, imageReference: true }],
  ['seedream', { mask: false, imageReference: true }],
];

export function getImageEditCapabilities(modelId: string): ImageEditCapabilities {
  const bare = bareModelId(modelId);
  const spec = findUserSchema(bare);
  if (spec) {
    if (!isModelRuntimeSupported(modelId, 'drawing')) return UNKNOWN_IMAGE_EDIT;
    return {
      mask: spec.image?.maskEdit === true,
      imageReference: (spec.image?.referenceImages ?? 0) > 0,
    };
  }
  return IMAGE_EDIT_CAPABILITIES.find(([key]) => bare.includes(key))?.[1] || UNKNOWN_IMAGE_EDIT;
}

/** 视频能力是唯一门控来源；未知模型一律不可提交，避免 UI 伪造支持。 */
export interface VideoModelCapabilities {
  available: boolean;
  supportsImageReference: boolean;
  supportsStartEndFrame: boolean;
  supportsAudio: boolean;
  seconds: number[];
  resolutions: string[];
  aspectRatios: string[];
}

const VIDEO_CAPABILITIES: Record<string, VideoModelCapabilities> = {
  'grok-imagine-video': { available: true, supportsImageReference: true, supportsStartEndFrame: false, supportsAudio: false, seconds: [5, 10], resolutions: ['720p', '1080p'], aspectRatios: ['16:9', '9:16', '1:1'] },
  'veo': { available: true, supportsImageReference: true, supportsStartEndFrame: true, supportsAudio: true, seconds: [4, 6, 8], resolutions: ['720p', '1080p'], aspectRatios: ['16:9', '9:16'] },
  'kling': { available: true, supportsImageReference: true, supportsStartEndFrame: true, supportsAudio: false, seconds: [5, 10], resolutions: ['720p', '1080p'], aspectRatios: ['16:9', '9:16', '1:1'] },
  'runway': { available: true, supportsImageReference: true, supportsStartEndFrame: true, supportsAudio: false, seconds: [5, 10], resolutions: ['720p', '1080p'], aspectRatios: ['16:9', '9:16'] },
  'pika': { available: true, supportsImageReference: true, supportsStartEndFrame: false, supportsAudio: false, seconds: [3, 5], resolutions: ['720p'], aspectRatios: ['16:9', '9:16', '1:1'] },
  'sora': { available: true, supportsImageReference: true, supportsStartEndFrame: false, supportsAudio: true, seconds: [5, 10], resolutions: ['720p', '1080p'], aspectRatios: ['16:9', '9:16'] },
  'wan': { available: true, supportsImageReference: true, supportsStartEndFrame: true, supportsAudio: false, seconds: [5, 10], resolutions: ['720p', '1080p'], aspectRatios: ['16:9', '9:16'] },
};

const UNKNOWN_VIDEO_CAPABILITIES: VideoModelCapabilities = {
  available: false, supportsImageReference: false, supportsStartEndFrame: false, supportsAudio: false,
  seconds: [], resolutions: [], aspectRatios: [],
};

/** 用户视频 schema 未声明秒数/分辨率/比例时的安全默认参数范围（能力门控不因缺省而开放）。 */
const DEFAULT_VIDEO_SECONDS = [5, 10];
const DEFAULT_VIDEO_RESOLUTIONS = ['720p', '1080p'];
const DEFAULT_VIDEO_ASPECT_RATIOS = ['16:9', '9:16', '1:1'];

export function getVideoModelCapabilities(modelId: string): VideoModelCapabilities {
  const bare = bareModelId(modelId);
  const spec = findUserSchema(bare);
  if (spec) {
    const v = spec.video;
    return {
      available: spec.kinds.includes('video') && isModelRuntimeSupported(modelId, 'video'),
      supportsImageReference: v?.imageReference === true,
      supportsStartEndFrame: v?.startEndFrame === true,
      supportsAudio: v?.audioInput === true,
      seconds: v?.seconds?.length ? v.seconds.slice() : DEFAULT_VIDEO_SECONDS,
      resolutions: DEFAULT_VIDEO_RESOLUTIONS.slice(),
      aspectRatios: DEFAULT_VIDEO_ASPECT_RATIOS.slice(),
    };
  }
  for (const [key, caps] of Object.entries(VIDEO_CAPABILITIES)) {
    if (bare.includes(key)) return caps;
  }
  return UNKNOWN_VIDEO_CAPABILITIES;
}

/** 音频能力是唯一门控来源；未知模型一律不可提交（4.2-B，能力可配置，宁缺毋滥）。 */
export interface AudioModelCapabilities {
  available: boolean;
  /** 是否支持图片条件音频（image-conditioned audio）；默认 false。 */
  supportsImageConditioning: boolean;
  seconds: number[];
  formats: Array<'mp3' | 'wav' | 'ogg'>;
}

/**
 * 4.2-B：音频模型能力表。当前没有任何已确认的真实音频供应商/协议，
 * 因此表为空（所有模型 available:false，canRun 返回「未配置音频模型」）。
 * 用户可通过 4.3-D schema 为自定义音频模型声明能力。
 */
const AUDIO_CAPABILITIES: Record<string, AudioModelCapabilities> = {};

const UNKNOWN_AUDIO_CAPABILITIES: AudioModelCapabilities = {
  available: false,
  supportsImageConditioning: false,
  seconds: [],
  formats: ['mp3'],
};

const AUDIO_FORMATS_UI: Array<'mp3' | 'wav' | 'ogg'> = ['mp3', 'wav', 'ogg'];

export function getAudioModelCapabilities(modelId: string): AudioModelCapabilities {
  const bare = bareModelId(modelId);
  const spec = findUserSchema(bare);
  if (spec) {
    const a = spec.audio;
    const formats = (a?.formats?.length ? a.formats : ['mp3']).filter((f): f is 'mp3' | 'wav' | 'ogg' =>
      f === 'mp3' || f === 'wav' || f === 'ogg',
    );
    return {
      available: spec.kinds.includes('audio') && isModelRuntimeSupported(modelId, 'audio'),
      // 图片条件音频由 image.referenceImages 声明（>0 即支持带图条件）
      supportsImageConditioning: (spec.image?.referenceImages ?? 0) > 0,
      seconds: a?.duration?.length ? a.duration.slice() : [],
      formats: formats.length ? formats : AUDIO_FORMATS_UI.slice(),
    };
  }
  for (const [key, caps] of Object.entries(AUDIO_CAPABILITIES)) {
    if (bare.includes(key)) return caps;
  }
  return UNKNOWN_AUDIO_CAPABILITIES;
}

/** 模型名称关键词 -> 能力配置的映射（绘图模型：比例/分辨率参数范围） */
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
 * 根据模型ID获取该模型支持的能力配置（用户 schema 优先，未命中回退内置规则）。
 * @param modelId 模型ID（如 "gemini-3-pro-image-preview" 或 "gpt-image-2"）
 * @returns 模型支持的比例和分辨率配置
 */
export function getModelCapabilities(modelId: string): ModelCapabilities {
  if (!modelId) return DEFAULT_CAPABILITIES;

  const bare = bareModelId(modelId);
  const spec = findUserSchema(bare);
  if (spec && spec.kinds.includes('drawing')) {
    const ratios = (spec.image?.aspectRatios || []).filter(isRatioLike);
    if (ratios.length) {
      return {
        aspectRatios: ratios,
        resolutions: DEFAULT_CAPABILITIES.resolutions.slice(),
        defaultAspectRatio: ratios.includes(DEFAULT_CAPABILITIES.defaultAspectRatio)
          ? DEFAULT_CAPABILITIES.defaultAspectRatio
          : ratios[0],
        defaultResolution: DEFAULT_CAPABILITIES.defaultResolution,
      };
    }
    return { ...DEFAULT_CAPABILITIES };
  }

  const lowerModelId = modelId.toLowerCase();

  // 精确匹配或前缀匹配（内置规则）
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

// ─────────────────────────────────────────
// 内置规则预览 + 前端本地校验（设置页用）
// ─────────────────────────────────────────

/** 设置页「回退内置规则」展示：返回该模型内置规则对应的 schema 草案；无内置规则返回 null。 */
export function getBuiltinCapabilityPreview(modelId: string): ModelCapabilitySpec | null {
  const bare = bareModelId(modelId);
  if (!bare) return null;

  const kinds: ModelKind[] = [];
  const image: ModelCapabilitySpec['image'] = {};
  const video: ModelCapabilitySpec['video'] = {};
  const audio: ModelCapabilitySpec['audio'] = {};

  const imageEdit = IMAGE_EDIT_CAPABILITIES.find(([key]) => bare.includes(key));
  if (imageEdit) {
    kinds.push('drawing');
    image.referenceImages = imageEdit[1].imageReference ? 1 : 0;
    image.maskEdit = imageEdit[1].mask;
    image.angle = false;
  }

  const drawCap = Object.entries(MODEL_CAPABILITIES).find(([key]) => bare.includes(key));
  if (drawCap) {
    if (!kinds.includes('drawing')) kinds.push('drawing');
    image.aspectRatios = drawCap[1].aspectRatios.slice();
  }

  const videoEntry = Object.entries(VIDEO_CAPABILITIES).find(([key]) => bare.includes(key));
  if (videoEntry) {
    kinds.push('video');
    const caps = videoEntry[1];
    video.imageReference = caps.supportsImageReference;
    video.startEndFrame = caps.supportsStartEndFrame;
    video.audioInput = caps.supportsAudio;
    video.seconds = caps.seconds.slice();
  }

  const audioEntry = Object.entries(AUDIO_CAPABILITIES).find(([key]) => bare.includes(key));
  if (audioEntry) {
    kinds.push('audio');
    const caps = audioEntry[1];
    audio.duration = caps.seconds.slice();
    audio.formats = caps.formats.slice();
  }

  if (kinds.length === 0) return null;

  return {
    modelId: bare,
    kinds,
    image: Object.keys(image).length ? image : undefined,
    video: Object.keys(video).length ? video : undefined,
    audio: Object.keys(audio).length ? audio : undefined,
    requestAdapter: kinds.includes('video') ? 'fluxport-video' : kinds.includes('audio') ? 'fluxport-video' : kinds.includes('drawing') ? 'openai-image' : 'openai-image',
  };
}

function isRatioLike(value: string): boolean {
  return typeof value === 'string' && (/^\d+:\d+$/.test(value) || value === 'Auto');
}

const KIND_WHITELIST: ModelKind[] = ['chat', 'drawing', 'video', 'audio'];
const ADAPTER_WHITELIST: RequestAdapterKind[] = ['openai-image', 'gemini-native', 'fluxport-video', 'custom-declarative'];
const AUDIO_FORMAT_WHITELIST = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'];
const FIELD_MAPPING_KEYS = [
  'prompt', 'model', 'seconds', 'format', 'aspectRatio', 'resolution',
  'referenceImages', 'startFrame', 'endFrame', 'audio',
];
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_.\[\]]*$/;
const INJECTION_WORDS = ['header', 'eval', 'exec', 'script', 'code', 'constructor', 'prototype', '__'];

/** 前端本地校验（与后端 model_rules.validate_capability_schema 对齐）；返回错误文案列表，空 = 通过。 */
export function validateCapabilitySpecLocal(spec: ModelCapabilitySpec): string[] {
  const errors: string[] = [];
  if (!spec) return ['schema 为空'];

  const modelId = String(spec.modelId || '').trim();
  if (!modelId) errors.push('modelId 不能为空');
  else if (modelId.length > 200) errors.push('modelId 过长（≤200 字符）');
  else if (/\s/.test(modelId)) errors.push('modelId 不能包含空白字符');

  if (!Array.isArray(spec.kinds) || spec.kinds.length === 0) {
    errors.push('kinds 至少选择一种能力类型');
  } else if (spec.kinds.some(k => !KIND_WHITELIST.includes(k))) {
    errors.push(`kinds 含非法类型（允许：${KIND_WHITELIST.join('/')}）`);
  }

  if (!ADAPTER_WHITELIST.includes(spec.requestAdapter)) {
    errors.push(`requestAdapter 不在白名单（允许：${ADAPTER_WHITELIST.join('/')}）`);
  }

  const img = spec.image;
  if (img) {
    if (img.referenceImages !== undefined && (!Number.isInteger(img.referenceImages) || img.referenceImages < 0)) {
      errors.push('image.referenceImages 必须是不小于 0 的整数');
    }
    if (img.maskEdit !== undefined && typeof img.maskEdit !== 'boolean') errors.push('image.maskEdit 必须是布尔值');
    if (img.angle !== undefined && typeof img.angle !== 'boolean') errors.push('image.angle 必须是布尔值');
    if (img.aspectRatios !== undefined) {
      if (!Array.isArray(img.aspectRatios) || img.aspectRatios.some(r => !isRatioLike(r))) {
        errors.push('image.aspectRatios 必须是形如 16:9 或 Auto 的字符串数组');
      }
    }
  }

  const vid = spec.video;
  if (vid) {
    if (vid.imageReference !== undefined && typeof vid.imageReference !== 'boolean') errors.push('video.imageReference 必须是布尔值');
    if (vid.startEndFrame !== undefined && typeof vid.startEndFrame !== 'boolean') errors.push('video.startEndFrame 必须是布尔值');
    if (vid.audioInput !== undefined && typeof vid.audioInput !== 'boolean') errors.push('video.audioInput 必须是布尔值');
    if (vid.seconds !== undefined) {
      if (!Array.isArray(vid.seconds) || vid.seconds.some(n => !Number.isFinite(n) || n <= 0 || n > 120)) {
        errors.push('video.seconds 必须是 1–120 的数字数组');
      }
    }
  }

  const aud = spec.audio;
  if (aud) {
    if (aud.duration !== undefined) {
      if (!Array.isArray(aud.duration) || aud.duration.some(n => !Number.isFinite(n) || n <= 0 || n > 600)) {
        errors.push('audio.duration 必须是 1–600 的数字数组');
      }
    }
    if (aud.formats !== undefined) {
      if (!Array.isArray(aud.formats) || aud.formats.some(f => !AUDIO_FORMAT_WHITELIST.includes(f))) {
        errors.push(`audio.formats 必须是 ${AUDIO_FORMAT_WHITELIST.join('/')} 之一`);
      }
    }
  }

  if (spec.requestAdapter === 'custom-declarative') {
    errors.push(...validateCustomAdapterLocal(spec.adapter));
  }

  return errors;
}

function validateCustomAdapterLocal(adapter: CustomDeclarativeAdapter | undefined): string[] {
  const errors: string[] = [];
  if (!adapter || typeof adapter !== 'object') {
    return ['custom-declarative 必须提供 adapter 描述（URL path/字段映射/状态字段/结果字段白名单）'];
  }
  const urlPath = String(adapter.urlPath || '').trim();
  if (!urlPath.startsWith('/')) errors.push('adapter.urlPath 必须以 / 开头（相对 API base）');
  if (urlPath.includes('..') || urlPath.includes('//') || /^https?:/i.test(urlPath)) {
    errors.push('adapter.urlPath 只能填相对路径，禁止绝对 URL 或路径穿越');
  }
  if (urlPath.length > 500) errors.push('adapter.urlPath 过长');

  const mapping = adapter.fieldMapping;
  if (!mapping || typeof mapping !== 'object') {
    errors.push('adapter.fieldMapping 不能为空');
  } else {
    let nonEmptyValues = 0;
    for (const key of Object.keys(mapping)) {
      if (!FIELD_MAPPING_KEYS.includes(key)) errors.push(`fieldMapping 含非法键：${key}`);
    }
    for (const value of Object.values(mapping)) {
      if (value !== undefined && value !== null && typeof value === 'string' && value.trim()) {
        nonEmptyValues += 1;
        if (!IDENTIFIER_RE.test(value.trim())) {
          errors.push(`fieldMapping 字段名「${value}」非法（仅允许字母/数字/下划线/点/中括号）`);
        }
      }
    }
    if (nonEmptyValues === 0) errors.push('adapter.fieldMapping 至少需要一个非空字段映射');
  }

  const task = adapter.task;
  if (task) {
    for (const field of ['taskIdField', 'pollUrlField', 'statusField'] as const) {
      const v = task[field];
      if (v !== undefined && typeof v === 'string' && v && !IDENTIFIER_RE.test(v)) {
        errors.push(`task.${field}「${v}」非法`);
      }
    }
    for (const list of ['completedValues', 'failedValues'] as const) {
      if (task[list] !== undefined && (!Array.isArray(task[list]) || task[list].some(v => typeof v !== 'string'))) {
        errors.push(`task.${list} 必须是字符串数组`);
      }
    }
    if (task.resultUrlFields !== undefined && !Array.isArray(task.resultUrlFields)) errors.push('task.resultUrlFields 必须是字符串数组');
    if (task.pollIntervalMs !== undefined && (!Number.isFinite(task.pollIntervalMs) || task.pollIntervalMs < 100)) {
      errors.push('task.pollIntervalMs 必须是 ≥100 的毫秒数');
    }
  }

  if (adapter.syncResultUrlFields !== undefined && !Array.isArray(adapter.syncResultUrlFields)) {
    errors.push('syncResultUrlFields 必须是字符串数组');
  }

  // 注入防护：任何疑似 header/eval/脚本/原型链字段一律拒绝
  const blob = JSON.stringify(adapter || {});
  const lower = blob.toLowerCase();
  for (const word of INJECTION_WORDS) {
    if (lower.includes(word)) {
      errors.push(`adapter 含被禁止的关键词「${word}」（禁止脚本 / 任意 Header / 原型链注入）`);
      break;
    }
  }

  return errors;
}
