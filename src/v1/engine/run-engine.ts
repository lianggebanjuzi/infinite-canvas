// src/v1/engine/run-engine.ts
// 执行引擎：run(nodeId)/runSelected()/runAll() + 状态机转换 + 下游 stale
// 唯一生成入口：任何节点类型不得绕过引擎直连 backend（共享约定第 3 条）

import { flowState } from '../state/flow-state';
import { dirty } from '../state/dirty';
import { nodeRegistry } from '../nodes/node-registry';
import { Backend, fetchImageModels } from '../api';
import { pollTask } from './poller';
import { historyDrawer } from '../ui/history-drawer';
import { linkView } from '../canvas/link-view';
import { showToast } from '../ui/toast';

/** 节点定义执行上下文（供 canRun/buildOptions 使用） */
const ctx: FlowContext = {
  getUpstreams: id => flowState.getUpstreams(id),
  getDownstreams: id => flowState.getDownstreams(id),
  getReferenceImages: id => flowState.getReferenceImages(id),
  getImageModels: fetchImageModels,
};

class RunEngine {
  /** 全局串行：同一时间只跑一个任务（避免 pywebview 轮询互相干扰） */
  private busy = false;

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
      flowState.updateNode(nodeId, { status: 'run', error: null });
      linkView.setNodeFlowing(nodeId, true); // 上游连线流光

      const params = node.params as unknown as StyleTransferParams;
      const prompt = (params.prompt || '').trim();
      const options = def.buildOptions(node, ctx);

      const created = await Backend.generateImage(prompt, options);
      if (!created || !created.task_id) {
        linkView.setNodeFlowing(nodeId, false);
        flowState.updateNode(nodeId, { status: 'fail', error: '任务创建失败，未返回 task_id' });
        showToast('任务创建失败', false);
        return;
      }

      const result = await pollTask(created.task_id);
      linkView.setNodeFlowing(nodeId, false);
      if (result.success && result.imageUrl) {
        flowState.setNodeImage(nodeId, result.imageUrl, undefined);
        flowState.updateNode(nodeId, { status: 'done', error: null, lastRunAt: Date.now() });
        historyDrawer.addImage(result.imageUrl);
        dirty.markUpstreamChanged(nodeId); // 若有下游 → 标 stale
        showToast('生成完成');
      } else {
        flowState.updateNode(nodeId, { status: 'fail', error: result.error || '生成失败' });
        showToast('生成失败', false);
      }
    } catch (e) {
      linkView.setNodeFlowing(nodeId, false);
      flowState.updateNode(nodeId, { status: 'fail', error: (e as Error).message || '生成失败' });
      showToast('生成失败', false);
    } finally {
      this.busy = false;
    }
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
