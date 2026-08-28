// 视频任务轮询：只查询创建时拿到的本地任务，不会在网络异常或超时后重新提交。
import { Backend } from '../api';

export interface VideoPollResult {
  success: boolean;
  video?: VideoMedia;
  remoteTaskId?: string;
  uncertain?: boolean;
  error?: string;
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export async function pollVideoTask(taskId: string, onTick?: (status: string, remoteTaskId?: string) => void): Promise<VideoPollResult> {
  // VideoAPI 正在代理远端轮询；20 分钟后转为 uncertain，不另投请求。
  const deadline = Date.now() + 20 * 60 * 1000;
  let remoteTaskId: string | undefined;
  while (Date.now() < deadline) {
    try {
      const response = await Backend.getVideoTaskResult(taskId);
      remoteTaskId = response.remote_task_id || remoteTaskId;
      if (response.status === 'not_found') return { success: false, remoteTaskId, error: '视频任务结果已过期，请重新生成' };
      if (response.status !== 'done') {
        onTick?.(response.status || 'pending', remoteTaskId);
        await delay(response.status === 'pending_confirmation' ? 15000 : 2000);
        continue;
      }
      const result = response.result;
      if (result?.success && typeof result.video_path === 'string' && result.video_path) {
        return {
          success: true,
          remoteTaskId: typeof result.task_id === 'string' ? result.task_id : remoteTaskId,
          video: {
            originalPath: result.video_path,
            url: typeof result.video_url === 'string' ? result.video_url : undefined,
            duration: typeof result.duration === 'number' ? result.duration : undefined,
            width: typeof result.width === 'number' ? result.width : undefined,
            height: typeof result.height === 'number' ? result.height : undefined,
            sizeBytes: typeof result.size_bytes === 'number' ? result.size_bytes : undefined,
            remoteTaskId: typeof result.task_id === 'string' ? result.task_id : remoteTaskId,
          },
        };
      }
      return { success: false, remoteTaskId, error: result?.message || result?.error || '视频生成失败' };
    } catch {
      // 桥接查询的短暂错误不应该伪装成密钥失败，更不能换 key 重投。
      onTick?.('recovering', remoteTaskId);
      await delay(3000);
    }
  }
  return { success: false, remoteTaskId, uncertain: true, error: '已提交，等待恢复查询' };
}
