// 媒体异步任务的共享状态语义。
// 创建请求一旦 accepted，调用方只能继续查询同一 localTaskId，不能在这里或上层自动重投。

/** 将后端轮询中间态归一为可持久化的 MediaTask。 */
export function normalizeMediaTask(status: string, localTaskId: string, remoteTaskId?: string): MediaTask {
  let state: MediaTask['state'] = 'accepted';
  if (status === 'queued' || status === 'pending') state = 'queued';
  else if (status === 'processing' || status === 'in_progress' || status === 'pending_confirmation') state = 'processing';
  else if (status === 'done') state = 'succeeded';
  else if (status === 'failed' || status === 'error') state = 'failed';

  return { state, localTaskId, ...(remoteTaskId ? { remoteTaskId } : {}) };
}

/** uncertain 是可恢复的终态：需要用户显式触发恢复查询，不能自动重投。 */
export function isMediaTaskTerminal(state: MediaTask['state']): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'uncertain';
}
