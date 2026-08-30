// 音频查看器：本地 audio 标签直接读取落盘文件；播放/暂停/下载/加入资产（4.2-B）。
import { flowState } from '../state/flow-state';
import { flowHistory } from '../state/history';
import { showToast } from './toast';
import { assetStore } from '../asset-store';

class AudioViewer {
  private el: HTMLElement | null = null;

  init(): void {
    window.addEventListener('icv:open-audio', event => {
      const nodeId = (event as CustomEvent<{ nodeId?: string }>).detail?.nodeId;
      if (nodeId) this.open(nodeId);
    });
  }

  open(nodeId: string): void {
    const node = flowState.getNode(nodeId);
    const audio = node?.audio;
    if (!node || !audio?.originalPath) { showToast('音频文件不可用', false); return; }
    this.el?.remove();
    const el = document.createElement('div');
    el.className = 'video-viewer-overlay';
    const prompt = node.trace?.prompt || (node.params as unknown as AudioGenParams).prompt || '';
    const validUrl = audio.url || fileUrlFromPath(audio.originalPath);
    const added = !!validUrl && assetStore.isAddedByUrl(validUrl);
    el.innerHTML = `<section class="video-viewer-panel" role="dialog" aria-modal="true" aria-label="音频查看器">
      <header><strong>音频查看器</strong><button data-act="close" title="关闭">×</button></header>
      <div class="audio-viewer-visual">
        <div class="audio-viewer-wave">${waveformHtml(24)}</div>
        <audio class="audio-viewer-media" controls playsinline preload="metadata"></audio>
      </div>
      <div class="video-viewer-meta">${escapeHtml(formatMeta(audio))}</div>
      <div class="video-viewer-actions">
        <button data-act="download">下载</button>
        <button data-act="copy">复制提示词</button>
        <button data-act="add-asset"${added ? ' disabled' : ''}>${added ? '已在资产库' : '加入资产'}</button>
      </div>
    </section>`;
    const media = el.querySelector('.audio-viewer-media') as HTMLAudioElement | null;
    if (media) media.src = validUrl;
    el.addEventListener('click', e => {
      const target = e.target as HTMLElement;
      if (target === el || target.dataset.act === 'close') { el.remove(); this.el = null; return; }
      const act = target.dataset.act;
      if (act === 'download' && audio.url) { const a = document.createElement('a'); a.href = audio.url; a.download = `${node.title || 'audio'}.${extOf(audio.originalPath)}`; a.click(); }
      if (act === 'copy') void copy(prompt);
      if (act === 'add-asset') this._addToAsset(node);
    });
    document.body.appendChild(el);
    this.el = el;
  }

  /** 加入资产：媒体记录（kind:'audio'），配方从节点 trace 合成。 */
  private _addToAsset(node: FlowNode): void {
    const audio = node.audio;
    if (!audio?.originalPath) return;
    const url = audio.url || fileUrlFromPath(audio.originalPath);
    if (!url) return;
    if (assetStore.isAddedByUrl(url)) { showToast('已在资产库'); return; }
    flowHistory.record();
    assetStore.addByMediaUrl(url, node.id, 'audio', audio.originalPath, assetStore.metaFromNode(node), {
      duration: audio.duration, mimeType: audio.mimeType, sizeBytes: audio.sizeBytes,
      remoteTaskId: audio.remoteTaskId,
    });
    showToast('已加入资产库');
  }
}

/** 离线抽样波形占位（不要求实时频谱）：固定条高，纯装饰。 */
function waveformHtml(bars: number): string {
  let html = '';
  let seed = 7;
  const next = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < bars; i++) {
    const h = Math.round(24 + next() * 60);
    html += `<i style="height:${h}%"></i>`;
  }
  return html;
}

/** 本地绝对路径 → file:// URL（与 video-viewer 同构） */
function fileUrlFromPath(filePath: string): string {
  const normalized = String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  return normalized ? encodeURI(`file:///${normalized}`) : '';
}

function extOf(path: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(String(path || '').split('?')[0]);
  return m ? m[1].toLowerCase() : 'mp3';
}

function formatMeta(audio: AudioMedia): string {
  const duration = typeof audio.duration === 'number' ? `${Math.round(audio.duration)} 秒` : '时长未知';
  const size = typeof audio.sizeBytes === 'number' ? `${(audio.sizeBytes / 1024 / 1024).toFixed(1)} MB` : '';
  const mime = audio.mimeType || '';
  const remote = audio.remoteTaskId ? ` · 远端任务 ${audio.remoteTaskId.slice(0, 12)}…` : '';
  return [duration, size, mime, remote].filter(Boolean).join(' · ');
}
function escapeHtml(s: string): string { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
async function copy(value: string): Promise<void> {
  if (!value.trim()) { showToast('无提示词可复制', false); return; }
  try { await navigator.clipboard.writeText(value); showToast('提示词已复制'); } catch { showToast('复制失败', false); }
}

export const audioViewer = new AudioViewer();
