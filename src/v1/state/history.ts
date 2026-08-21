// src/v1/state/history.ts
// 撤销/重做快照栈（HistoryStack）：在用户手势入口前 record() 一次全量快照，undo/redo 用 applySnapshot 回滚。
// 快照携带 nodes/edges/projectName/dirty（不含 canvas 视口），回滚即恢复当时 dirty（AC-A13/R5.3 天然成立）。
// 引擎运行期 suspend()/resume() 隔离：运行中状态/产出节点不入栈（R5.5）。
// 增量（X3）：采纳/锁定入撤销栈 —— 并行 assets 快照（assetUndoStack/assetRedoStack），
// record/undo/redo/clear 与 flow 快照同步存取；applySnapshot(assets) 后立即落盘回退索引文件。

import { flowState } from './flow-state';
import { assetStore } from '../asset-store';

/** 撤销深度上限（超出 shift 丢最旧） */
export const HISTORY_LIMIT = 50;

class HistoryStack {
  private undoStack: FlowSnapshot[] = [];
  private redoStack: FlowSnapshot[] = [];
  private assetUndoStack: AssetSnapshot[] = [];
  private assetRedoStack: AssetSnapshot[] = [];
  /** 运行可能并行，暂停状态必须可嵌套，不能由先结束的节点提前恢复。 */
  private suspendDepth = 0;

  get canUndo(): boolean {
    return this.undoStack.length > 0 && this.suspendDepth === 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0 && this.suspendDepth === 0;
  }

  /** 在用户手势入口前调用：当前状态入 undo 栈、清空 redo 栈、超限丢最旧（flow + assets 并行） */
  record(): void {
    if (this.suspendDepth > 0) return;
    this.undoStack.push(flowState.captureSnapshot());
    this.assetUndoStack.push(assetStore.captureSnapshot());
    if (this.undoStack.length > HISTORY_LIMIT) {
      this.undoStack.shift();
      this.assetUndoStack.shift();
    }
    this.redoStack.length = 0;
    this.assetRedoStack.length = 0;
  }

  /** 撤销：弹出最近快照恢复；恢复前把当前状态压入 redo 栈（flow + assets 并行） */
  undo(): void {
    if (this.suspendDepth > 0) return;
    const snap = this.undoStack.pop();
    const assetSnap = this.assetUndoStack.pop();
    if (!snap) return;
    this.redoStack.push(flowState.captureSnapshot());
    this.assetRedoStack.push(assetStore.captureSnapshot());
    flowState.applySnapshot(snap);
    if (assetSnap) assetStore.applySnapshot(assetSnap);
  }

  /** 重做：对称 */
  redo(): void {
    if (this.suspendDepth > 0) return;
    const snap = this.redoStack.pop();
    const assetSnap = this.assetRedoStack.pop();
    if (!snap) return;
    this.undoStack.push(flowState.captureSnapshot());
    this.assetUndoStack.push(assetStore.captureSnapshot());
    flowState.applySnapshot(snap);
    if (assetSnap) assetStore.applySnapshot(assetSnap);
  }

  /** 引擎运行期隔离：运行中状态变更不入栈 */
  suspend(): void {
    this.suspendDepth += 1;
  }

  resume(): void {
    this.suspendDepth = Math.max(0, this.suspendDepth - 1);
  }

  /** 清空两栈（打开/新建项目后调用，避免跨项目撤销；flow + assets 并行） */
  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.assetUndoStack.length = 0;
    this.assetRedoStack.length = 0;
  }
}

// 命名避开浏览器内置 window.history：本 bundle 以经典脚本加载（vite 插件去 type=module），
// 顶层 var 会落入全局作用域；若命名 history，经典脚本中赋值会被 window.history（只读 getter）静默丢弃，
// 导致所有 history.record()/undo() 抛 "history.record is not a function"（右键菜单失效根因）。
export const flowHistory = new HistoryStack();
