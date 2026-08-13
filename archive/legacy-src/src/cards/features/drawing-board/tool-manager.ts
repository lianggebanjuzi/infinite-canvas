// src/cards/features/drawing-board/tool-manager.ts
// 工具管理器：画笔/橡皮/文字设置 + 光标联动

import type { BrushSettings, EraserSettings, TextSettings } from './types';
import type { DrawingBoardCard } from '../../drawing-board-card';

export class DrawingBoardToolManager {
  private _card: DrawingBoardCard;
  readonly TOOLS = { SELECT: 'select', BRUSH: 'brush', ERASER: 'eraser', TEXT: 'text', PAN: 'pan' };
  currentTool = 'pan';
  brushSettings: BrushSettings = { size: 10, hardness: 0.8, color: '#000000', opacity: 1.0 };
  eraserSettings: EraserSettings = { size: 20 };
  textSettings: TextSettings = { fontSize: 32, color: '#000000', fontFamily: 'sans-serif' };

  constructor(card: DrawingBoardCard) { this._card = card; }

  restore(settings: { brushSettings?: Partial<BrushSettings>; eraserSettings?: Partial<EraserSettings>; textSettings?: Partial<TextSettings> } | null): void {
    if (!settings) return;
    this.brushSettings = { ...this.brushSettings, ...settings.brushSettings } as BrushSettings;
    this.eraserSettings = { ...this.eraserSettings, ...settings.eraserSettings } as EraserSettings;
    this.textSettings = { ...this.textSettings, ...settings.textSettings } as TextSettings;
  }

  export(): { brushSettings: BrushSettings; eraserSettings: EraserSettings; textSettings: TextSettings } {
    return { brushSettings: { ...this.brushSettings }, eraserSettings: { ...this.eraserSettings }, textSettings: { ...this.textSettings } };
  }

  setTool(tool: string): void {
    if (!Object.values(this.TOOLS).includes(tool)) return;
    this.currentTool = tool;
    this._updateUI();
    this._updateCursor();
    if (tool === 'brush' || tool === 'eraser') {
      const size = tool === 'brush' ? this.brushSettings.size : this.eraserSettings.size;
      const color = tool === 'brush' ? this.brushSettings.color : null;
      this._card._renderer.updateBrushCursor(true, size, color);
    } else {
      this.callBrushCursor(false);
    }
    this._card._renderer.requestRender();
  }

  updateBrushSetting(key: string, value: unknown): void {
    if (key in this.brushSettings) {
      this.brushSettings[key] = value as never;
      this._updateCursor();
      if (this.currentTool === 'brush') {
        this._card._renderer.updateBrushCursor(true, this.brushSettings.size, this.brushSettings.color);
      }
    }
  }

  updateEraserSetting(key: string, value: unknown): void {
    if (key in this.eraserSettings) {
      this.eraserSettings[key] = value as never;
      this._updateCursor();
      if (this.currentTool === 'eraser') {
        this._card._renderer.updateBrushCursor(true, this.eraserSettings.size, null);
      }
    }
  }

  updateTextSetting(key: string, value: unknown): void {
    if (key in this.textSettings) this.textSettings[key] = value as never;
  }

  private _updateUI(): void {
    const toolbar = this._card.element?.querySelector('.drawing-board-toolbar');
    if (!toolbar) return;
    toolbar.querySelectorAll('.draw-tool-btn[data-tool]').forEach(btn => {
      btn.classList.toggle('active', (btn as HTMLElement).dataset.tool === this.currentTool);
    });
    this._card.element?.querySelector('.brush-settings-panel')?.classList.toggle('hidden', this.currentTool !== this.TOOLS.BRUSH);
    this._card.element?.querySelector('.eraser-settings-panel')?.classList.toggle('hidden', this.currentTool !== this.TOOLS.ERASER);
    this._card.element?.querySelector('.text-settings-panel')?.classList.toggle('hidden', this.currentTool !== this.TOOLS.TEXT);
  }

  _updateCursor(): void {
    const canvas = this._card._renderer._canvas;
    if (!canvas) return;
    switch (this.currentTool) {
      case this.TOOLS.SELECT: canvas.style.cursor = 'default'; break;
      case this.TOOLS.BRUSH: case this.TOOLS.ERASER: canvas.style.cursor = 'none'; break;
      case this.TOOLS.TEXT: canvas.style.cursor = 'text'; break;
      case this.TOOLS.PAN: canvas.style.cursor = 'grab'; break;
    }
  }

  /** 调用渲染器的圆圈光标，自动取当前工具的默认值 */
  callBrushCursor(visible: boolean): void {
    const tool = this.currentTool;
    if (tool === 'brush') {
      this._card._renderer.updateBrushCursor(visible, this.brushSettings.size, this.brushSettings.color);
    } else if (tool === 'eraser') {
      this._card._renderer.updateBrushCursor(visible, this.eraserSettings.size, null);
    } else {
      this._card._renderer.updateBrushCursor(false, 10, null);
    }
  }

  initUI(): void { this._updateUI(); this._updateCursor(); }
}