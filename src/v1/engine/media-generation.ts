// 视频与音频的新任务执行器。
// RunEngine 负责活动运行表和批次；本模块负责已受理媒体任务的状态、结果与溯源写回。
import { flowState } from '../state/flow-state';
import { dirty } from '../state/dirty';
import { nodeRegistry } from '../nodes/node-registry';
import { Backend } from '../api';
import { historyDrawer } from '../ui/history-drawer';
import { historyPersist } from '../history-persist';
import { linkView } from '../canvas/link-view';
import { showToast } from '../ui/toast';
import { pollVideoTask } from './video-poller';
import { pollAudioTask } from './audio-poller';
import { normalizeMediaTask } from './media-task';
import { getVideoModelCapabilities } from '../nodes/model-config';
import type { ActiveRun } from './media-task-recovery';

const TASK_CREATE_TIMEOUT_MS = 60000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}（${Math.round(ms / 1000)}s 未响应）`)), ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

export interface MediaGenerationHost {
  context: FlowContext;
  isActive: (active: ActiveRun) => boolean;
  resolveReferenceImages: (nodeId: string) => Promise<string[]>;
  composePrompt: (nodeId: string) => string;
}

/** 执行视频、音频生成；受理后仅轮询同一 localTaskId。 */
export class MediaGenerationController {
  constructor(private readonly host: MediaGenerationHost) {}

  async runVideo(nodeId: string, active: ActiveRun): Promise<void> {
    const node = flowState.getNode(nodeId);
    if (!node) return;
    const def = nodeRegistry.get('video-gen');
    const options = def.buildOptions(node, this.host.context);
    const refs = await this.host.resolveReferenceImages(nodeId);
    options.referenceImages = refs;
    const prompt = this.host.composePrompt(nodeId);

    const caps = getVideoModelCapabilities((node.params as unknown as VideoGenParams).model || '');
    const audioUpstream = flowState.getUpstreams(nodeId).find(upstream => upstream.type === 'audio-gen');
    if (audioUpstream && !caps.supportsAudio) {
      flowState.updateNode(nodeId, {
        status: 'fail',
        error: '当前视频模型不支持音频输入（已忽略音轨）。可切换支持音频的视频模型，或断开音频连线后重试。',
      });
      showToast('当前视频模型不支持音频输入；请切换模型或断开音频连线', false);
      return;
    }

    flowState.updateNode(nodeId, { status: 'queued', error: null });
    flowState.updateNodeParams(nodeId, { videoTask: { state: 'queued' } });
    linkView.setNodeFlowing(nodeId, true);
    try {
      flowState.updateNode(nodeId, { status: 'submitting' });
      flowState.updateNodeParams(nodeId, { videoTask: { state: 'submitting' } });
      const created = await withTimeout(Backend.generateVideo(prompt, options), TASK_CREATE_TIMEOUT_MS, '视频任务创建超时');
      if (!this.host.isActive(active)) return;
      if (!created?.task_id) throw new Error('视频任务创建失败，未返回 task_id');
      flowState.updateNodeParams(nodeId, { videoTask: { state: 'accepted', localTaskId: created.task_id } });
      flowState.updateNode(nodeId, { status: 'run' });
      const result = await pollVideoTask(created.task_id, (status, remoteTaskId) => {
        if (!this.host.isActive(active)) return;
        const current = flowState.getNode(nodeId);
        if (!current) return;
        const existing = current.video || null;
        flowState.updateNodeParams(nodeId, { videoTask: normalizeMediaTask(status, created.task_id, remoteTaskId) });
        flowState.updateNode(nodeId, {
          status: status === 'queued' ? 'queued' : 'run',
          video: existing ? { ...existing, remoteTaskId: remoteTaskId || existing.remoteTaskId } : undefined,
          error: status === 'recovering' ? '查询恢复中：远端任务仍会保留' : null,
        });
      });
      if (!this.host.isActive(active)) return;
      if (!result.success || !result.video) {
        const suffix = result.remoteTaskId ? `（远端任务：${result.remoteTaskId}）` : '';
        const errorText = `${result.error || '视频生成失败'}${suffix}`;
        flowState.updateNodeParams(nodeId, {
          videoTask: { state: result.uncertain ? 'uncertain' : 'failed', localTaskId: created.task_id, remoteTaskId: result.remoteTaskId, error: errorText },
        });
        flowState.updateNode(nodeId, {
          status: result.uncertain ? 'stale' : 'fail', error: errorText,
          video: node.video ? { ...node.video, remoteTaskId: result.remoteTaskId || node.video.remoteTaskId } : null,
        });
        void historyPersist.appendTrace({
          kind: 'video', nodeId: node.id, prompt, model: (node.params as unknown as VideoGenParams).model || '',
          aspectRatio: (node.params as unknown as VideoGenParams).aspectRatio || '',
          resolution: (node.params as unknown as VideoGenParams).resolution || '',
          seconds: (node.params as unknown as VideoGenParams).seconds || 0,
          references: refs.map(ref => historyPersist.hashRef(ref)), createdAt: Date.now(), remoteTaskId: result.remoteTaskId,
          taskState: result.uncertain ? 'uncertain' : 'failed',
        });
        showToast(result.uncertain ? '视频已提交，稍后可重试查询同一任务' : `视频生成失败：${result.error || '未知错误'}`, false);
        return;
      }
      const params = node.params as unknown as VideoGenParams;
      const video = { ...result.video, remoteTaskId: result.remoteTaskId || result.video.remoteTaskId };
      const trace: GenerationTrace = {
        prompt, model: params.model || '', aspectRatio: params.aspectRatio || '', resolution: params.resolution || '', count: 1,
        refImageHashes: refs.map(ref => historyPersist.hashRef(ref)), refImageUrls: refs, seed: null,
        createdAt: Date.now(), parentId: node.parentId ?? node.id, outputType: 'video',
      };
      flowState.updateNodeParams(nodeId, {
        videoTask: { state: 'succeeded', localTaskId: created.task_id, remoteTaskId: video.remoteTaskId },
      });
      flowState.updateNode(nodeId, { status: 'done', error: null, video, trace, lastRunAt: Date.now() });
      void historyPersist.appendTrace({
        kind: 'video', nodeId: node.id, prompt, model: params.model || '', aspectRatio: params.aspectRatio || '',
        resolution: params.resolution || '', seconds: params.seconds || 0, references: refs.map(ref => historyPersist.hashRef(ref)),
        createdAt: trace.createdAt, remoteTaskId: video.remoteTaskId, originalPath: video.originalPath,
        videoUrl: video.url, duration: video.duration, taskState: 'succeeded',
      });
      historyDrawer.addVideo({
        nodeId: node.id, prompt, model: params.model || '', seconds: params.seconds || 0,
        originalPath: video.originalPath, mediaUrl: video.url, duration: video.duration,
        remoteTaskId: video.remoteTaskId, taskState: 'succeeded', timestamp: trace.createdAt,
      });
      dirty.markUpstreamChanged(nodeId);
      showToast('视频已生成并保存到本地');
    } catch (error) {
      if (this.host.isActive(active)) {
        const message = (error as Error).message || '视频生成失败';
        flowState.updateNodeParams(nodeId, { videoTask: { state: 'failed', error: message } });
        flowState.updateNode(nodeId, { status: 'fail', error: message });
        showToast(`视频生成失败：${message}`, false);
      }
    } finally {
      linkView.setNodeFlowing(nodeId, false);
    }
  }

  async runAudio(nodeId: string, active: ActiveRun): Promise<void> {
    const node = flowState.getNode(nodeId);
    if (!node) return;
    const def = nodeRegistry.get('audio-gen');
    const options = def.buildOptions(node, this.host.context);
    const refs = await this.host.resolveReferenceImages(nodeId);
    options.referenceImages = refs;
    const prompt = this.host.composePrompt(nodeId);

    flowState.updateNode(nodeId, { status: 'queued', error: null });
    flowState.updateNodeParams(nodeId, { audioTask: { state: 'queued' } });
    linkView.setNodeFlowing(nodeId, true);
    try {
      flowState.updateNode(nodeId, { status: 'submitting' });
      flowState.updateNodeParams(nodeId, { audioTask: { state: 'submitting' } });
      const created = await withTimeout(Backend.generateAudio(prompt, options), TASK_CREATE_TIMEOUT_MS, '音频任务创建超时');
      if (!this.host.isActive(active)) return;
      if (!created?.task_id) throw new Error('音频任务创建失败，未返回 task_id');
      flowState.updateNodeParams(nodeId, { audioTask: { state: 'accepted', localTaskId: created.task_id } });
      flowState.updateNode(nodeId, { status: 'run' });
      const result = await pollAudioTask(created.task_id, (status, remoteTaskId) => {
        if (!this.host.isActive(active)) return;
        const current = flowState.getNode(nodeId);
        if (!current) return;
        const existing = current.audio || null;
        flowState.updateNodeParams(nodeId, { audioTask: normalizeMediaTask(status, created.task_id, remoteTaskId) });
        flowState.updateNode(nodeId, {
          status: status === 'queued' ? 'queued' : 'run',
          audio: existing ? { ...existing, remoteTaskId: remoteTaskId || existing.remoteTaskId } : undefined,
          error: status === 'recovering' ? '查询恢复中：远端任务仍会保留' : null,
        });
      });
      if (!this.host.isActive(active)) return;
      if (!result.success || !result.audio) {
        const suffix = result.remoteTaskId ? `（远端任务：${result.remoteTaskId}）` : '';
        const errorText = `${result.error || '音频生成失败'}${suffix}`;
        flowState.updateNodeParams(nodeId, {
          audioTask: { state: result.uncertain ? 'uncertain' : 'failed', localTaskId: created.task_id, remoteTaskId: result.remoteTaskId, error: errorText },
        });
        flowState.updateNode(nodeId, {
          status: result.uncertain ? 'stale' : 'fail', error: errorText,
          audio: node.audio ? { ...node.audio, remoteTaskId: result.remoteTaskId || node.audio.remoteTaskId } : null,
        });
        void historyPersist.appendTrace({
          kind: 'audio', nodeId: node.id, prompt, model: (node.params as unknown as AudioGenParams).model || '',
          seconds: typeof (node.params as unknown as AudioGenParams).seconds === 'number' ? (node.params as unknown as AudioGenParams).seconds : undefined,
          format: typeof (node.params as unknown as AudioGenParams).format === 'string' ? (node.params as unknown as AudioGenParams).format : undefined,
          references: refs.map(ref => historyPersist.hashRef(ref)), createdAt: Date.now(), remoteTaskId: result.remoteTaskId,
          taskState: result.uncertain ? 'uncertain' : 'failed',
        });
        showToast(result.uncertain ? '音频已提交，稍后可重试查询同一任务' : `音频生成失败：${result.error || '未知错误'}`, false);
        return;
      }
      const params = node.params as unknown as AudioGenParams;
      const audio = { ...result.audio, remoteTaskId: result.remoteTaskId || result.audio.remoteTaskId };
      const trace: GenerationTrace = {
        prompt, model: params.model || '', aspectRatio: '', resolution: '', count: 1,
        refImageHashes: refs.map(ref => historyPersist.hashRef(ref)), refImageUrls: refs, seed: null,
        createdAt: Date.now(), parentId: node.parentId ?? node.id, outputType: 'audio',
      };
      flowState.updateNodeParams(nodeId, {
        audioTask: { state: 'succeeded', localTaskId: created.task_id, remoteTaskId: audio.remoteTaskId },
      });
      flowState.updateNode(nodeId, { status: 'done', error: null, audio, trace, lastRunAt: Date.now() });
      void historyPersist.appendTrace({
        kind: 'audio', nodeId: node.id, prompt, model: params.model || '',
        seconds: typeof params.seconds === 'number' ? params.seconds : undefined,
        format: typeof params.format === 'string' ? params.format : undefined,
        references: refs.map(ref => historyPersist.hashRef(ref)), createdAt: trace.createdAt,
        remoteTaskId: audio.remoteTaskId, originalPath: audio.originalPath,
        audioUrl: audio.url, duration: audio.duration, mimeType: audio.mimeType, taskState: 'succeeded',
      });
      historyDrawer.addAudio({
        nodeId: node.id, prompt, model: params.model || '', seconds: typeof params.seconds === 'number' ? params.seconds : undefined,
        format: typeof params.format === 'string' ? params.format : undefined,
        originalPath: audio.originalPath, mediaUrl: audio.url, duration: audio.duration,
        mimeType: audio.mimeType, remoteTaskId: audio.remoteTaskId, taskState: 'succeeded', timestamp: trace.createdAt,
      });
      dirty.markUpstreamChanged(nodeId);
      showToast('音频已生成并保存到本地');
    } catch (error) {
      if (this.host.isActive(active)) {
        const message = (error as Error).message || '音频生成失败';
        flowState.updateNodeParams(nodeId, { audioTask: { state: 'failed', error: message } });
        flowState.updateNode(nodeId, { status: 'fail', error: message });
        showToast(`音频生成失败：${message}`, false);
      }
    } finally {
      linkView.setNodeFlowing(nodeId, false);
    }
  }
}
