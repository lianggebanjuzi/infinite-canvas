// src/director/ui/toast.ts
// 导演台轻量提示（顶部浮出，3 秒自动消失；错误类型红色）。

type ToastKind = 'info' | 'error' | 'success';

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

class DirectorToast {
  private container: HTMLDivElement | null = null;
  private seq = 0;

  private ensureContainer(): HTMLDivElement {
    if (this.container) return this.container;
    const el = document.createElement('div');
    el.className = 'director-toast-container';
    document.body.appendChild(el);
    this.container = el;
    return el;
  }

  show(message: string, kind: ToastKind = 'info', duration = 3200): void {
    const container = this.ensureContainer();
    const id = ++this.seq;
    const item = document.createElement('div');
    item.className = `director-toast director-toast-${kind}`;
    item.textContent = message;
    container.appendChild(item);
    window.setTimeout(() => {
      item.classList.add('director-toast-out');
      window.setTimeout(() => item.remove(), 260);
    }, duration);
    void id;
  }

  info(message: string): void { this.show(message, 'info'); }
  success(message: string): void { this.show(message, 'success'); }
  error(message: string): void { this.show(message, 'error', 5200); }
}

export const toast = new DirectorToast();
