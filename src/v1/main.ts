// src/v1/main.ts
// v1 应用启动编排：等待 pywebview → 注册节点 → 渲染画布 → 绑定 UI → 键盘/错误处理
// A1：启动为空画布 + 空态引导（不自动加载模板）
// 无边框窗口拖动说明：顶栏拖动由 pywebview 官方 drag-region 机制接管（不再手写 ctypes），
// 前端只负责拦截交互元素防止误触发（详见 bindWindowControls）。

import '../bridge';

import './styles/variables.css';
import './styles/app.css';

// 注册节点定义（副作用：向 nodeRegistry 注册；统一「生成节点」唯一注册）
import './nodes/image-gen';
// 文本反推：chat 模型反推参考图提示词，输出文本（outputText）；同步调 chat_v2
import './nodes/text-gen';

import { flowState } from './state/flow-state';
import { selection } from './state/selection';
import { canvasView } from './canvas/canvas-view';
import { cardView } from './canvas/card-view';
import { interactions } from './canvas/interactions';
import { cmdPanel } from './ui/cmd-panel';
import { actionBar } from './ui/action-bar';
import { floatingPanels } from './ui/floating-panels';
import { historyDrawer } from './ui/history-drawer';
import { assetDrawer } from './ui/asset-drawer';
import { leftCapsule } from './ui/left-capsule';
import { bottomBar } from './ui/bottom-bar';
import { comparePanel } from './ui/compare-panel';
// 挂起：空态引导卡停用（index.html 容器已注释；恢复时取消本行与 init() 调用的注释）
// import { emptyState } from './ui/empty-state';
import { settingsPanel } from './ui/settings-panel';
import { outpaintPanel } from './ui/outpaint-panel';
import { saveCoordinator } from './save-coordinator';
import { closeGuard } from './close-guard';
import { flowHistory } from './state/history';
import { runEngine } from './engine/run-engine';
import { assetStore } from './asset-store';
import { resolveDefaultModel, resolveDefaultChatModel } from './api';

// ───────────────────────── pywebview 就绪等待 ─────────────────────────
function waitForPywebview(): Promise<void> {
  return new Promise(resolve => {
    if ((window as unknown as { pywebview?: unknown }).pywebview) {
      resolve();
    } else {
      window.addEventListener('pywebviewready', () => resolve(), { once: true });
      setTimeout(() => resolve(), 3000); // 兜底：3 秒后无论如何继续
    }
  });
}

// ───────────────────────── 全局错误处理 ─────────────────────────
function installGlobalErrorHandler(): void {
  // 仅输出到 DevTools console（不渲染进 UI，维持「画布不出现文字日志」共享约定第 6 条），
  // 便于 pywebview 调试模式下定位异常（曾因完全静默导致右键菜单等 init/交互异常难以诊断）。
  window.addEventListener('error', (e) => {
    console.error('[ICV] 未捕获错误:', e.error ?? e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[ICV] 未处理的 Promise 拒绝:', (e as PromiseRejectionEvent).reason);
  });
}

// ───────────────────────── 键盘快捷键 ─────────────────────────
function bindKeyboard(): void {
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    const tag = (document.activeElement?.tagName || '').toLowerCase();
    const isTyping = tag === 'input' || tag === 'textarea';
    const isMeta = e.ctrlKey || e.metaKey;

    // Tab：呼出悬浮面板（节点上方操作条 + 下方命令面板同时显示）
    // 仅无修饰键的 Tab；焦点在输入类元素（input/textarea/select/contenteditable）内时不拦截，
    // 保持浏览器默认焦点跳转（如改 prompt 时按 Tab 不得误触呼出）。
    // Tab 是纯「呼出」动作：已显示时按 Tab 无动作（show() 幂等 no-op），收起统一走 Esc / 点画布空白。
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      const el = document.activeElement as HTMLElement | null;
      const inInput = isTyping || tag === 'select' || !!el?.isContentEditable;
      if (!inInput && floatingPanels.show()) {
        e.preventDefault();
      }
      return;
    }

    // Ctrl+S 保存
    if (isMeta && e.key === 's') {
      e.preventDefault();
      void saveCoordinator.save(false);
      return;
    }

    // Escape 收起悬浮面板：输入框内聚焦也生效（改 prompt 时按 Esc 收起面板）。
    // 卡片就地编辑 textarea 对 Escape 做了 stopPropagation，不会冒泡到这里，互不干扰。
    if (e.key === 'Escape' && isTyping) {
      floatingPanels.hide();
      return;
    }

    if (isTyping) return;

    // Ctrl+Z 撤销 / Ctrl+Shift+Z / Ctrl+Y 重做（运行中禁用）
    if (isMeta && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      if (!runEngine.isBusy()) flowHistory.undo();
      return;
    }
    if (isMeta && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault();
      if (!runEngine.isBusy()) flowHistory.redo();
      return;
    }

    // Delete 删除选中
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const ids = [...flowState.selectedIds];
      if (ids.length > 0) {
        e.preventDefault();
        flowHistory.record();
        ids.forEach(id => flowState.removeNode(id));
        selection.clear();
      }
      return;
    }

    // Escape 关闭浮层
    if (e.key === 'Escape') {
      floatingPanels.hide(); // Tab 化：Esc 同时收起上下悬浮面板
      settingsPanel.close();
      outpaintPanel.close();
      comparePanel.close();
      assetDrawer.close(); // 资产库抽屉（可选，设计 §2 文件列表）
      document.getElementById('ctx-menu')?.classList.remove('show');
      document.getElementById('img-modal')?.classList.remove('show');
    }
  });
}

// ───────────────────────── 为生成节点回填默认模型 ─────────────────────────
// 类型感知：text-gen 回填 chat 默认模型（icv_default_chat_model），其余回填绘图默认模型（icv_default_model）
async function fillDefaultModels(): Promise<void> {
  const needsChat = flowState.nodes.some(n => n.type === 'text-gen' && !(n.params.model as string | undefined));
  const needsDraw = flowState.nodes.some(n => n.type !== 'text-gen' && !(n.params.model as string | undefined));

  if (needsChat) {
    const chatModel = await resolveDefaultChatModel();
    if (chatModel) {
      flowState.nodes
        .filter(n => n.type === 'text-gen' && !(n.params.model as string | undefined))
        .forEach(n => flowState.updateNodeParams(n.id, { model: chatModel }));
    }
  }
  if (needsDraw) {
    const drawModel = await resolveDefaultModel();
    if (drawModel) {
      flowState.nodes
        .filter(n => n.type !== 'text-gen' && !(n.params.model as string | undefined))
        .forEach(n => flowState.updateNodeParams(n.id, { model: drawModel }));
    }
  }
}

// ───────────────────────── 撤销/重做按钮状态 ─────────────────────────
/** 同步顶栏撤销/重做按钮灰显态：运行中禁用，无可撤销/重做时禁用 */
function syncUndoRedo(): void {
  const undoBtn = document.getElementById('btn-undo') as HTMLButtonElement | null;
  const redoBtn = document.getElementById('btn-redo') as HTMLButtonElement | null;
  const busy = runEngine.isBusy();
  if (undoBtn) undoBtn.disabled = busy || !flowHistory.canUndo;
  if (redoBtn) redoBtn.disabled = busy || !flowHistory.canRedo;
}

// ───────────────────────── 无边框窗口控制（自绘标题栏） ─────────────────────────
// 窗口拖动由 pywebview 官方 drag-region 机制接管（不再手写 ctypes）：
// pywebview 6.x 注入的 customize.js 在 document.body 上监听 mousedown（冒泡阶段），
// 命中 '.pywebview-drag-region'（即本顶栏）后走内部桥接 pywebviewMoveWindow，
// 由 WinForms 后端 move() 移动窗口（带 DPI 缩放；不经用户 js_api 异步层，稳定不抽搐）。
// 前端只需：① 捕获阶段拦截"交互元素"上的 mousedown（stopPropagation），
// 防止官方冒泡监听把点击项目名/窗口按钮误判为拖动；② 保留窗口控制按钮与双击最大化。
// W4：win_toggle_maximize 返回 {maximized} 切换 #win-max 图标；系统手势（Win+↑/↓）由
// 后端 window.events.maximized/restored → evaluate_js(window.__icvWinMaxState) 兜底同步。

/** 同步顶栏 #win-max 图标（□ ↔ ▣，W4） */
function setWinMaxIcon(maximized: boolean): void {
  const btn = document.getElementById('win-max');
  if (btn) btn.classList.toggle('maximized', !!maximized);
}

/** 后端 evaluate_js 回调：系统手势进入/退出最大化时同步图标（W2 脱节兜底） */
(window as unknown as Record<string, unknown>).__icvWinMaxState = (maximized: boolean): void => {
  setWinMaxIcon(!!maximized);
};

/** 兼容 pywebview 返回值可能被包一层 result（共享知识 5）：取 r?.maximized ?? r?.result?.maximized */
function readMaximized(r: unknown): boolean | null {
  const v = (r as { maximized?: unknown } | undefined)?.maximized
    ?? (r as { result?: { maximized?: unknown } } | undefined)?.result?.maximized;
  return typeof v === 'boolean' ? v : null;
}

/** 点击/双击顶栏触发最大化切换，并依据后端返回值同步图标（W4） */
async function toggleMaximizeAndSyncIcon(): Promise<void> {
  try {
    const r = await window.pywebview.api.win_toggle_maximize();
    const maximized = readMaximized(r);
    if (maximized !== null) setWinMaxIcon(maximized);
  } catch { /* 后端不可用时静默（纯浏览器调试场景） */ }
}

function bindWindowControls(): void {
  // 三个窗口按钮：关闭按钮走 closeGuard（不得直连 win_close，否则关闭保护形同虚设）
  document.getElementById('win-min')!.addEventListener('click', () => { window.pywebview.api.win_minimize(); });
  document.getElementById('win-max')!.addEventListener('click', () => { void toggleMaximizeAndSyncIcon(); });
  document.getElementById('win-close')!.addEventListener('click', () => { void closeGuard.requestClose(); });

  const topbar = document.querySelector('.topbar') as HTMLElement;

  // 捕获阶段（capture: true）拦截：交互元素（输入框/按钮/顶栏右侧窗口按钮区）不触发官方拖动。
  // 只 stopPropagation、不 preventDefault：不影响 input 聚焦与按钮点击（click 是独立事件，不受影响）。
  topbar.addEventListener('mousedown', (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, button, select, textarea, .topbar-right')) {
      e.stopPropagation();
    }
  }, true);

  // 双击顶栏空白 = 最大化/还原（W1）
  topbar.addEventListener('dblclick', (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, button, select, textarea, .topbar-right')) return;
    void toggleMaximizeAndSyncIcon();
  });
}

// ───────────────────────── 启动 ─────────────────────────
async function init(): Promise<void> {
  installGlobalErrorHandler();

  // 渲染层
  canvasView.init();      // 内部会订阅 flowState
  cardView.init();
  interactions.init();

  // 悬浮 UI
  historyDrawer.init();
  assetDrawer.init();
  // 双抽屉互斥（S5）：打开一个自动收起另一个；由 main.ts 编排，抽屉内部不互相 import 关闭逻辑
  historyDrawer.setMutex(() => assetDrawer.close());
  assetDrawer.setMutex(() => historyDrawer.close());
  // 左侧胶囊调（改版）：两个图标入口 + active 态同步（MutationObserver 监听抽屉 open class）
  leftCapsule.init();
  cmdPanel.init();
  actionBar.init();
  bottomBar.init();
  // emptyState.init(); // 挂起：空态引导卡停用（恢复时取消注释）
  settingsPanel.init();
  outpaintPanel.init();
  comparePanel.init();

  // 资产索引（采纳/锁定单一数据源；X1 三处订阅）
  assetStore.init();

  bindKeyboard();
  bindWindowControls();

  // 保存编排器（60s 自动保存 + 失焦 + 三态）+ 撤销/重做按钮
  saveCoordinator.init();
  // 关闭保护：dirty 上报后端缓存（main.py closing 事件读缓存，不再同步 evaluate_js 卡 GUI 线程）
  closeGuard.init();
  document.getElementById('btn-undo')?.addEventListener('click', () => { if (!runEngine.isBusy()) flowHistory.undo(); });
  document.getElementById('btn-redo')?.addEventListener('click', () => { if (!runEngine.isBusy()) flowHistory.redo(); });
  flowState.subscribe(() => syncUndoRedo());
  syncUndoRedo();

  // 初始渲染（空画布 → 空态引导）
  flowState.notify();

  // 等待 pywebview 后加载模型（填充默认模型，供模板/新节点使用）+ 初始化窗口最大化图标（W4）
  await waitForPywebview();
  // pywebview 就绪后强制重报一次 dirty：确保后端尽早拿到真实值并置位"已上报"标志
  // （此前 init 阶段若 pywebview 未就绪，win_set_dirty 会被静默跳过）
  closeGuard.syncNow();
  try {
    const r = await window.pywebview.api.win_is_maximized();
    const maximized = readMaximized(r);
    if (maximized !== null) setWinMaxIcon(maximized);
  } catch { /* 后端不可用时静默（纯浏览器调试场景） */ }
  void fillDefaultModels();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { void init(); });
} else {
  void init();
}
