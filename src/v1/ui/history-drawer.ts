// src/v1/ui/history-drawer.ts
// 左侧悬浮历史图库抽屉 + 拖入手势（改造自 src/components/history-sidebar.ts）
// 生成图自动加入；拖拽缩略图到画布触发 A4 语义（由 interactions 处理落点）。
// 打开项目时经 loadFromHistory 载入 history.jsonl（跨会话展示；image 行按 nodeId 解析到当前节点 imageUrl）。

import { flowState } from '../state/flow-state';

interface HistoryItem {
  src: string;
  timestamp: number;
  text?: string; // 文本记录：无图，展示 outputText 片段
}

class HistoryDrawer {
  private items: HistoryItem[] = [];
  private open = false;
  private drawer: HTMLElement | null = null;
  private grid: HTMLElement | null = null;
  private handle: HTMLElement | null = null;

  init(): void {
    this.drawer = document.getElementById('left-drawer');
    this.grid = document.getElementById('history-grid');
    this.handle = document.getElementById('drawer-handle');

    this.handle?.addEventListener('click', () => this.toggle());
    this.render();
  }

  addImage(src: string, meta: { timestamp?: number } = {}): void {
    if (!src) return;
    this.items.unshift({ src, timestamp: meta.timestamp ?? Date.now() });
    this.render();
    if (!this.open) this.openDrawer(true);
  }

  /** 载入 history.jsonl（打开项目时调用）：image 行按 nodeId 解析当前节点 imageUrl；text 行展示文本片段 */
  loadFromHistory(entries: HistoryEntry[]): void {
    const resolved: HistoryItem[] = [];
    entries.forEach(e => {
      if (e.kind === 'image') {
        const node = flowState.getNode(e.nodeId);
        const src = node && node.imageUrl ? node.imageUrl : '';
        if (!src) return; // 无图（历史图已在后续会话被替换/删除）跳过
        resolved.push({ src, timestamp: e.createdAt });
      } else {
        resolved.push({ src: '', timestamp: e.createdAt, text: e.outputText || '' });
      }
    });
    // 保留本会话生成图；persisted 追加在后（文件为 append 顺序，反转为最新在前）
    this.items = [...this.items, ...resolved.reverse()];
    this.render();
  }

  toggle(): void {
    this.openDrawer(!this.open);
  }

  openDrawer(open: boolean): void {
    this.open = open;
    this.drawer?.classList.toggle('open', open);
  }

  private render(): void {
    if (!this.grid) return;
    if (this.items.length === 0) {
      this.grid.innerHTML = '<div class="history-empty">本次会话生成的图片与历史记录将显示在这里，可拖入画布复用</div>';
      return;
    }
    this.grid.innerHTML = '';
    this.items.forEach(item => {
      if (item.text !== undefined && !item.src) {
        // 文本记录：文本缩略卡（不可拖为图片）
        const div = document.createElement('div');
        div.className = 'history-thumb history-text';
        div.textContent = item.text;
        div.title = new Date(item.timestamp).toLocaleString('zh-CN');
        this.grid!.appendChild(div);
        return;
      }
      const div = document.createElement('div');
      div.className = 'history-thumb';
      div.draggable = true;
      div.style.backgroundImage = `url('${item.src.replace(/'/g, "\\'")}')`;
      div.title = new Date(item.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      div.addEventListener('dragstart', (e: DragEvent) => {
        e.dataTransfer!.setData('application/history-image', item.src);
        e.dataTransfer!.setData('text/plain', item.src);
        div.style.opacity = '0.6';
      });
      div.addEventListener('dragend', () => { div.style.opacity = ''; });
      this.grid!.appendChild(div);
    });
  }
}

export const historyDrawer = new HistoryDrawer();
