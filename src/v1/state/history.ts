// src/v1/state/history.ts
// 撤销/重做快照栈（HistoryStack）：在用户手势入口前 record() 一次全量快照，undo/redo 用 applySnapshot 回滚。
// 快照携带 nodes/edges/projectName/dirty（不含 canvas 视口），回滚即恢复当时 dirty（AC-A13/R5.3 天然成立）。
// 引擎运行期 suspend()/resume() 隔离：运行中状态/产出节点不入栈（R5.5）。

import { flowState } from './flow-state';

/** 撤销深度上限（超出 shift 丢最旧） */
export const HISTORY_LIMIT = 50;

class HistoryStack {
  private undoStack: FlowSnapshot[] = [];
  private redoStack: FlowSnapshot[] = [];
  private suspended = false;

  get canUndo(): boolean {
    return this.undoStack.length > 0 && !this.suspended;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0 && !this.suspended;
  }

  /** 在用户手势入口前调用：当前状态入 undo 栈、清空 redo 栈、超限丢最旧 */
  record(): void {
    if (this.suspended) return;
    this.undoStack.push(flowState.captureSnapshot());
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /** 撤销：弹出最近快照恢复；恢复前把当前状态压入 redo 栈 */
  undo(): void {
    if (this.suspended) return;
    const snap = this.undoStack.pop();
    if (!snap) return;
    this.redoStack.push(flowState.captureSnapshot());
    flowState.applySnapshot(snap);
  }

  /** 重做：对称 */
  redo(): void {
    if (this.suspended) return;
    const snap = this.redoStack.pop();
    if (!snap) return;
    this.undoStack.push(flowState.captureSnapshot());
    flowState.applySnapshot(snap);
  }

  /** 引擎运行期隔离：运行中状态变更不入栈 */
  suspend(): void {
    this.suspended = true;
  }

  resume(): void {
    this.suspended = false;
  }

  /** 清空两栈（打开/新建项目后调用，避免跨项目撤销） */
  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}

// 命名避开浏览器内置 window.history：本 bundle 以经典脚本加载（vite 插件去 type=module），
// 顶层 var 会落入全局作用域；若命名 history，经典脚本中赋值会被 window.history（只读 getter）静默丢弃，
// 导致所有 history.record()/undo() 抛 "history.record is not a function"（右键菜单失效根因）。
export const flowHistory = new HistoryStack();
