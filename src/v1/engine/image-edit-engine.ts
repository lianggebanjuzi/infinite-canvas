// 4.1-B 远端图片编辑：统一 API 创建一次本地任务，远端受理后只轮询同一任务，绝不自动重投。
// 蒙版局改（mask-edit）与多角度（angle）共用：新建排队节点 → submitting → accepted（远端 task id）
// → 轮询原任务 → succeeded / failed / cancelled / uncertain；失败保留源节点与用户输入，重试创建新本地任务。

import { Backend } from '../api';
import { flowState } from '../state/flow-state';
import { flowHistory } from '../state/history';
import { dirty } from '../state/dirty';
import { CARD_W } from '../canvas/canvas-view';
import { pollTask } from './poller';
import { historyPersist } from '../history-persist';
import { historyDrawer } from '../ui/history-drawer';
import { showToast } from '../ui/toast';

export interface EditRequest {
  kind: 'mask-edit' | 'annotation' | 'angle';
  sourceId: string;
  prompt: string;
  model: string;
  /** 提交时的一次性压缩蒙版 PNG dataURL（不长期塞进节点 JSON / trace） */
  maskData?: string;
  /** 蒙版元数据（本地路径优先；仅记录轻量信息，便于 trace 追溯） */
  mask?: { path?: string; width: number; height: number };
  angle?: { preset: string; instruction: string };
  /** 供远端视觉模型理解的带批注参考图；第一张参考图始终是未标注原图。 */
  additionalReferenceImages?: string[];
  /** 下游节点创建后立即回调（编辑器据此在任务运行中支持「取消本地等待」） */
  onNodeCreated?: (nodeId: string) => void;
}

/** start() 结果句柄：编辑器据此决定关闭 / 保留蒙版提示词重试 / 取消本地等待。 */
export interface EditStartResult {
  nodeId: string;
  ok: boolean;
  cancelled?: boolean;
  error?: string;
}

/** 从节点 params 安全读取 StyleTransferParams（4 处 TS2352 修复：先过 unknown 再断言） */
function styleParams(node: FlowNode): StyleTransferParams {
  return (node?.params || {}) as unknown as StyleTransferParams;
}

class ImageEditEngine {
  private active = new Set<string>();

  /**
   * 启动一次图片编辑：创建下游排队节点并提交。
   * 返回 {nodeId, ok}；失败时 ok=false（编辑器保留蒙版与提示词，可修改后重试）。
   */
  async start(request: EditRequest): Promise<EditStartResult> {
    const source = flowState.getNode(request.sourceId);
    if (!source || !source.imageUrl) {
      return { nodeId: '', ok: false, error: '源节点没有可用图片' };
    }
    const sourceRefs = await this.sourceData(source);
    const refs = [...sourceRefs, ...(request.additionalReferenceImages || []).filter(Boolean)];
    if (!refs.length) {
      showToast('源图片读取失败，无法提交编辑', false);
      return { nodeId: '', ok: false, error: '源图片读取失败' };
    }
    flowHistory.record();
    const now = Date.now();
    const sp = styleParams(source);
    const trace: GenerationTrace = {
      prompt: request.prompt, model: request.model, aspectRatio: sp.aspectRatio || 'Auto', resolution: sp.resolution || '1k', count: 1,
      refImageHashes: sourceRefs.map(item => historyPersist.hashRef(item)), refImageUrls: source.imageUrl ? [source.imageUrl] : [], seed: null,
      createdAt: now, parentId: source.id, outputType: 'image-edit', editKind: request.kind, sourceNodeId: source.id,
      ...(request.mask ? { mask: request.mask } : {}), ...(request.angle ? { angle: request.angle } : {}),
    };
    const node = flowState.addNode('image-gen', source.x + (source.w ?? CARD_W) + 48, source.y, {
      title: request.kind === 'mask-edit' ? '局部修改（排队）'
        : request.kind === 'annotation' ? '批注修改（排队）'
          : `视角：${request.angle?.preset || '变化'}（排队）`,
      ratio: source.ratio, status: 'queued', parentId: source.id, trace,
      params: {
        prompt: request.prompt, model: request.model, aspectRatio: trace.aspectRatio, resolution: trace.resolution, count: 1, mode: 'draw',
        imageEditTask: { state: 'queued' },
      },
    });
    flowState.addEdge(source.id, node.id, { suppressStale: true });
    request.onNodeCreated?.(node.id);
    return this.submit(node.id, refs, request);
  }

  /** 取消本地等待：已受理的远端任务只保留记录，绝不重复提交（4.0 §3.2 用户取消语义）。 */
  cancel(nodeId: string): boolean {
    if (!this.active.has(nodeId)) return false;
    this.active.delete(nodeId);
    const node = flowState.getNode(nodeId);
    if (node) flowState.updateNode(nodeId, { status: 'idle', error: '已取消本地等待；远端任务不会被重复提交' });
    return true;
  }

  /** 项目恢复：accepted/processing 中的任务只查询原任务，不重投。 */
  async recover(nodeId: string): Promise<void> {
    const node = flowState.getNode(nodeId);
    const params = node?.params as Record<string, unknown> | undefined;
    const task = params?.imageEditTask as ImageEditTask | undefined;
    if (!node || !task?.localTaskId || this.active.has(nodeId)) return;
    const terminal: ImageEditTask['state'][] = ['succeeded', 'failed', 'cancelled', 'uncertain'];
    if (terminal.includes(task.state)) return;
    this.active.add(nodeId);
    flowState.updateNode(nodeId, { status: 'run', error: '查询恢复中：不会重新提交远端任务' });
    try {
      await this.awaitResult(nodeId, task.localTaskId);
    } finally {
      this.active.delete(nodeId);
    }
  }

  /** 恢复当前画布中全部未终结的图片编辑任务（打开项目后调用）。 */
  recoverAll(): void {
    flowState.nodes.forEach(node => {
      const params = node?.params as Record<string, unknown> | undefined;
      const task = params?.imageEditTask as ImageEditTask | undefined;
      if (!task?.localTaskId) return;
      const terminal: ImageEditTask['state'][] = ['succeeded', 'failed', 'cancelled', 'uncertain'];
      if (terminal.includes(task.state)) return;
      void this.recover(node.id);
    });
  }

  /** 是否还有运行中的图片编辑任务（关闭保护 / 撤销禁用共用）。 */
  isBusy(): boolean {
    return this.active.size > 0;
  }

  private async submit(nodeId: string, refs: string[], request: EditRequest): Promise<EditStartResult> {
    this.active.add(nodeId);
    const node = flowState.getNode(nodeId);
    if (!node?.trace) {
      this.active.delete(nodeId);
      return { nodeId, ok: false, error: '任务节点状态异常' };
    }
    try {
      flowState.updateNode(nodeId, { status: 'submitting', error: null });
      const created = await Backend.generateImageEdit(node.trace.prompt, {
        model: node.trace.model, aspectRatio: node.trace.aspectRatio, resolution: node.trace.resolution, count: 1,
        referenceImages: refs, ...(request.maskData ? { maskImage: request.maskData } : {}),
      });
      if (!this.active.has(nodeId)) return { nodeId, ok: false, cancelled: true, error: '已取消本地等待' };
      flowState.updateNodeParams(nodeId, { imageEditTask: { state: 'accepted', localTaskId: created.task_id } });
      flowState.updateNode(nodeId, { status: 'run' });
      await this.awaitResult(nodeId, created.task_id);
      const finalNode = flowState.getNode(nodeId);
      const ok = !!finalNode && finalNode.status === 'done';
      return { nodeId, ok, error: ok ? undefined : (finalNode?.error || '图片编辑失败') };
    } catch (error) {
      if (this.active.has(nodeId)) {
        const message = (error as Error).message || '图片编辑提交失败';
        flowState.updateNode(nodeId, { status: 'fail', error: message });
        return { nodeId, ok: false, error: message };
      }
      return { nodeId, ok: false, cancelled: true, error: '已取消本地等待' };
    } finally {
      this.active.delete(nodeId);
    }
  }

  private async awaitResult(nodeId: string, taskId: string): Promise<void> {
    const result = await pollTask(taskId, {
      onTick: (status, remoteTaskId) => {
        if (!this.active.has(nodeId)) return;
        const node = flowState.getNode(nodeId);
        if (!node?.trace) return;
        if (remoteTaskId) node.trace.remoteTaskId = remoteTaskId;
        flowState.updateNodeParams(nodeId, {
          imageEditTask: { state: this.normalizeState(status), localTaskId: taskId, remoteTaskId: remoteTaskId || node.trace.remoteTaskId },
        });
        flowState.updateNode(nodeId, {
          status: status === 'queued' ? 'queued' : 'run',
          error: status === 'recovering' ? '查询恢复中：正在查询原远端任务' : null,
        });
      },
    });
    if (!this.active.has(nodeId)) return;
    const node = flowState.getNode(nodeId);
    if (!node || !node.trace) return;
    if (!result.success) {
      const remote = node.trace.remoteTaskId ? `（远端任务：${node.trace.remoteTaskId}）` : '';
      const uncertain = result.code === 504;
      flowState.updateNodeParams(nodeId, {
        imageEditTask: {
          state: uncertain ? 'uncertain' : 'failed', localTaskId: taskId,
          remoteTaskId: node.trace.remoteTaskId, error: `${result.error || '图片编辑失败'}${remote}`,
        },
      });
      flowState.updateNode(nodeId, { status: uncertain ? 'stale' : 'fail', error: `${result.error || '图片编辑失败'}${remote}` });
      showToast(`${result.error || '图片编辑失败'}${remote}`, false);
      return;
    }
    let imageUrl = result.imageUrl;
    if (!imageUrl && result.originalPath) {
      const loaded = await Backend.loadLocalImage(result.originalPath);
      imageUrl = loaded.status === 'success' ? loaded.data_url : undefined;
    }
    if (!imageUrl) {
      flowState.updateNode(nodeId, { status: 'fail', error: '编辑完成但未返回可显示图片' });
      return;
    }
    const origin: ImageOrigin | null = result.originalPath ? { path: result.originalPath, url: result.originalUrl } : null;
    const ratio = result.width && result.height ? result.width / result.height : node.ratio;
    const trace = node.trace;
    flowState.updateNodeParams(nodeId, {
      imageEditTask: { state: 'succeeded', localTaskId: taskId, remoteTaskId: trace.remoteTaskId },
    });
    flowState.updateNode(nodeId, {
      title: trace.editKind === 'mask-edit' ? '局部修改结果'
        : trace.editKind === 'annotation' ? '批注修改结果'
          : `视角：${trace.angle?.preset || '变化'}`,
      imageUrl, imageOrigin: origin, imageWidth: result.width, imageHeight: result.height,
      ratio, status: 'done', error: null, lastRunAt: Date.now(),
    });
    void historyPersist.appendTrace({
      kind: 'image', nodeId, imageUrl, thumbnail: imageUrl,
      originalPath: origin?.path, originalUrl: origin?.url,
      ...trace, outputType: 'image-edit' as const,
    });
    historyDrawer.addImage(imageUrl, {
      nodeId, prompt: trace.prompt, model: trace.model, aspectRatio: trace.aspectRatio, resolution: trace.resolution, count: 1,
      outputType: 'image-edit', thumbnail: imageUrl, originalPath: origin?.path, originalUrl: origin?.url,
      width: result.width, height: result.height,
    });
    dirty.markUpstreamChanged(nodeId);
    showToast('图片编辑完成');
  }

  /** poller 的中间态字符串 → ImageEditTask.state 规范化（accepted 后只有原任务查询语义）。 */
  private normalizeState(status: string): ImageEditTask['state'] {
    if (status === 'queued' || status === 'pending') return 'queued';
    if (status === 'processing' || status === 'in_progress') return 'processing';
    if (status === 'recovering') return 'accepted';
    if (status === 'done') return 'succeeded';
    if (status === 'failed' || status === 'error') return 'failed';
    return 'accepted';
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
