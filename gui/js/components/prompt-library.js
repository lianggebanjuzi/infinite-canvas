// gui/js/components/prompt-library.js
// 提示词库管理器：UI组件版（UIInput/UITextarea）
// 负责 UI 浮层展示，增删操作委托给 PromptService

const PromptLibrary = {

    /**
     * @param {Event}    triggerEvent  - 触发按钮的点击事件
     * @param {string}   category      - 'common' | 'skill' | 'draw'
     * @param {Function} onSelect      - 选中回调 (item) => void
     */
    async open(triggerEvent, category, onSelect) {
        triggerEvent.stopPropagation();

        const existing = document.querySelector('.prompt-library-popup');
        if (existing) { existing.remove(); return; }

        const btn  = triggerEvent.currentTarget;
        const rect = btn.getBoundingClientRect();

        // 通过 service 获取数据
        const items = await PromptService.getItems(category);

        const titleMap = {
            common: '常用提示词库',
            skill:  'Skill 库',
            draw:   '绘图提示词库'
        };

        const popup     = document.createElement('div');
        popup.className = 'prompt-library-popup';

        const popupWidth  = 300;
        const popupHeight = 380;
        let   left        = rect.left;
        let   top         = rect.bottom + 6;

        if (left + popupWidth  > window.innerWidth  - 12)
            left = window.innerWidth  - popupWidth  - 12;
        if (top  + popupHeight > window.innerHeight - 12)
            top  = rect.top - popupHeight - 6;

        popup.style.left  = `${left}px`;
        popup.style.top   = `${top}px`;
        popup.style.width = `${popupWidth}px`;

        // ── Header ──
        const header     = document.createElement('div');
        header.className = 'prompt-library-header';
        header.innerHTML = `
            <span class="prompt-library-title">${titleMap[category] || category}</span>
            <button class="prompt-library-close" title="关闭">&times;</button>
        `;
        header.querySelector('.prompt-library-close')
              .addEventListener('click', () => popup.remove());

        // ── 列表 ──
        const listWrap     = document.createElement('div');
        listWrap.className = 'prompt-library-list';

        const renderList = (itemsToRender) => {
            listWrap.innerHTML = '';
            if (itemsToRender.length === 0) {
                listWrap.innerHTML =
                    '<div class="prompt-library-empty">暂无内容，点击下方按钮添加</div>';
                return;
            }

            itemsToRender.forEach(item => {
                const row     = document.createElement('div');
                row.className = 'prompt-library-item';
                row.innerHTML = `
                    <div class="prompt-library-item-body">
                        <div class="prompt-library-item-name">${item.name}</div>
                        <div class="prompt-library-item-preview">${item.content}</div>
                    </div>
                    <button class="prompt-library-item-del"
                            title="删除" data-id="${item.id}">
                        <i class="fas fa-times"></i>
                    </button>
                `;

                row.querySelector('.prompt-library-item-body')
                   .addEventListener('click', () => {
                       onSelect(item);
                       popup.remove();
                       Toast.show(`已插入：${item.name}`);
                   });

                row.querySelector('.prompt-library-item-del')
                   .addEventListener('click', async (e) => {
                       e.stopPropagation();
                       if (!confirm(`确定删除「${item.name}」吗？`)) return;
                       await PromptService.removeItem(category, item.id);
                       const updated = await PromptService.getItems(category);
                       renderList(updated);
                   });

                listWrap.appendChild(row);
            });
        };

        renderList(items);

        // ── 添加区域 ──
        const addWrap     = document.createElement('div');
        addWrap.className = 'prompt-library-add-wrap';

        const addBtn     = document.createElement('button');
        addBtn.className = 'prompt-library-add-btn';
        addBtn.innerHTML = '<i class="fas fa-plus"></i> 添加自定义';

        addBtn.addEventListener('click', () => {
            const existing = addWrap.querySelector('.prompt-library-add-form');
            if (existing) { existing.remove(); return; }

            const form     = document.createElement('div');
            form.className = 'prompt-library-add-form';

            const contentInput = window.UITextarea({
                placeholder: '提示词内容...',
                rows: 3,
            });
            contentInput.element.querySelector('textarea')
                .classList.add('prompt-library-add-textarea');

            const nameInput = window.UIInput({
                type: 'text',
                placeholder: '名称，例如：电商文案',
                onEnter: () => contentInput.focus(),
            });
            nameInput.input.classList.add('prompt-library-add-input');

            const formActions     = document.createElement('div');
            formActions.className = 'prompt-library-add-actions';

            const cancelBtn     = document.createElement('button');
            cancelBtn.className = 'btn-cancel';
            cancelBtn.textContent = '取消';
            cancelBtn.addEventListener('click', () => form.remove());

            const confirmBtn     = document.createElement('button');
            confirmBtn.className = 'btn-confirm';
            confirmBtn.textContent = '添加';
            confirmBtn.addEventListener('click', async () => {
                const name    = nameInput.value.trim();
                const content = contentInput.value.trim();

                if (!name)    { Toast.show('请输入名称');   nameInput.focus();    return; }
                if (!content) { Toast.show('请输入提示词内容'); contentInput.focus(); return; }

                confirmBtn.disabled     = true;
                confirmBtn.textContent  = '保存中...';

                await PromptService.addItem(category, name, content);

                const updated = await PromptService.getItems(category);
                renderList(updated);
                form.remove();
                Toast.show(`已添加：${name}`);
            });

            formActions.appendChild(cancelBtn);
            formActions.appendChild(confirmBtn);
            form.appendChild(nameInput.element);
            form.appendChild(contentInput.element);
            form.appendChild(formActions);
            addWrap.appendChild(form);

            setTimeout(() => nameInput.focus(), 30);
        });

        addWrap.appendChild(addBtn);

        popup.appendChild(header);
        popup.appendChild(listWrap);
        popup.appendChild(addWrap);
        document.body.appendChild(popup);

        // 点击外部关闭（排除表单内部点击）
        setTimeout(() => {
            document.addEventListener('click', function close(e) {
                if (!popup.contains(e.target)) {
                    popup.remove();
                    document.removeEventListener('click', close);
                }
            });
        }, 0);
    }
};

window.PromptLibrary = PromptLibrary;
