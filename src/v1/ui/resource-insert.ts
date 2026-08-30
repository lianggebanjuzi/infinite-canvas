// src/v1/ui/resource-insert.ts
// 统一资源插入协调模块（Phase 2 切片 B）。
// 资产库（asset-drawer）、历史图库（history-drawer）、画布拖拽（interactions）三处
// 不再各自创建不同格式的素材节点，统一收敛到本模块，保证插入语义一致。
//
// 插入语义（规范 5.3）：
//   - 从资源/历史拖到画布空白 → insertImageAsAsset：创建 isAsset:true 的图片节点，不触发生成；
//   - 拖到一个图片生成节点 → attachImageToNode：作为该节点主动 refImages 加入，不自动生成；
//   - 点击资源卡「放到画布」→ insertImageAsAsset（当前视口中心或可见空位）；
//   - 点击历史卡「继续创作」（用作下一步）→ startCreateFromResource：先放置素材/结果节点，
//     再调用统一的 createContinueStep（来源由边派生为参考图）。
//
// 纪律：本模块只创建/挂载节点，不直接修改资产库、历史与提示词库数据；
// 撤销快照由调用方在用户手势入口记录（startCreateFromResource 依赖 createContinueStep 的既有 record）。

import { flowState } from '../state/flow-state';
import { selection } from '../state/selection';
import { dirty } from '../state/dirty';
import { flowHistory } from '../state/history';
import { canvasView, CARD_W, imageCardHeight } from '../canvas/canvas-view';
import { createContinueStep } from './action-bar';
import { showToast } from './toast';

/** 插入素材节点时的附加几何信息（保持 insertImageAsAsset 首参签名稳定，额外信息走 options） */
export interface AssetInsertOptions {
  ratio?: number;
  imageWidth?: number;
  imageHeight?: number;
}

/** 历史图库条目中最小的图片字段子集（与 history-drawer 的 HistoryItem 结构性兼容） */
export interface ResourceHistoryImage {
  src: string;
  thumbnail?: string;
  originalPath?: string;
  originalUrl?: string;
  width?: number;
  height?: number;
  ratio?: number;
  prompt?: string;
  model?: string;
  aspectRatio?: string;
  resolution?: string;
  count?: number;
  refImageUrls?: string[];
  refImageHashes?: string[];
  outputType?: string;
  createdAt?: number;
}

/** 从资源/历史发起「继续创作」时携带的元数据（用于素材节点落位与后续配方溯源） */
export interface ResourceCreateMeta {
  ratio?: number;
  imageWidth?: number;
  imageHeight?: number;
  originalPath?: string;
}

/**
 * 计算新素材节点落点：优先使用调用方给出的世界坐标（卡片左上角）；
 * 未给出时使用当前视口中心（保留少量上移，让卡片主体落在视口内）。
 */
function resolveAssetPosition(position?: { x: number; y: number }): { x: number; y: number } {
  if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
    return { x: position.x, y: position.y };
  }
  const rect = canvasView.wrap?.getBoundingClientRect() ?? {
    left: 0,
    top: 0,
    width: window.innerWidth || 1280,
    height: window.innerHeight || 800,
  };
  const world = canvasView.toWorldCoords(rect.left + rect.width / 2, rect.top + rect.height / 2);
  const h = imageCardHeight(4 / 3);
  return { x: world.x - CARD_W / 2, y: world.y - h / 2 };
}

/**
 * 以一张图片创建一个素材节点（isAsset:true）。
 * @param url 展示图 URL（缩略图 / Data URL）
 * @param origin 原图本地引用（可选）
 * @param position 世界坐标（卡片左上角）；缺省 = 当前视口中心
 * @param options 附加几何信息（真实比例 / 原图像素）
 * @returns 新素材节点；url 无效时返回 null
 */
export function insertImageAsAsset(
  url: string,
  origin?: ImageOrigin | null,
  position?: { x: number; y: number },
  options: AssetInsertOptions = {},
): FlowNode | null {
  if (!url) {
    showToast('图片地址无效', false);
    return null;
  }
  const ratio = options.ratio && options.ratio > 0 ? options.ratio : 4 / 3;
  const pos = resolveAssetPosition(position);
  const extra: Partial<FlowNode> = {
    isAsset: true,
    imageUrl: url,
    imageOrigin: origin ?? null,
    ratio,
    status: 'idle',
    title: '素材',
    refImages: [],
  };
  if (typeof options.imageWidth === 'number' && options.imageWidth > 0) extra.imageWidth = options.imageWidth;
  if (typeof options.imageHeight === 'number' && options.imageHeight > 0) extra.imageHeight = options.imageHeight;
  const node = flowState.addNode('image-gen', pos.x, pos.y, extra);
  selection.select(node.id);
  return node;
}

/** 历史条目 → 可放置的图片字段（thumbnail 优先、src 回退；原图引用只在有 path 时写） */
function historyImageSource(item: ResourceHistoryImage): { url: string; origin: ImageOrigin | null } {
  const url = item.thumbnail || item.src || '';
  if (item.originalPath) return { url, origin: { path: item.originalPath } };
  if (item.originalUrl) return { url, origin: { path: '', url: item.originalUrl } };
  return { url, origin: null };
}

/** 4.2-C：以媒体文件（视频/音频）创建一个素材节点（isAsset:true；大文件仅存路径，不塞 base64）。 */
export function insertMediaAsAsset(
  kind: 'video' | 'audio',
  mediaUrl: string,
  mediaPath?: string,
  media: { duration?: number; mimeType?: string; remoteTaskId?: string } = {},
  position?: { x: number; y: number },
): FlowNode | null {
  if (!mediaUrl && !mediaPath) {
    showToast('媒体地址无效', false);
    return null;
  }
  const url = mediaUrl || fileUrlFromPath(mediaPath || '');
  if (!url) {
    showToast('媒体地址无效', false);
    return null;
  }
  const pos = resolveAssetPosition(position);
  const nodeType = kind === 'video' ? 'video-gen' : 'audio-gen';
  const mediaRec = {
    originalPath: mediaPath || mediaUrl,
    url,
    ...(typeof media.duration === 'number' ? { duration: media.duration } : {}),
    ...(typeof media.mimeType === 'string' ? { mimeType: media.mimeType } : {}),
    ...(typeof media.remoteTaskId === 'string' ? { remoteTaskId: media.remoteTaskId } : {}),
  };
  const extra: Partial<FlowNode> = {
    isAsset: true,
    ratio: 16 / 9,
    status: 'idle',
    title: kind === 'video' ? '视频素材' : '音频素材',
    refImages: [],
    ...(kind === 'video' ? { video: mediaRec } : { audio: mediaRec }),
  };
  const node = flowState.addNode(nodeType, pos.x, pos.y, extra);
  selection.select(node.id);
  return node;
}

/** 本地绝对路径 → file:// URL（与 video-viewer 同构） */
function fileUrlFromPath(filePath: string): string {
  const normalized = String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  return normalized ? encodeURI(`file:///${normalized}`) : '';
}

/**
 * 把一条历史图片放到画布：创建素材节点（含原图引用与配方溯源字段），不触发生成。
 * @param historyItem 历史图库条目（thumbnail/src/originalPath 等）
 * @param position 世界坐标（卡片左上角）；缺省 = 当前视口中心
 */
export function insertHistoryImageToCanvas(
  historyItem: ResourceHistoryImage,
  position?: { x: number; y: number },
): FlowNode | null {
  const { url, origin } = historyImageSource(historyItem);
  if (!url) {
    showToast('历史图片缺失，无法放到画布', false);
    return null;
  }
  return insertImageAsAsset(url, origin, position, {
    ratio: historyItem.ratio,
    imageWidth: historyItem.width,
    imageHeight: historyItem.height,
  });
}

/**
 * 把一张图挂到指定图片生成节点作为主动参考图（不自动生成）。
 * 素材节点 / 非 image-gen 节点拒绝。返回是否成功挂载。
 */
export function attachImageToNode(url: string, nodeId: string): boolean {
  if (!url) return false;
  const node = flowState.getNode(nodeId);
  if (!node || node.type !== 'image-gen') return false;
  if (flowState.isAssetNode(node)) {
    showToast('素材节点不能添加参考图', false);
    return false;
  }
  if ((node.refImages || []).includes(url)) {
    showToast('该参考图已添加');
    return true;
  }
  flowHistory.record();
  flowState.addRefImage(nodeId, url);
  dirty.markStale(nodeId);
  showToast('已添加参考图');
  return true;
}

/**
 * 把一张图挂到当前选中的图片生成节点作为主动参考图。
 * 供「资源卡拖到当前生成节点 / 提示词插入参考」等场景使用；未选中或非生成节点返回 false。
 */
export function attachImageToSelectedGeneration(url: string): boolean {
  const node = selection.single();
  if (!node) return false;
  return attachImageToNode(url, node.id);
}

/**
 * 从资源/历史图片发起「继续创作」：先在画布放置素材节点（视口中心），
 * 再调用统一的 createContinueStep（来源由边派生为参考图，不复制图片、不覆盖源节点）。
 * 整次手势在插入素材前记录一次；随后跳过 createContinueStep 的内部记录，
 * 保证一次撤销同时移除素材节点与下一步。
 */
export async function startCreateFromResource(url: string, metadata?: ResourceCreateMeta): Promise<void> {
  if (!url) {
    showToast('图片地址无效', false);
    return;
  }
  flowHistory.record();
  const node = insertImageAsAsset(url, metadata?.originalPath ? { path: metadata.originalPath } : null, undefined, {
    ratio: metadata?.ratio,
    imageWidth: metadata?.imageWidth,
    imageHeight: metadata?.imageHeight,
  });
  if (!node) return;
  await createContinueStep(node, { recordHistory: false });
}
