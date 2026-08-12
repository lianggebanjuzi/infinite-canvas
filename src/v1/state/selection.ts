// src/v1/state/selection.ts
// 单选/多选/框选集合管理（单一数据源 flowState.selectedIds）

import { flowState } from './flow-state';

class SelectionManager {
  get size(): number { return flowState.selectedIds.size; }
  get ids(): string[] { return [...flowState.selectedIds]; }

  isSelected(id: string): boolean { return flowState.selectedIds.has(id); }

  /** 单选（默认清空后选中）；additive=true 时追加（Shift 点选） */
  select(id: string, additive = false): void {
    if (!additive) flowState.selectedIds.clear();
    flowState.selectedIds.add(id);
    flowState.notify();
  }

  toggle(id: string): void {
    if (flowState.selectedIds.has(id)) flowState.selectedIds.delete(id);
    else flowState.selectedIds.add(id);
    flowState.notify();
  }

  /** 整组设置（框选结果） */
  set(ids: string[]): void {
    flowState.selectedIds.clear();
    ids.forEach(id => flowState.selectedIds.add(id));
    flowState.notify();
  }

  clear(): void {
    if (flowState.selectedIds.size === 0) return;
    flowState.selectedIds.clear();
    flowState.notify();
  }

  /** 单选时返回唯一节点，否则 null（用于指令面板/操作条显示条件） */
  single(): FlowNode | null {
    if (flowState.selectedIds.size !== 1) return null;
    return flowState.getNode([...flowState.selectedIds][0]) ?? null;
  }
}

export const selection = new SelectionManager();
