// src/v1/ui/director-bridge.ts
// 4.4 导演台 ↔ 主画布互通薄壳（D5）：
// - 从画布把选中图片送入导演台（传入项目 ID / 图片资源 / 临时返回通道）；
// - 导演台回传 PNG/MP4 → 走现有资源导入管线成为素材/视频节点；
// - trace 记录 director project id / shot id / camera id / 时间点，不暴露内部绝对路径。
// 导演台保存不改写 2D 画布（.icdirector 与 .icproj 完全隔离）。

import { flowState } from '../state/flow-state';
import { selection } from '../state/selection';
import { dirty } from '../state/dirty';
import { flowHistory } from '../state/history';
import { canvasView, CARD_W } from '../canvas/canvas-view';
import { insertImageAsAsset } from './resource-insert';
import { historyPersist } from '../history-persist';
import { Backend } from '../api';
import { API } from '../../utils/api';
import { showToast } from './toast';

export interface DirectorReturnPayload {
  kind: 'png' | 'mp4';
  path: string;
  projectId: string;
  cameraId: string;
  time: number;
  shotId?: string;
  sourceProjectId?: string;
  sourceNodeId?: string;
}

interface DirectorBackend {
  director_open(options: Record<string, unknown>): Promise<{ status: string; message?: string }>;
  load_local_image(path: string): Promise<{ status: string; data_url?: string; message?: string }>;
}

function backend(): DirectorBackend | null {
  const w = window as unknown as { pywebview?: { api?: DirectorBackend } };
  return w.pywebview?.api ?? null;
}

/** 导演台只接受已经落盘的图片节点；视频、音频、文本和空生成卡都不应出现入口。 */
export function canOpenDirectorForNode(node: FlowNode | null | undefined): boolean {
  return !!node
    && node.type === 'image-gen'
    && typeof node.imageOrigin?.path === 'string'
    && node.imageOrigin.path.trim().length > 0;
}

/** 从画布打开导演台（单选图片节点时调用） */
export async function openDirectorForNode(nodeId: string): Promise<{ status: string; message?: string }> {
  const api = backend();
  if (!api) {
    showToast('导演台需要桌面端运行环境（pywebview 后端）', false);
    return { status: 'error', message: '后端不可用' };
  }
  const node = flowState.getNode(nodeId);
  if (!node) {
    return { status: 'error', message: '节点不存在' };
  }
  if (!canOpenDirectorForNode(node)) {
    showToast('请选择一张已保存到本地的图片后再打开导演台', false);
    return { status: 'error', message: '当前节点没有可供导演台使用的本地图片' };
  }
  const imagePath = node.imageOrigin!.path;
  // 来源画布项目：以当前 .icproj 路径作为稳定来源标识（不暴露导演台内部路径）
  let sourceProjectId: string | undefined;
  try {
    const p = await API.getCurrentProjectPath();
    if (p?.path) sourceProjectId = p.path;
  } catch {
    // 未保存项目时无来源标识
  }
  const options: Record<string, unknown> = {
    imagePath: imagePath || undefined,
    imageName: node.title || '画布图片',
    sourceProjectId,
    sourceNodeId: node.id,
  };
  try {
    const res = await api.director_open(options);
    if (res.status !== 'success') {
      showToast(res.message || '打开导演台失败', false);
    }
    return res;
  } catch (e) {
    showToast(`打开导演台失败：${(e as Error).message}`, false);
    return { status: 'error', message: (e as Error).message };
  }
}

/** 计算回传节点落点（视口中心附近，与现有资源插入一致） */
function resolveInsertPosition(): { x: number; y: number } {
  const rect = canvasView.wrap?.getBoundingClientRect() ?? {
    left: 0, top: 0, width: window.innerWidth || 1280, height: window.innerHeight || 800,
  };
  const world = canvasView.toWorldCoords(rect.left + rect.width / 2, rect.top + rect.height / 2);
  return { x: world.x - CARD_W / 2, y: world.y - 40 };
}

/** 回传 PNG：走现有图片导入管线成为素材节点，并写 trace（director 溯源） */
async function handlePngReturn(payload: DirectorReturnPayload): Promise<void> {
  if (!payload.path) {
    showToast('回传图片路径无效', false);
    return;
  }
  let dataUrl = '';
  try {
    const res = await Backend.loadLocalImage(payload.path);
    if (res.status === 'success' && res.data_url) dataUrl = res.data_url;
  } catch {
    // 读取失败回退到 file:// 路径（缩略图可能不可用，但节点仍可溯源）
  }
  flowHistory.record();
  const node = insertImageAsAsset(
    dataUrl || `file:///${payload.path.replace(/\\/g, '/')}`,
    { path: payload.path },
    resolveInsertPosition(),
    { ratio: 16 / 9 },
  );
  if (!node) {
    showToast('回传图片插入失败', false);
    return;
  }
  // trace：记录 director 工程/镜头/相机/时间点（不暴露内部绝对路径）
  const trace: GenerationTrace = {
    prompt: '导演台导出',
    model: 'director',
    aspectRatio: '16:9',
    resolution: '720p',
    count: 1,
    refImageHashes: [],
    createdAt: Date.now(),
    parentId: node.id,
    outputType: 'image-edit',
    director: {
      projectId: payload.projectId,
      shotId: payload.shotId,
      cameraId: payload.cameraId,
      time: payload.time,
    },
  };
  flowState.updateNode(node.id, { trace });
  dirty.markStale(node.id);
  void historyPersist.appendTrace({
    kind: 'image',
    nodeId: node.id,
    originalPath: payload.path,
    prompt: '导演台导出',
    model: 'director',
    aspectRatio: '16:9',
    resolution: '720p',
    count: 1,
    refImageHashes: [],
    createdAt: Date.now(),
    parentId: node.id,
    outputType: 'image-edit',
    director: {
      projectId: payload.projectId,
      shotId: payload.shotId,
      cameraId: payload.cameraId,
      time: payload.time,
    },
  });
  showToast('导演台 PNG 已插入画布（trace 含导演台来源）');
}

/** 回传 MP4：创建 video-gen 节点（本地文件直读播放） */
async function handleMp4Return(payload: DirectorReturnPayload): Promise<void> {
  if (!payload.path) {
    showToast('回传视频路径无效', false);
    return;
  }
  const pos = resolveInsertPosition();
  const videoUrl = fileUrlFromPath(payload.path);
  flowHistory.record();
  const node = flowState.addNode('video-gen', pos.x, pos.y, {
    title: '导演台导出',
    status: 'idle',
    params: { prompt: '导演台导出', model: 'director', seconds: 5, aspectRatio: '16:9', resolution: '720p', audio: false },
    video: {
      originalPath: payload.path,
      url: videoUrl,
      duration: undefined,
      width: undefined,
      height: undefined,
      sizeBytes: undefined,
    },
  });
  selection.select(node.id);
  // trace：video 分支记录 director 溯源
  flowState.updateNode(node.id, {
    trace: {
      prompt: '导演台导出',
      model: 'director',
      aspectRatio: '16:9',
      resolution: '720p',
      count: 1,
      refImageHashes: [],
      createdAt: Date.now(),
      parentId: node.id,
      outputType: 'video',
      director: {
        projectId: payload.projectId,
        shotId: payload.shotId,
        cameraId: payload.cameraId,
        time: payload.time,
      },
    } as GenerationTrace,
  });
  dirty.markStale(node.id);
  void historyPersist.appendTrace({
    kind: 'video',
    nodeId: node.id,
    prompt: '导演台导出',
    model: 'director',
    aspectRatio: '16:9',
    resolution: '720p',
    seconds: 5,
    references: [],
    createdAt: Date.now(),
    originalPath: payload.path,
    videoUrl,
  });
  showToast('导演台视频已插入画布');
}

/** 导演台回传的是本地绝对路径，持久化前统一为可供媒体元素读取的 file URL。 */
function fileUrlFromPath(filePath: string): string {
  const normalized = String(filePath || '').trim().replace(/\\/g, '/');
  if (!normalized) return '';
  if (/^file:/i.test(normalized)) return normalized;
  if (normalized.startsWith('//')) return encodeFileUrl(`file:${normalized}`);
  return encodeFileUrl(`file:///${normalized.replace(/^\/+/, '')}`);
}

function encodeFileUrl(url: string): string {
  return encodeURI(url).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

/** 初始化导演台桥接（v1/main.ts 调用一次） */
export function initDirectorBridge(): void {
  // 注册回传通道：后端 director_return_to_canvas → window.__icvDirectorReturn(payload)
  const w = window as unknown as Record<string, unknown>;
  w.__icvDirectorReturn = (payload: DirectorReturnPayload) => {
    if (!payload || typeof payload !== 'object') return;
    if (payload.kind === 'mp4') {
      void handleMp4Return(payload);
    } else {
      void handlePngReturn(payload);
    }
  };

}
