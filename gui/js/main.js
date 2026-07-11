// js/main.js
// 应用入口：初始化所有模块、绑定全局事件
// ImageModal 模块已拆分至 image-modal.js
// ThemeManager 模块已拆分至 theme-manager.js
// ProjectManager 模块已拆分至 project-manager.js
// SelectionBox 模块已拆分至 selection-box.js
// Laser 模块已拆分至 laser-cutter.js
// 职责：模块协调、快捷键绑定、右键菜单、事件监听

(function () {

    // ─────────────────────────────────────────
    // 全局错误处理（桌面应用无控制台可看，必须兜底）
    // ─────────────────────────────────────────
    function _installGlobalErrorHandler() {
        window.addEventListener('error', (e) => {
            console.error('[Global Error]', e.message, e.filename, e.lineno, e.colno);
            if (window.Toast) {
                Toast.show('发生内部错误: ' + (e.message || '未知错误'), 4000);
            }
        });

        window.addEventListener('unhandledrejection', (e) => {
            console.error('[Unhandled Promise]', e.reason);
            const msg = e.reason?.message || String(e.reason || '异步操作失败');
            if (window.Toast) {
                Toast.show('异步错误: ' + msg, 4000);
            }
        });
    }

    // ─────────────────────────────────────────
    // 初始化所有模块
    // ─────────────────────────────────────────
    function init() {
        _installGlobalErrorHandler();  // 全局错误兜底

        Canvas.init();
        Minimap.init();
        LazyLoader.init();
        // 初始化时保存一个空快照（让用户可以 undo 到空白状态）
        CmdManager.clear();
        bindKeyboard();
        bindContextMenu();
        bindImageUpload();
        bindImageModal();
        bindCanvasEvents();
        bindColorPalette();
        bindFileDrop();
        HistorySidebar.init();
        HistorySidebar._bindCanvasDrop();
        initProjectNameButton();
        ThemeManager.init();
        ConnectionManager.init();
        AgentPanel.init();
        console.log('✅ Infinite Canvas 初始化完成');
    }

    // ─────────────────────────────────────────
    // 项目名称按钮（可编辑）
    // ─────────────────────────────────────────
    function initProjectNameButton() {
        const input = document.getElementById('project-name-input');
        if (!input) return;

        input.addEventListener('blur', () => {
            const val = input.value.trim() || '未命名项目';
            if (val !== input.dataset.prevValue) {
                CmdManager.execute(new ProjectNameCommand(val, input.dataset.prevValue || '未命名项目'));
            }
            input.value = val;
            input.dataset.prevValue = val;
        });
        // 记录初始值用于首次修改时保存旧值
        input.dataset.prevValue = input.value || '未命名项目';
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                input.blur();
            }
            e.stopPropagation();
        });
    }

    // ─────────────────────────────────────────
    // 全局键盘快捷键
    // ─────────────────────────────────────────
    function bindKeyboard() {
        window.addEventListener('keydown', (e) => {
            const tag      = document.activeElement.tagName.toLowerCase();
            const isTyping = tag === 'input' || tag === 'textarea';
            const isMeta   = e.ctrlKey || e.metaKey;

            // 输入框内不触发快捷键（除了保存）
            if (isTyping && !(isMeta && e.key === 's')) return;

            // Ctrl+Z 撤销
            if (isMeta && e.key === 'z' && !e.shiftKey) {
                e.preventDefault();

                // 策略：选中画板卡片时，始终使用画板的本地撤销
                // 理由：画板有自己的笔画级历史，全局快照不适合管理画板内容
                // 画板外操作（移动其他卡片等）交给全局 UndoRedo
                const selectedCardEl = document.querySelector('.card.selected, .card.multi-selected');
                if (selectedCardEl) {
                    const cardInstance = CardFactory.getInstance(selectedCardEl.id);
                    if (cardInstance?.hasLocalUndo?.()) {
                        // 画板有自己的撤销系统，优先使用
                        // card.undo() 返回 true 表示撤销成功（历史栈非空）
                        // card.undo() 返回 false 表示无可撤销（如刚初始化）
                        // 无论是否成功，都不再走全局历史（防止两套栈互相污染）
                        cardInstance.undo?.();
                        return;
                    }
                }

                // 非画板卡片或无可用本地历史 → 使用命令模式撤销
                CmdManager.undo();
                return;
            }

            // Ctrl+Y / Ctrl+Shift+Z 重做
            if (isMeta && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) {
                e.preventDefault();

                const selectedCardEl = document.querySelector('.card.selected, .card.multi-selected');
                if (selectedCardEl) {
                    const cardInstance = CardFactory.getInstance(selectedCardEl.id);
                    if (cardInstance?.hasLocalUndo?.()) {
                        cardInstance.redo?.();
                        return;
                    }
                }

                CmdManager.redo();
                return;
            }

            // Ctrl+C 复制
            if (isMeta && e.key === 'c') {
                e.preventDefault();
                Clipboard.copy();
                return;
            }

            // Ctrl+V 粘贴
            if (isMeta && e.key === 'v') {
                e.preventDefault();
                Clipboard.paste();
                return;
            }

            // Ctrl+S 保存
            if (isMeta && e.key === 's') {
                e.preventDefault();
                ProjectManager.save();
                return;
            }

            // Delete / Backspace 删除选中卡片
            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (isTyping) return;  // 输入框内不触发删除
                CardFactory.deleteSelected();
                return;
            }

            // Ctrl+G 创建分组
            if (isMeta && e.key === 'g') {
                e.preventDefault();
                if (window.GroupActions) {
                    GroupActions.createFromSelection();
                }
                return;
            }

            // ESC 关闭图片查看
            if (e.key === 'Escape') {
                ImageModal.close();
            }
        });
    }

    // ─────────────────────────────────────────
    // 右键菜单
    // ─────────────────────────────────────────
    function bindContextMenu() {
        const container  = document.getElementById('canvas-container');
        const canvasMenu = document.getElementById('canvas-menu');
        const cardMenu   = document.getElementById('card-context-menu');

        // 画布右键菜单
        container.addEventListener('contextmenu', (e) => {
            if (AppState.laser.justFinished) {
                e.preventDefault();
                AppState.laser.justFinished = false;
                return;
            }

            const isCard = e.target.closest('.card');
            if (isCard) {
                // 卡片右键菜单
                e.preventDefault();
                hideAllMenus();
                cardMenu.style.left    = e.clientX + 'px';
                cardMenu.style.top     = e.clientY + 'px';
                cardMenu.style.display = 'block';
            } else if (
                e.target === container ||
                e.target === document.getElementById('transform-layer')
            ) {
                // 画布空白右键菜单
                e.preventDefault();
                hideAllMenus();
                const pos = Canvas.toCanvasCoords(e.clientX, e.clientY);
                AppState.canvas.contextClickPos = pos;
                canvasMenu.style.left    = e.clientX + 'px';
                canvasMenu.style.top     = e.clientY + 'px';
                canvasMenu.style.display = 'block';
            }
        });

        // ★ 修复：排除所有面板和弹窗内的点击，避免干扰设置面板打开
        document.addEventListener('click', (e) => {
            if (
                e.target.closest('.settings-overlay')    ||
                e.target.closest('.modal-overlay')        ||
                e.target.closest('.add-provider-dialog')  ||
                e.target.closest('.prompt-library-popup') ||
                e.target.closest('#ui-layer')             ||
                e.target.closest('#right-sidebar')
            ) return;

            if (!e.target.closest('.context-menu')) {
                hideAllMenus();
            }
        });
    }

    function hideAllMenus() {
        document.querySelectorAll('.context-menu').forEach(m => {
            m.style.display = 'none';
        });
    }
    window.hideAllMenus = hideAllMenus;

    // ─────────────────────────────────────────
    // 图片上传
    // ─────────────────────────────────────────
    function bindImageUpload() {
        const input = document.getElementById('image-upload');
        input.addEventListener('change', function (e) {
            const file = e.target.files[0];
            if (!file || !AppState.cards.targetUploadCardId) return;

            const reader = new FileReader();
            reader.onload = (event) => {
                const cardId   = AppState.cards.targetUploadCardId;
                const instance = CardFactory.getInstance(cardId);
                if (!instance) return;

                const imgSrc = event.target.result;
                const imgObj = new Image();
                imgObj.src   = imgSrc;

                imgObj.onload = function () {
                    const ratio     = this.naturalHeight / this.naturalWidth;
                    const newWidth  = 240;
                    const newHeight = (newWidth * ratio) + 20;

                    const cardEl = document.getElementById(cardId);
                    if (cardEl) {
                        cardEl.style.width  = newWidth  + 'px';
                        cardEl.style.height = newHeight + 'px';
                    }

                    instance.setImage(imgSrc);

                    const titleInput = cardEl?.querySelector('.card-title-input');
                    if (titleInput && file.name) titleInput.value = file.name;
                };
            };
            reader.readAsDataURL(file);
            this.value = '';
        });
    }

    // ─────────────────────────────────────────
    // 图片大图查看
    // ─────────────────────────────────────────
    function bindImageModal() {
        const container = document.getElementById('canvas-container');
        const modal     = document.getElementById('image-modal');
        const modalImg  = document.getElementById('modal-image');
        const closeBtn  = modal.querySelector('.close-btn');

        container.addEventListener('dblclick', (e) => {
            const wrapper = e.target.closest('.image-card-wrapper');
            if (wrapper && wrapper.closest('.card')) {
                e.preventDefault();
                const img = wrapper.querySelector('.image-content');
                if (!img || !img.src) return;
                modal.style.display = 'flex';
                setTimeout(() => modal.classList.add('active'), 10);
                modalImg.src = img.src;
            }
        });

        closeBtn.onclick = ImageModal.close;

        modal.addEventListener('click', (e) => {
            if (e.target !== modal) return;
            ImageModal.close();
        });
    }

    // ─────────────────────────────────────────
    // 画布鼠标事件（框选 + 激光切割 + 点击取消选中）
    // ─────────────────────────────────────────
    function bindCanvasEvents() {
        const container = document.getElementById('canvas-container');

        container.addEventListener('mousedown', (e) => {
            if (e.target.closest('.context-menu')) return;

            const isCard    = e.target.closest('.card');
            const isTool    = e.target.closest('.toolbar');
            const isMinimap = e.target.closest('.minimap');
            const isUiLayer = e.target.closest('#ui-layer');
            const isSidebar = e.target.closest('#right-sidebar');

            hideAllMenus();

            if (!isCard && !isTool && !isMinimap && !isUiLayer && !isSidebar) {
                CardFactory.deselectAll();
            }

            if (e.button === 0 && e.shiftKey && !isCard) {
                e.preventDefault();
                SelectionBox.start(e);
                return;
            }

            if (e.button === 2 && e.ctrlKey) {
                Laser.start(e);
                return;
            }
        });

        window.addEventListener('mousemove', (e) => {
            SelectionBox.update(e);
            Laser.update(e);
        });

        window.addEventListener('mouseup', (e) => {
            SelectionBox.end(e);
            Laser.end(e);
        });
    }

    // ─────────────────────────────────────────
    // 颜色面板
    // ─────────────────────────────────────────
    function bindColorPalette() {
        const cardMenu = document.getElementById('card-context-menu');
        cardMenu.addEventListener('click', (e) => {
            const dot = e.target.closest('.color-dot');
            if (!dot) return;

            const color    = dot.dataset.color;
            const selected = document.querySelector(
                '.card.selected, .card.multi-selected'
            );
            if (selected) {
                const oldColor = selected.style.backgroundColor || '';
                CmdManager.execute(new PropertyChangeCommand(selected.id, 'backgroundColor', color, oldColor, '修改颜色'));
            }
            hideAllMenus();
        });
    }

    // ─────────────────────────────────────────
    // 文件拖放（图片 + .icproj 项目文件）
    // ─────────────────────────────────────────
    function bindFileDrop() {
        const container = document.getElementById('canvas-container');

        container.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect    = 'copy';
        container.style.outline      = '3px dashed var(--primary-color)';
        container.style.outlineOffset = '-10px';
        });

        container.addEventListener('dragleave', () => {
            container.style.outline      = '';
            container.style.outlineOffset = '';
        });

        container.addEventListener('drop', async (e) => {
            e.preventDefault();
            container.style.outline      = '';
            container.style.outlineOffset = '';

            const files = Array.from(e.dataTransfer.files);
            if (!files.length) return;

            // 优先处理项目文件
            const projectFile = files.find(f => f.name.endsWith('.icproj'));
            if (projectFile) {
                const reader = new FileReader();
                reader.onload = (ev) => {
                    try {
                        const data = JSON.parse(ev.target.result);
                        Storage.restoreCanvasData(data);
                        ProjectManager.updateTitle(projectFile.name);
                        Toast.show('项目已打开');
                    } catch {
                        Toast.show('无法解析项目文件');
                    }
                };
                reader.readAsText(projectFile);
                return;
            }

            // 处理图片文件
            const dropPos = Canvas.toCanvasCoords(e.clientX, e.clientY);
            let offsetX = 0, offsetY = 0;

            files.forEach((file) => {
                if (!file.type.startsWith('image/')) return;

                const reader = new FileReader();
                reader.onload = (ev) => {
                    const imgSrc = ev.target.result;
                    const imgObj = new Image();
                    imgObj.src   = imgSrc;

                    imgObj.onload = function () {
                        const ratio      = this.naturalHeight / this.naturalWidth;
                        const cardWidth  = 240;
                        const cardHeight = (cardWidth * ratio) + 20;

                        CardFactory.create('image', {
                            x:       dropPos.x + offsetX,
                            y:       dropPos.y + offsetY,
                            width:   cardWidth  + 'px',
                            height:  cardHeight + 'px',
                            content: imgSrc,
                            title:   file.name
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
    // 启动
    // ─────────────────────────────────────────
    window.addEventListener('DOMContentLoaded', init);

})();
