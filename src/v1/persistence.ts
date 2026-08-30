// src/v1/persistence.ts
// .icproj 序列化/反序列化 —— 只有本模块可以读写 .icproj（共享约定第 5 条）
// restore 校验 format==='icv' 且 version==='3.4'；兼容读取 3.3/3.2 旧文件（节点缺 outputText/textHistory 由 migrateNode 兜底）

import { flowState } from './state/flow-state';
import { flowHistory } from './state/history';
import { batchStore } from './state/batch-store';
import { Backend } from './api';
import { TEXT_HISTORY_LIMIT } from './nodes/text-gen';
import { showToast } from './ui/toast';
import { historyPersist } from './history-persist';
import { historyDrawer } from './ui/history-drawer';
import { assetStore } from './asset-store';
import { imageEditEngine } from './engine/image-edit-engine';
import { runEngine } from './engine/run-engine';

/**
 * 文本历史归一：只接受 {text: string, ts: number} 条目，过滤非法、按 TEXT_HISTORY_LIMIT 裁尾。
 */
function normalizeTextHistory(raw: unknown): TextGenHistoryItem[] {
  if (!Array.isArray(raw)) return [];
  const items: TextGenHistoryItem[] = [];
  raw.forEach(h => {
    if (!h || typeof h !== 'object') return;
    const text = typeof (h as { text?: unknown }).text === 'string'
      ? (h as { text: string }).text.trim()
      : '';
    if (!text) return;
    const ts = typeof (h as { ts?: unknown }).ts === 'number'
      ? (h as { ts: number }).ts
      : 0;
    items.push({ text, ts });
  });
  return items.slice(0, TEXT_HISTORY_LIMIT);
}

/**
 * 当前格式节点归一（接受 image-gen / text-gen；image-result 旧类型迁移为 image-gen；其余类型——含 3.0/3.1 旧类型——返回 null 被过滤）。
 * - image-gen：字段校验，refImages 缺省补空；type 保持 image-gen。
 * - image-result（3.2/3.3 旧文件）：迁移为 image-gen（双卡模型：产出节点=image-gen+parentId 标记），
 *   保留 parentId/坐标/imageUrl/title，params 补 { prompt, model, aspectRatio, resolution, count } 默认，title 缺省 '生成结果'。
 * - text-gen：params 归一 { instruction, model }（instruction 缺省置空，不预填），outputText/textHistory 归一（3.2 旧文件缺字段时补默认值）。
 * 连线 / 标题 / 参数保留。
 */

/** 原图引用归一：缺省/非法 → null（旧项目无 imageOrigin 双轨兼容；有则 {path, url?}） */
function normalizeImageOrigin(raw: unknown): ImageOrigin | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { path?: unknown; url?: unknown };
  const path = typeof o.path === 'string' && o.path ? o.path : '';
  if (!path) return null;
  const url = typeof o.url === 'string' && o.url ? o.url : undefined;
  return { path, url };
}

/** 批量结果图归一：只保留 url 为字符串的合法条目（此前 migrateNode 未透传，重开项目批量画廊丢失） */
function normalizeGeneratedImages(raw: unknown): GeneratedImageItem[] {
  if (!Array.isArray(raw)) return [];
  const items: GeneratedImageItem[] = [];
  raw.forEach(g => {
    if (!g || typeof g !== 'object') return;
    const item = g as { url?: unknown; prompt?: unknown; origin?: unknown; width?: unknown; height?: unknown };
    if (typeof item.url !== 'string' || !item.url) return;
    items.push({
      url: item.url,
      prompt: typeof item.prompt === 'string' ? item.prompt : '',
      origin: normalizeImageOrigin(item.origin),
      ...(typeof item.width === 'number' && item.width > 0 ? { width: item.width } : {}),
      ...(typeof item.height === 'number' && item.height > 0 ? { height: item.height } : {}),
    });
  });
  return items;
}

/** 批量浏览下标归一：非数字/负数 → 0 */
function normalizeActiveGeneratedIndex(raw: unknown): number {
  return typeof raw === 'number' && raw >= 0 ? Math.floor(raw) : 0;
}

function normalizeVideo(raw: unknown): VideoMedia | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  const originalPath = typeof v.originalPath === 'string' ? v.originalPath : '';
  if (!originalPath) return null;
  return {
    originalPath,
    ...(typeof v.url === 'string' ? { url: v.url } : {}),
    ...(typeof v.thumbnail === 'string' ? { thumbnail: v.thumbnail } : {}),
    ...(typeof v.duration === 'number' && v.duration >= 0 ? { duration: v.duration } : {}),
    ...(typeof v.mimeType === 'string' ? { mimeType: v.mimeType } : {}),
    ...(typeof v.width === 'number' && v.width > 0 ? { width: v.width } : {}),
    ...(typeof v.height === 'number' && v.height > 0 ? { height: v.height } : {}),
    ...(typeof v.sizeBytes === 'number' && v.sizeBytes >= 0 ? { sizeBytes: v.sizeBytes } : {}),
    ...(typeof v.remoteTaskId === 'string' ? { remoteTaskId: v.remoteTaskId } : {}),
  };
}

/** 4.2-B：音频媒体归一（大文件仅本地路径 + 轻量元数据，不塞 base64）。 */
function normalizeAudio(raw: unknown): AudioMedia | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  const originalPath = typeof v.originalPath === 'string' ? v.originalPath : '';
  if (!originalPath) return null;
  return {
    originalPath,
    ...(typeof v.url === 'string' ? { url: v.url } : {}),
    ...(typeof v.thumbnail === 'string' ? { thumbnail: v.thumbnail } : {}),
    ...(typeof v.duration === 'number' && v.duration >= 0 ? { duration: v.duration } : {}),
    ...(typeof v.mimeType === 'string' ? { mimeType: v.mimeType } : {}),
    ...(typeof v.sizeBytes === 'number' && v.sizeBytes >= 0 ? { sizeBytes: v.sizeBytes } : {}),
    ...(typeof v.remoteTaskId === 'string' ? { remoteTaskId: v.remoteTaskId } : {}),
  };
}

/** 媒体任务状态机归一（videoTask/audioTask；非法/缺失 → undefined 不写回）。 */
function normalizeMediaTask(raw: unknown): MediaTask | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const t = raw as Record<string, unknown>;
  const states: MediaTask['state'][] = ['queued', 'submitting', 'accepted', 'processing', 'succeeded', 'failed', 'cancelled', 'uncertain'];
  const state = states.includes(t.state as MediaTask['state']) ? t.state as MediaTask['state'] : undefined;
  if (!state) return undefined;
  const task: MediaTask = { state };
  if (typeof t.localTaskId === 'string' && t.localTaskId) task.localTaskId = t.localTaskId;
  if (typeof t.remoteTaskId === 'string' && t.remoteTaskId) task.remoteTaskId = t.remoteTaskId;
  if (typeof t.error === 'string' && t.error) task.error = t.error;
  return task;
}

/** 工作流节点参数剥离媒体任务/首尾帧瞬态（工作流不携带任务状态与本地媒体引用）。 */
function stripMediaTaskParams(raw: unknown): Record<string, unknown> {
  const p: Record<string, unknown> = { ...((raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>) };
  delete p.videoTask;
  delete p.audioTask;
  delete p.startFrame;
  delete p.endFrame;
  return p;
}

/** 本地编辑 trace 也属于项目事实源；只接受可序列化的已知字段，旧/坏记录安全回退 null。 */
function normalizeTrace(raw: unknown): GenerationTrace | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const outputType = t.outputType;
  if (!['txt2img', 'img2img', 'outpaint', 'image-edit', 'video', 'audio'].includes(String(outputType))) return null;
  const cropRaw = t.crop as Record<string, unknown> | undefined;
  const splitRaw = t.split as Record<string, unknown> | undefined;
  const numeric = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  return {
    prompt: typeof t.prompt === 'string' ? t.prompt : '', model: typeof t.model === 'string' ? t.model : '',
    aspectRatio: typeof t.aspectRatio === 'string' ? t.aspectRatio : '', resolution: typeof t.resolution === 'string' ? t.resolution : '',
    count: typeof t.count === 'number' && t.count > 0 ? t.count : 1,
    refImageHashes: Array.isArray(t.refImageHashes) ? t.refImageHashes.filter((item): item is string => typeof item === 'string') : [],
    ...(Array.isArray(t.refImageUrls) ? { refImageUrls: t.refImageUrls.filter((item): item is string => typeof item === 'string') } : {}),
    createdAt: typeof t.createdAt === 'number' ? t.createdAt : 0, outputType: outputType as GenerationTrace['outputType'],
    ...(typeof t.parentId === 'string' ? { parentId: t.parentId } : {}),
    ...(typeof t.seed === 'string' || t.seed === null ? { seed: t.seed } : {}),
    ...(typeof t.batchId === 'string' ? { batchId: t.batchId } : {}), ...(typeof t.jobId === 'string' ? { jobId: t.jobId } : {}),
    ...(typeof t.editKind === 'string' && ['crop', 'split', 'mask-edit', 'annotation', 'angle'].includes(t.editKind) ? { editKind: t.editKind as GenerationTrace['editKind'] } : {}),
    ...(typeof t.sourceNodeId === 'string' ? { sourceNodeId: t.sourceNodeId } : {}),
    ...(cropRaw && numeric(cropRaw.x) !== undefined && numeric(cropRaw.y) !== undefined && numeric(cropRaw.width) !== undefined && numeric(cropRaw.height) !== undefined ? { crop: { x: numeric(cropRaw.x)!, y: numeric(cropRaw.y)!, width: numeric(cropRaw.width)!, height: numeric(cropRaw.height)!, ...(numeric(cropRaw.rotation) !== undefined ? { rotation: numeric(cropRaw.rotation) } : {}) } } : {}),
    ...(splitRaw && numeric(splitRaw.rows) !== undefined && numeric(splitRaw.cols) !== undefined && numeric(splitRaw.index) !== undefined ? { split: { rows: numeric(splitRaw.rows)!, cols: numeric(splitRaw.cols)!, index: numeric(splitRaw.index)!, ...(numeric(splitRaw.row) !== undefined ? { row: numeric(splitRaw.row) } : {}), ...(numeric(splitRaw.column) !== undefined ? { column: numeric(splitRaw.column) } : {}), ...(numeric(splitRaw.gutter) !== undefined ? { gutter: numeric(splitRaw.gutter) } : {}) } } : {}),
    ...(numeric(t.imageWidth) !== undefined ? { imageWidth: numeric(t.imageWidth) } : {}), ...(numeric(t.imageHeight) !== undefined ? { imageHeight: numeric(t.imageHeight) } : {}),
  };
}

function migrateNode(raw: unknown): FlowNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const t = r.type as string;
  if (t !== 'image-gen' && t !== 'image-result' && t !== 'text-gen' && t !== 'text-split' && t !== 'video-gen' && t !== 'audio-gen') return null;
  if (typeof r.id !== 'string') return null;

  const rawParams = r.params && typeof r.params === 'object'
    ? (r.params as Record<string, unknown>)
    : {};

  const parentId = typeof r.parentId === 'string' && r.parentId ? r.parentId : null;

  // 旧结果卡（3.2/3.3）：迁移为完整 image-gen 产出节点（双卡模型）
  if (t === 'image-result') {
    return {
      id: r.id,
      type: 'image-gen',
      x: typeof r.x === 'number' ? r.x : 0,
      y: typeof r.y === 'number' ? r.y : 0,
      ratio: typeof r.ratio === 'number' && r.ratio > 0 ? r.ratio : 3 / 4,
      status: (['idle', 'run', 'done', 'stale', 'fail'] as NodeStatus[]).includes(r.status as NodeStatus) ? r.status as NodeStatus : 'idle',
      title: typeof r.title === 'string' ? r.title : '生成结果',
      params: { prompt: '', model: '', aspectRatio: '3:4', resolution: '2k', count: 1, ...rawParams },
      imageUrl: typeof r.imageUrl === 'string' ? r.imageUrl : null,
      imageOrigin: normalizeImageOrigin(r.imageOrigin),
      outputText: null,
      generatedImages: normalizeGeneratedImages(r.generatedImages),
      activeGeneratedIndex: normalizeActiveGeneratedIndex(r.activeGeneratedIndex),
      textHistory: [],
      refImages: [],
      error: typeof r.error === 'string' ? r.error : null,
      lastRunAt: typeof r.lastRunAt === 'number' ? r.lastRunAt : null,
      parentId,
      trace: normalizeTrace(r.trace),
      ...(r.isAsset === true ? { isAsset: true } : {}), // isAsset 透传（防重开丢标记；缺省 undefined 不输出 key）
      ...(typeof r.w === 'number' && r.w > 0 ? { w: r.w } : {}), // 宽高透传（text-gen 缩放；旧项目无字段自动回退默认）
      ...(typeof r.h === 'number' && r.h > 0 ? { h: r.h } : {}),
    };
  }

  // 文本反推：3.3 新增（兼容 3.2 文件无 outputText/textHistory）
  if (t === 'text-gen') {
    return {
      id: r.id,
      type: 'text-gen',
      x: typeof r.x === 'number' ? r.x : 0,
      y: typeof r.y === 'number' ? r.y : 0,
      ratio: typeof r.ratio === 'number' && r.ratio > 0 ? r.ratio : 3 / 4,
      status: (['idle', 'run', 'done', 'stale', 'fail'] as NodeStatus[]).includes(r.status as NodeStatus) ? r.status as NodeStatus : 'idle',
      title: typeof r.title === 'string' ? r.title : '文本反推',
      // instruction 缺省置空（不预填 DEFAULT_INSTRUCTION；旧文件已有值由 rawParams 覆盖保留）
      params: { instruction: '', model: '', ...rawParams },
      imageUrl: null,
      imageOrigin: null,
      outputText: typeof r.outputText === 'string' ? r.outputText : null,
      textHistory: normalizeTextHistory(r.textHistory),
      refImages: Array.isArray(r.refImages)
        ? (r.refImages as unknown[]).filter((u): u is string => typeof u === 'string')
        : [],
      error: typeof r.error === 'string' ? r.error : null,
      lastRunAt: typeof r.lastRunAt === 'number' ? r.lastRunAt : null,
      parentId: null,
        trace: null,
      ...(typeof r.w === 'number' && r.w > 0 ? { w: r.w } : {}), // 宽高透传（text-gen 缩放；旧项目无字段自动回退默认）
      ...(typeof r.h === 'number' && r.h > 0 ? { h: r.h } : {}),
    };
  }

  // 文本拆分：此前未收录会被静默丢弃（节点+连线一并消失）；拆分符/槽位随项目保留，卡内画廊字段同 image-gen 透传
  if (t === 'text-split') {
    return {
      id: r.id,
      type: 'text-split',
      x: typeof r.x === 'number' ? r.x : 0,
      y: typeof r.y === 'number' ? r.y : 0,
      ratio: typeof r.ratio === 'number' && r.ratio > 0 ? r.ratio : 0.72,
      status: (['idle', 'run', 'done', 'stale', 'fail'] as NodeStatus[]).includes(r.status as NodeStatus) ? r.status as NodeStatus : 'idle',
      title: typeof r.title === 'string' ? r.title : '文本拆分',
      params: { delimiter: '########', segments: ['', ''], ...rawParams },
      imageUrl: null,
      imageOrigin: null,
      outputText: null,
      generatedImages: normalizeGeneratedImages(r.generatedImages),
      activeGeneratedIndex: normalizeActiveGeneratedIndex(r.activeGeneratedIndex),
      textHistory: [],
      refImages: [],
      error: typeof r.error === 'string' ? r.error : null,
      lastRunAt: typeof r.lastRunAt === 'number' ? r.lastRunAt : null,
      parentId: null,
      trace: null,
      ...(typeof r.w === 'number' && r.w > 0 ? { w: r.w } : {}),
      ...(typeof r.h === 'number' && r.h > 0 ? { h: r.h } : {}),
    };
  }

  if (t === 'video-gen') {
    return {
      id: r.id, type: 'video-gen', x: typeof r.x === 'number' ? r.x : 0, y: typeof r.y === 'number' ? r.y : 0,
      ratio: typeof r.ratio === 'number' && r.ratio > 0 ? r.ratio : 16 / 9,
      status: (['idle', 'run', 'done', 'stale', 'fail', 'queued', 'submitting'] as NodeStatus[]).includes(r.status as NodeStatus) ? r.status as NodeStatus : 'idle',
      title: typeof r.title === 'string' ? r.title : '视频生成',
      params: { prompt: '', model: '', seconds: 5, aspectRatio: '16:9', resolution: '720p', audio: false, ...rawParams },
      imageUrl: null, imageOrigin: null, video: normalizeVideo(r.video), outputText: null, textHistory: [], refImages: [],
      error: typeof r.error === 'string' ? r.error : null, lastRunAt: typeof r.lastRunAt === 'number' ? r.lastRunAt : null,
      parentId, trace: normalizeTrace(r.trace),
      ...(r.isAsset === true ? { isAsset: true } : {}),
      ...(typeof r.w === 'number' && r.w > 0 ? { w: r.w } : {}),
      ...(typeof r.h === 'number' && r.h > 0 ? { h: r.h } : {}),
    };
  }

  if (t === 'audio-gen') {
    const task = normalizeMediaTask(rawParams.audioTask);
    return {
      id: r.id, type: 'audio-gen', x: typeof r.x === 'number' ? r.x : 0, y: typeof r.y === 'number' ? r.y : 0,
      ratio: typeof r.ratio === 'number' && r.ratio > 0 ? r.ratio : 16 / 9,
      status: (['idle', 'run', 'done', 'stale', 'fail', 'queued', 'submitting'] as NodeStatus[]).includes(r.status as NodeStatus) ? r.status as NodeStatus : 'idle',
      title: typeof r.title === 'string' ? r.title : '音频生成',
      params: {
        prompt: '', model: '', seconds: 10, format: 'mp3', ...rawParams,
        ...(task ? { audioTask: task } : {}),
      },
      imageUrl: null, imageOrigin: null, audio: normalizeAudio(r.audio), outputText: null, textHistory: [], refImages: [],
      error: typeof r.error === 'string' ? r.error : null, lastRunAt: typeof r.lastRunAt === 'number' ? r.lastRunAt : null,
      parentId, trace: normalizeTrace(r.trace),
      ...(r.isAsset === true ? { isAsset: true } : {}),
      ...(typeof r.w === 'number' && r.w > 0 ? { w: r.w } : {}),
      ...(typeof r.h === 'number' && r.h > 0 ? { h: r.h } : {}),
    };
  }

  const node: FlowNode = {
    id: r.id,
    type: 'image-gen',
    x: typeof r.x === 'number' ? r.x : 0,
    y: typeof r.y === 'number' ? r.y : 0,
    ratio: typeof r.ratio === 'number' && r.ratio > 0 ? r.ratio : 3 / 4,
    status: (['idle', 'run', 'done', 'stale', 'fail'] as NodeStatus[]).includes(r.status as NodeStatus) ? r.status as NodeStatus : 'idle',
    title: typeof r.title === 'string' ? r.title : '图片生成',
    params: { prompt: '', model: '', aspectRatio: '3:4', resolution: '2k', count: 1, ...rawParams },
    imageUrl: typeof r.imageUrl === 'string' ? r.imageUrl : null,
    imageOrigin: normalizeImageOrigin(r.imageOrigin),
    ...(typeof r.imageWidth === 'number' && r.imageWidth > 0 ? { imageWidth: r.imageWidth } : {}), // 真实像素透传（尺寸标注不回退 params）
    ...(typeof r.imageHeight === 'number' && r.imageHeight > 0 ? { imageHeight: r.imageHeight } : {}),
    outputText: null,
    generatedImages: normalizeGeneratedImages(r.generatedImages),
    activeGeneratedIndex: normalizeActiveGeneratedIndex(r.activeGeneratedIndex),
    textHistory: [],
    refImages: [],
    error: typeof r.error === 'string' ? r.error : null,
    lastRunAt: typeof r.lastRunAt === 'number' ? r.lastRunAt : null,
    parentId,
    trace: normalizeTrace(r.trace),
    ...(r.isAsset === true ? { isAsset: true } : {}), // isAsset 透传（防重开丢标记；缺省 undefined 不输出 key）
    ...(typeof r.w === 'number' && r.w > 0 ? { w: r.w } : {}), // 宽高透传（text-gen 缩放；旧项目无字段自动回退默认）
    ...(typeof r.h === 'number' && r.h > 0 ? { h: r.h } : {}),
    ...(typeof r.imageAspectLocked === 'boolean' ? { imageAspectLocked: r.imageAspectLocked } : {}),
  };

  node.refImages = Array.isArray(r.refImages)
    ? (r.refImages as unknown[]).filter((u): u is string => typeof u === 'string')
    : [];
  return node;
}

class Persistence {
  private lastPath: string | null = null;

  /** 收集当前画布为 FlowProject */
  collect(): FlowProject {
    return {
      format: 'icv',
      version: '3.4',
      projectName: flowState.projectName,
      canvas: { ...flowState.canvas },
      modelDefaults: { ...flowState.modelDefaults },
      nodes: flowState.nodes.map(n => ({
        ...n,
        // 共享约定 6：八态持久化归一为五态（queued→idle、submitting→run、partial-failed→done；run/done/stale/fail 原样）
        status: n.status === 'queued' ? 'idle' : (n.status === 'submitting' ? 'run' : (n.status === 'partial-failed' ? 'done' : n.status)),
        params: { ...(n.params || {}) },
        refImages: [...(n.refImages || [])],
        textHistory: [...(n.textHistory || [])],
        parentId: n.parentId ?? null,
      })),
      edges: flowState.edges.map(e => ({ ...e })),
      createdAt: flowState.createdAt,
      updatedAt: Date.now(),
    };
  }

  /** 新建始终从空项目开始：不复用旧节点、历史或项目路径；全局资产索引保持不动。 */
  createNewProject(): void {
    const now = Date.now();
    flowState.replaceAll({
      format: 'icv', version: '3.4', projectName: '未命名项目',
      canvas: { scale: 1, panX: 60, panY: 40 }, modelDefaults: { drawing: '', chat: '', video: '', audio: '' },
      nodes: [], edges: [], createdAt: now, updatedAt: now,
    });
    this.lastPath = null;
    flowHistory.clear();
    batchStore.clear();
    historyDrawer.clear();
    this.syncProjectNameInput();
  }

  /**
   * 将当前画布收敛为可复用工作流。模板保存编排与默认文本/参数，刻意丢弃结果图、来源图片、任务状态和历史，
   * 因而从模板启动的永远是一份干净的新创作，不会意外引用用户过去的本地文件。
   */
  collectWorkflow(id: string, title: string): WorkflowTemplate {
    const now = Date.now();
    return {
      id,
      title,
      version: 1,
      canvas: { ...flowState.canvas },
      modelDefaults: { ...flowState.modelDefaults },
      nodes: flowState.nodes.map(node => ({
        ...node,
        status: 'idle' as NodeStatus,
        imageUrl: null,
        imageOrigin: null,
        imageWidth: undefined,
        imageHeight: undefined,
        outputText: null,
        generatedImages: [],
        activeGeneratedIndex: 0,
        textHistory: [],
        refImages: [],
        error: null,
        lastRunAt: null,
        parentId: null,
        trace: null,
        isAsset: undefined,
        // 4.2：工作流不携带本地媒体引用（视频/音频大文件路径只属于项目）
        video: null,
        audio: null,
        params: stripMediaTaskParams(node.params),
      })),
      edges: flowState.edges.map(edge => ({ ...edge })),
      createdAt: now,
      updatedAt: now,
    };
  }

  /** 用工作流开启新的未保存项目；调用方负责在此之前经过 closeGuard。 */
  restoreWorkflow(workflow: WorkflowTemplate): boolean {
    const ok = this.restore({
      format: 'icv',
      version: '3.4',
      projectName: workflow.title,
      canvas: workflow.canvas,
      modelDefaults: workflow.modelDefaults,
      nodes: workflow.nodes,
      edges: workflow.edges,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    if (!ok) return false;
    this.lastPath = null;
    flowState.dirty = true;
    flowState.updatedAt = Date.now();
    flowState.notify();
    flowHistory.clear();
    historyDrawer.clear();
    this.syncProjectNameInput();
    return true;
  }

  /** 校验并恢复项目（format==='icv'；version 接受 3.4 与兼容读取 3.3/3.2；更旧版本不支持） */
  restore(raw: unknown): boolean {
    if (!raw || typeof raw !== 'object') {
      showToast('项目文件格式错误', false);
      return false;
    }
    const p = raw as Partial<FlowProject>;
    if (p.format !== 'icv' || (p.version !== '3.4' && p.version !== '3.3' && p.version !== '3.2')) {
      showToast('旧版项目不支持，请新建', false);
      return false;
    }
    if (!Array.isArray(p.nodes)) {
      showToast('项目文件缺少节点数据', false);
      return false;
    }

    const nodes = (p.nodes as unknown[])
      .map(migrateNode)
      .filter((n): n is FlowNode => n !== null);

    const nodeIds = new Set(nodes.map(n => n.id));
    const edges = (Array.isArray(p.edges) ? p.edges : [])
      .filter(e => e && typeof e.id === 'string' && nodeIds.has(e.from) && nodeIds.has(e.to))
      .map(e => ({ id: e.id, from: e.from, to: e.to })) as FlowEdge[];

    flowState.replaceAll({
      format: 'icv',
      version: '3.4',
      projectName: typeof p.projectName === 'string' ? p.projectName : '未命名项目',
      canvas: {
        scale: typeof p.canvas?.scale === 'number' ? p.canvas.scale : 1,
        panX: typeof p.canvas?.panX === 'number' ? p.canvas.panX : 60,
        panY: typeof p.canvas?.panY === 'number' ? p.canvas.panY : 40,
      },
      modelDefaults: {
        drawing: typeof p.modelDefaults?.drawing === 'string' ? p.modelDefaults.drawing : '',
        chat: typeof p.modelDefaults?.chat === 'string' ? p.modelDefaults.chat : '',
        video: typeof p.modelDefaults?.video === 'string' ? p.modelDefaults.video : '',
        audio: typeof p.modelDefaults?.audio === 'string' ? p.modelDefaults.audio : '',
      },
      nodes,
      edges,
      createdAt: typeof p.createdAt === 'number' ? p.createdAt : Date.now(),
      updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : Date.now(),
    });
    // B-7：换项目后从节点结果（imageUrl/generatedImages/trace）重建已知批次（.icproj 版本不动）
    batchStore.rebuildFromNodes();
    return true;
  }

  /** 保存（A2：图片 base64 内嵌；大体积时 Toast 提示）。silent=true 静默（自动保存不逐次 toast）。返回是否保存成功。 */
  async save(silent = false): Promise<boolean> {
    const data = this.collect();
    // 快照 collect 时刻的状态版本：仅在「collect 后状态未再变化」时才清 dirty，
    // 否则在途期间的新改动会保留 dirty，由 SaveCoordinator 的 pending 补写再落盘后复位（零丢失）。
    const versionAtCollect = flowState.updatedAt;
    let sizeKB = 0;
    try { sizeKB = Math.round(JSON.stringify(data).length / 1024); } catch { sizeKB = 0; }

    let result = await Backend.saveProject(data);
    if (result.status === 'need_save_as') {
      result = await Backend.saveProjectAs(data);
      if (result.status === 'success') {
        this.lastPath = result.path ?? null;
        if (this.lastPath) void this._touchRecentProject(this.lastPath);
        this._clearDirtyIfUnchanged(versionAtCollect);
        void assetStore.persistNow(); // 幂等兜底：资产索引随项目保存落盘（X2）
        this._afterSave(sizeKB, silent);
        return true;
      }
      if (result.status !== 'cancelled' && !silent) {
        showToast('保存失败: ' + (result.message || ''), false);
      }
      return false;
    }

    if (result.status === 'success') {
      this.lastPath = result.path ?? null;
      if (this.lastPath) void this._touchRecentProject(this.lastPath);
      this._clearDirtyIfUnchanged(versionAtCollect);
      void assetStore.persistNow(); // 幂等兜底：资产索引随项目保存落盘（X2）
      this._afterSave(sizeKB, silent);
      return true;
    }
    if (!silent) showToast('保存失败: ' + (result.message || ''), false);
    return false;
  }

  /** 仅在「collect 快照后状态未再变化」时清 dirty；否则保留 dirty（在途期间又产生了新改动，尚未落盘） */
  private _clearDirtyIfUnchanged(versionAtCollect: number): void {
    if (flowState.updatedAt === versionAtCollect) {
      flowState.dirty = false;
    }
  }

  private _afterSave(sizeKB: number, silent: boolean): void {
    flowState.notify();
    if (silent) return;
    const hint = sizeKB > 2048 ? '（项目较大，图片已内嵌保存）' : '';
    showToast('项目已保存' + hint);
  }

  /** 是否已有保存路径 */
  hasPath(): boolean {
    return this.lastPath !== null;
  }

  /** 打开项目（对话框）：入口已由 closeGuard.guardOpen 包装；成功后清撤销栈 + 载入 history.jsonl + 恢复资产索引 */
  async open(): Promise<void> {
    const result = await Backend.openProject();
    await this._openResult(result);
  }

  /** 从最近项目按路径打开；不绕过现有 restore/历史/资产恢复链路。 */
  async openPath(filePath: string): Promise<boolean> {
    const result = await Backend.loadProject(filePath);
    return this._openResult(result);
  }

  private async _openResult(result: BackendProjectResult): Promise<boolean> {
    if (result.status === 'success' && result.data !== undefined && result.data !== null) {
      if (this.restore(result.data)) {
        this.lastPath = result.path ?? null;
        if (this.lastPath) void this._touchRecentProject(this.lastPath);
        this.syncProjectNameInput();
        flowHistory.clear(); // 跨项目：清空撤销栈，避免撤销回滚到旧项目快照
        void this._loadHistoryIntoDrawer();
        void assetStore.loadFromBackend(); // 恢复资产库（关闭重开后状态一致）
        imageEditEngine.recoverAll();      // 4.1-B：恢复进行中的蒙版/多角度任务（受理后只查询原任务）
        runEngine.recoverMediaTasks();     // 4.2-A/B：恢复进行中的视频/音频任务（受理后只查询原任务）
        showToast('项目已打开');
        return true;
      }
    } else if (result.status !== 'cancelled') {
      showToast('打开失败: ' + (result.message || ''), false);
    }
    return false;
  }

  private async _touchRecentProject(path: string): Promise<void> {
    await Backend.touchRecentProject(path, flowState.projectName);
  }

  /** 载入 flowHistory.jsonl 到历史图库（跨会话展示；失败静默） */
  private async _loadHistoryIntoDrawer(): Promise<void> {
    const entries = await historyPersist.loadHistory();
    historyDrawer.loadFromHistory(entries);
  }

  /** 同步项目名输入框 */
  syncProjectNameInput(): void {
    const input = document.getElementById('project-name') as HTMLInputElement | null;
    if (input) input.value = flowState.projectName;
  }
}

export const persistence = new Persistence();
