// src/v1/ui/history-drawer.ts
// 左侧悬浮历史图库抽屉 + 拖入手势（改造自 src/components/history-sidebar.ts）
// 生成图自动加入；拖拽缩略图到画布触发 A4 语义（由 interactions 处理落点）

interface HistoryItem {
  src: string;
  timestamp: number;
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
      this.grid.innerHTML = '<div class="history-empty">本次会话生成的图片将显示在这里，可拖入画布复用</div>';
      return;
    }
    this.grid.innerHTML = '';
    this.items.forEach(item => {
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
