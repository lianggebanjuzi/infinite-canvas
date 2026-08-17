// src/v1/engine/poller.ts
// 任务轮询器：间隔查询 get_task_result，超时/失败回写（复用 ai-draw-api.generate 的轮询思想）

import { Backend } from '../api';

export interface PollOptions {
  intervalMs?: number;   // 默认 2000
  timeoutMs?: number;    // 默认 300000（后端上游超时 300s）
  onTick?: (status: string) => void;
}

export interface PollResult {
  success: boolean;
  imageUrl?: string;        // 展示图（新后端=缩略图 data URL；旧后端无缩略图时为原图 base64）
  thumbnail?: string;       // 显式缩略图（新后端，= imageUrl）
  originalPath?: string;    // 原图本地绝对路径（查看大图按需加载用）
  originalUrl?: string;     // file:// 引用（备用）
  savedToDisk?: boolean; // incremental-3：生成图是否写入用户配置目录（tempfile 兜底为 false；后端旧版无该字段时为 undefined）
  code?: number;
  error?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 轮询直到任务完成/失败/超时 */
export async function pollTask(taskId: string, opts: PollOptions = {}): Promise<PollResult> {
  const intervalMs = opts.intervalMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 300000;
  const started = Date.now();

  for (;;) {
    if (Date.now() - started > timeoutMs) {
      return { success: false, code: 504, error: '生成超时，请检查网络后重试' };
    }

    let res: BackendTaskResult;
    try {
      res = await Backend.getTaskResult(taskId);
    } catch (e) {
      return { success: false, code: 500, error: (e as Error).message || '查询任务失败' };
    }

    if (!res || res.status === 'not_found') {
      return { success: false, code: 404, error: '任务结果已过期，请重新生成' };
    }

    if (res.status === 'pending') {
      opts.onTick?.('pending');
      await delay(intervalMs);
      continue;
    }

    if (res.status === 'done') {
      const r = res.result;
      if (r && r.success && r.image_url) {
        return {
          success: true,
          imageUrl: r.image_url,
          thumbnail: typeof r.thumbnail === 'string' ? r.thumbnail : undefined,
          originalPath: typeof r.original_path === 'string' ? r.original_path : undefined,
          originalUrl: typeof r.original_url === 'string' ? r.original_url : undefined,
          savedToDisk: typeof r.saved_to_disk === 'boolean' ? r.saved_to_disk : undefined,
        };
      }
      // 失败：错误码 + 消息（不自动切供应商，由用户手动重跑）
      const code = r?.error_code ?? 500;
      const message = r?.message || r?.error || '生成失败';
      return { success: false, code, error: message };
    }

    return { success: false, code: 500, error: `未知任务状态: ${res.status}` };
  }
}
