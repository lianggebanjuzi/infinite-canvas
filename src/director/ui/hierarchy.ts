// src/director/ui/hierarchy.ts
// 导演台场景层级面板：对象列表、选中、隐藏/锁定、W/E/R 变换、世界/局部、吸附、贴地、聚焦。

import { DirectorObject, DirectorObjectKind } from '../types';
import { sceneManager } from '../engine/scene';
import { DirectorAppActions } from './app-actions';
import { viewport, TransformTool } from './viewport';

const KIND_ICONS: Record<DirectorObjectKind, string> = {
  box: '▣', sphere: '◉', cylinder: '▮', cone: '▲', plane: '▬', capsule: '◍', gltf: '⬡', character: '🧍',
};

export class HierarchyPanel {
  private listEl!: HTMLElement;
  private emptyEl!: HTMLElement;
  private actions: DirectorAppActions | null = null;
  private selectedId: string | null = null;

  init(actions: DirectorAppActions): void {
    this.actions = actions;
    this.listEl = document.getElementById('d-hierarchy-list') as HTMLElement;
    this.emptyEl = document.getElementById('d-hierarchy-empty') as HTMLElement;

    // 添加对象
    document.querySelectorAll<HTMLElement>('[data-add]').forEach(btn => {
      btn.addEventListener('click', () => {
        const kind = btn.dataset.add as DirectorObjectKind | undefined;
        if (kind && this.actions) this.actions.addObject(kind);
      });
    });

    // 导入
    document.getElementById('d-import-gltf')?.addEventListener('click', () => this.actions?.importGltf());
    document.getElementById('d-import-image')?.addEventListener('click', () => this.actions?.importImage());

    // 工具
    document.querySelectorAll<HTMLElement>('[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => {
        const tool = btn.dataset.tool as TransformTool | undefined;
        if (!tool) return;
        document.querySelectorAll('[data-tool]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.actions?.setTool(tool);
      });
    });

    document.getElementById('d-space-world')?.addEventListener('click', () => {
      document.getElementById('d-space-world')?.classList.add('active');
      document.getElementById('d-space-local')?.classList.remove('active');
      this.actions?.setSpace('world');
    });
    document.getElementById('d-space-local')?.addEventListener('click', () => {
      document.getElementById('d-space-local')?.classList.add('active');
      document.getElementById('d-space-world')?.classList.remove('active');
      this.actions?.setSpace('local');
    });

    const snapBtn = document.getElementById('d-snap-toggle');
    const snapStep = document.getElementById('d-snap-step') as HTMLInputElement;
    let snapOn = false;
    snapBtn?.addEventListener('click', () => {
      snapOn = !snapOn;
      snapBtn.classList.toggle('active', snapOn);
      this.actions?.setSnap(snapOn, parseFloat(snapStep?.value || '0.25'));
      viewport.setSnap(snapOn, parseFloat(snapStep?.value || '0.25'));
      document.getElementById('d-viewport-info')!.textContent = `吸附: ${snapOn ? '开' : '关'}`;
    });
    snapStep?.addEventListener('change', () => {
      if (snapOn) {
        this.actions?.setSnap(true, parseFloat(snapStep.value || '0.25'));
        viewport.setSnap(true, parseFloat(snapStep.value || '0.25'));
      }
    });

    document.getElementById('d-ground')?.addEventListener('click', () => this.actions?.groundSelected());
    document.getElementById('d-focus')?.addEventListener('click', () => this.actions?.focusSelected());

    this.render();
  }

  /** 由 app 在选择变化后调用 */
  setSelection(id: string | null): void {
    this.selectedId = id;
    this.render();
  }

  refresh(): void {
    this.render();
  }

  private render(): void {
    if (!this.listEl) return;
    const objects = [...sceneManager.handles.values()].map(h => h.data);
    this.emptyEl.style.display = objects.length ? 'none' : 'block';
    this.listEl.innerHTML = '';

    for (const obj of objects) {
      const row = document.createElement('div');
      row.className = 'd-hierarchy-item' + (obj.id === this.selectedId ? ' selected' : '');
      row.title = `${obj.name}（${obj.kind}）`;

      const icon = document.createElement('span');
      icon.className = 'd-hi-icon';
      icon.textContent = KIND_ICONS[obj.kind] ?? '•';
      row.appendChild(icon);

      const name = document.createElement('span');
      name.className = 'd-hi-name';
      name.textContent = obj.name;
      name.addEventListener('dblclick', () => {
        const next = window.prompt('重命名对象', obj.name);
        if (next && next.trim() && next.trim() !== obj.name) {
          this.actions?.renameObject(obj.id, next.trim());
        }
      });
      row.appendChild(name);

      const eye = document.createElement('button');
      eye.className = 'd-hi-btn' + (obj.visible ? '' : ' off');
      eye.textContent = obj.visible ? '👁' : '—';
      eye.title = obj.visible ? '隐藏' : '显示';
      eye.addEventListener('click', (e) => {
        e.stopPropagation();
        this.actions?.toggleObjectVisible(obj.id);
      });
      row.appendChild(eye);

      const lock = document.createElement('button');
      lock.className = 'd-hi-btn' + (obj.locked ? ' off' : '');
      lock.textContent = obj.locked ? '🔒' : '🔓';
      lock.title = obj.locked ? '解锁' : '锁定';
      lock.addEventListener('click', (e) => {
        e.stopPropagation();
        this.actions?.toggleObjectLocked(obj.id);
      });
      row.appendChild(lock);

      row.addEventListener('click', () => {
        this.actions?.selectObject(obj.id);
      });

      this.listEl.appendChild(row);
    }
  }
}

export const hierarchyPanel = new HierarchyPanel();
