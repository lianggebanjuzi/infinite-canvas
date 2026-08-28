// src/v1/ui/result-viewer.ts
// 结果查看器抽屉（C-2）：批次图片大图浏览（prev/next / 第 x/N 张）、提示词/模型/尺寸/参考图/任务时间、
// 失败原因、下载/复制提示词/反推/再编辑/单项重试。
// 数据源：节点结果（imageUrl/generatedImages）+ batch-store（Job 状态/失败原因/任务时间），
// 大图按需加载原图（优先 file:// 直读，宿主拦截时才 Backend.loadLocalImage 回退）。

import { flowState } from '../state/flow-state';
import { batchStore } from '../state/batch-store';
import { selection } from '../state/selection';
import { runEngine } from '../engine/run-engine';
import { Backend, localImageFileUrl } from '../api';
import { showToast } from './toast';
import { createContinueStep } from './action-bar';
import { imageEditor } from './image-editor/image-editor';

/** 查看器条目：由节点 generatedImages（或单张 imageUrl）+ batch Job 合成 */
interface ViewerItem {
  index: number;             // 0-based 批次内序号
  total: number;
  url: string;
  prompt: string;
  origin?: { path?: string; url?: string } | null;
  width?: number;
  height?: number;
  batchId?: string;
  jobId?: string;
  status?: string;           // Job 状态（succeeded/failed/cancelled/…）
  error?: string | null;
  createdAt?: number;
}

class ResultViewer {
  private el: HTMLElement | null = null;
  private nodeId: string | null = null;
  private items: ViewerItem[] = [];
  private current = 0;

  init(): void {
    this.el = document.getElementById('result-viewer');
    if (!this.el) return;
    document.getElementById('rv-close')?.addEventListener('click', () => this.close());
    this.el.addEventListener('click', (e: MouseEvent) => this._onClick(e));
    this.el.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') { this.prev(); e.preventDefault(); }
      if (e.key === 'ArrowRight') { this.next(); e.preventDefault(); }
    });
  }

  /** 打开查看器：nodeId + 可选起始序号（默认节点当前预览位） */
  open(nodeId: string, index?: number): void {
    const node = flowState.getNode(nodeId);
    if (!node || !this.el) return;
    if (node.type !== 'image-gen' || (!node.imageUrl && !(node.generatedImages?.length))) {
      showToast('该节点还没有可查看的图片', false);
      return;
    }
    this.nodeId = nodeId;
    this.items = this._collectItems(node);
    const start = Math.min(Math.max(0, index ?? node.activeGeneratedIndex ?? 0), Math.max(0, this.items.length - 1));
    this.current = start;
    this.el.classList.add('show');
    this._render();
  }

  close(): void {
    if (!this.el) return;
    this.el.classList.remove('show');
    this.nodeId = null;
    this.items = [];
  }

  isOpen(): boolean {
    return !!this.el && this.el.classList.contains('show');
  }

  prev(): void {
    if (this.items.length === 0) return;
    this.current = (this.current - 1 + this.items.length) % this.items.length;
    this._render();
  }

  next(): void {
    if (this.items.length === 0) return;
    this.current = (this.current + 1) % this.items.length;
    this._render();
  }

  /** 当前展示项（供卡片预览快捷切换联动） */
  get currentIndex(): number { return this.current; }
  get currentNodeId(): string | null { return this.nodeId; }

  /** 收集展示条目：
   *  有批次（batch-store 非 restored）→ 按 job.index 排列：成功项显示结果图，失败项显示失败原因 + 单项重试；
   *  无批次（count=1 单图 / restored 重建）→ generatedImages 平铺（restored 已知成功 Job）。
   */
  private _collectItems(node: FlowNode): ViewerItem[] {
    const images = (node.generatedImages && node.generatedImages.length > 0 ? node.generatedImages : []);
    const batch = node.trace?.batchId ? batchStore.getBatch(node.trace.batchId) : undefined;
    const items: ViewerItem[] = [];
    if (batch && batch.jobs.length > 0 && batch.restored !== true) {
      let successOrdinal = 0;
      batch.jobs.slice().sort((a, b) => a.index - b.index).forEach(job => {
        if (job.status === 'succeeded') {
          const img = images[successOrdinal];
          successOrdinal += 1;
          if (!img) return;
          items.push({
            index: items.length, total: batch.total,
            url: img.url, prompt: job.prompt || img.prompt,
            origin: img.origin, width: img.width, height: img.height,
            batchId: batch.id, jobId: job.id, status: 'succeeded', createdAt: job.finishedAt,
          });
        } else if (job.status === 'failed') {
          items.push({
            index: items.length, total: batch.total,
            url: '', prompt: job.prompt,
            batchId: batch.id, jobId: job.id, status: 'failed', error: job.error, createdAt: job.finishedAt,
          });
        }
      });
      return items;
    }
    // 无批次：单张或 generatedImages 平铺
    const total = images.length > 0 ? images.length : 1;
    for (let i = 0; i < total; i++) {
      const img = images[i];
      const url = img ? img.url : (node.imageUrl || '');
      items.push({
        index: i,
        total,
        url,
        prompt: img?.prompt || node.trace?.prompt || '',
        origin: img?.origin || node.imageOrigin,
        width: img?.width ?? node.imageWidth,
        height: img?.height ?? node.imageHeight,
        batchId: node.trace?.batchId,
        jobId: node.trace?.batchId ? `${node.trace.batchId}_j${i}` : undefined,
        status: 'succeeded',
        createdAt: node.trace?.createdAt,
      });
    }
    return items;
  }

  private _render(): void {
    if (!this.el || this.items.length === 0) return;
    const item = this.items[this.current];
    const node = flowState.getNode(this.nodeId || '');
    const trace = node?.trace || null;
    const recipeAvailable = !!trace;
    const actualPrompt = recipeAvailable ? (item.prompt || trace!.prompt || '') : '';
    const refs = recipeAvailable ? (trace!.refImageUrls || []) : [];
    const countEl = document.getElementById('rv-count');
    if (countEl) countEl.textContent = item.total > 1 ? `第 ${this.current + 1}/${item.total}` : '';
    const body = document.getElementById('rv-body');
    if (!body) return;
    const stageHtml = item.url
      ? `<img id="rv-img" src="${escapeUrl(item.url)}" alt="" ${item.width ? `data-w="${item.width}"` : ''} ${item.height ? `data-h="${item.height}"` : ''}>`
      : `<div class="rv-noimg">该任务失败，无结果图</div>`;
    body.innerHTML = `
      <div class="rv-main">
        <div class="rv-stage" id="rv-stage">
          ${stageHtml}
          <div class="rv-loading" id="rv-loading">加载原图中…</div>
        </div>
        ${item.total > 1 ? `
        <div class="rv-nav">
          <button class="rv-nav-btn" data-action="prev" title="上一张 (←)">‹</button>
          <button class="rv-nav-btn" data-action="next" title="下一张 (→)">›</button>
        </div>` : ''}
      </div>
      <div class="rv-info">
        ${item.error && item.status === 'failed' ? `<div class="rv-fail">失败原因：${escapeHtml(item.error)}</div>` : ''}
        ${recipeAvailable ? `
          <div class="rv-field"><div class="rv-label">来源</div><div class="rv-value">${escapeHtml(sourceText(node!))}</div></div>
          <div class="rv-field"><div class="rv-label">操作</div><div class="rv-value">${escapeHtml(operationText(trace!.outputType))}</div></div>
          <div class="rv-field"><div class="rv-label">提示词</div><div class="rv-value prompt">${escapeHtml(actualPrompt || '—')}</div></div>
          <div class="rv-field"><div class="rv-label">模型</div><div class="rv-value">${escapeHtml(modelName(trace!.model || '') || '—')}</div></div>
          <div class="rv-field"><div class="rv-label">尺寸</div><div class="rv-value" data-field="size">${sizeText(item)}</div></div>
          <div class="rv-field"><div class="rv-label">设置</div><div class="rv-value">${escapeHtml(`${trace!.aspectRatio || '—'} · ${(trace!.resolution || '—').toUpperCase()} · ${trace!.count || 1} 张`)}</div></div>
          <div class="rv-field"><div class="rv-label">时间</div><div class="rv-value">${escapeHtml(formatTime(item.createdAt || trace!.createdAt))}</div></div>
          ${refs.length ? `<div class="rv-field"><div class="rv-label">参考</div><div class="rv-reference-strip">${refs.map(url => `<img src="${escapeUrl(url)}" alt="参考图">`).join('')}</div></div>` : ''}
          ${item.batchId ? `<div class="rv-field"><div class="rv-label">批次 / 任务</div><div class="rv-value">${escapeHtml(shortId(item.batchId))}${item.jobId ? ' · 第 ' + escapeHtml(String(this.current + 1)) + ' 项' : ''}</div></div>` : ''}
        ` : '<div class="rv-recipe-missing">历史配方不可用</div>'}
        <div class="rv-actions">
          ${item.url ? `<button class="btn-ghost rv-btn" data-action="download">下载</button>` : ''}
          ${recipeAvailable ? '<button class="btn-ghost rv-btn" data-action="copy">复制提示词</button>' : ''}
          ${item.url ? '<button class="btn-primary rv-btn" data-action="continue">以此继续创作</button>' : ''}
          ${item.url ? '<button class="btn-ghost rv-btn" data-action="crop">裁剪</button>' : ''}
          <button class="btn-ghost rv-btn" data-action="reverse">反推</button>
          <button class="btn-ghost rv-btn" data-action="reedit">再编辑</button>
          ${item.status === 'failed' ? `<button class="btn-primary rv-btn" data-action="retry">重试此条</button>` : ''}
        </div>
      </div>`;
    if (item.url) this._loadOriginal(item);
  }

  /** 原图按需加载：浏览器先直读文件，避免整张原图 base64 跨桥接；失败才兼容回退。 */
  private _loadOriginal(item: ViewerItem): void {
    const img = document.getElementById('rv-img') as HTMLImageElement | null;
    const loading = document.getElementById('rv-loading') as HTMLElement | null;
    if (!img || !loading || !item.url) { if (loading) loading.style.display = 'none'; return; }
    img.onload = () => {
      const sizeEl = document.querySelector('[data-field="size"]');
      if (sizeEl && img.naturalWidth > 0 && img.naturalHeight > 0 && !(item.width)) {
        sizeEl.textContent = `${img.naturalWidth}×${img.naturalHeight}`;
      }
      loading.style.display = 'none';
    };
    const path = item.origin?.path;
    if (!path) { loading.style.display = 'none'; return; }
    loading.style.display = 'flex';
    const loadThroughBridge = async (): Promise<void> => {
      try {
        const res = await Backend.loadLocalImage(path);
        if (res.status === 'success' && res.data_url) {
          img.onerror = null;
          img.src = res.data_url;
          return;
        }
      } catch {
        // 下方统一提示并保留缩略图。
      }
      loading.style.display = 'none';
      showToast('原图加载失败，已显示缩略图', false);
    };
    img.onerror = () => {
      img.onerror = null;
      void loadThroughBridge();
    };
    img.src = localImageFileUrl(path, item.origin?.url);
  }

  private _onClick(e: MouseEvent): void {
    const target = e.target as Element;
    if (target === this.el) { this.close(); return; } // 点空白关闭
    const btn = target.closest('[data-action]') as HTMLElement | null;
    if (!btn) return;
    const action = btn.dataset.action;
    e.preventDefault();
    e.stopPropagation();
    const item = this.items[this.current];
    if (action === 'prev') { this.prev(); return; }
    if (action === 'next') { this.next(); return; }
    if (!item) return;
    if (action === 'download') {
      const a = document.createElement('a');
      a.href = item.url;
      a.download = `image_${this.current + 1}.png`;
      a.click();
      return;
    }
    if (action === 'copy') {
      copyText(nodePrompt(this.nodeId, item.prompt));
      return;
    }
    if (action === 'continue') {
      const node = flowState.getNode(this.nodeId || '');
      if (!node || !item.url) { showToast('该结果不可继续创作', false); return; }
      // 候选组只在用户明确采用时切换卡片主视觉；随后复用唯一 continue 入口。
      if ((node.generatedImages || []).length > 0) {
        flowState.updateNode(node.id, { activeGeneratedIndex: this.current, imageUrl: item.url,
          imageOrigin: item.origin?.path ? { path: item.origin.path, url: item.origin.url } : null,
          imageWidth: item.width, imageHeight: item.height });
      }
      this.close();
      void createContinueStep(node);
      return;
    }
    if (action === 'reverse') {
      this._reversePrompt();
      return;
    }
    if (action === 'reedit') {
      if (this.nodeId) selection.select(this.nodeId);
      this.close();
      return;
    }
    if (action === 'crop') {
      if (!this.nodeId) return;
      // 多候选时明确采用当前查看项，编辑结果仍从同一来源节点派生。
      const node = flowState.getNode(this.nodeId);
      if (node && (node.generatedImages || []).length > 0 && item.url) {
        flowState.updateNode(node.id, { activeGeneratedIndex: this.current, imageUrl: item.url,
          imageOrigin: item.origin?.path ? { path: item.origin.path, url: item.origin.url } : null,
          imageWidth: item.width, imageHeight: item.height });
      }
      this.close();
      void imageEditor.openCrop(this.nodeId);
      return;
    }
    if (action === 'retry') {
      const node = flowState.getNode(this.nodeId || '');
      if (!node || !item.batchId || !item.jobId) { showToast('批次信息已失效', false); return; }
      void runEngine.retryJob(node.id, item.batchId, item.jobId);
      this.close();
      return;
    }
  }

  /** 反推：运行直接连接的 text-gen 下游（有则选中并运行；无则提示） */
  private _reversePrompt(): void {
    const nodeId = this.nodeId;
    if (!nodeId) return;
    const downstreamText = flowState.getDownstreams(nodeId).find(n => n.type === 'text-gen');
    if (!downstreamText) {
      showToast('请先连接文本节点以反推', false);
      return;
    }
    selection.select(downstreamText.id);
    void runEngine.run(downstreamText.id);
  }
}

function modelName(modelId: string): string {
  if (!modelId) return '';
  return modelId.split(':').pop() || modelId || '';
}

function operationText(outputType: GenerationTrace['outputType']): string {
  return outputType === 'outpaint' ? '扩图' : (outputType === 'img2img' ? '图生图' : '文生图');
}

function sourceText(node: FlowNode): string {
  if (flowState.isAssetNode(node)) return '导入素材';
  const upstream = flowState.getUpstreams(node.id).find(item => item.type === 'image-gen');
  if (!upstream) return '当前创作步骤';
  return flowState.isAssetNode(upstream) ? '导入素材' : '上一步图片';
}

function nodePrompt(nodeId: string | null, itemPrompt: string): string {
  const node = flowState.getNode(nodeId || '');
  return node?.trace ? (itemPrompt || node.trace.prompt || '') : '';
}

function sizeText(item: ViewerItem): string {
  if (item.width && item.height) return `${item.width}×${item.height}`;
  return '—';
}

function formatTime(ts?: number): string {
  if (!ts || !(ts > 0)) return '—';
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function shortId(id: string): string {
  return id.length > 12 ? `…${id.slice(-10)}` : id;
}

function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeUrl(url: string): string {
  return url.replace(/'/g, "\\'").replace(/"/g, '\\"');
}

/** 复制文本（Clipboard API 优先，兜底 execCommand；成功 toast） */
function copyText(text: string): void {
  const value = (text || '').trim();
  if (!value) { showToast('无提示词可复制', false); return; }
  const done = (): void => showToast('提示词已复制');
  const fail = (): void => showToast('复制失败', false);
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    void navigator.clipboard.writeText(value).then(done, fail);
    return;
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } finally { document.body.removeChild(ta); }
    if (copied) done(); else fail();
  } catch { fail(); }
}

export const resultViewer = new ResultViewer();
