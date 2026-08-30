// 图片批处理的单 Job 执行器。
// 不管理队列、批次汇总或画布写回；这些仍由 batch-queue 与 RunEngine 负责。
import { Backend } from '../api';
import { pollTask, type PollResult } from './poller';
import type { JobRunOutcome, RunJobFn } from './batch-queue';

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

export interface ImageGenerationJobHost {
  resolveDisplayUrl: (result: PollResult) => Promise<string | null>;
}

/**
 * 创建可交给 BatchQueue 的 Job 处理器。
 * 受理后由 pollTask 查询同一 task_id；取消只停止本地等待，绝不重投远端任务。
 */
export function makeImageGenerationJob(
  host: ImageGenerationJobHost,
  options: Record<string, unknown>,
  markNotSavedToDisk: () => void,
): RunJobFn {
  return async (job, hooks): Promise<JobRunOutcome> => {
    if (hooks.isCancelled()) return { success: false, error: '已取消' };
    try {
      const created = await withTimeout(
        Backend.generateImage(job.prompt, { ...options, count: 1 }),
        TASK_CREATE_TIMEOUT_MS,
        '任务创建超时',
      );
      if (hooks.isCancelled()) return { success: false, error: '已取消' };
      if (!created?.task_id) throw new Error('任务创建失败，未返回 task_id');
      hooks.onRunning(created.task_id);

      const result = await pollTask(created.task_id);
      if (hooks.isCancelled()) return { success: false, error: '已取消' };
      if (!result.success) throw new Error(result.error || '生成失败');
      const displayUrl = await host.resolveDisplayUrl(result);
      if (hooks.isCancelled()) return { success: false, error: '已取消' };
      if (!displayUrl) throw new Error(result.error || '生成成功但未返回图片数据');
      if (result.savedToDisk === false) markNotSavedToDisk();

      const origin: ImageOrigin | null = result.originalPath
        ? { path: result.originalPath, url: result.originalUrl }
        : null;
      return {
        success: true,
        image: {
          url: displayUrl,
          originalPath: origin?.path,
          originalUrl: origin?.url,
          width: result.width,
          height: result.height,
        },
      };
    } catch (error) {
      return { success: false, error: (error as Error).message || '生成失败' };
    }
  };
}
