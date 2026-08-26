// src/v1/main.ts
// v1 应用启动编排：等待 pywebview → 注册节点 → 渲染画布 → 绑定 UI → 键盘/错误处理
// A1：启动为空画布 + 空态引导（不自动加载模板）
// 无边框窗口拖动说明（B1）：顶栏拖动由前端自实现——mousedown 记录增量起点 → window mousemove
// 累计增量调后端 win_move_relative 相对移动 → mouseup 结束；最大化状态下前端锁定（后端亦拒绝），
// 双击顶栏空白切换最大化。不再使用 pywebview 官方 drag-region（最大化/还原后拖动失效的已知坑）。

import '../bridge';

import './styles/variables.css';
import './styles/app.css';

// 注册节点定义（副作用：向 nodeRegistry 注册；统一「生成节点」唯一注册）
import './nodes/image-gen';
// 文本反推：chat 模型反推参考图提示词，输出文本（outputText）；同步调 chat_v2
import './nodes/text-gen';
import './nodes/text-split';

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
import { taskPanel } from './ui/task-panel';
import { resultViewer } from './ui/result-viewer';
import { workflowLibrary } from './ui/workflow-library';
import { saveCoordinator } from './save-coordinator';
import { closeGuard } from './close-guard';
import { flowHistory } from './state/history';
import { runEngine } from './engine/run-engine';
import { batchStore } from './state/batch-store';
import { assetStore } from './asset-store';
import { fetchImageModels, fetchChatModels } from './api';

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
        ids.forEach(id => {
          runEngine.cancel(id);
          flowState.removeNode(id);
        });
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
      resultViewer.close(); // C-2：结果查看器抽屉
      workflowLibrary.close();
      assetDrawer.close(); // 资产库抽屉（可选，设计 §2 文件列表）
      document.getElementById('ctx-menu')?.classList.remove('show');
      document.getElementById('img-modal')?.classList.remove('show');
    }
  });
}

// ───────────────────────── 为生成节点回填项目内模型偏好 ─────────────────────────
async function fillDefaultModels(): Promise<void> {
  const resolveRoute = (saved: string, models: Array<{ id: string }>): string => {
    if (!saved) return '';
    if (models.some(item => item.id === saved)) return saved;
    // Key 被重建后，三段路由的中间 key id 会改变；模型 ID 仍唯一时迁移到
    // 当前可用路由。多个同名模型时不猜，交由下方安全回退处理。
    const bareId = saved.split(':').pop() || '';
    const matches = models.filter(item => (item.id.split(':').pop() || '') === bareId);
    return matches.length === 1 ? matches[0].id : '';
  };

  const reconcile = (
    type: 'text-gen' | 'image-gen',
    kind: 'chat' | 'drawing',
    models: Array<{ id: string }>,
  ): void => {
    const available = models.filter(item => Boolean(item.id));
    if (available.length === 0) return;
    const preferred = resolveRoute(flowState.getModelDefault(kind), available);
    const fallback = preferred || available[0].id;
    if (flowState.getModelDefault(kind) !== fallback) flowState.setModelDefault(kind, fallback);
    flowState.nodes
      .filter(node => node.type === type)
      .forEach(node => {
        const saved = String(node.params.model || '');
        const resolved = resolveRoute(saved, available);
        const target = resolved || fallback;
        if (target && target !== saved) flowState.updateNodeParams(node.id, { model: target });
      });
  };

  const [chatModels, drawModels] = await Promise.all([fetchChatModels(), fetchImageModels()]);
  reconcile('text-gen', 'chat', chatModels);
  reconcile('image-gen', 'drawing', drawModels);
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

// ───────────────────────── 无边框窗口控制（自绘标题栏，B1 自实现拖动） ─────────────────────────
// 窗口拖动不再走 pywebview 官方 drag-region（其「绝对坐标 = screenX - initialX」公式与
// 假最大化 SetWindowPos 贴工作区交互存在已知坑：最大化态可被拖走、还原后再拖失效）。
// 改为前端自实现：
//   - mousedown 顶栏空白：记录增量起点（screenX/screenY），若处于最大化态直接忽略（防假最大化窗口被拖走）；
//   - window mousemove：累计增量（CSS px）经 requestAnimationFrame 合并后调后端
//     win_move_relative(dx, dy)（后端按当前 DPI 换算物理像素、相对当前左上角移动，任何状态自洽）；
//   - mouseup / 窗口失焦：结束拖动。
// 保留：双击顶栏空白切换最大化、三个窗口按钮、输入框/按钮/顶栏右侧区的捕获拦截（防误触）。
// W4：win_toggle_maximize 返回 {maximized} 切换 #win-max 图标；系统手势（Win+↑/↓）由
// 后端 window.events.maximized/restored → evaluate_js(window.__icvWinMaxState) 兜底同步。

/** 顶栏拖动增量累计（rAF 合并；accX/accY 为自上次发送以来的累计增量） */
interface WinDragState {
  lastScreenX: number;
  lastScreenY: number;
  accX: number;
  accY: number;
  rafId: number | null;
}

/** 当前是否处于最大化态（拖动锁定用；由 setWinMaxIcon / __icvWinMaxState 同步） */
let winMaximized = false;
/** 顶栏拖动进行中状态（null = 未拖动） */
let winDrag: WinDragState | null = null;

/** 同步顶栏 #win-max 图标（□ ↔ ▣，W4）+ 最大化态标志（B1 拖动锁定） */
function setWinMaxIcon(maximized: boolean): void {
  winMaximized = !!maximized;
  const btn = document.getElementById('win-max');
  if (btn) btn.classList.toggle('maximized', !!maximized);
}

/** 后端 evaluate_js 回调：系统手势进入/退出最大化时同步图标与锁定标志（W2 脱节兜底） */
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

/** 顶栏 mousedown：开始自实现窗口拖动（B1）；交互元素/最大化态忽略 */
function startWinDrag(e: MouseEvent): void {
  // 交互元素（输入框/按钮/右侧窗口按钮区）不触发拖动（click 是独立事件，不受影响）
  const t = e.target as HTMLElement;
  if (t.closest('input, button, select, textarea, .topbar-right')) return;
  // 最大化状态下禁止拖动：假最大化窗口被 SetWindowPos 拖走后标志位/还原基准会漂移（B1 核心）
  if (winMaximized) return;
  // 上一段拖动未正常结束（如鼠标在窗口外松开）时先复位，避免增量错乱
  endWinDrag();
  winDrag = { lastScreenX: e.screenX, lastScreenY: e.screenY, accX: 0, accY: 0, rafId: null };
  window.addEventListener('mousemove', onWinDragMove);
  window.addEventListener('mouseup', onWinDragUp);
  // 鼠标在窗口外松开时窗口收不到 mouseup → 失焦兜底结束拖动
  window.addEventListener('blur', onWinDragBlur);
  e.preventDefault(); // 防止拖动期间文本选择/原生拖拽残留
}

function onWinDragMove(e: MouseEvent): void {
  if (!winDrag) return;
  // 累计增量（CSS px；后端按 DPI 换算物理像素，相对当前左上角移动）
  winDrag.accX += e.screenX - winDrag.lastScreenX;
  winDrag.accY += e.screenY - winDrag.lastScreenY;
  winDrag.lastScreenX = e.screenX;
  winDrag.lastScreenY = e.screenY;
  if (winDrag.rafId !== null) return; // 上一帧待发送：增量已累计，避免高频 IPC
  winDrag.rafId = requestAnimationFrame(() => {
    const d = winDrag;
    if (!d) return;
    d.rafId = null;
    const dx = d.accX;
    const dy = d.accY;
    d.accX = 0;
    d.accY = 0;
    if (dx === 0 && dy === 0) return;
    // 后端不可用/最大化被后端拒绝时静默（纯浏览器调试场景）；失败不阻塞后续移动
    window.pywebview.api.win_move_relative(dx, dy).catch(() => {});
  });
}

function endWinDrag(): void {
  if (!winDrag) return;
  if (winDrag.rafId !== null) {
    cancelAnimationFrame(winDrag.rafId);
    winDrag.rafId = null;
  }
  winDrag = null;
  window.removeEventListener('mousemove', onWinDragMove);
  window.removeEventListener('mouseup', onWinDragUp);
  window.removeEventListener('blur', onWinDragBlur);
}

function onWinDragUp(): void {
  endWinDrag();
}

function onWinDragBlur(): void {
  endWinDrag();
}

function bindWindowControls(): void {
  // 三个窗口按钮：关闭按钮走 closeGuard（不得直连 win_close，否则关闭保护形同虚设）
  document.getElementById('win-min')!.addEventListener('click', () => { window.pywebview.api.win_minimize(); });
  document.getElementById('win-max')!.addEventListener('click', () => { void toggleMaximizeAndSyncIcon(); });
  document.getElementById('win-close')!.addEventListener('click', () => { void closeGuard.requestClose(); });

  const topbar = document.querySelector('.topbar') as HTMLElement;

  // 捕获阶段统一拦截顶栏 mousedown：无论 .pywebview-drag-region 类是否残留（旧 dist 兜底），
  // 都 stopPropagation 阻止冒泡到 body 上的官方 drag-region 监听，避免「双拖动」冲突。
  // 交互元素（输入框/按钮/右侧窗口按钮区）→ 仅拦截不拖动（click 是独立事件、input 聚焦是默认动作，均不受影响）；
  // 空白处 → 开始自实现拖动（B1）。只 stopPropagation、不 preventDefault（拖动真正开始时才 preventDefault）。
  topbar.addEventListener('mousedown', (e: MouseEvent) => {
    e.stopPropagation();
    const t = e.target as HTMLElement;
    if (t.closest('input, button, select, textarea, .topbar-right')) return;
    startWinDrag(e);
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
  // 批次 2：底部任务面板 + 右侧属性编辑器 + 结果查看器（编辑职责从 cmd-panel 迁入右侧栏）
  taskPanel.init();
  resultViewer.init();
  workflowLibrary.init();

  // 资产库索引（单一数据源）
  assetStore.init();
  // 资产库是跨项目的全局索引（<图片保存目录>/assets.json），不能等到
  // “打开已有项目”才恢复；否则启动后直接新建项目会误显示为空。
  await assetStore.loadFromBackend();

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

  // B-7：启动时从节点结果重建已知批次（打开项目时由 persistence.restore 再次重建）
  batchStore.rebuildFromNodes();

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
  await cmdPanel.refreshModels();
  void fillDefaultModels();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { void init(); });
} else {
  void init();
}
