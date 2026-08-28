// src/v1/ui/confirm.ts
// 自定义确认弹窗：Promise 化，暖园艺风 token，绝不使用浏览器原生 confirm()

export interface ConfirmConfig {
  title?: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

export interface ThreeWayConfig {
  title?: string;
  message?: string;
  saveText?: string;
  discardText?: string;
  cancelText?: string;
}

export type ThreeWayChoice = 'save' | 'discard' | 'cancel';

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

/**
 * 三选一弹窗（关闭保护 / 打开前检查共用）：保存（主）/ 放弃（危险色）/ 取消（弱）。
 * 复用 .confirm-overlay/.confirm-dialog 样式；Esc 等同「取消」；焦点默认落在「保存」。
 */
export function threeWayDialog(config: ThreeWayConfig = {}): Promise<ThreeWayChoice> {
  const title = config.title ?? '有未保存的改动';
  const message = config.message ?? '';
  const saveText = config.saveText ?? '保存';
  const discardText = config.discardText ?? '放弃改动';
  const cancelText = config.cancelText ?? '取消';

  return new Promise<ThreeWayChoice>((resolve) => {
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

    const discardBtn = document.createElement('button');
    discardBtn.className = 'confirm-btn danger';
    discardBtn.textContent = discardText;

    const saveBtn = document.createElement('button');
    saveBtn.className = 'confirm-btn primary';
    saveBtn.textContent = saveText;

    actions.appendChild(cancelBtn);
    actions.appendChild(discardBtn);
    actions.appendChild(saveBtn);
    dialog.appendChild(titleEl);
    if (message) dialog.appendChild(msgEl);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    let settled = false;

    const cleanup = (): void => {
      document.removeEventListener('keydown', onKey);
      overlay.removeEventListener('click', onOverlayClick);
    };

    const finish = (choice: ThreeWayChoice): void => {
      if (settled) return;
      settled = true;
      cleanup();
      overlay.remove();
      resolve(choice);
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish('cancel');
      }
    };

    const onOverlayClick = (e: MouseEvent): void => {
      if (e.target === overlay) finish('cancel');
    };

    cancelBtn.addEventListener('click', () => finish('cancel'));
    discardBtn.addEventListener('click', () => finish('discard'));
    saveBtn.addEventListener('click', () => finish('save'));
    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKey);

    saveBtn.focus();
  });
}
