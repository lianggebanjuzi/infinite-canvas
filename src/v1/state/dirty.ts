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
}

export const dirty = new DirtyMarker();
