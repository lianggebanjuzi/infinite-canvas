// src/main.ts — Infinite Canvas 1.0 TypeScript 入口
// 渐进迁移：先导入已迁移的 TS 模块，逐步覆盖所有功能

// 图标字体随应用一起打包，确保桌面端离线可用。
import '@fortawesome/fontawesome-free/css/all.min.css';

// ─────────────────────────────────────────
// 0. 全局桥接（必须最先加载，解决 declare const 依赖）
// ─────────────────────────────────────────
import './bridge';

// ─────────────────────────────────────────
// 1. 导入已迁移的 TS 模块（自动桥接到 window）
// ─────────────────────────────────────────

// 状态管理
import './state/index';

// 工具函数
import './utils/index';

// UI 组件库（Toast 等）
import './ui/index';

// 核心引擎（命令系统、画布、剪贴板、快照等）
import './core/index';

// 卡片系统
import './cards/index';

// 服务层
import './services/index';

// UI 组件（设置面板、供应商、模型、提示词库、连线、小地图、历史侧边栏）
import './components/settings';
import './components/provider-panel';
import './components/model-panel';
import './components/prompt-library';
import './components/connection';
import './components/minimap';
import './components/history-sidebar';

// 独立模块（主题、图片查看器、项目管理、框选、激光切割）
import './independent/theme-manager';
import './independent/image-modal';
import './independent/project-manager';
import './independent/selection-box';
import './independent/laser-cutter';

// 分组模块
import './groups/GroupManager';
import './groups/GroupRenderer';
import './groups/GroupExecutor';
import './groups/group-actions';

// Agent 对话面板
import './independent/agent-panel';

// ─────────────────────────────────────────
// 2. pywebview 就绪等待
// ─────────────────────────────────────────
function waitForPywebview(): Promise<void> {
    return new Promise((resolve) => {
        if ((window as unknown as { pywebview?: unknown }).pywebview) {
            resolve();
        } else {
            window.addEventListener('pywebviewready', () => resolve(), { once: true });
            // 兜底：3 秒后无论如何继续
            setTimeout(() => resolve(), 3000);
        }
    });
}

// ─────────────────────────────────────────
// 3. 全局错误处理
// ─────────────────────────────────────────
function installGlobalErrorHandler(): void {
    window.addEventListener('error', (e) => {
        console.error('[Global Error]', e.message, e.filename, e.lineno, e.colno);
        const win = window as unknown as { Toast?: { show: (msg: string, dur?: number) => void } };
        if (win.Toast) {
            win.Toast.show('发生内部错误: ' + (e.message || '未知错误'), 4000);
        }
    });

    window.addEventListener('unhandledrejection', (e) => {
        console.error('[Unhandled Promise]', e.reason);
        const msg = e.reason?.message || String(e.reason || '异步操作失败');
        const win = window as unknown as { Toast?: { show: (msg: string, dur?: number) => void } };
        if (win.Toast) {
            win.Toast.show('异步错误: ' + msg, 4000);
        }
    });
}

// ─────────────────────────────────────────
// 4. 键盘快捷键
// ─────────────────────────────────────────
function bindKeyboard(): void {
    window.addEventListener('keydown', (e) => {
        const tag = (document.activeElement?.tagName || '').toLowerCase();
        const isTyping = tag === 'input' || tag === 'textarea';
        const isMeta = e.ctrlKey || e.metaKey;
        const win = window as unknown as Record<string, unknown>;

        if (isTyping && !(isMeta && e.key === 's')) return;

        // Ctrl+Z 撤销
        if (isMeta && e.key === 'z' && !e.shiftKey) {
            e.preventDefault();
            const CmdManager = win.CmdManager as { undo: () => void; redo: () => void } | undefined;
            const CardFactory = win.CardFactory as {
                getInstance: (id: string) => { hasLocalUndo?: () => boolean; undo?: () => void } | undefined;
            } | undefined;

            const selectedCardEl = document.querySelector('.card.selected, .card.multi-selected');
            if (selectedCardEl && CardFactory) {
                const cardInstance = CardFactory.getInstance(selectedCardEl.id);
                if (cardInstance?.hasLocalUndo?.()) {
                    cardInstance.undo?.();
                    return;
                }
            }
            CmdManager?.undo();
            return;
        }

        // Ctrl+Y / Ctrl+Shift+Z 重做
        if (isMeta && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) {
            e.preventDefault();
            const CmdManager = win.CmdManager as { undo: () => void; redo: () => void } | undefined;
            const CardFactory = win.CardFactory as {
                getInstance: (id: string) => { hasLocalUndo?: () => boolean; redo?: () => void } | undefined;
            } | undefined;

            const selectedCardEl = document.querySelector('.card.selected, .card.multi-selected');
            if (selectedCardEl && CardFactory) {
                const cardInstance = CardFactory.getInstance(selectedCardEl.id);
                if (cardInstance?.hasLocalUndo?.()) {
                    cardInstance.redo?.();
                    return;
                }
            }
            CmdManager?.redo();
            return;
        }

        // Ctrl+C 复制
        if (isMeta && e.key === 'c') {
            e.preventDefault();
            (win.Clipboard as { copy: () => void } | undefined)?.copy();
            return;
        }

        // Ctrl+V 粘贴
        if (isMeta && e.key === 'v') {
            e.preventDefault();
            (win.Clipboard as { paste: () => void } | undefined)?.paste();
            return;
        }

        // Ctrl+S 保存
        if (isMeta && e.key === 's') {
            e.preventDefault();
            (win.ProjectManager as { save: () => void } | undefined)?.save();
            return;
        }

        // Delete / Backspace
        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (isTyping) return;
            (win.CardFactory as { deleteSelected: () => void } | undefined)?.deleteSelected();
            return;
        }

        // Ctrl+G 创建分组
        if (isMeta && e.key === 'g') {
            e.preventDefault();
            (win.GroupActions as { createFromSelection: () => void } | undefined)?.createFromSelection();
            return;
        }

        // ESC 关闭图片查看
        if (e.key === 'Escape') {
            (win.ImageModal as { close: () => void } | undefined)?.close();
        }
    });
}

// ─────────────────────────────────────────
// 5. 右键菜单
// ─────────────────────────────────────────
function bindContextMenu(): void {
    const container = document.getElementById('canvas-container');
    const canvasMenu = document.getElementById('canvas-menu');
    const cardMenu = document.getElementById('card-context-menu');
    if (!container || !canvasMenu || !cardMenu) return;

    const win = window as unknown as Record<string, unknown>;

    container.addEventListener('contextmenu', (e) => {
        const AppState = win.AppState as { laser: { justFinished: boolean }; canvas: { contextClickPos: { x: number; y: number } } } | undefined;

        if (AppState?.laser?.justFinished) {
            e.preventDefault();
            AppState.laser.justFinished = false;
            return;
        }

        const isCard = e.target instanceof Element && e.target.closest('.card');
        if (isCard) {
            e.preventDefault();
            hideAllMenus();
            cardMenu.style.left = e.clientX + 'px';
            cardMenu.style.top = e.clientY + 'px';
            cardMenu.style.display = 'block';
        } else if (
            e.target === container ||
            (e.target instanceof Element && e.target.id === 'transform-layer')
        ) {
            e.preventDefault();
            hideAllMenus();
            const Canvas = win.Canvas as { toCanvasCoords: (x: number, y: number) => { x: number; y: number } } | undefined;
            if (Canvas && AppState) {
                const pos = Canvas.toCanvasCoords(e.clientX, e.clientY);
                AppState.canvas.contextClickPos = pos;
            }
            canvasMenu.style.left = e.clientX + 'px';
            canvasMenu.style.top = e.clientY + 'px';
            canvasMenu.style.display = 'block';
        }
    });

    document.addEventListener('click', (e) => {
        if (!(e.target instanceof Element)) return;
        if (
            e.target.closest('.settings-overlay') ||
            e.target.closest('.modal-overlay') ||
            e.target.closest('.add-provider-dialog') ||
            e.target.closest('.prompt-library-popup') ||
            e.target.closest('#ui-layer') ||
            e.target.closest('#right-sidebar')
        ) return;

        if (!e.target.closest('.context-menu')) {
            hideAllMenus();
        }
    });
}

function hideAllMenus(): void {
    document.querySelectorAll('.context-menu').forEach(m => {
        (m as HTMLElement).style.display = 'none';
    });
}

// 桥接到 window，供分组模块等外部调用
(window as unknown as Record<string, unknown>).hideAllMenus = hideAllMenus;

// ─────────────────────────────────────────
// 6. 图片上传
// ─────────────────────────────────────────
function bindImageUpload(): void {
    const input = document.getElementById('image-upload') as HTMLInputElement | null;
    if (!input) return;

    input.addEventListener('change', (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        const win = window as unknown as Record<string, unknown>;
        const AppState = win.AppState as { cards: { targetUploadCardId: string } } | undefined;
        if (!file || !AppState?.cards?.targetUploadCardId) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            const cardId = AppState.cards.targetUploadCardId;
            const CardFactory = win.CardFactory as {
                getInstance: (id: string) => { setImage: (src: string) => void } | undefined;
            } | undefined;
            const instance = CardFactory?.getInstance(cardId);
            if (!instance) return;

            const imgSrc = event.target?.result as string;
            const imgObj = new Image();
            imgObj.src = imgSrc;

            imgObj.onload = () => {
                const ratio = imgObj.naturalHeight / imgObj.naturalWidth;
                const newWidth = 240;
                const newHeight = (newWidth * ratio) + 20;

                const cardEl = document.getElementById(cardId);
                if (cardEl) {
                    cardEl.style.width = newWidth + 'px';
                    cardEl.style.height = newHeight + 'px';
                }

                instance.setImage(imgSrc);

                const titleInput = cardEl?.querySelector('.card-title-input') as HTMLInputElement | null;
                if (titleInput && file.name) titleInput.value = file.name;
            };
        };
        reader.readAsDataURL(file);
        input.value = '';
    });
}

// ─────────────────────────────────────────
// 7. 图片大图查看
// ─────────────────────────────────────────
function bindImageModal(): void {
    const container = document.getElementById('canvas-container');
    const modal = document.getElementById('image-modal');
    const modalImg = document.getElementById('modal-image') as HTMLImageElement | null;
    const closeBtn = modal?.querySelector('.close-btn');
    if (!container || !modal || !modalImg || !closeBtn) return;

    const win = window as unknown as Record<string, unknown>;

    container.addEventListener('dblclick', (e) => {
        if (!(e.target instanceof Element)) return;
        const wrapper = e.target.closest('.image-card-wrapper');
        if (wrapper && wrapper.closest('.card')) {
            e.preventDefault();
            const img = wrapper.querySelector('.image-content') as HTMLImageElement | null;
            if (!img?.src) return;
            modal.style.display = 'flex';
            setTimeout(() => modal.classList.add('active'), 10);
            modalImg.src = img.src;
        }
    });

    closeBtn.addEventListener('click', () => {
        (win.ImageModal as { close: () => void } | undefined)?.close();
    });

    modal.addEventListener('click', (e) => {
        if (e.target !== modal) return;
        (win.ImageModal as { close: () => void } | undefined)?.close();
    });
}

// ─────────────────────────────────────────
// 8. 画布鼠标事件
// ─────────────────────────────────────────
function bindCanvasEvents(): void {
    const container = document.getElementById('canvas-container');
    if (!container) return;

    const win = window as unknown as Record<string, unknown>;

    container.addEventListener('mousedown', (e) => {
        if (!(e.target instanceof Element) || e.target.closest('.context-menu')) return;

        const isCard = e.target.closest('.card');
        const isTool = e.target.closest('.toolbar');
        const isMinimap = e.target.closest('.minimap');
        const isUiLayer = e.target.closest('#ui-layer');
        const isSidebar = e.target.closest('#right-sidebar');

        hideAllMenus();

        if (!isCard && !isTool && !isMinimap && !isUiLayer && !isSidebar) {
            (win.CardFactory as { deselectAll: () => void } | undefined)?.deselectAll();
        }

        if (e.button === 0 && e.shiftKey && !isCard) {
            e.preventDefault();
            (win.SelectionBox as { start: (e: MouseEvent) => void } | undefined)?.start(e);
            return;
        }

        if (e.button === 2 && e.ctrlKey) {
            (win.Laser as { start: (e: MouseEvent) => void } | undefined)?.start(e);
            return;
        }
    });

    window.addEventListener('mousemove', (e) => {
        (win.SelectionBox as { update: (e: MouseEvent) => void } | undefined)?.update(e);
        (win.Laser as { update: (e: MouseEvent) => void } | undefined)?.update(e);
    });

    window.addEventListener('mouseup', (e) => {
        (win.SelectionBox as { end: (e: MouseEvent) => void } | undefined)?.end(e);
        (win.Laser as { end: (e: MouseEvent) => void } | undefined)?.end(e);
    });
}

// ─────────────────────────────────────────
// 9. 颜色面板
// ─────────────────────────────────────────
function bindColorPalette(): void {
    const cardMenu = document.getElementById('card-context-menu');
    if (!cardMenu) return;

    cardMenu.addEventListener('click', (e) => {
        if (!(e.target instanceof Element)) return;
        const dot = e.target.closest('.color-dot') as HTMLElement | null;
        if (!dot) return;

        const color = dot.dataset.color || '';
        const selected = document.querySelector('.card.selected, .card.multi-selected') as HTMLElement | null;
        if (selected) {
            const oldColor = selected.style.backgroundColor || '';
            const win = window as unknown as Record<string, unknown>;
            const CmdManager = win.CmdManager as {
                execute: (cmd: unknown) => void;
            } | undefined;
            const PropertyChangeCommand = win.PropertyChangeCommand as new (id: string, prop: string, newVal: string, oldVal: string, label: string) => unknown;
            if (CmdManager && PropertyChangeCommand) {
                CmdManager.execute(new PropertyChangeCommand(selected.id, 'backgroundColor', color, oldColor, '修改颜色'));
            }
        }
        hideAllMenus();
    });
}

// ─────────────────────────────────────────
// 10. 文件拖放
// ─────────────────────────────────────────
function bindFileDrop(): void {
    const container = document.getElementById('canvas-container');
    if (!container) return;

    const win = window as unknown as Record<string, unknown>;

    container.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'copy';
        container.style.outline = '3px dashed var(--primary-color)';
        container.style.outlineOffset = '-10px';
    });

    container.addEventListener('dragleave', () => {
        container.style.outline = '';
        container.style.outlineOffset = '';
    });

    container.addEventListener('drop', async (e) => {
        e.preventDefault();
        container.style.outline = '';
        container.style.outlineOffset = '';

        const files = Array.from(e.dataTransfer?.files || []);
        if (!files.length) return;

        // 优先处理项目文件
        const projectFile = files.find(f => f.name.endsWith('.icproj'));
        if (projectFile) {
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    const data = JSON.parse(ev.target?.result as string);
                    (win.Storage as { restoreCanvasData: (data: unknown) => void } | undefined)?.restoreCanvasData(data);
                    (win.ProjectManager as { updateTitle: (name: string) => void } | undefined)?.updateTitle(projectFile.name);
                    (win.Toast as { show: (msg: string) => void } | undefined)?.show('项目已打开');
                } catch {
                    (win.Toast as { show: (msg: string) => void } | undefined)?.show('无法解析项目文件');
                }
            };
            reader.readAsText(projectFile);
            return;
        }

        // 处理图片文件
        const Canvas = win.Canvas as { toCanvasCoords: (x: number, y: number) => { x: number; y: number } } | undefined;
        const dropPos = Canvas?.toCanvasCoords(e.clientX, e.clientY) || { x: 0, y: 0 };
        let offsetX = 0, offsetY = 0;

        const CardFactory = win.CardFactory as {
            create: (type: string, opts: Record<string, unknown>) => unknown;
        } | undefined;

        files.forEach((file) => {
            if (!file.type.startsWith('image/')) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                const imgSrc = ev.target?.result as string;
                const imgObj = new Image();
                imgObj.src = imgSrc;

                imgObj.onload = () => {
                    const ratio = imgObj.naturalHeight / imgObj.naturalWidth;
                    const cardWidth = 240;
                    const cardHeight = (cardWidth * ratio) + 20;

                    CardFactory?.create('image', {
                        x: dropPos.x + offsetX,
                        y: dropPos.y + offsetY,
                        width: cardWidth + 'px',
                        height: cardHeight + 'px',
                        content: imgSrc,
                        title: file.name,
                    });

                    offsetX += 260;
                    if (offsetX > 780) { offsetX = 0; offsetY += 200; }
                };
            };
            reader.readAsDataURL(file);
        });
    });
}

// ─────────────────────────────────────────
// 11. 项目名称编辑
// ─────────────────────────────────────────
function initProjectNameButton(): void {
    const input = document.getElementById('project-name-input') as HTMLInputElement | null;
    if (!input) return;

    input.addEventListener('blur', () => {
        const val = input.value.trim() || '未命名项目';
        if (val !== input.dataset.prevValue) {
            const win = window as unknown as Record<string, unknown>;
            const CmdManager = win.CmdManager as { execute: (cmd: unknown) => void } | undefined;
            const ProjectNameCommand = win.ProjectNameCommand as new (newName: string, oldName: string) => unknown;
            if (CmdManager && ProjectNameCommand) {
                CmdManager.execute(new ProjectNameCommand(val, input.dataset.prevValue || '未命名项目'));
            }
        }
        input.value = val;
        input.dataset.prevValue = val;
    });

    input.dataset.prevValue = input.value || '未命名项目';

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            input.blur();
        }
        e.stopPropagation();
    });
}

// ─────────────────────────────────────────
// 12. 事件绑定（用于替换 onclick 属性）
// ─────────────────────────────────────────
function bindToolbarEvents(): void {
    const win = window as unknown as Record<string, unknown>;

    document.getElementById('btn-save')?.addEventListener('click', () => {
        (win.ProjectManager as { save: () => void } | undefined)?.save();
    });
    document.getElementById('btn-save-as')?.addEventListener('click', () => {
        (win.ProjectManager as { saveAs: () => void } | undefined)?.saveAs();
    });
    document.getElementById('btn-open')?.addEventListener('click', () => {
        (win.ProjectManager as { open: () => void } | undefined)?.open();
    });
    document.getElementById('btn-new')?.addEventListener('click', () => {
        (win.ProjectManager as { new: () => void } | undefined)?.new();
    });
    document.getElementById('btn-settings')?.addEventListener('click', () => {
        (win.SettingsPanel as { open: () => void } | undefined)?.open();
    });
    document.getElementById('theme-toggle-btn')?.addEventListener('click', () => {
        (win.ThemeManager as { toggle: () => void } | undefined)?.toggle();
    });
    document.getElementById('minimap-toggle-btn')?.addEventListener('click', () => {
        (win.Minimap as { toggle: () => void } | undefined)?.toggle();
    });
    document.getElementById('btn-close-settings')?.addEventListener('click', () => {
        (win.SettingsPanel as { close: () => void } | undefined)?.close();
    });
    document.getElementById('btn-add-provider')?.addEventListener('click', () => {
        (win.ProviderPanel as { openAddDialog: () => void } | undefined)?.openAddDialog();
    });
    document.getElementById('btn-cancel-add-provider')?.addEventListener('click', () => {
        (win.ProviderPanel as { closeAddDialog: () => void } | undefined)?.closeAddDialog();
    });
    document.getElementById('btn-confirm-add-provider')?.addEventListener('click', () => {
        (win.ProviderPanel as { confirmAdd: () => void } | undefined)?.confirmAdd();
    });
    document.getElementById('btn-delete-provider')?.addEventListener('click', () => {
        (win.ProviderPanel as { deleteCurrent: () => void } | undefined)?.deleteCurrent();
    });
    document.getElementById('btn-close-provider-detail')?.addEventListener('click', () => {
        (win.ProviderPanel as { closeDetail: () => void } | undefined)?.closeDetail();
    });
    document.getElementById('btn-close-model-manager')?.addEventListener('click', () => {
        (win.ModelPanel as { close: () => void } | undefined)?.close();
    });
    document.getElementById('agent-panel-toggle')?.addEventListener('click', () => {
        (win.AgentPanel as { toggle: () => void } | undefined)?.toggle();
    });

    // 设置面板标签切换
    document.querySelectorAll('.settings-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const tabName = (tab as HTMLElement).dataset.tab;
            if (tabName) {
                (win.SettingsPanel as { switchTab: (name: string) => void } | undefined)?.switchTab(tabName);
            }
        });
    });

    // 上下文菜单操作
    document.getElementById('canvas-menu')?.addEventListener('click', (e) => {
        if (!(e.target instanceof Element)) return;
        const item = e.target.closest('.menu-item') as HTMLElement | null;
        if (!item?.dataset.action) return;
        const action = item.dataset.action;
        const ConnectionManager = win.ConnectionManager as {
            createCardAndConnect?: (type: string) => void;
        } | undefined;

        switch (action) {
            case 'create-text-card': ConnectionManager?.createCardAndConnect?.('text'); break;
            case 'create-image-card': ConnectionManager?.createCardAndConnect?.('image'); break;
            case 'create-ai-image-card': ConnectionManager?.createCardAndConnect?.('ai-image'); break;
            case 'create-drawing-board-card': ConnectionManager?.createCardAndConnect?.('drawing-board'); break;
            case 'create-preview-card': ConnectionManager?.createCardAndConnect?.('preview'); break;
            case 'create-agent-card': ConnectionManager?.createCardAndConnect?.('agent'); break;
            case 'create-compare-card': ConnectionManager?.createCardAndConnect?.('compare'); break;
            case 'paste': (win.Clipboard as { paste: () => void } | undefined)?.paste(); break;
        }
    });

    document.getElementById('card-context-menu')?.addEventListener('click', (e) => {
        if (!(e.target instanceof Element)) return;
        const item = e.target.closest('.menu-item') as HTMLElement | null;
        if (!item?.dataset.action) return;
        const action = item.dataset.action;

        switch (action) {
            case 'copy': (win.Clipboard as { copy: () => void } | undefined)?.copy(); break;
            case 'paste': (win.Clipboard as { paste: () => void } | undefined)?.paste(); break;
            case 'delete': (win.CardFactory as { deleteSelected: () => void } | undefined)?.deleteSelected(); break;
            case 'create-group': (win.GroupActions as { createFromSelection: () => void } | undefined)?.createFromSelection(); break;
        }
    });
}

// ─────────────────────────────────────────
// 13. 主初始化
// ─────────────────────────────────────────
async function init(): Promise<void> {
    installGlobalErrorHandler();

    // 先绑定 UI 事件（不需要 pywebview API，避免 3 秒延迟）
    bindKeyboard();
    bindContextMenu();
    bindImageUpload();
    bindImageModal();
    bindCanvasEvents();
    bindColorPalette();
    bindFileDrop();
    bindToolbarEvents();
    initProjectNameButton();

    // 等待 pywebview API 就绪
    await waitForPywebview();

    // 初始化已迁移的 TS 模块（需要 pywebview API）
    const win = window as unknown as Record<string, unknown>;

    // Canvas 初始化
    (win.Canvas as { init: () => void } | undefined)?.init();

    // Minimap（如果已迁移或通过 window 桥接可用）
    (win.Minimap as { init: () => void } | undefined)?.init();

    // LazyLoader
    (win.LazyLoader as { init: () => void } | undefined)?.init();

    // 命令管理器初始化空白快照
    (win.CmdManager as { clear: () => void } | undefined)?.clear();

    // 事件绑定（已在 waitForPywebview 之前完成）

    // 初始化 HistorySidebar（如已迁移）
    const HistorySidebar = win.HistorySidebar as { init: () => void; _bindCanvasDrop: () => void } | undefined;
    HistorySidebar?.init();
    HistorySidebar?._bindCanvasDrop?.();

    // ThemeManager
    (win.ThemeManager as { init: () => void } | undefined)?.init();

    // ConnectionManager
    (win.ConnectionManager as { init: () => void } | undefined)?.init();

    // AgentPanel
    (win.AgentPanel as { init: () => void } | undefined)?.init();

    console.log('✅ Infinite Canvas 1.0 (TypeScript) 初始化完成');
}

// ─────────────────────────────────────────
// 启动
// ─────────────────────────────────────────
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init(); });
} else {
    init();
}
