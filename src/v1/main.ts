// src/v1/main.ts
// v1 应用启动编排：等待 pywebview → 注册节点 → 渲染画布 → 绑定 UI → 键盘/错误处理
// A1：启动为空画布 + 空态引导（不自动加载模板）

import '../bridge';

import './styles/variables.css';
import './styles/app.css';

// 注册节点定义（副作用：向 nodeRegistry 注册；统一「生成节点」唯一注册）
import './nodes/image-gen';
// 结果卡：只读结果载体（引擎自动创建，不进新建菜单）；必须在 image-gen 之后注册（菜单过滤依赖 creatable）
import './nodes/image-result';

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
import { resolveDefaultModel } from './api';

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
async function fillDefaultModels(): Promise<void> {
  const model = await resolveDefaultModel();
  if (!model) return;
  flowState.nodes
    .filter(n => !(n.params.model as string | undefined))
    .forEach(n => flowState.updateNodeParams(n.id, { model }));
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
