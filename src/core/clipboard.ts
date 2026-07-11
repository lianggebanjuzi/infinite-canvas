// src/core/clipboard.ts
// 剪贴板：复制、粘贴

import type { Command } from './command-base';
import { CompoundCommand } from './command-base';
import { SnapshotCollector } from './snapshot';
import { AppState } from '../state/app-state';

declare const Toast: { show(message: string, duration?: number): void };
declare const uid: (prefix: string) => string;
declare const Canvas: { container: HTMLElement | null };
declare const Minimap: { scheduleUpdate(): void };

declare const CardFactory: {
    create(type: string, options: Record<string, unknown>, saveHistory?: boolean, extra?: Record<string, unknown>): { id: string; element: HTMLElement } | null;
    destroyInstance(id: string): void;
};

declare const ConnectionManager: {
    create(startId: string, endId: string, endPort: string | null, saveHistory: boolean): { id: string } | null;
    updateCardConnections(id: string): void;
};

declare const CreateConnectionCommand: new (startId: string, endId: string, endPort: string | null) => Command;

export const Clipboard = {

    async copy(): Promise<void> {
        const selectedCards = this._getSelectedCards();

        if (selectedCards.length === 0) {
            Toast.show('请先选中画布元素');
            return;
        }

        const selectedIds = selectedCards.map(c => c.id);

        const snapshot = SnapshotCollector.collect({
            sanitizeBase64: false,
            includeCanvas: false,
            selectedIds
        });

        try {
            const result = await (window as unknown as {
                API: { copyToClipboard(data: unknown): Promise<{ status: string }> }
            }).API.copyToClipboard(snapshot) as { status: string };

            if (result.status === 'success') {
                Toast.show(`已复制 ${snapshot.cards.length} 个元素`);
            } else {
                Toast.show(`复制失败: ${(result as Record<string, string>).message || ''}`);
            }
        } catch (error) {
            Toast.show('复制失败: ' + (error instanceof Error ? error.message : ''));
            console.error('复制失败:', error);
        }
    },

    async paste(): Promise<void> {
        try {
            const result = await (window as unknown as {
                API: { pasteFromClipboard(): Promise<{ status?: string; message?: string; data?: { cards?: unknown[]; connections?: unknown[] } }> }
            }).API.pasteFromClipboard() as { status?: string; message?: string; data?: { cards?: unknown[]; connections?: unknown[] } };

            if (result.status !== 'success') {
                Toast.show(result.message || '粘贴失败');
                return;
            }

            const { cards: cardsData, connections: connectionsData } = result.data || {};

            if (!cardsData || cardsData.length === 0) {
                Toast.show('剪贴板中无可用元素');
                return;
            }

            const basePos = this._calcPastePosition(cardsData as Array<{ left: string; top: string }>);
            const idMap: Record<string, string> = {};

            let compound: CompoundCommand | null = null;
            if ((window as unknown as { CmdManager?: { undoStack: Command[]; redoStack: Command[] } }).CmdManager) {
                compound = new CompoundCommand(`粘贴 ${(cardsData as unknown[]).length} 个元素`);
                (window as unknown as { CmdManager: { undoStack: Command[]; redoStack: Command[] } }).CmdManager.undoStack.push(compound);
                (window as unknown as { CmdManager: { undoStack: Command[]; redoStack: Command[] } }).CmdManager.redoStack = [];
            }

            const newCards = (cardsData as Array<{
                id: string; type: string; left: string; top: string;
                width: string; height: string; title: string; content: string; bg: string; maskData?: unknown;
            }>).map((cardData, index) => {
                const newId   = uid('card');
                idMap[cardData.id] = newId;

                const minX    = parseFloat((cardsData as Array<{ left: string }>)[0].left);
                const minY    = parseFloat((cardsData as Array<{ top: string }>)[0].top);
                const offsetX = parseFloat(cardData.left) - minX;
                const offsetY = parseFloat(cardData.top)  - minY;

                return CardFactory.create(cardData.type, {
                    id: newId,
                    x: basePos.x + offsetX,
                    y: basePos.y + offsetY,
                    width: cardData.width,
                    height: cardData.height,
                    title: cardData.title,
                    content: cardData.content,
                    bg: cardData.bg,
                    maskData: cardData.maskData || null
                }, false, { isPaste: true, pasteIndex: index });
            });

            setTimeout(() => {
                (connectionsData as Array<{
                    start: string; end: string; endPort?: string;
                }> | undefined)?.forEach(conn => {
                    const newStart = idMap[conn.start];
                    const newEnd   = idMap[conn.end];
                    if (newStart && newEnd) {
                        ConnectionManager.create(newStart, newEnd, conn.endPort || null, false);
                        if (compound && CreateConnectionCommand) {
                            compound.add(new CreateConnectionCommand(newStart, newEnd, conn.endPort || null));
                        }
                    }
                });

                if (compound && newCards.length > 0) {
                    const pastedIds = newCards.filter(Boolean).map(c => (c as { id: string }).id);

                    compound.undo = () => {
                        for (const cid of pastedIds) {
                            const el = document.getElementById(cid);
                            if (!el) continue;
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

            this._selectCards(newCards.filter(Boolean) as Array<{ element: HTMLElement }>);
            Toast.show(`已粘贴 ${newCards.length} 个元素`);

        } catch (error) {
            Toast.show('粘贴失败');
            console.error('粘贴失败:', error);
        }
    },

    _getSelectedCards(): Element[] {
        if (AppState.cards.multiSelected.length > 0) {
            return AppState.cards.multiSelected;
        }
        const single = document.querySelector('.card.selected');
        return single ? [single] : [];
    },

    _calcPastePosition(cardsData: Array<{ left: string; top: string }>): { x: number; y: number } {
        const { pasteOffsetX, pasteOffsetY } = AppState.ai;
        const { contextClickPos }            = AppState.canvas;

        let minX = Infinity, minY = Infinity;
        cardsData.forEach(c => {
            minX = Math.min(minX, parseFloat(c.left));
            minY = Math.min(minY, parseFloat(c.top));
        });

        let baseX: number, baseY: number;
        if (contextClickPos.x !== 0 || contextClickPos.y !== 0) {
            baseX = contextClickPos.x;
            baseY = contextClickPos.y;
        } else {
            const rect = Canvas.container?.getBoundingClientRect() ?? { width: 0, height: 0 };
            baseX = (rect.width  / 2 - AppState.canvas.panX) / AppState.canvas.scale;
            baseY = (rect.height / 2 - AppState.canvas.panY) / AppState.canvas.scale;
        }

        return { x: baseX + pasteOffsetX, y: baseY + pasteOffsetY };
    },

    _selectCards(cards: Array<{ element: HTMLElement }>): void {
        document.querySelectorAll('.card.selected, .card.multi-selected').forEach(c => {
            c.classList.remove('selected', 'multi-selected');
        });
        AppState.cards.multiSelected = [];

        cards.forEach(card => {
            if (!card || !card.element) return;
            card.element.classList.add('multi-selected');
            AppState.cards.multiSelected.push(card.element);
        });
    }
};

(window as unknown as { Clipboard: typeof Clipboard }).Clipboard = Clipboard;
