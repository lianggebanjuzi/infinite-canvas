// 跨会话媒体任务恢复。
// 仅查询持久化的 localTaskId；不创建新任务，也不在异常时换 Key 重投。
import { flowState } from '../state/flow-state';
import { flowHistory } from '../state/history';
import { showToast } from '../ui/toast';
import { pollVideoTask, VideoPollResult } from './video-poller';
import { pollAudioTask, AudioPollResult } from './audio-poller';
import { isMediaTaskTerminal, normalizeMediaTask } from './media-task';

export interface ActiveRun {
  nodeId: string;
  cancelled: boolean;
  historySuspended: boolean;
}

type MediaKind = 'video' | 'audio';

export interface MediaTaskInProgress {
  nodeId: string;
  kind: MediaKind;
  remoteTaskId?: string;
}

/**
 * 管理项目重新打开后的媒体恢复生命周期。
 * 活动运行表由 RunEngine 所有；本控制器只登记恢复查询，确保普通运行与恢复运行互斥。
 */
export class MediaTaskRecoveryController {
  constructor(
    private readonly activeRuns: Map<string, ActiveRun>,
    private readonly isActive: (active: ActiveRun) => boolean,
  ) {}

  inProgress(): MediaTaskInProgress[] {
    const result: MediaTaskInProgress[] = [];
    flowState.nodes.forEach(node => {
      if (this.activeRuns.has(node.id) && (node.type === 'video-gen' || node.type === 'audio-gen')) {
        result.push({ nodeId: node.id, kind: node.type === 'video-gen' ? 'video' : 'audio' });
        return;
      }
      if (node.type === 'video-gen') {
        const task = (node.params as Record<string, unknown> | undefined)?.videoTask as MediaTask | undefined;
        if (task && !isMediaTaskTerminal(task.state)) {
          result.push({ nodeId: node.id, kind: 'video', remoteTaskId: task.remoteTaskId });
        }
      } else if (node.type === 'audio-gen') {
        const task = (node.params as Record<string, unknown> | undefined)?.audioTask as MediaTask | undefined;
        if (task && !isMediaTaskTerminal(task.state)) {
          result.push({ nodeId: node.id, kind: 'audio', remoteTaskId: task.remoteTaskId });
        }
      }
    });
    return result;
  }

  recoverAll(): void {
    flowState.nodes.forEach(node => {
      if (node.type === 'video-gen') {
        const task = (node.params as Record<string, unknown> | undefined)?.videoTask as MediaTask | undefined;
        if (task?.localTaskId && !isMediaTaskTerminal(task.state) && !this.activeRuns.has(node.id)) {
          void this.recoverNode(node.id, 'video', task);
        }
      } else if (node.type === 'audio-gen') {
        const task = (node.params as Record<string, unknown> | undefined)?.audioTask as MediaTask | undefined;
        if (task?.localTaskId && !isMediaTaskTerminal(task.state) && !this.activeRuns.has(node.id)) {
          void this.recoverNode(node.id, 'audio', task);
        }
      }
    });
  }

  private async recoverNode(nodeId: string, kind: MediaKind, task: MediaTask): Promise<void> {
    const active: ActiveRun = { nodeId, cancelled: false, historySuspended: true };
    this.activeRuns.set(nodeId, active);
    flowState.updateNode(nodeId, { status: 'run', error: '查询恢复中：不会重新提交远端任务' });
    try {
      const result = kind === 'video'
        ? await pollVideoTask(task.localTaskId!, (status, remoteTaskId) => {
            if (!this.isActive(active)) return;
            const current = flowState.getNode(nodeId);
            if (!current) return;
            flowState.updateNodeParams(nodeId, { videoTask: normalizeMediaTask(status, task.localTaskId!, remoteTaskId) });
            flowState.updateNode(nodeId, { status: status === 'queued' ? 'queued' : 'run', error: status === 'recovering' ? '查询恢复中：远端任务仍会保留' : null });
          })
        : await pollAudioTask(task.localTaskId!, (status, remoteTaskId) => {
            if (!this.isActive(active)) return;
            const current = flowState.getNode(nodeId);
            if (!current) return;
            flowState.updateNodeParams(nodeId, { audioTask: normalizeMediaTask(status, task.localTaskId!, remoteTaskId) });
            flowState.updateNode(nodeId, { status: status === 'queued' ? 'queued' : 'run', error: status === 'recovering' ? '查询恢复中：远端任务仍会保留' : null });
          });
      if (!this.isActive(active)) return;
      const node = flowState.getNode(nodeId);
      if (!node) return;

      if (kind === 'video') {
        const videoResult = result as VideoPollResult;
        if (!videoResult.success || !videoResult.video) {
          this.failRecovery(nodeId, 'video', task, videoResult);
          return;
        }
        const video = { ...videoResult.video, remoteTaskId: videoResult.remoteTaskId || videoResult.video.remoteTaskId };
        const trace = this.recoveryTrace(node, 'video');
        flowState.updateNodeParams(nodeId, {
          videoTask: { state: 'succeeded', localTaskId: task.localTaskId, remoteTaskId: video.remoteTaskId },
        });
        flowState.updateNode(nodeId, {
          status: 'done', error: null, lastRunAt: Date.now(), video,
          trace: node.trace ? { ...node.trace, remoteTaskId: video.remoteTaskId } : trace,
        });
        showToast('视频任务已恢复');
        return;
      }

      const audioResult = result as AudioPollResult;
      if (!audioResult.success || !audioResult.audio) {
        this.failRecovery(nodeId, 'audio', task, audioResult);
        return;
      }
      const audio = { ...audioResult.audio, remoteTaskId: audioResult.remoteTaskId || audioResult.audio.remoteTaskId };
      const trace = this.recoveryTrace(node, 'audio');
      flowState.updateNodeParams(nodeId, {
        audioTask: { state: 'succeeded', localTaskId: task.localTaskId, remoteTaskId: audio.remoteTaskId },
      });
      flowState.updateNode(nodeId, {
        status: 'done', error: null, lastRunAt: Date.now(), audio,
        trace: node.trace ? { ...node.trace, remoteTaskId: audio.remoteTaskId } : trace,
      });
      showToast('音频任务已恢复');
    } catch (error) {
      if (this.isActive(active)) {
        const message = (error as Error).message || '任务恢复失败';
        flowState.updateNode(nodeId, { status: 'fail', error: message });
      }
    } finally {
      if (active.historySuspended) { flowHistory.resume(); active.historySuspended = false; }
      if (this.activeRuns.get(nodeId) === active) this.activeRuns.delete(nodeId);
    }
  }

  private failRecovery(
    nodeId: string,
    kind: MediaKind,
    task: MediaTask,
    result: { error?: string; remoteTaskId?: string; uncertain?: boolean },
  ): void {
    const label = kind === 'video' ? '视频' : '音频';
    const suffix = result.remoteTaskId ? `（远端任务：${result.remoteTaskId}）` : '';
    const errorText = `${result.error || `${label}生成失败`}${suffix}`;
    const taskPatch: MediaTask = {
      state: result.uncertain ? 'uncertain' : 'failed',
      localTaskId: task.localTaskId,
      remoteTaskId: result.remoteTaskId,
      error: errorText,
    };
    flowState.updateNodeParams(nodeId, kind === 'video' ? { videoTask: taskPatch } : { audioTask: taskPatch });
    flowState.updateNode(nodeId, { status: result.uncertain ? 'stale' : 'fail', error: errorText });
  }

  private recoveryTrace(node: FlowNode, outputType: 'video' | 'audio'): GenerationTrace {
    return {
      prompt: node.trace?.prompt || ((node.params as Record<string, unknown>).prompt as string) || '',
      model: node.trace?.model || '', aspectRatio: '', resolution: '', count: 1,
      refImageHashes: node.trace?.refImageHashes || [], refImageUrls: node.trace?.refImageUrls || [], seed: null,
      createdAt: node.trace?.createdAt || Date.now(), parentId: node.parentId ?? node.id, outputType,
    };
  }
}
