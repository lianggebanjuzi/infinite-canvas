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
// 结果卡：只读结果载体（引擎自动创建，不进新建菜单）；必须在 image-gen 之后注册（菜单过滤依赖 creatable）
import './nodes/image-result';
// 文本反推：chat 模型反推参考图提示词，输出文本（outputText）；同步调 chat_v2
import './nodes/text-gen';

import { flowState } from './state/flow-state';
import { selection } from './state/selection';
import { canvasView } from './canvas/canvas-view';
import { cardView } from './canvas/card-view';
import { interactions } from './canvas/interactions';
import { cmdPanel } from './ui/cmd-panel';
import { actionBar } from './ui/action-bar';
import { historyDrawer } from './ui/history-drawer';
import { bottomBar } from './ui/bottom-bar';
// 挂起：空态引导卡停用（index.html 容器已注释；恢复时取消本行与 init() 调用的注释）
// import { emptyState } from './ui/empty-state';
import { settingsPanel } from './ui/settings-panel';
import { persistence } from './persistence';
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
  window.addEventListener('error', () => { /* 静默：不出现文字日志（共享约定第 6 条） */ });
  window.addEventListener('unhandledrejection', () => { /* 静默 */ });
}

// ───────────────────────── 键盘快捷键 ─────────────────────────
function bindKeyboard(): void {
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    const tag = (document.activeElement?.tagName || '').toLowerCase();
    const isTyping = tag === 'input' || tag === 'textarea';
    const isMeta = e.ctrlKey || e.metaKey;

    // Ctrl+S 保存
    if (isMeta && e.key === 's') {
      e.preventDefault();
      void persistence.save();
      return;
    }

    if (isTyping) return;

    // Delete 删除选中
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const ids = [...flowState.selectedIds];
      if (ids.length > 0) {
        e.preventDefault();
        ids.forEach(id => flowState.removeNode(id));
        selection.clear();
      }
      return;
    }

    // Escape 关闭浮层
    if (e.key === 'Escape') {
      settingsPanel.close();
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

// ───────────────────────── 无边框窗口控制（自绘标题栏） ─────────────────────────
// 窗口拖动由 pywebview 官方 drag-region 机制接管（不再手写 ctypes）：
// pywebview 6.x 注入的 customize.js 在 document.body 上监听 mousedown（冒泡阶段），
// 命中 '.pywebview-drag-region'（即本顶栏）后走内部桥接 pywebviewMoveWindow，
// 由 WinForms 后端 move() 移动窗口（带 DPI 缩放；不经用户 js_api 异步层，稳定不抽搐）。
// 前端只需：① 捕获阶段拦截"交互元素"上的 mousedown（stopPropagation），
// 防止官方冒泡监听把点击项目名/窗口按钮误判为拖动；② 保留窗口控制按钮与双击最大化。
function bindWindowControls(): void {
  // 三个窗口按钮
  document.getElementById('win-min')!.addEventListener('click', () => { window.pywebview.api.win_minimize(); });
  document.getElementById('win-max')!.addEventListener('click', () => { window.pywebview.api.win_toggle_maximize(); });
  document.getElementById('win-close')!.addEventListener('click', () => { window.pywebview.api.win_close(); });

  const topbar = document.querySelector('.topbar') as HTMLElement;

  // 捕获阶段（capture: true）拦截：交互元素（输入框/按钮/顶栏右侧窗口按钮区）不触发官方拖动。
  // 只 stopPropagation、不 preventDefault：不影响 input 聚焦与按钮点击（click 是独立事件，不受影响）。
  topbar.addEventListener('mousedown', (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, button, select, textarea, .topbar-right')) {
      e.stopPropagation();
    }
  }, true);

  // 双击顶栏空白 = 最大化/还原
  topbar.addEventListener('dblclick', (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, button, select, textarea, .topbar-right')) return;
    window.pywebview.api.win_toggle_maximize();
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
  cmdPanel.init();
  actionBar.init();
  bottomBar.init();
  // emptyState.init(); // 挂起：空态引导卡停用（恢复时取消注释）
  settingsPanel.init();

  bindKeyboard();
  bindWindowControls();

  // 初始渲染（空画布 → 空态引导）
  flowState.notify();

  // 等待 pywebview 后加载模型（填充默认模型，供模板/新节点使用）
  await waitForPywebview();
  void fillDefaultModels();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { void init(); });
} else {
  void init();
}
