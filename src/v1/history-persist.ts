// src/v1/history-persist.ts
// history.jsonl 客户端：前端构造 trace（source of truth 写 node.trace），后端 append 单行流水。
// 关系（单向）：buildImageTrace → GenerationTrace 写 node.trace；appendTrace 时再包 kind/nodeId 成 HistoryEntry。
// 二者不双向同步、不回溯改写。text-gen 节点 trace 恒 null，其历史由 textHistory 承担，仍追加一条 kind:'text' 流水。

import { Backend } from './api';
import { showToast } from './ui/toast';

class HistoryPersist {
  /** djb2 轻量字符串哈希（非密码学，用于「是否同源」比对） */
  hashRef(url: string): string {
    let hash = 5381;
    const s = String(url || '');
    for (let i = 0; i < s.length; i++) {
      hash = ((hash << 5) + hash) ^ s.charCodeAt(i);
    }
    return (hash >>> 0).toString(16);
  }

  /**
   * 构造图片生成档案（GenerationTrace，写 node.trace 作 source of truth）：
   * prompt/model/aspectRatio/resolution/count 取节点 params，
   * refImageHashes 由本次实际使用的参考图 refs 哈希而来（含上游派生，非仅 node.refImages）；
   * refImageUrls 可选记录实际参考图 URL（跨会话复现反查用；旧 trace 缺失时按 hash 反查图池兜底）；
   * parentId = node.parentId ?? node.id（手建节点自身生成时即自己 id）。
   * imageUrl 为本次产出图 URL（写 history.jsonl 行用；GenerationTrace 本身不存 imageUrl 字段）。
   * promptOverride：文本走线增量——本次实际使用的合成 prompt（composeImagePrompt 唯一入口产出；
   * 上游文本 + 自身 prompt）。传入时优先于 node.params.prompt 记录到 trace（W3-2：trace 含上游文本，线即真相可回溯）。
   * batchId/jobId（B-6 追溯）：可选；传入时写入 trace（新 trace 带批次/任务编号；旧调用方不传 → 字段缺省，兼容旧数据）。
   */
  buildImageTrace<O extends Exclude<GenerationTrace['outputType'], 'video' | 'audio'>>(node: FlowNode, refs: string[], outputType: O, imageUrl?: string, promptOverride?: string, batchId?: string, jobId?: string): GenerationTrace & { outputType: O } {
    const p = (node.params || {}) as unknown as StyleTransferParams;
    void imageUrl; // 供调用方构造 HistoryEntry 时携带（见 run-engine appendTrace）
    return {
      prompt: typeof promptOverride === 'string' ? promptOverride : (typeof p.prompt === 'string' ? p.prompt : ''),
      model: typeof p.model === 'string' ? p.model : '',
      aspectRatio: typeof p.aspectRatio === 'string' ? p.aspectRatio : '4:3',
      resolution: typeof p.resolution === 'string' ? p.resolution : '2k',
      count: typeof p.count === 'number' ? p.count : 1,
      refImageHashes: (refs || []).filter(r => !!r).map(r => this.hashRef(r)),
      refImageUrls: (refs || []).filter(r => !!r),
      seed: null,
      createdAt: Date.now(),
      parentId: node.parentId ?? node.id,
      outputType,
      ...(batchId ? { batchId } : {}),
      ...(jobId ? { jobId } : {}),
    };
  }

  /** 构造文本流水（kind:'text' 精简字段，无图片字段；text 节点 trace 恒 null，仅作 jsonl 行） */
  buildTextTrace(node: FlowNode): HistoryEntry {
    const p = (node.params || {}) as unknown as TextGenParams;
    return {
      kind: 'text',
      nodeId: node.id,
      instruction: typeof p.instruction === 'string' ? p.instruction : '',
      model: typeof p.model === 'string' ? p.model : '',
      outputText: node.outputText || '',
      createdAt: Date.now(),
      parentId: node.parentId ?? null,
    };
  }

  /** 追加一条 trace 到 history.jsonl；写失败不阻断结果展示，仅 toast「历史记录未写入」 */
  async appendTrace(entry: HistoryEntry): Promise<void> {
    try {
      const res = await Backend.appendHistory(entry);
      if (res.status !== 'success') showToast('历史记录未写入', false);
    } catch {
      showToast('历史记录未写入', false);
    }
  }

  /** 读取 history.jsonl（打开项目时跨会话展示）；失败/空库返回 [] */
  async loadHistory(): Promise<HistoryEntry[]> {
    try {
      const res = await Backend.loadHistory();
      if (res.status === 'success' && Array.isArray(res.entries)) {
        return res.entries as HistoryEntry[];
      }
    } catch {
      // 读取失败静默，返回空列表（R6.6 空库引导由 drawer 承担）
    }
    return [];
  }
}

export const historyPersist = new HistoryPersist();
