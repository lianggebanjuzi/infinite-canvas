// src/v1/ui/bottom-bar.ts
// 底部胶囊条：打开 / 保存 / 主题 / 设置 + 运行选中（A5：多选高亮可用，单选=运行当前卡）

import { flowState } from '../state/flow-state';
import { selection } from '../state/selection';
import { persistence } from '../persistence';
import { runEngine } from '../engine/run-engine';
import { saveCoordinator } from '../save-coordinator';
import { closeGuard } from '../close-guard';
import { flowHistory } from '../state/history';
import { settingsPanel } from './settings-panel';
import { comparePanel } from './compare-panel';
import { taskPanel } from './task-panel';
import { showToast } from './toast';
import { Backend } from '../api';

const THEME_KEY = 'infinite_canvas_theme';
export const WORKSPACE_THEMES = ['warm', 'dark', 'ocean', 'violet', 'copper'] as const;
export type WorkspaceTheme = typeof WORKSPACE_THEMES[number];

export function normalizeWorkspaceTheme(value: unknown): WorkspaceTheme {
  return WORKSPACE_THEMES.includes(value as WorkspaceTheme) ? value as WorkspaceTheme : 'warm';
}

/** 主题是全局设置而非项目字段，切换不会污染 .icproj。 */
export async function applyWorkspaceTheme(value: unknown, persist = true): Promise<WorkspaceTheme> {
  const theme = normalizeWorkspaceTheme(value);
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_KEY, theme); // 桌面桥接未就绪时的启动回退
  if (persist) {
    try {
      const settings = await Backend.loadSettings();
      await Backend.saveSettings({ ...settings, workspace_theme: theme });
    } catch { /* 纯浏览器预览可继续使用本会话主题 */ }
  }
  return theme;
}

class BottomBar {
  private runBtn: HTMLButtonElement | null = null;
  private compareBtn: HTMLButtonElement | null = null;
  private nameInput: HTMLInputElement | null = null;

  init(): void {
    this.runBtn = document.getElementById('btn-run-selected') as HTMLButtonElement | null;
    this.compareBtn = document.getElementById('btn-compare') as HTMLButtonElement | null;
    this.nameInput = document.getElementById('project-name') as HTMLInputElement | null;

    // 打开：先过 closeGuard 的 dirty 检查（保存/放弃/取消）
    document.getElementById('btn-open')?.addEventListener('click', () => void closeGuard.guardOpen(() => persistence.open()));
    // 保存：统一走 SaveCoordinator（三路唯一入口）
    document.getElementById('btn-save')?.addEventListener('click', () => void saveCoordinator.save(false));
    document.getElementById('btn-theme')?.addEventListener('click', () => this._toggleTheme());
    document.getElementById('btn-settings')?.addEventListener('click', () => settingsPanel.open());
    this.runBtn?.addEventListener('click', () => void runEngine.runSelected());
    // 任务面板切换（B-4：运行中自动展开，结束可手动收起/展开摘要）
    document.getElementById('btn-task')?.addEventListener('click', () => taskPanel.toggle());

    // 对比（C1）：n = 选中可对比数（image-gen 且 imageUrl 非空；文本不计入），n<2 时整钮禁用
    this.compareBtn?.addEventListener('click', () => {
      const comparable = this._comparableIds();
      if (comparable.length < 2) {
        showToast('请至少选择 2 张成图进行对比', false);
        return;
      }
      comparePanel.open(comparable);
    });

    // 项目名编辑：聚焦记一次快照（整段重命名为一步撤销）
    this.nameInput?.addEventListener('focus', () => flowHistory.record());
    this.nameInput?.addEventListener('input', () => {
      flowState.projectName = this.nameInput!.value || '未命名项目';
      flowState.updatedAt = Date.now(); // 与 dirty 绑定：任何改动都要同步版本号（S3 修复依赖 updatedAt 判断保存后是否又有新改动）
      flowState.dirty = true;
      flowState.notify();
    });

    // 主题初始化
    const saved = localStorage.getItem(THEME_KEY);
    void Backend.loadSettings().then(settings => void applyWorkspaceTheme(settings.workspace_theme || saved || 'warm', false)).catch(() => void applyWorkspaceTheme(saved || 'warm', false));

    flowState.subscribe(() => this._sync());
    this._sync();
  }

  /** 可对比节点 id（image-gen 且 imageUrl 非空；文本节点不计入 n，Q5 拍板） */
  private _comparableIds(): string[] {
    return selection.ids.filter(id => {
      const n = flowState.getNode(id);
      return !!n && n.type === 'image-gen' && !!n.imageUrl;
    });
  }

  private _toggleTheme(): void {
    const html = document.documentElement;
    const current = normalizeWorkspaceTheme(html.getAttribute('data-theme'));
    const next = WORKSPACE_THEMES[(WORKSPACE_THEMES.indexOf(current) + 1) % WORKSPACE_THEMES.length];
    void applyWorkspaceTheme(next);
  }

  private _sync(): void {
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
    // 对比按钮（C1）：n = 可对比数；n<2 整钮禁用；文本节点不计入 n（混选时不隐藏）
    if (this.compareBtn) {
      const n = this._comparableIds().length;
      this.compareBtn.disabled = n < 2;
      this.compareBtn.classList.toggle('run-active', n >= 2);
      const label = this.compareBtn.querySelector('span');
      if (label) label.textContent = n >= 2 ? `对比 (${n})` : '对比';
    }
  }
}

export const bottomBar = new BottomBar();
