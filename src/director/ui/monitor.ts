// src/director/ui/monitor.ts
// 摄像机监看器：显示活动摄像机画面（渲染由 viewport 完成），
// 提供「编辑视角 / 摄像机视角」切换与监看标题更新。

import { cameraManager } from '../engine/camera';
import { viewport, ViewMode } from './viewport';

export class Monitor {
  private titleEl!: HTMLElement;
  private emptyEl!: HTMLElement;
  private monitorCanvas!: HTMLCanvasElement;
  private onViewModeChange: ((mode: ViewMode) => void) | null = null;

  init(onViewModeChange?: (mode: ViewMode) => void): void {
    this.onViewModeChange = onViewModeChange ?? null;
    this.titleEl = document.getElementById('d-monitor-title') as HTMLElement;
    this.emptyEl = document.getElementById('d-monitor-empty') as HTMLElement;
    this.monitorCanvas = document.getElementById('d-monitor-canvas') as HTMLCanvasElement;

    document.getElementById('d-view-edit')?.addEventListener('click', () => {
      this.setViewMode('edit');
    });
    document.getElementById('d-view-camera')?.addEventListener('click', () => {
      this.setViewMode('camera');
    });

    this.refresh();
  }

  setViewMode(mode: ViewMode): void {
    viewport.setViewMode(mode);
    document.getElementById('d-view-edit')?.classList.toggle('active', mode === 'edit');
    document.getElementById('d-view-camera')?.classList.toggle('active', mode === 'camera');
    document.getElementById('d-viewport-tag')!.textContent = mode === 'edit' ? '编辑视角' : '摄像机视角';
    this.onViewModeChange?.(mode);
  }

  /** 摄像机切换后刷新标题（由 app 调用） */
  refresh(): void {
    const cam = cameraManager.getActive();
    if (cam) {
      this.titleEl.textContent = `监看 · ${cam.name}`;
      this.emptyEl.style.display = 'none';
      if (this.monitorCanvas) this.monitorCanvas.style.display = 'block';
    } else {
      this.titleEl.textContent = '监看 · 无摄像机';
      this.emptyEl.style.display = 'flex';
      if (this.monitorCanvas) this.monitorCanvas.style.display = 'none';
    }
  }
}

export const monitor = new Monitor();
