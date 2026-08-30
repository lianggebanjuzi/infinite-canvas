// 轻量视频查看器：本地 video 标签直接读取落盘文件，不通过 base64/桥接搬运媒体。
// 4.2-A：加入「加入资产」；本地路径失效时提供「重新定位 / 从历史恢复」，不让卡片崩溃。
import { flowState } from '../state/flow-state';
import { flowHistory } from '../state/history';
import { showToast } from './toast';
import { createVideoStep } from './action-bar';
import { assetStore } from '../asset-store';
import { historyDrawer } from './history-drawer';
import { Backend } from '../api';

class VideoViewer {
  private el: HTMLElement | null = null;

  init(): void {
    window.addEventListener('icv:open-video', event => {
      const nodeId = (event as CustomEvent<{ nodeId?: string }>).detail?.nodeId;
      if (nodeId) this.open(nodeId);
    });
  }

  open(nodeId: string): void {
    const node = flowState.getNode(nodeId);
    const video = node?.video;
    if (!node || !video) { showToast('视频文件不可用，可从历史恢复或重新定位文件', false); return; }
    this.el?.remove();
    const el = document.createElement('div');
    el.className = 'video-viewer-overlay';
    const prompt = node.trace?.prompt || (node.params as unknown as VideoGenParams).prompt || '';
    const mediaUrl = videoUrl(video);
    const render = (mediaUnavailable: boolean): void => {
      const playable = !!mediaUrl && !mediaUnavailable;
      const added = playable && assetStore.isAddedByUrl(mediaUrl);
      const recoverHtml = playable
        ? ''
        : `<div class="video-viewer-recover">
            <b>视频文件无法播放</b>
            <span>本地文件可能已被移动、删除，或当前环境无法读取。</span>
            <div class="video-viewer-recover-actions">
              <button data-act="relocate">重新定位文件</button>
              <button data-act="history">从历史恢复</button>
            </div>
          </div>`;
      el.innerHTML = `<section class="video-viewer-panel" role="dialog" aria-modal="true" aria-label="视频查看器">
        <header><strong>视频查看器</strong><button data-act="close" title="关闭">×</button></header>
        ${playable ? '<video class="video-viewer-media" controls loop playsinline></video>' : ''}
        ${recoverHtml}
        <div class="video-viewer-meta">${escapeHtml(formatMeta(video, node))}</div>
        <div class="video-viewer-actions">
          ${playable ? '<button data-act="mute">静音</button><button data-act="download">下载</button>' : ''}
          <button data-act="copy">复制提示词</button>
          <button data-act="continue">继续创作</button>
          ${playable ? `<button data-act="add-asset"${added ? ' disabled' : ''}>${added ? '已在资产库' : '加入资产'}</button>` : ''}
        </div>
      </section>`;
      const media = el.querySelector('.video-viewer-media') as HTMLVideoElement | null;
      if (media) {
        media.addEventListener('error', () => render(true), { once: true });
        media.src = mediaUrl;
      }
    };
    el.addEventListener('click', e => {
      const target = e.target as HTMLElement;
      if (target === el || target.dataset.act === 'close') { el.remove(); this.el = null; return; }
      const act = target.dataset.act;
      const media = el.querySelector('video') as HTMLVideoElement | null;
      if (act === 'mute' && media) { media.muted = !media.muted; target.textContent = media.muted ? '取消静音' : '静音'; }
      if (act === 'download' && mediaUrl) { const a = document.createElement('a'); a.href = mediaUrl; a.download = `${node.title || 'video'}.mp4`; a.click(); }
      if (act === 'copy') void copy(prompt);
      if (act === 'continue') { el.remove(); this.el = null; void createVideoStep(node); }
      if (act === 'add-asset') { this._addToAsset(node); }
      if (act === 'relocate') { el.remove(); this.el = null; this._relocate(nodeId); }
      if (act === 'history') { el.remove(); this.el = null; this._restoreFromHistory(nodeId); }
    });
    render(!mediaUrl);
    document.body.appendChild(el);
    this.el = el;
  }

  /** 加入资产：媒体记录（kind:'video'），配方从节点 trace 合成。 */
  private _addToAsset(node: FlowNode): void {
    const video = node.video;
    if (!video?.originalPath) return;
    const url = videoUrl(video);
    if (!url) return;
    if (assetStore.isAddedByUrl(url)) { showToast('已在资产库'); return; }
    flowHistory.record();
    assetStore.addByMediaUrl(url, node.id, 'video', video.originalPath, assetStore.metaFromNode(node), {
      duration: video.duration, mimeType: video.mimeType, sizeBytes: video.sizeBytes,
      width: video.width, height: video.height, remoteTaskId: video.remoteTaskId,
    });
    showToast('已加入资产库');
  }

  /** 重新定位：先经后端落盘选中的文件，再用返回的绝对路径更新节点。 */
  private _relocate(nodeId: string): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      void this._persistRelocatedFile(nodeId, file);
    });
    input.click();
  }

  private async _persistRelocatedFile(nodeId: string, file: File): Promise<void> {
    const sourcePath = (file as File & { path?: string }).path || '';
    try {
      const res = isAbsoluteLocalPath(sourcePath)
        ? await Backend.prepareImportedMedia({ kind: 'video', sourcePath, filename: file.name })
        : await Backend.prepareImportedMedia({
          kind: 'video',
          dataUrl: (await readFileAsDataUrl(file)) || '',
          filename: file.name,
        });
      if (res.status !== 'success' || !res.path) {
        showToast(res.message || '重新定位视频文件失败', false);
        return;
      }
      const node = flowState.getNode(nodeId);
      if (!node) return;
      const existing = node.video || null;
      flowState.updateNode(nodeId, {
        video: {
          ...(existing || { originalPath: res.path }),
          originalPath: res.path,
          url: videoUrl({ originalPath: res.path, url: res.url }),
          duration: res.duration ?? existing?.duration,
          mimeType: res.mime_type ?? existing?.mimeType,
          sizeBytes: res.size_bytes ?? existing?.sizeBytes,
        },
        error: null,
        status: node.status === 'fail' || node.status === 'stale' ? 'done' : node.status,
      });
      showToast('已重新定位视频文件');
    } catch (e) {
      showToast(`重新定位视频文件失败：${(e as Error).message}`, false);
    }
  }

  /** 从历史恢复：查询该节点最近的视频历史条目，命中则恢复路径。 */
  private _restoreFromHistory(nodeId: string): void {
    const entry = historyDrawer.getVideoEntryByNode(nodeId);
    if (!entry?.originalPath) { showToast('历史中未找到该视频记录', false); return; }
    const node = flowState.getNode(nodeId);
    if (!node) return;
    const existing = node.video || null;
    const url = videoUrl({ originalPath: entry.originalPath, url: entry.videoUrl });
    flowState.updateNode(nodeId, {
      video: { ...(existing || { originalPath: entry.originalPath }), originalPath: entry.originalPath, url, duration: entry.duration },
      error: null,
      status: node.status === 'fail' || node.status === 'stale' ? 'done' : node.status,
    });
    showToast('已从历史恢复视频文件');
  }
}

/** 本地绝对路径 → file:// URL（正斜杠规范化；与 api.localImageFileUrl 同构，避免 import 循环） */
function fileUrlFromPath(filePath: string): string {
  const normalized = String(filePath || '').trim().replace(/\\/g, '/');
  if (!normalized) return '';
  if (/^file:/i.test(normalized)) return normalized;
  if (normalized.startsWith('//')) return encodeFileUrl(`file:${normalized}`);
  return encodeFileUrl(`file:///${normalized.replace(/^\/+/, '')}`);
}

/** 新数据使用 URL；兼容旧版把 Windows 路径误写进 video.url 的项目。 */
function videoUrl(video: Pick<VideoMedia, 'originalPath' | 'url'>): string {
  const url = String(video.url || '').trim();
  if (url && !isWindowsPath(url)) return url;
  return fileUrlFromPath(url || video.originalPath);
}

function isWindowsPath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

function isAbsoluteLocalPath(value: string): boolean {
  return isWindowsPath(value) || value.startsWith('/');
}

function encodeFileUrl(url: string): string {
  return encodeURI(url).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

function readFileAsDataUrl(file: File): Promise<string | null> {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

function formatMeta(video: VideoMedia, node: FlowNode): string {
  const p = node.params as unknown as VideoGenParams;
  const duration = typeof video.duration === 'number' ? `${Math.round(video.duration)} 秒` : '时长未知';
  const size = video.width && video.height ? `${video.width}×${video.height}` : p.resolution || '—';
  const remote = video.remoteTaskId ? ` · 远端任务 ${video.remoteTaskId.slice(0, 12)}…` : '';
  return `${duration} · ${p.aspectRatio || '—'} · ${size}${remote}`;
}
function escapeHtml(s: string): string { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
async function copy(value: string): Promise<void> {
  if (!value.trim()) { showToast('无提示词可复制', false); return; }
  try { await navigator.clipboard.writeText(value); showToast('提示词已复制'); } catch { showToast('复制失败', false); }
}

export const videoViewer = new VideoViewer();
