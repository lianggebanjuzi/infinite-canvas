// src/v1/engine/poller.ts
// 任务轮询器：间隔查询 get_task_result，超时/失败回写（复用 ai-draw-api.generate 的轮询思想）

import { Backend } from '../api';

export interface PollOptions {
  intervalMs?: number;   // 默认 2000
  timeoutMs?: number;    // 默认 480000（8 分钟）—— 无进展超时：连续这么久没有任何成功响应（含 pending/done）才判 504；
                         // 任何一次成功响应都会重置计时器（后端上游慢/大图传输慢 = 活着，不算超时；只有彻底无响应才兜底）
  onTick?: (status: string, remoteTaskId?: string) => void;
}

export interface PollResult {
  success: boolean;
  imageUrl?: string;        // 展示图（新后端=缩略图 data URL；旧后端无缩略图时为原图 base64）
  thumbnail?: string;       // 显式缩略图（新后端，= imageUrl）
  originalPath?: string;    // 原图本地绝对路径（查看大图按需加载用）
  originalUrl?: string;     // file:// 引用（备用）
  savedToDisk?: boolean; // incremental-3：生成图是否写入用户配置目录（tempfile 兜底为 false；后端旧版无该字段时为 undefined）
  width?: number;         // 原图真实像素宽（PIL im.size；旧后端缺失为 undefined）
  height?: number;        // 原图真实像素高
  code?: number;
  error?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 单次任务查询超时（pywebview 桥接 Promise 永不 settle 的兜底；超时视为瞬态故障重试）。
 * 90s：只防「彻底无响应」的真悬挂，不误伤大 base64 响应慢传输（4k 图 data URL 可达数 MB~十几 MB，
 * 桥接序列化/传输可能远超 20s）。
 */
const REQUEST_TIMEOUT_MS = 90000;

/**
 * 无进展超时：连续这么久没有任何成功响应（含 status='pending' 与 done）才判 504。
 * 慢 ≠ 超时：只要还能拿到响应（哪怕一直是 pending）就持续重置计时器；仅当每次查询都被单次超时
 * 掐掉/抛错（桥接真断/后端真挂）才走到这里兜底，保证批次必然在有限时间内结束、busy 释放。
 */
const STALL_TIMEOUT_MS = 8 * 60 * 1000;

/**
 * 给 Promise 加单次超时：超时 reject 而非无限等待（桥接掉包场景兜底）。
 * 显式 then/clearTimeout 模式：源 Promise 稍后 settle 也不会产生 unhandled rejection。
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}（${Math.round(ms / 1000)}s 未响应）`)), ms);
    p.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}

/** 轮询直到任务完成/失败/无进展超时 */
export async function pollTask(taskId: string, opts: PollOptions = {}): Promise<PollResult> {
  const intervalMs = opts.intervalMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? STALL_TIMEOUT_MS;
  // 无进展计时：最近一次成功响应时刻（pending/done 均重置；catch 分支不重置 = 无响应）
  let lastResponseAt = Date.now();

  for (;;) {
    if (Date.now() - lastResponseAt > timeoutMs) {
      return { success: false, code: 504, error: '长时间无响应，请检查网络后重试' };
    }

    let res: BackendTaskResult;
    try {
      res = await withTimeout(Backend.getTaskResult(taskId), REQUEST_TIMEOUT_MS, '查询任务超时');
    } catch {
      // 单次查询失败/悬挂：视为瞬态故障 → 重试（不直接判失败，避免桥接偶发抖动杀掉正常任务）；
      // 注意：此处不更新 lastResponseAt —— 单次超时/异常即「无响应」，由无进展超时兜底
      opts.onTick?.('recovering');
      await delay(intervalMs);
      continue;
    }

    // 收到任何成功响应（pending/done/not_found 均算后端在应答）→ 刷新无进展计时
    lastResponseAt = Date.now();

    if (!res || res.status === 'not_found') {
      return { success: false, code: 404, error: '任务结果已过期，请重新生成' };
    }

    if (res.status === 'pending') {
      opts.onTick?.(res.remote_status || 'queued', res.remote_task_id);
      await delay(intervalMs);
      continue;
    }

    if (res.status === 'done') {
      const r = res.result;
      // 成功契约（v2）：image_url（缩略图 data URL）可能为空——后端缩略图失败时不回退大 base64，
      // 但会保留 original_path（原图已落盘，含 tempfile 兜底）。只要 image_url / original_path /
      // original_url 任一存在即可判成功，由引擎 _resolveImageUrl 按
      // image_url → loadLocalImage(original_path) → original_url 顺序解析展示图。
      if (r && r.success && (r.image_url || r.original_path || r.original_url)) {
        return {
          success: true,
          imageUrl: typeof r.image_url === 'string' ? r.image_url : undefined,
          thumbnail: typeof r.thumbnail === 'string' ? r.thumbnail : undefined,
          originalPath: typeof r.original_path === 'string' ? r.original_path : undefined,
          originalUrl: typeof r.original_url === 'string' ? r.original_url : undefined,
          savedToDisk: typeof r.saved_to_disk === 'boolean' ? r.saved_to_disk : undefined,
          width: typeof r.width === 'number' && r.width > 0 ? r.width : undefined,
          height: typeof r.height === 'number' && r.height > 0 ? r.height : undefined,
        };
      }
      // 失败：错误码 + 消息（不自动切供应商，由用户手动重跑）；success 但无任何可展示/可回退的图 → 明确提示，不静默白屏
      const code = r?.error_code ?? 500;
      const message = r?.message || r?.error || (r?.success ? '生成成功但未返回图片数据，请重试或检查图片保存路径' : '生成失败');
      return { success: false, code, error: message };
    }

    return { success: false, code: 500, error: `未知任务状态: ${res.status}` };
  }
}
