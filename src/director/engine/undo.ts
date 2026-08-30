// src/director/engine/undo.ts
// 导演台撤销/重做：对工程的可持久化部分做快照（深拷贝），命令式入栈。
// 每次「变更前」调用 push() 记录当前状态；undo/redo 返回快照并由上层重建场景。

import { DirectorProject } from '../types';

export interface DirectorUndoSnapshot {
  project: DirectorProject;
}

export class DirectorUndo {
  private undoStack: DirectorProject[] = [];
  private redoStack: DirectorProject[] = [];
  private listeners = new Set<() => void>();
  private maxDepth = 60;
  private lastPushedKey = '';

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private notify(): void {
    this.listeners.forEach(fn => {
      try { fn(); } catch { /* 单个订阅者异常不影响整体 */ }
    });
  }

  /** 变更前调用：把当前工程快照入撤销栈（相邻同内容快照去重） */
  push(project: DirectorProject): void {
    const snapshot = JSON.parse(JSON.stringify(project)) as DirectorProject;
    const key = JSON.stringify(snapshot);
    if (key === this.lastPushedKey) return; // 无实际变化
    this.lastPushedKey = key;
    this.undoStack.push(snapshot);
    if (this.undoStack.length > this.maxDepth) this.undoStack.shift();
    this.redoStack = [];
    this.notify();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** 撤销：返回应恢复的工程快照；无可用撤销返回 null */
  undo(current: DirectorProject): DirectorProject | null {
    const prev = this.undoStack.pop();
    if (!prev) return null;
    this.redoStack.push(JSON.parse(JSON.stringify(current)) as DirectorProject);
    this.lastPushedKey = JSON.stringify(prev);
    this.notify();
    return prev;
  }

  /** 重做：返回应恢复的工程快照；无可用重做返回 null */
  redo(current: DirectorProject): DirectorProject | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(JSON.parse(JSON.stringify(current)) as DirectorProject);
    this.lastPushedKey = JSON.stringify(next);
    this.notify();
    return next;
  }

  /** 清空历史（打开/新建工程时调用） */
  reset(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.lastPushedKey = '';
    this.notify();
  }
}

export const directorUndo = new DirectorUndo();
