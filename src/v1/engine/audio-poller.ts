// 音频任务适配层：复用已受理媒体任务轮询，只保留音频结果字段解析。
import { Backend } from '../api';
import { pollAcceptedMediaTask, type MediaTaskPollResult } from './media-task-poller';

export interface AudioPollResult extends MediaTaskPollResult<AudioMedia> {
  audio?: AudioMedia;
}

function parseAudioResult(result: unknown, fallbackRemoteTaskId?: string): { audio?: AudioMedia; remoteTaskId?: string; error?: string } {
  const data = result as Record<string, unknown> | null | undefined;
  const remoteTaskId = typeof data?.task_id === 'string' ? data.task_id : fallbackRemoteTaskId;
  if (data?.success && typeof data.audio_path === 'string' && data.audio_path) {
    return {
      remoteTaskId,
      audio: {
        originalPath: data.audio_path,
        url: typeof data.audio_url === 'string' ? data.audio_url : undefined,
        duration: typeof data.duration === 'number' ? data.duration : undefined,
        mimeType: typeof data.mime_type === 'string' ? data.mime_type : undefined,
        sizeBytes: typeof data.size_bytes === 'number' ? data.size_bytes : undefined,
        remoteTaskId,
      },
    };
  }
  return { remoteTaskId, error: typeof data?.message === 'string' ? data.message : typeof data?.error === 'string' ? data.error : undefined };
}

/** AudioAPI 的远端轮询；20 分钟后转为 uncertain，不另投请求。 */
export async function pollAudioTask(taskId: string, onTick?: (status: string, remoteTaskId?: string) => void): Promise<AudioPollResult> {
  const result = await pollAcceptedMediaTask<AudioMedia>({
    taskId,
    readTask: id => Backend.getAudioTaskResult(id),
    parseResult: (raw, remoteTaskId) => {
      const parsed = parseAudioResult(raw, remoteTaskId);
      return { media: parsed.audio, remoteTaskId: parsed.remoteTaskId, error: parsed.error };
    },
    expiredMessage: '音频任务结果已过期，请重新生成',
    failureMessage: '音频生成失败',
    onTick,
  });
  return { ...result, audio: result.media };
}
