// src/cards/features/drawing-board/history-manager.ts
// 历史管理器：画板局部撤销/重做

import type { DrawingBoardCard } from '../../drawing-board-card';

export class DrawingBoardHistoryManager {
  private _card: DrawingBoardCard;
  private _maxHistory: number;
  private _history: string[] = [];
  private _index = -1;
  _justRestored = false;

  constructor(card: DrawingBoardCard, maxHistory = 50) { this._card = card; this._maxHistory = maxHistory; }

  save(): void {
    const layerState = this._card._layerManager.export();
    const viewState = this._card._viewController.export();
    const state = { ...layerState, ...viewState };
    this._history = this._history.slice(0, this._index + 1);
    this._history.push(JSON.stringify(state));
    if (this._history.length > this._maxHistory) this._history.shift();
    else this._index++;
    this._justRestored = false;
  }

  isJustRestored(): boolean { return this._justRestored; }
  undo(): boolean { if (this._index > 0) { this._index--; this._restore(); return true; } return false; }
  redo(): boolean { if (this._index < this._history.length - 1) { this._index++; this._restore(); return true; } return false; }

  private _restore(): void {
    const state = JSON.parse(this._history[this._index]);
    this._card._layerManager.restore(state);
    this._card._viewController.restore(state);
    this._card._viewController._apply();
    this._card._renderer.syncDrawingLayerFromLayer(this._card._layerManager.getSelected());
    this._card._renderer.render();
    this._card._renderLayersList();
    this._justRestored = true;
  }

  canUndo(): boolean { return this._index > 0; }
  canRedo(): boolean { return this._index < this._history.length - 1; }
  clear(): void { this._history = []; this._index = -1; }
}