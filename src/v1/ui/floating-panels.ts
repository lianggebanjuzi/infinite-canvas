// src/v1/ui/floating-panels.ts
// 悬浮面板显隐控制器（Tab 化）：action-bar（节点上方操作条）与 cmd-panel（节点下方命令面板）
// 不再「选中节点 → 自动出现」，改为 Tab 键统一「呼出」、Esc / 点画布空白统一「收起」。
// 本模块只维护一个共享可见性开关并触发 flowState.notify()，让两个面板订阅的 sync()
// 根据 isVisible() 自行决定显示/收起与定位——不改动两个面板内部结构。
//
// 行为约定：
// - show()：Tab 呼出专用——有单选节点时显示（已显示则幂等 no-op，不重复 notify）；
//   无选中节点时返回 false（调用方不 preventDefault，保留 Tab 焦点跳转）
// - hide()：Esc / 点画布空白等收起场景调用，面板跟随新选中节点刷新但保持收起（不自动出现）
// - toggle()：保留但不被键盘调用（历史 flip 语义，供其他入口按需使用）
// - 面板显示态下切换选中节点：sync() 仍会刷新内容/位置（跟随新选中节点），不会误收起

import { flowState } from '../state/flow-state';
import { selection } from '../state/selection';

class FloatingPanels {
  /** 当前是否处于显示态（选中节点自动露出，也可用 Tab 呼出） */
  private _visible = false;
  /** 用于区分“切换选中节点”和“同一节点内部状态更新”，避免输入时反复弹出面板 */
  private _selectionKey = '';
  /** 中键平移期间临时收起面板；结束时仅恢复原本已显示的面板。 */
  private _suspendedForPan = false;
  private _restoreAfterPan = false;

  constructor() {
    flowState.subscribe(() => this._revealOnSelectionChange());
  }

  /** 单选节点是主工作入口：切换到新节点时自动露出面板；Esc 后同节点更新不打断用户。 */
  private _revealOnSelectionChange(): void {
    const key = selection.ids.join('|');
    const changed = key !== this._selectionKey;
    this._selectionKey = key;
    if (changed && selection.single()) this._visible = true;
  }

  /** 悬浮面板当前是否显示 */
  isVisible(): boolean {
    return this._visible;
  }

  /**
   * Tab 切换（保留）：有单选节点时翻转显隐并触发两个面板重新 sync。
   * 已不被键盘调用——Tab 键盘路径只走 show()（纯呼出）；本方法供其他入口按需使用。
   * 返回是否真正发生了切换（无选中节点时返回 false，供调用方决定是否保留默认 Tab 行为）。
   */
  toggle(): boolean {
    if (!selection.single()) return false;
    this._visible = !this._visible;
    flowState.notify();
    return true;
  }

  /** 收起（Esc / 点画布空白等场景）；已是收起态则无操作 */
  hide(): void {
    if (!this._visible) return;
    this._visible = false;
    flowState.notify();
  }

  /** 开始平移画布：先收起已显示的上下悬浮框，避免它们滞后于画布而发生跳位。 */
  suspendForPan(): void {
    if (this._suspendedForPan) return;
    this._suspendedForPan = true;
    this._restoreAfterPan = this._visible;
    if (!this._visible) return;
    this._visible = false;
    flowState.notify();
  }

  /** 结束平移：仅恢复开始前就已显示、且仍有单选节点的悬浮框。 */
  resumeAfterPan(): void {
    if (!this._suspendedForPan) return;
    const shouldRestore = this._restoreAfterPan && !!selection.single();
    this._suspendedForPan = false;
    this._restoreAfterPan = false;
    if (!shouldRestore) return;
    this._visible = true;
    flowState.notify();
  }

  /**
   * Tab 呼出：有单选节点时显示悬浮面板。
   * 幂等：已显示（_visible 为 true）时直接返回 true，不重复 notify。
   * 返回是否应拦截本次 Tab（无选中节点时返回 false，供调用方保留默认 Tab 焦点跳转）。
   */
  show(): boolean {
    if (!selection.single()) return false;
    if (this._visible) return true;
    this._visible = true;
    flowState.notify();
    return true;
  }
}

export const floatingPanels = new FloatingPanels();
