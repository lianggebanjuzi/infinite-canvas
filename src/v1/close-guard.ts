// src/v1/close-guard.ts
// 关闭保护 + 打开前 dirty 检查：共用同一套三选一弹窗（保存 / 放弃 / 取消）。
// 关闭保护链路（跨进程边界，未响应修复后）：
//   OS 点 X → pywebview `closing` 事件 → main.py 读前端上报的 dirty 缓存（不再同步 evaluate_js，
//   避免 GUI 线程等待 JS 渲染大图卡死窗口）；dirty=true → 返回 False 阻止关闭 → 后台线程
//   evaluate_js 触发 `window.__icvRequestClose()` → 本模块 requestClose()（内部再校验真实 dirty）；
//   用户三选一：保存并关闭 → saveForClose() 成功后调 win_close()（_closing_forced 强制 destroy，不再触发 closing）；
//   不保存 → win_close()；取消 → 不关。
// 自绘关闭按钮（顶栏 X）不能直连 win_close，否则绕过保护——必须走 requestClose()。

import { flowState } from './state/flow-state';
import { saveCoordinator } from './save-coordinator';
import { runEngine } from './engine/run-engine';
import { imageEditEngine } from './engine/image-edit-engine';
import { threeWayDialog } from './ui/confirm';

type PromptMode = 'close' | 'open';
type PromptChoice = 'save' | 'discard' | 'cancel';

class CloseGuard {
  private prompting = false;
  private unsubscribeDirty: (() => void) | null = null;

  /** 启动 dirty 上报（main.ts init 调用）：订阅 flowState 变更 + 初始上报一次 */
  init(): void {
    if (this.unsubscribeDirty) return;
    this.unsubscribeDirty = flowState.subscribe(() => syncDirtyToBackend());
    syncDirtyToBackend();
  }

  /** 强制重报一次（main.ts 在 pywebview 就绪后调用，确保后端尽快拿到真实 dirty 与"已上报"标志） */
  syncNow(): void {
    lastReportedDirty = null;
    syncDirtyToBackend();
  }

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
      const busy = runEngine.isBusy() || imageEditEngine.isBusy();
      // 4.2：进行中的视频/音频媒体任务（含跨会话可恢复的 videoTask/audioTask）
      const mediaTasks = runEngine.mediaTasksInProgress();
      const mediaHint = mediaTasks.length > 0
        ? `有 ${mediaTasks.length} 个视频/音频任务正在进行或等待恢复：关闭后远端仍会继续生成，下次打开项目时可恢复查询同一任务。`
        : '';
      const busyHint = busy
        ? '当前项目有尚未保存的修改，且有任务在运行，关闭会中断。'
        : '当前项目有尚未保存的修改。';
      return await threeWayDialog({
        title: mode === 'close' ? '有未保存的改动' : '打开项目前有未保存的改动',
        message: [busyHint, mediaHint].filter(Boolean).join('\n'),
        saveText: mode === 'close' ? (mediaTasks.length > 0 ? '保存并关闭' : '保存并关闭') : '保存',
        // 媒体任务进行中：第二按钮语义 = 关闭但保留远端任务记录（不保存本地改动）
        discardText: mode === 'close' ? (mediaTasks.length > 0 ? '关闭但保留远端任务记录' : '不保存') : '放弃改动',
        cancelText: mediaTasks.length > 0 ? '取消关闭（继续等待）' : '取消',
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

// ── 关闭未响应修复：dirty 状态主动上报后端缓存 ──
// main.py 的 closing 事件不再同步 evaluate_js（GUI 线程等待 JS 渲染大图会卡死窗口），
// 改为读取后端缓存的 dirty；本模块在 flowState 变更时主动上报，保证缓存近似实时。
// 脏读可接受：未响应比"偶尔多弹一次确认"更严重；且 requestClose 内部会再校验真实 dirty。
let lastReportedDirty: boolean | null = null;

function reportDirtyToBackend(dirty: boolean): void {
  const api = (window as unknown as { pywebview?: { api?: Record<string, unknown> } }).pywebview?.api;
  if (!api || typeof api.win_set_dirty !== 'function') return;
  try {
    void (api.win_set_dirty as (d: boolean) => unknown)(dirty);
  } catch { /* 后端不可用时静默（纯浏览器调试场景） */ }
}

function syncDirtyToBackend(): void {
  const dirty = flowState.dirty;
  if (dirty === lastReportedDirty) return; // 值未变化不重复上报（画布平移/选中等非 dirty 变更不刷桥）
  lastReportedDirty = dirty;
  reportDirtyToBackend(dirty);
}
