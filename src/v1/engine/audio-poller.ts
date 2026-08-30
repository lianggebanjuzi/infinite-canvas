// 音频任务轮询：只查询创建时拿到的本地任务，不会在网络异常或超时后重新提交（4.2-B）。
import { Backend } from '../api';

export interface AudioPollResult {
  success: boolean;
  audio?: AudioMedia;
  remoteTaskId?: string;
  uncertain?: boolean;
  error?: string;
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export async function pollAudioTask(taskId: string, onTick?: (status: string, remoteTaskId?: string) => void): Promise<AudioPollResult> {
  // AudioAPI 正在代理远端轮询；20 分钟后转为 uncertain，不另投请求。
  const deadline = Date.now() + 20 * 60 * 1000;
  let remoteTaskId: string | undefined;
  while (Date.now() < deadline) {
    try {
      const response = await Backend.getAudioTaskResult(taskId);
      remoteTaskId = response.remote_task_id || remoteTaskId;
      if (response.status === 'not_found') return { success: false, remoteTaskId, error: '音频任务结果已过期，请重新生成' };
      if (response.status !== 'done') {
        onTick?.(response.status || 'pending', remoteTaskId);
        await delay(response.status === 'pending_confirmation' ? 15000 : 2000);
        continue;
      }
      const result = response.result;
      if (result?.success && typeof result.audio_path === 'string' && result.audio_path) {
        return {
          success: true,
          remoteTaskId: typeof result.task_id === 'string' ? result.task_id : remoteTaskId,
          audio: {
            originalPath: result.audio_path,
            url: typeof result.audio_url === 'string' ? result.audio_url : undefined,
            duration: typeof result.duration === 'number' ? result.duration : undefined,
            mimeType: typeof result.mime_type === 'string' ? result.mime_type : undefined,
            sizeBytes: typeof result.size_bytes === 'number' ? result.size_bytes : undefined,
            remoteTaskId: typeof result.task_id === 'string' ? result.task_id : remoteTaskId,
          },
        };
      }
      return { success: false, remoteTaskId, error: result?.message || result?.error || '音频生成失败' };
    } catch {
      // 桥接查询的短暂错误不应该伪装成密钥失败，更不能换 key 重投。
      onTick?.('recovering', remoteTaskId);
      await delay(3000);
    }
  }
  return { success: false, remoteTaskId, uncertain: true, error: '已提交，等待恢复查询' };
}
