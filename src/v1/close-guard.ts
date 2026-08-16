// src/v1/close-guard.ts
// 关闭保护 + 打开前 dirty 检查：共用同一套三选一弹窗（保存 / 放弃 / 取消）。
// 关闭保护链路（跨进程边界）：
//   OS 点 X → pywebview `closing` 事件 → main.py 用 evaluate_js 同步查 `window.__icvIsDirty()`；
//   dirty=true → 返回 False 阻止关闭 → evaluate_js 触发 `window.__icvRequestClose()` → 本模块 requestClose()；
//   用户三选一：保存并关闭 → saveForClose() 成功后调 win_close()（_closing_forced 强制 destroy，不再触发 closing）；
//   不保存 → win_close()；取消 → 不关。
// 自绘关闭按钮（顶栏 X）不能直连 win_close，否则绕过保护——必须走 requestClose()。

import { flowState } from './state/flow-state';
import { saveCoordinator } from './save-coordinator';
import { runEngine } from './engine/run-engine';
import { threeWayDialog } from './ui/confirm';

type PromptMode = 'close' | 'open';
type PromptChoice = 'save' | 'discard' | 'cancel';

class CloseGuard {
  private prompting = false;

  /** 关闭保护入口（顶栏 X / pywebview closing 拦截后触发） */
  async requestClose(): Promise<void> {
    if (this.prompting) return;
    if (!flowState.dirty) {
      this._forceClose();
      return;
    }
    const choice = await this.promptUnsavedChanges('close');
    if (choice === 'save') {
      const ok = await saveCoordinator.saveForClose();
      if (!ok) return; // 保存失败/取消 → 不关闭（R3.2）
      this._forceClose();
    } else if (choice === 'discard') {
      this._forceClose();
    }
    // 'cancel' → 不关闭
  }

  /** 打开/新建/切换前 dirty 检查；用户确认后执行 action（如 persistence.open） */
  async guardOpen(action: () => void | Promise<void>): Promise<void> {
    if (this.prompting) return;
    if (!flowState.dirty) {
      await action();
      return;
    }
    const choice = await this.promptUnsavedChanges('open');
    if (choice === 'save') {
      const ok = await saveCoordinator.save(false);
      if (!ok) return; // 保存失败/取消 → 中止打开，当前项目保持不变
      await action();
    } else if (choice === 'discard') {
      await action();
    }
    // 'cancel' → 不执行打开
  }

  /** 三选一弹窗：mode='close'（关闭保护）/'open'（打开前检查），运行中附加中断警示 */
  async promptUnsavedChanges(mode: PromptMode): Promise<PromptChoice> {
    this.prompting = true;
    try {
      const busy = runEngine.isBusy();
      return await threeWayDialog({
        title: mode === 'close' ? '有未保存的改动' : '打开项目前有未保存的改动',
        message: busy
          ? '当前项目有尚未保存的修改，且有任务在运行，关闭会中断。'
          : '当前项目有尚未保存的修改。',
        saveText: mode === 'close' ? '保存并关闭' : '保存',
        discardText: mode === 'close' ? '不保存' : '放弃改动',
        cancelText: '取消',
      });
    } finally {
      this.prompting = false;
    }
  }

  /** 强制关闭（经 win_close 的 _closing_forced 标志绕过 closing 拦截） */
  private _forceClose(): void {
    try {
      window.pywebview.api.win_close();
    } catch {
      // 兜底：无 pywebview（纯浏览器调试）时尝试 window.close
      window.close();
    }
  }
}

export const closeGuard = new CloseGuard();

// ── pywebview 桥接钩子（main.py 的 closing 事件经 evaluate_js 调用） ──
const w = window as unknown as Record<string, unknown>;
w.__icvIsDirty = (): boolean => flowState.dirty;
w.__icvRequestClose = (): void => { void closeGuard.requestClose(); };
