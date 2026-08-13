// src/v1/ui/confirm.ts
// 自定义确认弹窗：Promise 化，暖园艺风 token，绝不使用浏览器原生 confirm()

export interface ConfirmConfig {
  title?: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

/** 弹出确认对话框，resolve(true) 表示确认，resolve(false) 表示取消/关闭 */
export function confirmDialog(config: ConfirmConfig = {}): Promise<boolean> {
  const title = config.title ?? '确认操作';
  const message = config.message ?? '';
  const confirmText = config.confirmText ?? '确认';
  const cancelText = config.cancelText ?? '取消';
  const danger = config.danger === true;

  return new Promise<boolean>((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';

    const titleEl = document.createElement('div');
    titleEl.className = 'confirm-title';
    titleEl.textContent = title;

    const msgEl = document.createElement('div');
    msgEl.className = 'confirm-message';
    msgEl.textContent = message;

    const actions = document.createElement('div');
    actions.className = 'confirm-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'confirm-btn';
    cancelBtn.textContent = cancelText;

    const okBtn = document.createElement('button');
    okBtn.className = 'confirm-btn' + (danger ? ' danger' : ' primary');
    okBtn.textContent = confirmText;

    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    dialog.appendChild(titleEl);
    if (message) dialog.appendChild(msgEl);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    let settled = false;

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        finish(e.key === 'Enter');
      }
    };

    const onOverlayClick = (e: MouseEvent): void => {
      if (e.target === overlay) finish(false);
    };

    const cleanup = (): void => {
      document.removeEventListener('keydown', onKey);
      overlay.removeEventListener('click', onOverlayClick);
    };

    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      cleanup();
      overlay.remove();
      resolve(result);
    };

    cancelBtn.addEventListener('click', () => finish(false));
    okBtn.addEventListener('click', () => finish(true));
    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKey);

    okBtn.focus();
  });
}
