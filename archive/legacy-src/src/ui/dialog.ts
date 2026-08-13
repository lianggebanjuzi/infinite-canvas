/**
 * Dialog 弹窗组件
 * 
 * 用法：
 *   const dialog = Dialog({
 *     title: '确认删除',
 *     content: '确定要删除这个供应商吗？',
 *     confirmText: '删除',
 *     cancelText: '取消',
 *     onConfirm: () => { console.log('确认') },
 *     onCancel: () => { console.log('取消') }
 *   });
 *   
 *   // 手动关闭
 *   dialog.close();
 */

export interface DialogOptions {
  /** 弹窗标题 */
  title: string;
  /** 弹窗内容（支持 HTML 字符串） */
  content?: string;
  /** 弹窗内容（DOM 元素） */
  body?: HTMLElement;
  /** 确认按钮文字，默认 '确认' */
  confirmText?: string;
  /** 取消按钮文字，默认 '取消' */
  cancelText?: string;
  /** 是否显示取消按钮，默认 true */
  showCancel?: boolean;
  /** 确认按钮是否为危险操作（红色），默认 false */
  danger?: boolean;
  /** 点击遮罩是否关闭，默认 true */
  closeOnOverlay?: boolean;
  /** 按下 Esc 是否关闭，默认 true */
  closeOnEsc?: boolean;
  /** 确认回调 */
  onConfirm?: () => void | Promise<void>;
  /** 取消回调 */
  onCancel?: () => void;
  /** 关闭回调（确认和取消都会触发） */
  onClose?: () => void;
}

export interface DialogInstance {
  /** 关闭弹窗 */
  close: () => void;
  /** 获取弹窗元素 */
  element: HTMLElement;
}

export function Dialog(options: DialogOptions): DialogInstance {
  const {
    title,
    content,
    body,
    confirmText = '确认',
    cancelText = '取消',
    showCancel = true,
    danger = false,
    closeOnOverlay = true,
    closeOnEsc = true,
    onConfirm,
    onCancel,
    onClose,
  } = options;

  // 创建遮罩
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  // 创建弹窗
  const dialog = document.createElement('div');
  dialog.className = 'modal-dialog';

  // 标题
  const titleEl = document.createElement('h3');
  titleEl.className = 'modal-title';
  titleEl.textContent = title;
  dialog.appendChild(titleEl);

  // 内容
  if (content || body) {
    const bodyEl = document.createElement('div');
    bodyEl.className = 'modal-body';
    if (body) {
      bodyEl.appendChild(body);
    } else if (content) {
      bodyEl.innerHTML = content;
    }
    dialog.appendChild(bodyEl);
  }

  // 按钮区域
  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  if (showCancel) {
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-cancel';
    cancelBtn.textContent = cancelText;
    cancelBtn.addEventListener('click', () => {
      onCancel?.();
      onClose?.();
      close();
    });
    actions.appendChild(cancelBtn);
  }

  const confirmBtn = document.createElement('button');
  confirmBtn.className = `btn btn-confirm${danger ? ' btn-danger' : ''}`;
  confirmBtn.textContent = confirmText;
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = '处理中...';
    try {
      await onConfirm?.();
      onClose?.();
      close();
    } catch (e) {
      console.error('[Dialog] 确认回调出错:', e);
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = confirmText;
    }
  });
  actions.appendChild(confirmBtn);

  dialog.appendChild(actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // 动画入场
  requestAnimationFrame(() => {
    overlay.classList.add('is-visible');
  });

  // 关闭函数
  function close() {
    overlay.classList.remove('is-visible');
    overlay.addEventListener('transitionend', () => {
      overlay.remove();
    }, { once: true });
    // 兜底：如果动画没触发，300ms 后移除
    setTimeout(() => overlay.remove(), 300);
  }

  // 点击遮罩关闭
  if (closeOnOverlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        onCancel?.();
        onClose?.();
        close();
      }
    });
  }

  // Esc 关闭
  if (closeOnEsc) {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel?.();
        onClose?.();
        close();
        document.removeEventListener('keydown', handleEsc);
      }
    };
    document.addEventListener('keydown', handleEsc);
  }

  // 聚焦确认按钮
  confirmBtn.focus();

  return { close, element: overlay };
}
