// src/v1/engine/run-engine.ts
// 执行引擎：run(nodeId)/runSelected()/runAll() + 状态机转换 + 下游 stale + 多结果卡批次并发
// 唯一生成入口：任何节点类型不得绕过引擎直连 backend（共享约定第 3 条）
//
// 多结果卡（方向 B）：
//   - 生成节点 run → runBatch：N=clamp(count,1,4)（启动时快照 params.count）并发 N 个单张请求（count=1）
//   - 每张完成立即自动建一张结果卡（image-result）并从生成节点自动连线（suppressStale）
//   - 重跑先 removeChildren 清掉旧结果卡再重建；结果永不写回生成节点
//   - 部分失败：有成功即 done + toast「成功 x/y」；全失败才 fail（旧图保留）
//   - busy 锁粒度=整个批次（批次内并发、批次间串行）

import { flowState } from '../state/flow-state';
import { dirty } from '../state/dirty';
import { nodeRegistry } from '../nodes/node-registry';
import { Backend, fetchImageModels } from '../api';
import { pollTask } from './poller';
import { historyDrawer } from '../ui/history-drawer';
import { linkView } from '../canvas/link-view';
import { CARD_W } from '../canvas/canvas-view';
import { showToast } from '../ui/toast';

/** 节点定义执行上下文（供 canRun/buildOptions 使用） */
const ctx: FlowContext = {
  getUpstreams: id => flowState.getUpstreams(id),
  getDownstreams: id => flowState.getDownstreams(id),
  getReferenceImages: id => flowState.getReferenceImages(id),
  getImageModels: fetchImageModels,
};

/** 批次进度（不持久化；cmd-panel 在 run 状态实时展示） */
interface BatchProgress {
  total: number;
  done: number;
  failed: number;
  lastError: string | null;
}

/** 生成请求并发数上限/下限 */
const COUNT_MIN = 1;
const COUNT_MAX = 4;
/** 结果卡相对生成节点的横向间距 */
const RESULT_GAP_X = 48;
/** 结果卡纵向间距（卡片高之外额外 28px） */
const RESULT_GAP_Y = 28;

/**
 * 加载图片并返回实际宽高比（naturalWidth / naturalHeight）。
 * 后端 image_url 不附带尺寸信息，需前端加载图片获取；加载失败/尺寸无效返回 null。
 * 带 10s 超时保护，避免加载异常阻塞状态回写。
 */
function loadImageRatio(url: string): Promise<number | null> {
  return new Promise(resolve => {
    const img = new Image();
    let settled = false;
    const timer = setTimeout(() => finish(null), 10000); // 10s 超时保护
    const finish = (ratio: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      resolve(ratio);
    };
    img.onload = () => {
      const ratio = img.naturalWidth > 0 && img.naturalHeight > 0
        ? img.naturalWidth / img.naturalHeight
        : null;
      finish(ratio);
    };
    img.onerror = () => finish(null);
    img.src = url;
  });
}

class RunEngine {
  /** 全局串行：同一时间只跑一个任务（避免 pywebview 轮询互相干扰；批次内并发、批次间串行） */
  private busy = false;

  /** 批次瞬时进度（不持久化）：nodeId → {total,done,failed} */
  private batchProgress = new Map<string, BatchProgress>();
  /** 本批次新建的结果卡 id 集合（供 markUpstreamChangedExcept 跳过） */
  private _createdCardIds = new Set<string>();

  /** 读取批次进度（cmd-panel 选中 run 节点时展示「生成中 done/total」） */
  getBatchProgress(nodeId: string): { total: number; done: number; failed: number } | undefined {
    const p = this.batchProgress.get(nodeId);
    return p ? { total: p.total, done: p.done, failed: p.failed } : undefined;
  }

  async run(nodeId: string): Promise<void> {
    const node = flowState.getNode(nodeId);
    if (!node) return;
    if (node.status === 'run') return;
    if (this.busy) { showToast('已有任务在运行，请稍候', false); return; }

    const def = nodeRegistry.get(node.type);
    const check = def.canRun(node, ctx);
    if (typeof check === 'string') { showToast(check, false); return; }

    this.busy = true;
    try {
      await this.runBatch(nodeId);
    } finally {
      this.busy = false;
    }
  }

  /**
   * 批次执行（生成节点专用）：并发 N 个单张请求，成功即建结果卡。
   * 前置：canRun 已通过；busy 锁已持有。
   */
  private async runBatch(nodeId: string): Promise<void> {
    const node = flowState.getNode(nodeId);
    if (!node) return;

    // 1. 启动时快照参数与 options（buildOptions 只取一次、强制 count:1）
    const params = node.params as unknown as StyleTransferParams;
    const prompt = (params.prompt || '').trim();
    const total = Math.min(COUNT_MAX, Math.max(COUNT_MIN, Math.round(Number(params.count) || COUNT_MIN)));
    const def = nodeRegistry.get(node.type);
    const options = def.buildOptions(node, ctx);
    options.count = COUNT_MIN;

    // 2. 重跑顶掉：置 run 之前先清掉上次的结果卡（其下游标 stale）
    flowState.removeChildren(nodeId);

    // 3. 置 run + 上游连线流光
    flowState.updateNode(nodeId, { status: 'run', error: null });
    linkView.setNodeFlowing(nodeId, true);

    // 4. 批次进度（瞬时，不持久化）
    const progress: BatchProgress = { total, done: 0, failed: 0, lastError: null };
    this.batchProgress.set(nodeId, progress);
    this._createdCardIds.clear();
    flowState.notify(); // 面板立即显示「生成中 0/total」

    // 5. 并发 N 个 worker（Promise.allSettled：互不阻塞，任一失败不影响兄弟）
    const jobs = Array.from({ length: total }, (_, i) =>
      this.runOneWorker(nodeId, prompt, options, i, progress));
    await Promise.allSettled(jobs);

    linkView.setNodeFlowing(nodeId, false);
    this.batchProgress.delete(nodeId);

    // 6. 汇总：有成功 → done + 旧图入历史后清空 + 旧下游标 stale（新结果卡跳过）
    const after = flowState.getNode(nodeId);
    if (!after) return; // 批次期间生成节点被删除
    if (progress.done > 0) {
      // 旧 imageUrl 先入历史图库保留，再清空（结果永不写回生成节点，回到 refImages[0] 占位）
      if (after.imageUrl) {
        historyDrawer.addImage(after.imageUrl);
        // 注意：setNodeImage(id, null) 忽略 null 不清空 imageUrl，必须用 updateNode({imageUrl:null})
        flowState.updateNode(nodeId, { imageUrl: null });
      }
      flowState.updateNode(nodeId, { status: 'done', error: null, lastRunAt: Date.now() });
      dirty.markUpstreamChangedExcept(nodeId, this._createdCardIds);
      showToast(`成功 ${progress.done}/${total}`);
    } else {
      // 全失败：保留旧图，节点 fail
      flowState.updateNode(nodeId, { status: 'fail', error: progress.lastError || '生成失败' });
      showToast('生成失败', false);
    }
  }

  /** 单个 worker：创建单张生成任务 → 轮询 → 成功立即建结果卡；失败计数 */
  private async runOneWorker(
    genId: string,
    prompt: string,
    options: Record<string, unknown>,
    slotIndex: number,
    progress: BatchProgress,
  ): Promise<void> {
    try {
      const created = await Backend.generateImage(prompt, { ...options, count: COUNT_MIN });
      if (!created || !created.task_id) {
        throw new Error('任务创建失败，未返回 task_id');
      }
      const result = await pollTask(created.task_id);
      if (result.success && result.imageUrl) {
        // 出一张建一张（不等兄弟）：立即创建结果卡并自动连线
        const card = await this.createResultCard(genId, result.imageUrl, slotIndex);
        this._createdCardIds.add(card.id);
        progress.done += 1;
      } else {
        throw new Error(result.error || '生成失败');
      }
    } catch (e) {
      progress.failed += 1;
      progress.lastError = (e as Error).message || '生成失败';
    } finally {
      this._touchProgress(genId);
    }
  }

  /**
   * 创建一张结果卡（image-result）：生成节点右侧纵向排列，第 i 张
   * x=gen.x+CARD_W+48，y=gen.y + i*(cardH+28)；自动连线（suppressStale）；入历史图库。
   * 槽位 slotIndex 固定（0..N-1），并发完成顺序不定也不重叠。
   */
  private async createResultCard(genId: string, imageUrl: string, slotIndex: number): Promise<FlowNode> {
    const gen = flowState.getNode(genId);
    if (!gen) throw new Error('生成节点已删除，结果卡创建失败');
    const ratio = await loadImageRatio(imageUrl);
    const r = ratio && ratio > 0 ? ratio : 3 / 4;
    const cardH = Math.round(CARD_W / r);
    const x = gen.x + CARD_W + RESULT_GAP_X;
    const y = gen.y + slotIndex * (cardH + RESULT_GAP_Y);

    const node = flowState.addNode('image-result', x, y, {
      parentId: genId,
      imageUrl,
      ratio: r,
      status: 'done',
      error: null,
      lastRunAt: Date.now(),
      title: '生成结果',
    });
    // 自动建卡连线：suppressStale 避免刚 done 的结果卡被立即打回 stale
    flowState.addEdge(genId, node.id, { suppressStale: true });
    historyDrawer.addImage(imageUrl);
    return node;
  }

  /** 批次进度变更后通知（结果卡创建已触发 notify；失败无卡片场景需手动触发，保证面板进度刷新） */
  private _touchProgress(_nodeId: string): void {
    flowState.notify();
  }

  /** A5：运行选中。单选=运行当前卡；多选=按拓扑序运行整组 */
  async runSelected(): Promise<void> {
    const ids = [...flowState.selectedIds];
    if (ids.length === 0) { showToast('请先选中节点', false); return; }
    if (ids.length === 1) { await this.run(ids[0]); return; }
    await this.runAll(ids);
  }

  /** 运行全部/一组（按拓扑序；遇失败停止，避免依赖链空跑） */
  async runAll(ids?: string[]): Promise<void> {
    const targets = ids && ids.length > 0 ? ids : flowState.nodes.map(n => n.id);
    const sorted = this._topoSort(targets);
    for (const id of sorted) {
      const node = flowState.getNode(id);
      if (!node || node.status === 'done') continue;
      await this.run(id);
      const after = flowState.getNode(id);
      if (after && after.status === 'fail') break;
    }
  }

  /** Kahn 拓扑排序（参照 pipeline-engine._topoSort） */
  private _topoSort(ids: string[]): string[] {
    const idSet = new Set(ids);
    const inDegree = new Map<string, number>();
    const adjList = new Map<string, string[]>();
    ids.forEach(id => {
      inDegree.set(id, 0);
      adjList.set(id, []);
    });
    ids.forEach(id => {
      flowState.getEdgesFrom(id).forEach(edge => {
        if (idSet.has(edge.to)) {
          adjList.get(id)!.push(edge.to);
          inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
        }
      });
    });
    const queue: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }
    const result: string[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      result.push(id);
      (adjList.get(id) || []).forEach(neighbor => {
        inDegree.set(neighbor, (inDegree.get(neighbor) ?? 1) - 1);
        if (inDegree.get(neighbor) === 0) queue.push(neighbor);
      });
    }
    // 环保护：未能排入的节点追加在末尾（模板默认无环）
    ids.forEach(id => { if (!result.includes(id)) result.push(id); });
    return result;
  }
}

export const runEngine = new RunEngine();
