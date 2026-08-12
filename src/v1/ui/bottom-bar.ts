// src/v1/ui/bottom-bar.ts
// 底部胶囊条：打开 / 保存 / 主题 / 设置 + 运行选中（A5：多选高亮可用，单选=运行当前卡）

import { flowState } from '../state/flow-state';
import { selection } from '../state/selection';
import { persistence } from '../persistence';
import { runEngine } from '../engine/run-engine';
import { settingsPanel } from './settings-panel';

const THEME_KEY = 'infinite_canvas_theme';

class BottomBar {
  private runBtn: HTMLButtonElement | null = null;
  private saveDot: HTMLElement | null = null;
  private nameInput: HTMLInputElement | null = null;

  init(): void {
    this.runBtn = document.getElementById('btn-run-selected') as HTMLButtonElement | null;
    this.saveDot = document.getElementById('save-dot');
    this.nameInput = document.getElementById('project-name') as HTMLInputElement | null;

    document.getElementById('btn-open')?.addEventListener('click', () => void persistence.open());
    document.getElementById('btn-save')?.addEventListener('click', () => void persistence.save());
    document.getElementById('btn-theme')?.addEventListener('click', () => this._toggleTheme());
    document.getElementById('btn-settings')?.addEventListener('click', () => settingsPanel.open());
    this.runBtn?.addEventListener('click', () => void runEngine.runSelected());

    // 项目名编辑
    this.nameInput?.addEventListener('input', () => {
      flowState.projectName = this.nameInput!.value || '未命名项目';
      flowState.dirty = true;
      flowState.notify();
    });

    // 主题初始化
    const saved = localStorage.getItem(THEME_KEY);
    document.documentElement.setAttribute('data-theme', saved === 'dark' ? 'dark' : 'light');

    flowState.subscribe(() => this._sync());
    this._sync();
  }

  private _toggleTheme(): void {
    const html = document.documentElement;
    const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    localStorage.setItem(THEME_KEY, next);
  }

  private _sync(): void {
    // 未保存小圆点
    this.saveDot?.classList.toggle('show', flowState.dirty);
    // 项目名输入框（未聚焦时不覆盖）
    if (this.nameInput && document.activeElement !== this.nameInput) {
      this.nameInput.value = flowState.projectName;
    }
    // 运行选中按钮（A5）
    if (this.runBtn) {
      const n = selection.size;
      this.runBtn.disabled = n === 0;
      this.runBtn.classList.toggle('run-active', n > 1);
      const label = this.runBtn.querySelector('span');
      if (label) label.textContent = n === 1 ? '运行当前卡' : (n > 1 ? `运行选中 (${n})` : '运行选中');
    }
  }
}

export const bottomBar = new BottomBar();
