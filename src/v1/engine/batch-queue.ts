// src/v1/engine/batch-queue.ts
// 限并发批次调度：同一批次最多 5 个 Job 在途，成功结果逐张回调给画布。
// 只做纯调度：Job 实际执行（Backend.generateImage + pollTask + 结果写回）由 run-engine 以 RunJobFn 注入，
// 队列负责状态流转（creating→running→终态）、取消感知、批次完成判定与汇总回调。
// 批间串行由 run-engine 的 busy 锁保证（本队列允许 submit 多个批次，但 run-engine 一次只提交一个）。

import { batchStore } from '../state/batch-store';

/** 当前 API 容量：批次和重试共享同一个上限，避免同一供应商瞬时被打满。 */
export const MAX_IMAGE_API_CONCURRENCY = 5;

/** 当前产品策略：最多保留 5 个在途 API 请求。 */
export function readConcurrency(total = Number.MAX_SAFE_INTEGER): number {
  return Math.min(MAX_IMAGE_API_CONCURRENCY, Math.max(1, Math.round(Number(total) || 1)));
}

/** Job 执行期钩子：onRunning 上报远端任务 id；isCancelled 供执行器在 await 间隙感知取消（防继续写结果） */
export interface JobHooks {
  onRunning: (remoteTaskId: string) => void;
  isCancelled: () => boolean;
}

/** Job 执行结果：success=false 时 error 记入 Job 独立 error（B-3） */
export interface JobRunOutcome {
  success: boolean;
  image?: GenerationJob['image'];
  error?: string | null;
}

/** 执行器：run-engine 注入（创建任务 → 轮询 → 解析展示图 → 返回结果；不做状态流转） */
export type RunJobFn = (job: GenerationJob, hooks: JobHooks) => Promise<JobRunOutcome>;

/** 批次完成回调（run-engine 注入：把成功 Job 结果写回节点；写回异常不阻断队列） */
export type BatchCompleteFn = (batch: GenerationBatch) => void | Promise<void>;
/** 单 Job 成功回调：让完成图立即进入节点结果区，不等其它 Job 结束。 */
export type BatchJobCompleteFn = (batch: GenerationBatch, job: GenerationJob) => void | Promise<void>;

interface Submission {
  batchId: string;
  runJob: RunJobFn;
  onJobComplete?: BatchJobCompleteFn;
  onComplete?: BatchCompleteFn;
  resolve: (batch: GenerationBatch | null) => void;
}

class BatchQueue {
  private running = new Set<string>();               // 在途 jobId 集合（并发计数用）
  private writing = new Set<string>();               // 成功图正在写回画布；批次不能在此阶段提前收尾
  private submissions = new Map<string, Submission>(); // 批次提交（submit/retry 时注册，终态时消费并释放）

  /** 当前在途 Job 数（外部展示/测试用） */
  get runningCount(): number {
    return this.running.size;
  }

  /**
   * 提交批次：立即 pump 调度。返回的 Promise 在该批次全部 Job 到达终态（finalize）后 resolve。
   * onJobComplete 在每张图成功时调用；onComplete 只在批次终态调用。
   */
  submit(batchId: string, runJob: RunJobFn, onJobComplete?: BatchJobCompleteFn, onComplete?: BatchCompleteFn): Promise<GenerationBatch | null> {
    return new Promise(resolve => {
      const batch = batchStore.getBatch(batchId);
      if (!batch) { resolve(null); return; }
      this.submissions.set(batchId, { batchId, runJob, onJobComplete, onComplete, resolve });
      this.pump();
    });
  }

  /** 重试单 Job（B-3）：复位 queued 后重新调度；返回该批次下次终态 */
  retryJob(batchId: string, jobId: string, runJob: RunJobFn, onJobComplete?: BatchJobCompleteFn, onComplete?: BatchCompleteFn): Promise<GenerationBatch | null> {
    return new Promise(resolve => {
      const batch = batchStore.getBatch(batchId);
      if (!batch) { resolve(null); return; }
      batchStore.retryJob(batchId, jobId);
      this.submissions.set(batchId, { batchId, runJob, onJobComplete, onComplete, resolve });
      this.pump();
    });
  }

  /** 重试全部失败项（B-3）；返回重试条数（0 = 无失败项） */
  retryFailed(batchId: string, runJob: RunJobFn, onJobComplete?: BatchJobCompleteFn, onComplete?: BatchCompleteFn): Promise<GenerationBatch | null> {
    return new Promise(resolve => {
      const batch = batchStore.getBatch(batchId);
      if (!batch) { resolve(null); return; }
      const count = batchStore.retryFailed(batchId);
      if (count === 0) { resolve(batch); return; }
      this.submissions.set(batchId, { batchId, runJob, onJobComplete, onComplete, resolve });
      this.pump();
    });
  }

  /** 取消批次：剩余 Job → cancelled；在途 Job 通过 hooks.isCancelled 停止（B-2 取消语义） */
  cancelBatch(batchId: string): void {
    batchStore.cancelBatch(batchId);
    this.pump(); // 若还有其它批次排队，可继续调度（批间串行由 run-engine busy 锁保证，正常无并发批次）
  }

  // ───────────────────────── 调度核心 ─────────────────────────

  /** 限并发调度：最多 5 个在途 Job；任一请求结束立即补发下一项。 */
  private pump(): void {
    const concurrency = readConcurrency();
    while (this.running.size < concurrency) {
      const batch = this._nextBatchWithQueuedJob();
      if (!batch) break;
      const job = batch.jobs.find(j => j.status === 'queued');
      if (!job) break;
      void this._runJob(batch.id, job.id);
    }
    // 兜底 finalize：cancel 恰落在 createBatch 与 submit/pump 间隙等竞态时，
    // 批次可能已全终态但无人触发 _maybeFinalize → 这里统一收敛，保证 submit/retry 的 Promise 必然 resolve。
    for (const [batchId] of this.submissions) {
      const b = batchStore.getBatch(batchId);
      if (b && b.jobs.every(j =>
        j.status === 'succeeded' || j.status === 'failed' || j.status === 'cancelled')) {
        void this._maybeFinalize(batchId);
      }
    }
  }

  /** 取「还有 queued Job 且未终态」的最早批次（restored 展示批次无真实任务，不调度） */
  private _nextBatchWithQueuedJob(): GenerationBatch | undefined {
    return batchStore.list().find(b => {
      if (b.restored === true) return false;
      if (b.status === 'cancelled' || b.status === 'completed' || b.status === 'partial-failed' || b.status === 'failed') return false;
      return b.jobs.some(j => j.status === 'queued');
    });
  }

  private async _runJob(batchId: string, jobId: string): Promise<void> {
    const sub = this.submissions.get(batchId);
    const job = batchStore.getJob(batchId, jobId);
    if (!sub || !job || job.status !== 'queued') return;

    batchStore.markJobStatus(batchId, jobId, 'creating');
    this.running.add(jobId);

    const hooks: JobHooks = {
      onRunning: remoteTaskId => batchStore.markJobStatus(batchId, jobId, 'running', { remoteTaskId }),
      isCancelled: () => {
        const b = batchStore.getBatch(batchId);
        return !!b && b.status === 'cancelled';
      },
    };

    let outcome: JobRunOutcome;
    try {
      outcome = await sub.runJob(job, hooks);
    } catch (e) {
      outcome = { success: false, error: (e as Error).message || '生成失败' };
    }

    this.running.delete(jobId);
    // API 槽位已释放：不等待图片落盘/画布写回，立刻补发下一条 queued Job。
    // 这样批量任务始终维持最多 5 个请求在途，单张结果仍由下方回调逐张写入。
    this.pump();

    if (hooks.isCancelled()) {
      batchStore.markJobStatus(batchId, jobId, 'cancelled');
    } else if (outcome.success) {
      batchStore.markJobStatus(batchId, jobId, 'succeeded', { image: outcome.image ?? null });
      const completedBatch = batchStore.getBatch(batchId);
      const completedJob = batchStore.getJob(batchId, jobId);
      if (completedBatch && completedJob && sub.onJobComplete) {
        this.writing.add(jobId);
        try { await sub.onJobComplete(completedBatch, completedJob); } catch { /* 单张写回异常不阻断其它任务 */ }
        finally { this.writing.delete(jobId); }
      }
    } else {
      batchStore.markJobStatus(batchId, jobId, 'failed', { error: outcome.error || '生成失败' });
    }

    await this._maybeFinalize(batchId);
  }

  /** 全部 Job 终态且 running 空 → 批次完成判定 + 写回回调 + resolve 提交方 */
  private async _maybeFinalize(batchId: string): Promise<void> {
    const batch = batchStore.getBatch(batchId);
    if (!batch) return;
    const allTerminal = batch.jobs.every(j =>
      j.status === 'succeeded' || j.status === 'failed' || j.status === 'cancelled');
    if (!allTerminal) return;
    // Job 状态已是 succeeded，但其图片可能仍在异步加载尺寸、写入节点/历史。
    // 必须等所有写回结束再 resolve，否则界面会只看到部分完成图。
    if (batch.jobs.some(j => this.writing.has(j.id))) return;

    batchStore.finalizeBatch(batchId);
    const sub = this.submissions.get(batchId);
    if (sub) {
      this.submissions.delete(batchId);
      const final = batchStore.getBatch(batchId) ?? batch;
      if (sub.onComplete) {
        try {
          await sub.onComplete(final);
        } catch { /* 写回异常不影响队列与调用方 */ }
      }
      sub.resolve(final);
    }
  }
}

export const batchQueue = new BatchQueue();
