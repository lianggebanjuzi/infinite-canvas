// src/director/ui/shell.ts
// 导演台窗口壳：文件菜单（新建/打开/保存/另存）、撤销/重做、工程名称、导出入口、
// 回传画布、WebGL 不可用时的静态降级（新建/打开/保存仍可用）、键盘快捷键。

import { toast } from './toast';

export interface ShellActions {
  onNew(): void;
  onOpen(): void;
  onSave(): void;
  onSaveAs(): void;
  onUndo(): void;
  onRedo(): void;
  onProjectNameChange(name: string): void;
  onExportPng(): void;
  onExportMp4(): void;
  onReturnCanvas(): void;
  setTool(tool: 'translate' | 'rotate' | 'scale'): void;
  focusSelected(): void;
  togglePlay(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  refreshTitle(): void;
}

export class Shell {
  private actions: ShellActions | null = null;
  private nameInput!: HTMLInputElement;
  private saveStatus!: HTMLElement;

  init(actions: ShellActions): void {
    this.actions = actions;
    this.nameInput = document.getElementById('d-project-name') as HTMLInputElement;
    this.saveStatus = document.getElementById('d-save-status') as HTMLElement;

    document.getElementById('d-new')?.addEventListener('click', () => this.actions?.onNew());
    document.getElementById('d-open')?.addEventListener('click', () => this.actions?.onOpen());
    document.getElementById('d-save')?.addEventListener('click', () => this.actions?.onSave());
    document.getElementById('d-save-as')?.addEventListener('click', () => this.actions?.onSaveAs());
    document.getElementById('d-undo')?.addEventListener('click', () => this.actions?.onUndo());
    document.getElementById('d-redo')?.addEventListener('click', () => this.actions?.onRedo());
    document.getElementById('d-export-png')?.addEventListener('click', () => this.actions?.onExportPng());
    document.getElementById('d-export-mp4')?.addEventListener('click', () => this.actions?.onExportMp4());
    document.getElementById('d-return-canvas')?.addEventListener('click', () => this.actions?.onReturnCanvas());

    this.nameInput?.addEventListener('change', () => {
      const v = this.nameInput.value.trim();
      if (v) this.actions?.onProjectNameChange(v);
      else this.nameInput.value = this.actions ? this.currentName() : '';
    });

    // WebGL 降级按钮
    document.getElementById('d-fallback-new')?.addEventListener('click', () => this.actions?.onNew());
    document.getElementById('d-fallback-open')?.addEventListener('click', () => this.actions?.onOpen());
    document.getElementById('d-fallback-save')?.addEventListener('click', () => this.actions?.onSave());

    this.bindKeyboard();
    this.refreshTitle();
  }

  private currentName(): string {
    return this.nameInput?.value || '未命名导演工程';
  }

  /** 刷新保存状态与撤销/重做按钮（app 调用） */
  refresh(saveState: 'saved' | 'dirty', canUndo: boolean, canRedo: boolean): void {
    if (this.saveStatus) {
      this.saveStatus.dataset.status = saveState;
      this.saveStatus.textContent = saveState === 'saved' ? '已保存' : '有修改';
    }
    const undoBtn = document.getElementById('d-undo') as HTMLButtonElement;
    const redoBtn = document.getElementById('d-redo') as HTMLButtonElement;
    if (undoBtn) undoBtn.disabled = !canUndo;
    if (redoBtn) redoBtn.disabled = !canRedo;
  }

  refreshTitle(): void {
    if (this.nameInput && this.actions) {
      this.nameInput.value = this.currentName();
    }
  }

  setProjectName(name: string): void {
    if (this.nameInput) this.nameInput.value = name;
  }

  /** 显示 WebGL 不可用降级（app 在视口初始化失败后调用） */
  showWebglFallback(): void {
    const fb = document.getElementById('d-webgl-fallback');
    if (fb) fb.style.display = 'flex';
  }

  private bindKeyboard(): void {
    window.addEventListener('keydown', (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      const isTyping = tag === 'input' || tag === 'textarea' || tag === 'select';
      const meta = e.ctrlKey || e.metaKey;

      if (meta && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (e.shiftKey) this.actions?.onSaveAs();
        else this.actions?.onSave();
        return;
      }
      if (meta && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        this.actions?.onNew();
        return;
      }
      if (meta && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        this.actions?.onOpen();
        return;
      }
      if (meta && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.actions?.onRedo();
        else this.actions?.onUndo();
        return;
      }
      if (meta && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        this.actions?.onRedo();
        return;
      }
      if (isTyping) return;

      switch (e.key.toLowerCase()) {
        case 'w': this.actions?.setTool('translate'); break;
        case 'e': this.actions?.setTool('rotate'); break;
        case 'r': this.actions?.setTool('scale'); break;
        case 'f': this.actions?.focusSelected(); break;
        case ' ': e.preventDefault(); this.actions?.togglePlay(); break;
        default: break;
      }
    });
  }

  showInfo(message: string): void { toast.info(message); }
  showError(message: string): void { toast.error(message); }
  showSuccess(message: string): void { toast.success(message); }
}

export const shell = new Shell();
