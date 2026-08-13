// src/v1/state/dirty.ts
// 脏标记传播：上游变更 → 递归标记直接/间接下游为 stale
// 规则（架构文档「七、共享约定」第 4 条）：
//   - 只标记直接/间接下游为 stale
//   - 运行中（run）节点不覆盖状态
//   - fail 节点被上游变更后转 stale（允许重跑）

import { flowState } from './flow-state';

class DirtyMarker {
  /** 上游变更（换图/改参数）：标记所有下游为 stale */
  markUpstreamChanged(fromId: string): void {
    const downstream = flowState.getAllDownstreams(fromId);
    if (downstream.length === 0) return;
    let changed = false;
    downstream.forEach(n => {
      if (n.status === 'run') return;            // 运行中不覆盖
      if (n.status !== 'stale') {
        n.status = 'stale';
        changed = true;
      }
    });
    if (changed) {
      flowState.updatedAt = Date.now();
      flowState.dirty = true;
      flowState.notify();
    }
  }

  /** 标记单节点 stale（不改自身以外的任何状态） */
  markStale(nodeId: string): void {
    const node = flowState.getNode(nodeId);
    if (!node || node.status === 'run' || node.status === 'stale') return;
    node.status = 'stale';
    flowState.updatedAt = Date.now();
    flowState.dirty = true;
    flowState.notify();
  }

  /**
   * 上游变更但跳过指定节点及其子树（批次成功建卡后调用，exceptIds=本批次新建结果卡 id 集合）：
   * 让旧下游标 stale、新结果卡（刚 done）及其子树跳过，避免被立即打回 stale。
   * BFS 传播：从直接下游出发，遇到 exceptIds 中的节点即整棵子树跳过（不再向下递归）。
   */
  markUpstreamChangedExcept(fromId: string, exceptIds: Set<string>): void {
    const skip = new Set(exceptIds);
    let changed = false;
    const visit = (id: string): void => {
      if (skip.has(id)) return; // 跳过该节点及其整棵子树
      const node = flowState.getNode(id);
      if (!node) return;
      if (node.status === 'run') return;            // 运行中不覆盖
      if (node.status !== 'stale') {
        node.status = 'stale';
        changed = true;
      }
      flowState.getDownstreams(id).forEach(d => visit(d.id));
    };
    flowState.getDownstreams(fromId).forEach(d => visit(d.id));
    if (changed) {
      flowState.updatedAt = Date.now();
      flowState.dirty = true;
      flowState.notify();
    }
  }
}

export const dirty = new DirtyMarker();
