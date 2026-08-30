// 视频任务适配层：复用已受理媒体任务轮询，只保留视频结果字段解析。
import { Backend } from '../api';
import { pollAcceptedMediaTask, type MediaTaskPollResult } from './media-task-poller';

export interface VideoPollResult extends MediaTaskPollResult<VideoMedia> {
  video?: VideoMedia;
}

function parseVideoResult(result: unknown, fallbackRemoteTaskId?: string): { video?: VideoMedia; remoteTaskId?: string; error?: string } {
  const data = result as Record<string, unknown> | null | undefined;
  const remoteTaskId = typeof data?.task_id === 'string' ? data.task_id : fallbackRemoteTaskId;
  if (data?.success && typeof data.video_path === 'string' && data.video_path) {
    return {
      remoteTaskId,
      video: {
        originalPath: data.video_path,
        url: typeof data.video_url === 'string' ? data.video_url : undefined,
        duration: typeof data.duration === 'number' ? data.duration : undefined,
        width: typeof data.width === 'number' ? data.width : undefined,
        height: typeof data.height === 'number' ? data.height : undefined,
        sizeBytes: typeof data.size_bytes === 'number' ? data.size_bytes : undefined,
        remoteTaskId,
      },
    };
  }
  return { remoteTaskId, error: typeof data?.message === 'string' ? data.message : typeof data?.error === 'string' ? data.error : undefined };
}

/** VideoAPI 的远端轮询；20 分钟后转为 uncertain，不另投请求。 */
export async function pollVideoTask(taskId: string, onTick?: (status: string, remoteTaskId?: string) => void): Promise<VideoPollResult> {
  const result = await pollAcceptedMediaTask<VideoMedia>({
    taskId,
    readTask: id => Backend.getVideoTaskResult(id),
    parseResult: (raw, remoteTaskId) => {
      const parsed = parseVideoResult(raw, remoteTaskId);
      return { media: parsed.video, remoteTaskId: parsed.remoteTaskId, error: parsed.error };
    },
    expiredMessage: '视频任务结果已过期，请重新生成',
    failureMessage: '视频生成失败',
    onTick,
  });
  return { ...result, video: result.media };
}
