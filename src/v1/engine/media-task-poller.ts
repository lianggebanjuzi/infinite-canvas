// 已受理媒体任务的共享轮询器。
// 这里只查询创建时获得的 taskId；不提供重新提交能力，避免 accepted 后重复扣费。

export interface MediaTaskPollResponse {
  status?: string;
  remote_task_id?: string;
  result?: unknown;
}

export interface MediaTaskPollResult<TMedia> {
  success: boolean;
  media?: TMedia;
  remoteTaskId?: string;
  uncertain?: boolean;
  error?: string;
}

export interface MediaTaskPollOptions<TMedia> {
  taskId: string;
  readTask: (taskId: string) => Promise<MediaTaskPollResponse>;
  parseResult: (result: unknown, fallbackRemoteTaskId?: string) => {
    media?: TMedia;
    remoteTaskId?: string;
    error?: string;
  };
  expiredMessage: string;
  failureMessage: string;
  onTick?: (status: string, remoteTaskId?: string) => void;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 查询一个已经 accepted 的媒体任务。
 * `uncertain` 保留 local/remote task id 给恢复流程，调用方不得把它视为可自动重投的失败。
 */
export async function pollAcceptedMediaTask<TMedia>(options: MediaTaskPollOptions<TMedia>): Promise<MediaTaskPollResult<TMedia>> {
  const now = options.now || Date.now;
  const sleep = options.sleep || delay;
  const deadline = now() + (options.timeoutMs ?? 20 * 60 * 1000);
  let remoteTaskId: string | undefined;

  while (now() < deadline) {
    try {
      const response = await options.readTask(options.taskId);
      remoteTaskId = response.remote_task_id || remoteTaskId;
      if (response.status === 'not_found') {
        return { success: false, remoteTaskId, error: options.expiredMessage };
      }
      if (response.status !== 'done') {
        options.onTick?.(response.status || 'pending', remoteTaskId);
        await sleep(response.status === 'pending_confirmation' ? 15000 : 2000);
        continue;
      }

      const parsed = options.parseResult(response.result, remoteTaskId);
      remoteTaskId = parsed.remoteTaskId || remoteTaskId;
      if (parsed.media) return { success: true, media: parsed.media, remoteTaskId };
      return { success: false, remoteTaskId, error: parsed.error || options.failureMessage };
    } catch {
      // 短暂的桥接查询错误不能被伪装成密钥失败，更不能换 Key 重投。
      options.onTick?.('recovering', remoteTaskId);
      await sleep(3000);
    }
  }

  return { success: false, remoteTaskId, uncertain: true, error: '已提交，等待恢复查询' };
}
