// src/v1/ui/task-panel.ts
// 底部任务面板（B-4）：列出批次与逐 Job（#1~#N）状态/缩略图/失败标识/单条重试/重试全部失败。
// 批次头部「成功 x/y，失败 z」+ 并发数 + 收起/展开；运行中自动展开、结束后保留最近批次摘要可收起（PRD Q4）。
// 数据源 = batchStore（执行态事实源，共享约定 1）；不轮询，Job/Batch 每次状态变化经 notify 驱动刷新（共享约定 8）。
// restored 重建批次仅展示已知结果 + unknownCount「另有 N 个任务状态未知」，不提供重试。

import { flowState } from '../state/flow-state';
import { batchStore } from '../state/batch-store';
import { runEngine } from '../engine/run-engine';
import { showToast } from './toast';

/** Job 状态 → 中文短标签（与七态口径一致） */
const JOB_STATUS_TEXT: Record<JobStatus, string> = {
  queued: '排队中',
  creating: '创建中',
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
};

/** 批次状态 → 中文短标签 */
const BATCH_STATUS_TEXT: Record<BatchStatus, string> = {
  queued: '排队中',
  running: '运行中',
  completed: '已完成',
  'partial-failed': '部分失败',
  failed: '失败',
  cancelled: '已取消',
};

const ICON_RETRY = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>';
const ICON_CHEVRON = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

class TaskPanel {
  private el: HTMLElement | null = null;
  /** 用户展开/收起偏好（null=跟随运行态自动） */
  private expandedByUser: boolean | null = null;
  /** 上一帧是否存在运行中批次（用于「新一轮运行开始 → 自动展开」） */
  private wasActive = false;

  init(): void {
    this.el = document.getElementById('task-panel');
    if (!this.el) return;
    batchStore.subscribe(() => this.render());
    flowState.subscribe(() => this.render());
    this.el.addEventListener('click', (e: MouseEvent) => this._onClick(e));
    this.render();
  }

  /** 供 bottom-bar「任务」按钮切换显隐 */
  toggle(): void {
    if (!this.el) return;
    const hidden = this.el.classList.contains('hidden');
    this.el.classList.toggle('hidden', !hidden);
  }

  /** 运行中自动展开（bottom-bar 运行入口联动；无批次时隐藏） */
  show(): void {
    if (!this.el) return;
    this.el.classList.remove('hidden');
    this.render();
  }

  private render(): void {
    if (!this.el) return;
    const batches = this._visibleBatches();
    if (batches.length === 0) {
      this.el.classList.remove('show');
      this.el.innerHTML = '';
      this.wasActive = false;
      return;
    }

    const hasActive = batches.some(b => b.status === 'queued' || b.status === 'running');
    // 新一轮运行开始 → 复位用户偏好，恢复「运行中自动展开」默认
    if (hasActive && !this.wasActive) this.expandedByUser = null;
    this.wasActive = hasActive;
    const expanded = hasActive
      ? this.expandedByUser !== false
      : this.expandedByUser === true;

    const html = batches.map(b => this._renderBatch(b, expanded)).join('');
    this.el.innerHTML = `<div class="task-panel-inner">${html}</div>`;
    this.el.classList.add('show');
  }

  /** 展示批次：运行中（queued/running）全部 + 最近一个已结束批次（restored 仅在有结果时展示） */
  private _visibleBatches(): GenerationBatch[] {
    const list = batchStore.list().filter(b => b.restored !== true);
    const active = list.filter(b => b.status === 'queued' || b.status === 'running');
    const finished = list.filter(b => b.status !== 'queued' && b.status !== 'running');
    const latestFinished = finished.length > 0 ? [finished[finished.length - 1]] : [];
    return [...active.reverse(), ...latestFinished];
  }

  private _renderBatch(batch: GenerationBatch, expanded: boolean): string {
    const node = flowState.getNode(batch.nodeId);
    const title = node?.title || '节点';
    const s = batchStore.summarize(batch.id);
    const shortId = batch.id.length > 10 ? `${batch.id.slice(-8)}` : batch.id;
    const statusText = BATCH_STATUS_TEXT[batch.status] || batch.status;
    const retryAll = s.failed > 0
      ? `<button class="tp-retry-all" data-action="retry-all" data-batch="${escapeAttr(batch.id)}" title="重试全部失败项">重试全部失败 (${s.failed})</button>`
      : '';
    const unknownHint = batch.unknownCount && batch.unknownCount > 0
      ? `<span class="tp-unknown" title="刷新前进行中的任务，状态未知">另有 ${batch.unknownCount} 个任务状态未知</span>`
      : '';
    const chevron = expanded ? ICON_CHEVRON : ICON_CHEVRON.replace('m6 9 6 6 6-6', 'm6 15 6-6 6 6');
    const jobs = expanded ? `<div class="tp-jobs">${batch.jobs.map(j => this._renderJob(batch, j)).join('')}</div>` : '';

    return `<div class="tp-batch" data-status="${batch.status}">
      <div class="tp-head">
        <span class="tp-batch-label">批次 #${escapeHtml(shortId)}</span>
        <span class="tp-node-title">${escapeHtml(title)}</span>
        <span class="tp-status-chip" data-status="${batch.status}">${statusText}</span>
        <span class="tp-summary">成功 <b>${s.succeeded}</b>/${s.total} · 失败 <b>${s.failed}</b> · 并发上限 ${batch.concurrency}</span>
        ${unknownHint}
        <span class="tp-head-actions">${retryAll}
          <button class="tp-toggle" data-action="toggle" data-batch="${escapeAttr(batch.id)}" title="${expanded ? '收起' : '展开'}">${chevron}</button>
        </span>
      </div>
      ${jobs}
    </div>`;
  }

  private _renderJob(batch: GenerationBatch, job: GenerationJob): string {
    const thumb = job.status === 'succeeded' && job.image?.url
      ? `<div class="tp-job-thumb" style="background-image:url('${escapeUrl(job.image.url)}')" title="${escapeAttr(job.prompt)}"></div>`
      : `<div class="tp-job-thumb no-img"><span>${job.status === 'failed' ? '✕' : (job.status === 'cancelled' ? '−' : '…')}</span></div>`;
    const error = job.status === 'failed' && job.error
      ? `<div class="tp-job-error" title="${escapeAttr(job.error)}">${escapeHtml(truncate(job.error, 40))}</div>`
      : '';
    const retry = (job.status === 'failed' || job.status === 'cancelled')
      ? `<button class="tp-job-retry" data-action="retry-job" data-batch="${escapeAttr(batch.id)}" data-job="${escapeAttr(job.id)}" title="重试此条">${ICON_RETRY}<span>重试</span></button>`
      : '';
    const attempts = job.attempts > 1 ? `<span class="tp-job-attempts" title="已尝试 ${job.attempts} 次">×${job.attempts}</span>` : '';
    return `<div class="tp-job" data-status="${job.status}">
      <div class="tp-job-index">#${job.index + 1}${attempts}</div>
      ${thumb}
      <div class="tp-job-status">${JOB_STATUS_TEXT[job.status] || job.status}</div>
      ${error}
      ${retry}
    </div>`;
  }

  private _onClick(e: MouseEvent): void {
    const btn = (e.target as Element).closest('button') as HTMLElement | null;
    if (!btn) return;
    const action = btn.dataset.action;
    const batchId = btn.dataset.batch || '';
    const jobId = btn.dataset.job || '';
    e.preventDefault();
    e.stopPropagation();
    if (action === 'toggle') {
      const wasExpanded = this.expandedByUser === true || (this.expandedByUser === null && this.wasActive);
      this.expandedByUser = !wasExpanded;
      this.render();
      return;
    }
    if (action === 'retry-job') {
      const batch = batchStore.getBatch(batchId);
      if (!batch) { showToast('批次信息已失效', false); return; }
      void runEngine.retryJob(batch.nodeId, batchId, jobId);
      return;
    }
    if (action === 'retry-all') {
      const batch = batchStore.getBatch(batchId);
      if (!batch) { showToast('批次信息已失效', false); return; }
      void runEngine.retryFailed(batch.nodeId, batchId);
      return;
    }
  }
}

/** HTML 转义（标题/错误/提示词展示用，防注入） */
function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 属性值转义（data-* 内嵌用） */
function escapeAttr(text: string): string {
  return escapeHtml(text);
}

/** 背景图 URL 转义（单引号包裹的 style 内） */
function escapeUrl(url: string): string {
  return url.replace(/'/g, "\\'").replace(/"/g, '\\"');
}

/** 截断长文本（面板单行展示） */
function truncate(text: string, n: number): string {
  return text.length > n ? text.slice(0, n) + '…' : text;
}

export const taskPanel = new TaskPanel();
