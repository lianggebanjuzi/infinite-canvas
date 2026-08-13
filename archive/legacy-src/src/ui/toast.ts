/**
 * Toast 提示组件
 * 
 * 用法：
 *   Toast.show('操作成功');
 *   Toast.show('操作失败', 'error');
 *   Toast.show('请稍候...', 'info', 5000);
 */

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastOptions {
  /** 提示文字 */
  message: string;
  /** 提示类型，默认 'success' */
  type?: ToastType;
  /** 显示时长（毫秒），默认 3000，0 表示不自动关闭 */
  duration?: number;
  /** 关闭回调 */
  onClose?: () => void;
}

// Toast 容器（单例）
let container: HTMLElement | null = null;

function getContainer(): HTMLElement {
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    container.style.cssText = 'position:fixed;top:20px;right:20px;z-index:10000;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
    document.body.appendChild(container);
  }
  return container;
}

export const Toast = {
  /**
   * 显示 Toast 提示
   */
  show(messageOrOptions: string | ToastOptions, typeOrDuration?: ToastType | number, duration = 3000): void {
    // 兼容旧调用方式：Toast.show('msg', 1200) 第二个参数为数字时当作 duration
    let options: ToastOptions;
    if (typeof messageOrOptions === 'string') {
      if (typeof typeOrDuration === 'number') {
        options = { message: messageOrOptions, type: 'success', duration: typeOrDuration };
      } else {
        options = { message: messageOrOptions, type: typeOrDuration || 'success', duration };
      }
    } else {
      options = messageOrOptions;
    }

    const {
      message,
      type: toastType = 'success',
      duration: toastDuration = 3000,
      onClose,
    } = options;

    const toast = document.createElement('div');
    toast.className = `toast toast--${toastType}`;
    toast.style.pointerEvents = 'auto';
    toast.textContent = message;

    const parent = getContainer();
    parent.appendChild(toast);

    // 动画入场
    requestAnimationFrame(() => {
      toast.classList.add('toast--show');
    });

    // 自动关闭
    if (toastDuration > 0) {
      setTimeout(() => {
        toast.classList.remove('toast--show');
        toast.addEventListener('transitionend', () => {
          toast.remove();
          onClose?.();
        }, { once: true });
        setTimeout(() => toast.remove(), 300);
      }, toastDuration);
    }
  },

  /**
   * 成功提示
   */
  success(message: string, duration?: number): void {
    this.show({ message, type: 'success', duration });
  },

  /**
   * 错误提示
   */
  error(message: string, duration?: number): void {
    this.show({ message, type: 'error', duration: duration || 5000 });
  },

  /**
   * 警告提示
   */
  warning(message: string, duration?: number): void {
    this.show({ message, type: 'warning', duration });
  },

  /**
   * 信息提示
   */
  info(message: string, duration?: number): void {
    this.show({ message, type: 'info', duration });
  },
};

// 挂载到 window，保持兼容
(window as unknown as Record<string, unknown>).Toast = Toast;
