// 轻量视频查看器：本地 video 标签直接读取落盘文件，不通过 base64/桥接搬运媒体。
import { flowState } from '../state/flow-state';
import { showToast } from './toast';
import { createVideoStep } from './action-bar';

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
    if (!node || !video?.url) { showToast('视频文件不可用，可从历史恢复或重新定位文件', false); return; }
    this.el?.remove();
    const el = document.createElement('div');
    el.className = 'video-viewer-overlay';
    const prompt = node.trace?.prompt || (node.params as unknown as VideoGenParams).prompt || '';
    el.innerHTML = `<section class="video-viewer-panel" role="dialog" aria-modal="true" aria-label="视频查看器">
      <header><strong>视频查看器</strong><button data-act="close" title="关闭">×</button></header>
      <video class="video-viewer-media" src="${escapeUrl(video.url)}" controls loop playsinline></video>
      <div class="video-viewer-meta">${escapeHtml(formatMeta(video, node))}</div>
      <div class="video-viewer-actions"><button data-act="mute">静音</button><button data-act="download">下载</button><button data-act="copy">复制提示词</button><button data-act="continue">继续创作</button></div>
    </section>`;
    el.addEventListener('click', e => {
      const target = e.target as HTMLElement;
      if (target === el || target.dataset.act === 'close') { el.remove(); this.el = null; return; }
      const act = target.dataset.act;
      const media = el.querySelector('video') as HTMLVideoElement | null;
      if (act === 'mute' && media) { media.muted = !media.muted; target.textContent = media.muted ? '取消静音' : '静音'; }
      if (act === 'download') { const a = document.createElement('a'); a.href = video.url!; a.download = `${node.title || 'video'}.mp4`; a.click(); }
      if (act === 'copy') void copy(prompt);
      if (act === 'continue') { el.remove(); this.el = null; void createVideoStep(node); }
    });
    document.body.appendChild(el);
    this.el = el;
  }
}

function formatMeta(video: VideoMedia, node: FlowNode): string {
  const p = node.params as unknown as VideoGenParams;
  const duration = typeof video.duration === 'number' ? `${Math.round(video.duration)} 秒` : '时长未知';
  const size = video.width && video.height ? `${video.width}×${video.height}` : p.resolution || '—';
  return `${duration} · ${p.aspectRatio || '—'} · ${size}`;
}
function escapeHtml(s: string): string { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function escapeUrl(s: string): string { return s.replace(/'/g, "\\'").replace(/"/g, '\\"'); }
async function copy(value: string): Promise<void> {
  if (!value.trim()) { showToast('无提示词可复制', false); return; }
  try { await navigator.clipboard.writeText(value); showToast('提示词已复制'); } catch { showToast('复制失败', false); }
}

export const videoViewer = new VideoViewer();
