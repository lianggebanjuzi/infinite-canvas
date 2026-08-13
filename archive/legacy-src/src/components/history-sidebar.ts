// src/components/history-sidebar.ts
// 右侧侧边栏 + 本次会话生成历史图库

import { AppState } from '../state/app-state';
import { API } from '../utils/api';
import { Dom } from '../utils/dom';
import { SnapshotCollector } from '../core/snapshot';

declare const Toast: { show(message: string, duration?: number): void };
declare const CardFactory: { create(type: string, options: Record<string, unknown>, saveHistory?: boolean, extra?: Record<string, unknown>): unknown };
declare const Canvas: { toCanvasCoords(x: number, y: number): { x: number; y: number } };

interface HistoryItem {
    src: string;
    timestamp: number;
    resolution: string;
    aspectRatio: string;
}

interface AddImageMeta {
    generatedAt?: number;
    resolution?: string;
    aspectRatio?: string;
}

export const HistorySidebar = {

    _isExpanded: false,
    _items: [] as HistoryItem[],

    // ─────────────────────────────────────────
    // 初始化
    // ─────────────────────────────────────────
    init(): void {
        this._bindToggle();
        this._bindTabSwitch();
        this._renderEmpty();
        console.log('[HistorySidebar] 初始化完成');
    },

    // ─────────────────────────────────────────
    // 添加一张生成图片到历史
    // ─────────────────────────────────────────
    addImage(src: string, meta: AddImageMeta | null = null): void {
        if (!src) return;

        this._items.push({
            src,
            timestamp:   meta?.generatedAt  || Date.now(),
            resolution:  meta?.resolution   || '',
            aspectRatio: meta?.aspectRatio  || ''
        });
        this._renderGrid();

        // 有新图时自动展开侧边栏
        if (!this._isExpanded) {
            this.expand();
        }

        console.log(`[HistorySidebar] 新增图片，当前共 ${this._items.length} 张`);
    },

    // ─────────────────────────────────────────
    // 清空历史
    // ─────────────────────────────────────────
    clear(): void {
        this._items = [];
        this._renderEmpty();
        this._updateCount();
        console.log('[HistorySidebar] 历史已清空');
    },

    // ─────────────────────────────────────────
    // 展开 / 折叠
    // ─────────────────────────────────────────
    expand(): void {
        this._isExpanded = true;
        document.getElementById('left-sidebar')?.classList.add('expanded');
    },

    collapse(): void {
        this._isExpanded = false;
        document.getElementById('left-sidebar')?.classList.remove('expanded');
    },

    toggle(): void {
        this._isExpanded ? this.collapse() : this.expand();
    },

    // ─────────────────────────────────────────
    // 渲染
    // ─────────────────────────────────────────
    _renderGrid(): void {
        const grid = document.getElementById('history-grid');
        if (!grid) return;

        grid.innerHTML = '';

        // 最新的在最前面
        const reversed = [...this._items].reverse();

        reversed.forEach((item: HistoryItem, idx: number) => {
            const div = document.createElement('div');
            div.className   = 'history-item';
            div.draggable   = true;
            div.dataset.src = item.src;

            // 格式化时间
            const timeStr = item.timestamp
                ? new Date(item.timestamp).toLocaleTimeString('zh-CN', {
                    hour:   '2-digit',
                    minute: '2-digit',
                    second: '2-digit'
                  })
                : '';

            // 分辨率标签
            const res = item.resolution
                ? `<span class="history-meta-tag">${item.resolution.toUpperCase()}</span>`
                : '';

            // 比例标签（Auto 不显示）
            const ar = (item.aspectRatio && item.aspectRatio !== 'Auto')
                ? `<span class="history-meta-tag">${item.aspectRatio}</span>`
                : '';

            div.innerHTML = `
                <img src="${item.src}" alt="生成图 ${this._items.length - idx}">
                <div class="history-item-index">${this._items.length - idx}</div>
                <div class="history-item-meta">
                    <div class="history-meta-tags">${res}${ar}</div>
                    ${timeStr
                        ? `<div class="history-meta-time">${timeStr}</div>`
                        : ''}
                </div>
            `;

            // 拖拽到画布
            div.addEventListener('dragstart', (e: DragEvent) => {
                e.dataTransfer!.setData('text/plain', item.src);
                e.dataTransfer!.setData('application/history-image', item.src);
                div.style.opacity = '0.6';
            });

            div.addEventListener('dragend', () => {
                div.style.opacity = '';
            });

            // 双击：在画布上创建预览卡片
            div.addEventListener('dblclick', () => {
                this._createPreviewCard(item.src);
            });

            grid.appendChild(div);
        });

        this._updateCount();
    },

    _renderEmpty(): void {
        const grid = document.getElementById('history-grid');
        if (!grid) return;
        grid.innerHTML = `
            <div class="history-empty">
                <i class="fas fa-images"></i>
                <div>本次会话生成的图片将显示在这里</div>
            </div>
        `;
        this._updateCount();
    },

    _updateCount(): void {
        const el = document.getElementById('history-count');
        if (el) el.textContent = `${this._items.length} 张`;
    },

    // ─────────────────────────────────────────
    // 双击创建预览卡片
    // ─────────────────────────────────────────
    _createPreviewCard(src: string): void {
        const cx = (window.innerWidth  / 2 - AppState.canvas.panX) / AppState.canvas.scale;
        const cy = (window.innerHeight / 2 - AppState.canvas.panY) / AppState.canvas.scale;

        const card = CardFactory.create('preview', {
            x: cx - 200,
            y: cy - 150,
        });

        if (card) {
            (card as Record<string, (src: string) => void>).setImage(src);
            Toast.show('已创建预览卡片');
        }
    },

    // ─────────────────────────────────────────
    // 拖入画布创建图片卡片
    // ─────────────────────────────────────────
    _bindCanvasDrop(): void {
        const container = document.getElementById('canvas-container') as HTMLElement | null;
        if (!container || (container as unknown as Record<string, boolean>)._historyDropBound) return;

        container.addEventListener('dragover', (e: DragEvent) => {
            if (e.dataTransfer!.types.includes('application/history-image')) {
                e.preventDefault();
                e.dataTransfer!.dropEffect = 'copy';
            }
        });

        container.addEventListener('drop', (e: DragEvent) => {
            const src = e.dataTransfer!.getData('application/history-image');
            if (!src) return;
            e.preventDefault();

            const pos = Canvas.toCanvasCoords(e.clientX, e.clientY);

            const imgObj = new Image();
            imgObj.onload = function (this: HTMLImageElement) {
                const ratio      = this.naturalHeight / this.naturalWidth;
                const cardWidth  = 240;
                const cardHeight = Math.round(cardWidth * ratio) + 20;

                CardFactory.create('image', {
                    x:       pos.x,
                    y:       pos.y,
                    width:   cardWidth  + 'px',
                    height:  cardHeight + 'px',
                    content: src,
                    title:   '历史图片'
                });
            } as unknown as ((this: GlobalEventHandlers, ev: Event) => void);
            imgObj.src = src;
        });

        (container as unknown as Record<string, boolean>)._historyDropBound = true;
    },

    // ─────────────────────────────────────────
    // 事件绑定
    // ─────────────────────────────────────────
    _bindToggle(): void {
        const toggle = document.getElementById('sidebar-toggle');
        toggle?.addEventListener('click', () => this.toggle());
    },

    _bindTabSwitch(): void {
        const tabs = document.querySelectorAll('.sidebar-tab-btn');
        tabs.forEach(btn => {
            btn.addEventListener('click', () => {
                const panelId = (btn as HTMLElement).dataset.panel;

                // 切换标签激活态
                tabs.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                // 切换面板
                document.querySelectorAll('.sidebar-panel-content')
                    .forEach(p => p.classList.remove('active'));
                document.getElementById(`sidebar-panel-${panelId}`)
                    ?.classList.add('active');

                // 点击当前已激活的标签：折叠/展开
                if (this._isExpanded) {
                    this.collapse();
                } else {
                    this.expand();
                }
            });
        });
    }
};

(window as unknown as Record<string, unknown>).HistorySidebar = HistorySidebar;
