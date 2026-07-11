// js/core/clipboard.js
const Clipboard = {

    async copy() {
        const selectedCards = this._getSelectedCards();

        if (selectedCards.length === 0) {
            Toast.show('请先选中画布元素');
            return;
        }

        const selectedIds = selectedCards.map(c => c.id);

        const snapshot = SnapshotCollector.collect({
            sanitizeBase64: false,  // 复制时保留完整数据
            includeCanvas: false,
            selectedIds
        });

        try {
            const result = await API.copyToClipboard(snapshot);

            if (result.status === 'success') {
                Toast.show(`已复制 ${snapshot.cards.length} 个元素`);
            } else {
                Toast.show('复制失败: ' + result.message);
            }
        } catch (error) {
            Toast.show('复制失败');
            console.error('复制失败:', error);
        }
    },

    async paste() {
        try {
            const result = await API.pasteFromClipboard();
            console.log('paste result:', JSON.stringify(result));

            if (result.status !== 'success') {
                Toast.show(result.message);
                return;
            }

            const { cards: cardsData, connections: connectionsData } = result.data;

            if (!cardsData || cardsData.length === 0) {
                Toast.show('剪贴板中无可用元素');
                return;
            }

            const basePos = this._calcPastePosition(cardsData);
            const idMap   = {};

            // 使用命令模式的批量操作
            let compound = null;

            if (window.CmdManager) {
                compound = new CompoundCommand(`粘贴 ${cardsData.length} 个元素`);
                // 先压入空 compound 占位，等所有卡片创建完成后再更新
                CmdManager.undoStack.push(compound);
                CmdManager.redoStack = [];
            }

            const newCards = cardsData.map((cardData, index) => {
                const newId   = uid('card');
                idMap[cardData.id] = newId;

                const minX    = parseFloat(cardsData[0].left);
                const minY    = parseFloat(cardsData[0].top);
                const offsetX = parseFloat(cardData.left) - minX;
                const offsetY = parseFloat(cardData.top)  - minY;

                // saveHistory=false：不单独记录每个卡片的创建
                return CardFactory.create(cardData.type, {
                    id:       newId,
                    x:        basePos.x + offsetX,
                    y:        basePos.y + offsetY,
                    width:    cardData.width,
                    height:   cardData.height,
                    title:    cardData.title,
                    content:  cardData.content,
                    bg:       cardData.bg,
                    maskData: cardData.maskData || null
                }, false, { isPaste: true, pasteIndex: index });
            });

            setTimeout(() => {
                connectionsData?.forEach(conn => {
                    const newStart = idMap[conn.start];
                    const newEnd   = idMap[conn.end];
                    if (newStart && newEnd) {
                        ConnectionManager.create(newStart, newEnd, conn.endPort || null, false);
                        // 注册连线创建到复合命令
                        if (compound) {
                            compound.add(new CreateConnectionCommand(newStart, newEnd, conn.endPort));
                        }
                    }
                });

                // 更新 compound 的 undo/redo 方法（使用实际创建的卡片 ID）
                if (compound && newCards.length > 0) {
                    const pastedIds = newCards.filter(Boolean).map(c => c.id);

                    // 重写 undo：删除所有粘贴的卡片
                    compound.undo = () => {
                        for (const cid of pastedIds) {
                            const el = document.getElementById(cid);
                            if (!el) continue;
                            // 移除连线
                            AppState.connections.list
                                .filter(c => pastedIds.includes(c.start) && pastedIds.includes(c.end))
                                .forEach(c => { c.element?.remove(); });
                            AppState.connections.list = AppState.connections.list.filter(
                                c => !(pastedIds.includes(c.start) && pastedIds.includes(c.end))
                            );
                            CardFactory.destroyInstance(cid);
                            el.remove();
                        }
                        AppState.cards.multiSelected = [];
                        AppState.cards.activeCardId = null;
                        Minimap.scheduleUpdate();
                    };

                    // redo：暂时不支持（需要重新从剪贴板读取）
                    compound.redo = () => {
                        console.warn('[Clipboard] 粘贴操作暂不支持重做');
                    };
                }

                Minimap.scheduleUpdate();
            }, 50);

            AppState.ai.pasteOffsetX += AppState.ai.pasteOffsetStep;
            AppState.ai.pasteOffsetY += AppState.ai.pasteOffsetStep;
            if (AppState.ai.pasteOffsetX > AppState.ai.pasteOffsetMax) {
                AppState.ai.pasteOffsetX = 0;
                AppState.ai.pasteOffsetY = 0;
            }

            this._selectCards(newCards.filter(Boolean));
            Toast.show(`已粘贴 ${newCards.length} 个元素`);

        } catch (error) {
            Toast.show('粘贴失败');
            console.error('粘贴失败:', error);
        }
    },

    _getSelectedCards() {
        if (AppState.cards.multiSelected.length > 0) {
            return AppState.cards.multiSelected;
        }
        const single = document.querySelector('.card.selected');
        return single ? [single] : [];
    },

    _calcPastePosition(cardsData) {
        const { pasteOffsetX, pasteOffsetY } = AppState.ai;
        const { contextClickPos }            = AppState.canvas;

        let minX = Infinity, minY = Infinity;
        cardsData.forEach(c => {
            minX = Math.min(minX, parseFloat(c.left));
            minY = Math.min(minY, parseFloat(c.top));
        });

        let baseX, baseY;
        if (contextClickPos.x !== 0 || contextClickPos.y !== 0) {
            baseX = contextClickPos.x;
            baseY = contextClickPos.y;
        } else {
            const rect = Canvas.container.getBoundingClientRect();
            baseX = (rect.width  / 2 - AppState.canvas.panX) / AppState.canvas.scale;
            baseY = (rect.height / 2 - AppState.canvas.panY) / AppState.canvas.scale;
        }

        return {
            x: baseX + pasteOffsetX,
            y: baseY + pasteOffsetY
        };
    },

    // ── 修复：card 是卡片实例，DOM 元素在 card.element 上 ──────────────
    _selectCards(cards) {
        document.querySelectorAll('.card.selected, .card.multi-selected').forEach(c => {
            c.classList.remove('selected', 'multi-selected');
        });
        AppState.cards.multiSelected = [];

        cards.forEach(card => {
            if (!card || !card.element) return;
            const el = card.element;
            el.classList.add('multi-selected');
            AppState.cards.multiSelected.push(el);  // state 里统一存 DOM 元素
        });
    }
};

window.Clipboard = Clipboard;
