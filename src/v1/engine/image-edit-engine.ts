// 4.1-B 远端图片编辑：统一 API 创建一次本地任务，远端受理后只轮询同一任务，绝不自动重投。

import { Backend, localImageFileUrl } from '../api';
import { flowState } from '../state/flow-state';
import { flowHistory } from '../state/history';
import { dirty } from '../state/dirty';
import { CARD_W } from '../canvas/canvas-view';
import { pollTask } from './poller';
import { historyPersist } from '../history-persist';
import { historyDrawer } from '../ui/history-drawer';
import { showToast } from '../ui/toast';

interface EditRequest {
  kind: 'mask-edit' | 'angle';
  sourceId: string;
  prompt: string;
  model: string;
  maskData?: string;
  mask?: { path?: string; width: number; height: number };
  angle?: { preset: string; instruction: string };
}

class ImageEditEngine {
  private active = new Set<string>();

  async start(request: EditRequest): Promise<void> {
    const source = flowState.getNode(request.sourceId);
    if (!source || !source.imageUrl) return;
    const refs = await this.sourceData(source);
    if (!refs.length) { showToast('源图片读取失败，无法提交编辑', false); return; }
    flowHistory.record();
    const now = Date.now();
    const trace: GenerationTrace = {
      prompt: request.prompt, model: request.model, aspectRatio: (source.params as StyleTransferParams).aspectRatio || 'Auto', resolution: (source.params as StyleTransferParams).resolution || '1k', count: 1,
      refImageHashes: refs.map(item => historyPersist.hashRef(item)), refImageUrls: source.imageUrl ? [source.imageUrl] : [], seed: null,
      createdAt: now, parentId: source.id, outputType: 'image-edit', editKind: request.kind, sourceNodeId: source.id,
      ...(request.mask ? { mask: request.mask } : {}), ...(request.angle ? { angle: request.angle } : {}),
    };
    const node = flowState.addNode('image-gen', source.x + (source.w ?? CARD_W) + 48, source.y, {
      title: request.kind === 'mask-edit' ? '局部修改（排队）' : `视角：${request.angle?.preset || '变化'}（排队）`,
      ratio: source.ratio, status: 'queued', parentId: source.id, trace,
      params: { prompt: request.prompt, model: request.model, aspectRatio: trace.aspectRatio, resolution: trace.resolution, count: 1, mode: 'draw', imageEditTask: { state: 'queued' } },
    });
    flowState.addEdge(source.id, node.id, { suppressStale: true });
    await this.submit(node.id, refs, request.maskData);
  }

  cancel(nodeId: string): boolean {
    if (!this.active.has(nodeId)) return false;
    this.active.delete(nodeId);
    const node = flowState.getNode(nodeId);
    if (node) flowState.updateNode(nodeId, { status: 'idle', error: '已取消本地等待；远端任务不会被重复提交' });
    return true;
  }

  async recover(nodeId: string): Promise<void> {
    const node = flowState.getNode(nodeId);
    const localTaskId = (node?.params as Record<string, unknown> | undefined)?.imageEditTask as { localTaskId?: string } | undefined;
    if (!node || !localTaskId?.localTaskId || this.active.has(nodeId)) return;
    this.active.add(nodeId);
    flowState.updateNode(nodeId, { status: 'run', error: '查询恢复中：不会重新提交远端任务' });
    try { await this.awaitResult(nodeId, localTaskId.localTaskId); } finally { this.active.delete(nodeId); }
  }

  private async submit(nodeId: string, refs: string[], maskData?: string): Promise<void> {
    this.active.add(nodeId);
    const node = flowState.getNode(nodeId);
    if (!node?.trace) return;
    try {
      flowState.updateNode(nodeId, { status: 'submitting', error: null } as Partial<FlowNode>);
      const created = await Backend.generateImageEdit(node.trace.prompt, { model: node.trace.model, aspectRatio: node.trace.aspectRatio, resolution: node.trace.resolution, count: 1, referenceImages: refs, ...(maskData ? { maskImage: maskData } : {}) });
      if (!this.active.has(nodeId)) return;
      flowState.updateNodeParams(nodeId, { imageEditTask: { state: 'accepted', localTaskId: created.task_id } });
      flowState.updateNode(nodeId, { status: 'run' });
      await this.awaitResult(nodeId, created.task_id);
    } catch (error) {
      if (this.active.has(nodeId)) flowState.updateNode(nodeId, { status: 'fail', error: (error as Error).message || '图片编辑提交失败' });
    } finally { this.active.delete(nodeId); }
  }

  private async awaitResult(nodeId: string, taskId: string): Promise<void> {
    const result = await pollTask(taskId, { onTick: (status, remoteTaskId) => {
      if (!this.active.has(nodeId)) return;
      const node = flowState.getNode(nodeId); if (!node?.trace) return;
      if (remoteTaskId) node.trace.remoteTaskId = remoteTaskId;
      flowState.updateNodeParams(nodeId, { imageEditTask: { state: status, localTaskId: taskId, remoteTaskId: remoteTaskId || node.trace.remoteTaskId } });
      flowState.updateNode(nodeId, { status: status === 'queued' ? 'queued' : 'run', error: status === 'recovering' ? '查询恢复中：正在查询原远端任务' : null });
    }});
    if (!this.active.has(nodeId)) return;
    const node = flowState.getNode(nodeId);
    if (!node || !node.trace) return;
    if (!result.success) {
      const remote = node.trace.remoteTaskId ? `（远端任务：${node.trace.remoteTaskId}）` : '';
      const uncertain = result.code === 504;
      flowState.updateNode(nodeId, { status: uncertain ? 'stale' : 'fail', error: `${result.error || '图片编辑失败'}${remote}` });
      return;
    }
    let imageUrl = result.imageUrl;
    if (!imageUrl && result.originalPath) {
      const loaded = await Backend.loadLocalImage(result.originalPath);
      imageUrl = loaded.status === 'success' ? loaded.data_url : undefined;
    }
    if (!imageUrl) { flowState.updateNode(nodeId, { status: 'fail', error: '编辑完成但未返回可显示图片' }); return; }
    const origin: ImageOrigin | null = result.originalPath ? { path: result.originalPath, url: result.originalUrl } : null;
    const ratio = result.width && result.height ? result.width / result.height : node.ratio;
    const trace = node.trace;
    flowState.updateNode(nodeId, { title: trace.editKind === 'mask-edit' ? '局部修改结果' : `视角：${trace.angle?.preset || '变化'}`, imageUrl, imageOrigin: origin, imageWidth: result.width, imageHeight: result.height, ratio, status: 'done', error: null, lastRunAt: Date.now() });
    void historyPersist.appendTrace({ kind: 'image', nodeId, imageUrl, thumbnail: imageUrl, originalPath: origin?.path, originalUrl: origin?.url, ...trace });
    historyDrawer.addImage(imageUrl, { nodeId, prompt: trace.prompt, model: trace.model, aspectRatio: trace.aspectRatio, resolution: trace.resolution, count: 1, outputType: 'image-edit', thumbnail: imageUrl, originalPath: origin?.path, originalUrl: origin?.url, width: result.width, height: result.height });
    dirty.markUpstreamChanged(nodeId);
    showToast('图片编辑完成');
  }

  private async sourceData(source: FlowNode): Promise<string[]> {
    if (source.imageOrigin?.path) {
      const data = await Backend.loadLocalImage(source.imageOrigin.path);
      if (data.status === 'success' && data.data_url) return [data.data_url];
    }
    return source.imageUrl ? [source.imageUrl] : [];
  }
}

export const imageEditEngine = new ImageEditEngine();
