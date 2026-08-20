// src/v1/state/batch-store.ts
// 会话级 Batch/Job 存储（仿 asset-store 模式：单例 + 订阅通知 + 不落盘）。
// 共享约定 1（D1）：Batch = 执行态唯一事实源；节点结果（imageUrl/generatedImages/trace）= 结果持久化真相。
//   运行期状态（queued/creating/running/failed/cancelled/attempts/error）只存这里，绝不写入 FlowNode；
//   节点 status 只反映「七态派生结果」（nodeStatus 唯一出口）。
// B-7：启动/换项目后 rebuildFromNodes() 从节点结果反向重建已知批次（.icproj 版本不动、不加 batches 段）。

import { flowState } from './flow-state';

class BatchStore {
  private batches = new Map<string, GenerationBatch>();
  private listeners = new Set<() => void>();

  // ───────────────────────── 订阅通知（仿 asset-store） ─────────────────────────
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  notify(): void {
    this.listeners.forEach(fn => {
      try { fn(); } catch { /* 单个订阅者异常不影响整体 */ }
    });
  }

  // ───────────────────────── 创建 / 查询 ─────────────────────────

  /**
   * 同步创建批次：total=N + N 个 queued Job（B-1 验收：任意时刻 jobs.length === total）。
   * batchId = 传入 id 或 `${nodeId}_${Date.now()}`（R3 兼容）；jobId = `${batchId}_j${index}`（共享约定 4）。
   * id 由调用方（run-engine）预计算并透传——保证 createBatch 与 batchQueue.submit 使用同一批次号
   * （若内部再取 Date.now()，跨毫秒边界会导致提交查不到批次，批次永不执行）。
   * 创建后立即 notify（面板/卡片订阅刷新），不自动入队——由 run-engine 决定 submit 时机。
   */
  createBatch(opts: {
    id?: string;
    nodeId: string;
    source: GenerationBatch['source'];
    total: number;
    concurrency: number;
    prompts: string[];
  }): GenerationBatch {
    const batchId = opts.id || `${opts.nodeId}_${Date.now()}`;
    const createdAt = Date.now();
    const total = Math.max(1, Math.round(Number(opts.total) || 1));
    const jobs: GenerationJob[] = [];
    for (let i = 0; i < total; i++) {
      jobs.push({
        id: `${batchId}_j${i}`,
        batchId,
        index: i,
        prompt: typeof opts.prompts[i] === 'string' ? opts.prompts[i] : '',
        status: 'queued',
        error: null,
        attempts: 1,
        createdAt,
      });
    }
    const batch: GenerationBatch = {
      id: batchId,
      nodeId: opts.nodeId,
      source: opts.source,
      total,
      concurrency: opts.concurrency,
      status: 'queued',
      jobs,
      createdAt,
    };
    this.batches.set(batchId, batch);
    this.notify();
    return batch;
  }

  getBatch(batchId: string): GenerationBatch | undefined {
    return this.batches.get(batchId);
  }

  getJob(batchId: string, jobId: string): GenerationJob | undefined {
    return this.batches.get(batchId)?.jobs.find(j => j.id === jobId);
  }

  /** 某节点的全部批次（按创建时间升序 = 执行顺序） */
  getBatchesByNode(nodeId: string): GenerationBatch[] {
    return [...this.batches.values()]
      .filter(b => b.nodeId === nodeId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 进行中的批次（queued/running；排除 restored 重建批次——那些只是展示，没有真实任务在跑） */
  getActiveBatch(nodeId: string): GenerationBatch | undefined {
    return [...this.batches.values()].find(b =>
      b.nodeId === nodeId && b.restored !== true && (b.status === 'queued' || b.status === 'running'));
  }

  /** 某节点最近一次（非 restored）批次 */
  getLatestBatch(nodeId: string): GenerationBatch | undefined {
    const list = this.getBatchesByNode(nodeId).filter(b => b.restored !== true);
    return list[list.length - 1];
  }

  /** 全量批次（按创建时间升序） */
  list(): GenerationBatch[] {
    return [...this.batches.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  // ───────────────────────── 状态流转（唯一写入口） ─────────────────────────

  /**
   * Job 状态流转唯一写入口：每次状态变化 notify（共享约定 8）。
   * queued→creating→running→终态（succeeded/failed/cancelled）；重试时 retryJob 复位 queued。
   */
  markJobStatus(batchId: string, jobId: string, status: JobStatus, patch: Partial<GenerationJob> = {}): void {
    const batch = this.batches.get(batchId);
    const job = batch?.jobs.find(j => j.id === jobId);
    if (!batch || !job) return;
    job.status = status;
    Object.assign(job, patch);
    if (status === 'running') job.startedAt = job.startedAt ?? Date.now();
    if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
      job.finishedAt = job.finishedAt ?? Date.now();
    }
    if (status === 'queued') {
      job.error = null;
      job.finishedAt = undefined;
    }
    // 首个 Job 开工 → 批次 queued→running
    if (batch.status === 'queued' && (status === 'creating' || status === 'running')) {
      batch.status = 'running';
    }
    this.notify();
  }

  /**
   * 批次汇总（B-5 准确汇总）：逐 Job 独立计数。
   * status 字段 = 批次当前状态（可能仍在跑）；调用方结合 running/queued 判断。
   */
  summarize(batchId: string): {
    total: number; succeeded: number; failed: number; cancelled: number;
    running: number; queued: number; status: BatchStatus;
  } {
    const batch = this.batches.get(batchId);
    if (!batch) return { total: 0, succeeded: 0, failed: 0, cancelled: 0, running: 0, queued: 0, status: 'cancelled' };
    let succeeded = 0, failed = 0, cancelled = 0, running = 0, queued = 0;
    batch.jobs.forEach(j => {
      switch (j.status) {
        case 'succeeded': succeeded++; break;
        case 'failed': failed++; break;
        case 'cancelled': cancelled++; break;
        case 'creating':
        case 'running': running++; break;
        case 'queued': queued++; break;
      }
    });
    return { total: batch.total, succeeded, failed, cancelled, running, queued, status: batch.status };
  }

  /** 首个失败原因（UI 显示用；无失败 → null） */
  firstError(batchId: string): string | null {
    const batch = this.batches.get(batchId);
    const job = batch?.jobs.find(j => j.status === 'failed' && j.error);
    return job?.error ?? null;
  }

  /**
   * 批次结束判定（队列在全部 Job 到达终态且 running 空时调用）：
   * cancelled（有取消）→ completed（全成功）→ partial-failed（有成功有失败）→ failed（全失败）。
   */
  finalizeBatch(batchId: string): void {
    const batch = this.batches.get(batchId);
    if (!batch) return;
    const s = this.summarize(batchId);
    let status: BatchStatus;
    if (s.cancelled > 0) status = 'cancelled';
    else if (s.failed === 0) status = 'completed';
    else if (s.succeeded > 0) status = 'partial-failed';
    else status = 'failed';
    batch.status = status;
    batch.finishedAt = Date.now();
    this.notify();
  }

  // ───────────────────────── 重试 / 取消 ─────────────────────────

  /** 重试单 Job（B-3）：attempts+1、status=queued、error 清空；批次回到 running（供队列重新调度） */
  retryJob(batchId: string, jobId: string): void {
    const batch = this.batches.get(batchId);
    const job = batch?.jobs.find(j => j.id === jobId);
    if (!batch || !job) return;
    if (job.status !== 'failed' && job.status !== 'cancelled') return;
    job.status = 'queued';
    job.error = null;
    job.attempts += 1;
    job.remoteTaskId = undefined;
    job.image = null;
    job.startedAt = undefined;
    job.finishedAt = undefined;
    batch.status = 'running';
    batch.finishedAt = undefined;
    this.notify();
  }

  /** 重试全部失败项（B-3）；返回重试条数（0 = 无失败项） */
  retryFailed(batchId: string): number {
    const batch = this.batches.get(batchId);
    if (!batch) return 0;
    const failed = batch.jobs.filter(j => j.status === 'failed');
    failed.forEach(j => this.retryJob(batchId, j.id));
    return failed.length;
  }

  /** 取消整批（B-2 取消语义）：剩余非终态 Job → cancelled；批次 → cancelled。在途 Job 由队列 hooks.isCancelled 感知。 */
  cancelBatch(batchId: string): void {
    const batch = this.batches.get(batchId);
    if (!batch) return;
    batch.jobs.forEach(j => {
      if (j.status === 'queued' || j.status === 'creating' || j.status === 'running') {
        j.status = 'cancelled';
        j.finishedAt = j.finishedAt ?? Date.now();
      }
    });
    batch.status = 'cancelled';
    batch.finishedAt = Date.now();
    this.notify();
  }

  // ───────────────────────── 节点七态派生（B-5 唯一出口） ─────────────────────────

  /**
   * 节点七态派生（卡片/面板状态唯一出口）：
   *   有运行中/排队中批次 → queued/run（读 batch.status + jobs 分布）
   *   批次结束 → done（全成功）/ partial-failed（有成功有失败）/ fail（全失败）/ idle（取消）
   *   无批次 → 从节点结果派生终态（node.status，维持现状语义）
   * restored 重建批次不参与派生（只是展示；没有真实任务在跑）。
   */
  nodeStatus(nodeId: string): NodeStatus {
    const node = flowState.getNode(nodeId);
    if (!node) return 'idle';
    const active = this.getActiveBatch(nodeId);
    if (active) {
      const s = this.summarize(active.id);
      if (s.running > 0) return 'run';
      if (s.queued > 0) return 'queued';
      return 'run';
    }
    const latest = this.getLatestBatch(nodeId);
    if (latest) {
      switch (latest.status) {
        case 'completed': return 'done';
        case 'partial-failed': return 'partial-failed';
        case 'failed': return 'fail';
        case 'cancelled': return 'idle';
        default: break; // queued/running 已被 getActiveBatch 覆盖；restored 不在此列
      }
    }
    return node.status;
  }

  // ───────────────────────── 刷新恢复（B-7） ─────────────────────────

  /**
   * 从节点持久化结果（imageUrl / generatedImages / trace）重建已知批次。
   * - 每个有结果的 image-gen 节点按 trace.batchId（缺失用 `${nodeId}_restored`）重建一个批次，
   *   已知成功 Job 按 generatedImages 顺序（无则单张 imageUrl）填充；
   * - 持久化 status='run' 的节点（保存时恰在运行中）→ restored + unknownCount「另有 N 个任务状态未知」；
   * - .icproj 版本不动、不加 batches 段；旧节点无新字段时正常加载（新字段全可选）。
   */
  rebuildFromNodes(): void {
    this.batches.clear();
    flowState.nodes
      .filter(n => n.type === 'image-gen')
      .forEach(node => {
        const items = Array.isArray(node.generatedImages)
          ? node.generatedImages.filter((i): i is GeneratedImageItem => !!i && typeof i.url === 'string' && !!i.url)
          : [];
        const trace = node.trace;
        const hasResult = items.length > 0 || !!node.imageUrl || !!trace?.batchId;
        if (!hasResult && node.status !== 'run') return;

        const batchId = trace?.batchId || `${node.id}_restored`;
        const createdAt = trace?.createdAt || Date.now();
        const known: Array<{ url: string; prompt?: string; origin?: ImageOrigin | null; width?: number; height?: number }> =
          items.length > 0
            ? items.map(i => ({ url: i.url, prompt: i.prompt, origin: i.origin, width: i.width, height: i.height }))
            : (node.imageUrl ? [{ url: node.imageUrl, prompt: trace?.prompt, origin: node.imageOrigin, width: node.imageWidth, height: node.imageHeight }] : []);

        const jobs: GenerationJob[] = known.map((item, i) => ({
          id: `${batchId}_j${i}`,
          batchId,
          index: i,
          prompt: item.prompt || trace?.prompt || '',
          status: 'succeeded' as JobStatus,
          image: {
            url: item.url,
            originalPath: item.origin?.path,
            originalUrl: item.origin?.url,
            width: item.width,
            height: item.height,
          },
          error: null,
          attempts: 1,
          createdAt,
          finishedAt: createdAt,
        }));

        if (jobs.length === 0 && node.status !== 'run') return; // 无已知结果也无进行中标记 → 不建空批次

        const wasRunning = node.status === 'run';
        const batch: GenerationBatch = {
          id: batchId,
          nodeId: node.id,
          source: 'manual-count', // 重建无法可靠区分驱动来源；面板仅作展示用
          total: jobs.length,
          concurrency: 2,
          status: wasRunning ? 'running' : 'completed',
          jobs,
          createdAt,
          finishedAt: wasRunning ? undefined : createdAt,
          restored: true,
          ...(wasRunning ? { unknownCount: 1 } : {}),
        };
        this.batches.set(batchId, batch);
      });
    this.notify();
  }

  /** 会话级：清空全部批次（换项目重建前调用） */
  clear(): void {
    this.batches.clear();
    this.notify();
  }
}

export const batchStore = new BatchStore();
