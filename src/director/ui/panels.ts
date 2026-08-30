// src/director/ui/panels.ts
// 导演台右侧控制面板：摄像机、参考图、光照、人物（姿势/IK）。
// 全部通过 DirectorAppActions 驱动（undo + 工程同步由 app 负责）。

import { cameraManager } from '../engine/camera';
import { referenceManager } from '../engine/reference';
import { lightingManager } from '../engine/lighting';
import { characterManager, POSE_PRESETS } from '../engine/character';
import { sceneManager } from '../engine/scene';
import { DirectorAppActions } from './app-actions';

export class Panels {
  private actions: DirectorAppActions | null = null;

  init(actions: DirectorAppActions): void {
    this.actions = actions;

    // 页签切换
    document.querySelectorAll<HTMLElement>('.d-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.d-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.d-panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        const panel = document.querySelector<HTMLElement>(`.d-panel[data-panel-body="${tab.dataset.panel}"]`);
        if (panel) panel.classList.add('active');
      });
    });

    // ── 摄像机 ──
    document.getElementById('d-cam-add')?.addEventListener('click', () => this.actions?.addCamera());
    document.getElementById('d-cam-duplicate')?.addEventListener('click', () => {
      const id = cameraManager.activeCameraId;
      if (id) this.actions?.duplicateCamera(id);
    });
    document.getElementById('d-cam-rename')?.addEventListener('click', () => {
      const id = cameraManager.activeCameraId;
      if (id) this.actions?.renameCamera(id);
    });
    document.getElementById('d-cam-delete')?.addEventListener('click', () => {
      const id = cameraManager.activeCameraId;
      if (id) this.actions?.deleteCamera(id);
    });
    const fovInput = document.getElementById('d-cam-fov') as HTMLInputElement;
    const fovOut = document.getElementById('d-cam-fov-out') as HTMLElement;
    fovInput?.addEventListener('input', () => {
      fovOut.textContent = `${fovInput.value}°`;
      this.actions?.setCameraFov(parseFloat(fovInput.value));
    });
    const aspectSelect = document.getElementById('d-cam-aspect') as HTMLSelectElement;
    aspectSelect?.addEventListener('change', () => {
      const v = aspectSelect.value;
      this.actions?.setCameraAspect(evalAspect(v));
    });
    document.getElementById('d-cam-include-export')?.addEventListener('change', (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      this.actions?.setCameraIncludeExport(checked);
    });

    // ── 参考图 ──
    document.getElementById('d-ref-add')?.addEventListener('click', () => this.actions?.addReference());

    // ── 光照 ──
    const bindRange = (id: string, outId: string, field: string, factor = 1): void => {
      const input = document.getElementById(id) as HTMLInputElement;
      const out = document.getElementById(outId) as HTMLElement;
      if (!input || !out) return;
      const apply = (): void => {
        out.textContent = (parseFloat(input.value) * factor).toFixed(2);
        this.actions?.setLightingField(field, parseFloat(input.value));
      };
      input.addEventListener('input', apply);
    };
    bindRange('d-light-exposure', 'd-light-exposure-out', 'exposure');
    bindRange('d-light-ambient', 'd-light-ambient-out', 'ambientIntensity');
    bindRange('d-light-key', 'd-light-key-out', 'keyIntensity');
    bindRange('d-light-fill', 'd-light-fill-out', 'fillIntensity');
    const bindColor = (id: string, field: string): void => {
      const input = document.getElementById(id) as HTMLInputElement;
      input?.addEventListener('input', () => this.actions?.setLightingField(field, input.value));
    };
    bindColor('d-light-ambient-color', 'ambientColor');
    bindColor('d-light-key-color', 'keyColor');
    bindColor('d-light-fill-color', 'fillColor');
    bindColor('d-light-bg', 'background');
    document.getElementById('d-light-default')?.addEventListener('click', () => this.actions?.restoreDefaultLighting());

    // ── 人物 ──
    const poseSelect = document.getElementById('d-pose-select') as HTMLSelectElement;
    if (poseSelect) {
      poseSelect.innerHTML = '';
      for (const p of POSE_PRESETS) {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.label;
        poseSelect.appendChild(opt);
      }
    }
    document.getElementById('d-pose-apply')?.addEventListener('click', () => {
      if (poseSelect) this.actions?.applyPosePreset(poseSelect.value);
    });
    document.getElementById('d-pose-save')?.addEventListener('click', () => this.actions?.storePose());
    document.getElementById('d-pose-ik')?.addEventListener('click', () => this.actions?.toggleIkMode());

    this.refreshAll();
  }

  /** 刷新全部面板状态（app 在数据变化后调用） */
  refreshAll(): void {
    this.refreshCameraPanel();
    this.refreshReferencePanel();
    this.refreshLightingPanel();
    this.refreshCharacterPanel();
  }

  /** 只刷新光照面板（滑块高频输入时调用） */
  refreshLighting(): void {
    this.refreshLightingPanel();
  }

  private refreshCameraPanel(): void {
    const list = document.getElementById('d-cam-list');
    if (!list) return;
    list.innerHTML = '';
    for (const cam of cameraManager.cameras) {
      const row = document.createElement('div');
      row.className = 'd-cam-item' + (cam.id === cameraManager.activeCameraId ? ' active' : '');
      const name = document.createElement('span');
      name.className = 'd-cam-name';
      name.textContent = cam.name;
      row.appendChild(name);
      row.addEventListener('click', () => this.actions?.selectCamera(cam.id));
      list.appendChild(row);
    }
    const active = cameraManager.getActive();
    const fovInput = document.getElementById('d-cam-fov') as HTMLInputElement;
    const fovOut = document.getElementById('d-cam-fov-out') as HTMLElement;
    const aspectSelect = document.getElementById('d-cam-aspect') as HTMLSelectElement;
    const includeExport = document.getElementById('d-cam-include-export') as HTMLInputElement;
    if (active) {
      if (fovInput) { fovInput.value = String(active.fov); fovOut.textContent = `${Math.round(active.fov)}°`; }
      if (aspectSelect) aspectSelect.value = aspectToLabel(active.aspect);
      if (includeExport) includeExport.checked = active.includeInExport;
    }
  }

  private refreshReferencePanel(): void {
    const list = document.getElementById('d-ref-list');
    if (!list) return;
    list.innerHTML = '';
    for (const ref of referenceManager.references) {
      const row = document.createElement('div');
      row.className = 'd-ref-item' + (ref.id === referenceManager.selectedId ? ' selected' : '');
      const thumb = document.createElement('img');
      thumb.className = 'd-ref-thumb';
      thumb.src = ref.assetRef.path || '';
      thumb.alt = '';
      row.appendChild(thumb);
      const meta = document.createElement('div');
      meta.className = 'd-ref-meta';
      const name = document.createElement('div');
      name.className = 'd-ref-name';
      name.textContent = ref.name;
      const sub = document.createElement('div');
      sub.className = 'd-ref-sub';
      sub.textContent = `${ref.assetRef.missing ? '资源缺失 ' : ''}${ref.includeInExport ? '导出' : '不导出'} · 透明度 ${Math.round(ref.opacity * 100)}%`;
      meta.appendChild(name);
      meta.appendChild(sub);
      row.appendChild(meta);
      const eye = document.createElement('button');
      eye.className = 'd-hi-btn' + (ref.visible ? '' : ' off');
      eye.textContent = ref.visible ? '👁' : '—';
      eye.title = ref.visible ? '隐藏' : '显示';
      eye.addEventListener('click', (e) => {
        e.stopPropagation();
        this.actions?.toggleReferenceVisible(ref.id);
      });
      row.appendChild(eye);
      const del = document.createElement('button');
      del.className = 'd-hi-btn';
      del.textContent = '✕';
      del.title = '删除参考图';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        this.actions?.deleteReference(ref.id);
      });
      row.appendChild(del);
      row.addEventListener('click', () => this.actions?.selectReference(ref.id));
      list.appendChild(row);
    }
  }

  private refreshLightingPanel(): void {
    const l = lightingManager.lighting;
    const setRange = (id: string, outId: string, value: number): void => {
      const input = document.getElementById(id) as HTMLInputElement;
      const out = document.getElementById(outId) as HTMLElement;
      if (input) input.value = String(value);
      if (out) out.textContent = value.toFixed(2);
    };
    setRange('d-light-exposure', 'd-light-exposure-out', l.exposure);
    setRange('d-light-ambient', 'd-light-ambient-out', l.ambientIntensity);
    setRange('d-light-key', 'd-light-key-out', l.keyIntensity);
    setRange('d-light-fill', 'd-light-fill-out', l.fillIntensity);
    const setColor = (id: string, value: string): void => {
      const input = document.getElementById(id) as HTMLInputElement;
      if (input) input.value = value;
    };
    setColor('d-light-ambient-color', l.ambientColor);
    setColor('d-light-key-color', l.keyColor);
    setColor('d-light-fill-color', l.fillColor);
    setColor('d-light-bg', l.background);
  }

  private refreshCharacterPanel(): void {
    const hint = document.getElementById('d-char-hint');
    const ikHint = document.getElementById('d-ik-hint');
    const poseSelect = document.getElementById('d-pose-select') as HTMLSelectElement;
    const hasChar = characterManager.hasCharacter();
    if (hint) {
      hint.textContent = hasChar
        ? '选中人物对象后可应用姿势预设、保存姿势或开启 IK 模式。'
        : '场景中没有人物对象时，此面板自动降级（不报错）。点左侧「🧍 人物」添加。';
    }
    const firstId = characterManager.firstCharacterId();
    if (firstId) {
      const handle = sceneManager.getHandle(firstId);
      if (handle && handle.data.character && poseSelect) {
        poseSelect.value = POSE_PRESETS.some(p => p.name === handle.data.character?.poseName)
          ? handle.data.character.poseName
          : 'idle';
      }
    }
    if (ikHint) ikHint.style.display = characterManager.ikMode ? 'block' : 'none';
    const ikBtn = document.getElementById('d-pose-ik');
    if (ikBtn) ikBtn.classList.toggle('active', characterManager.ikMode);
  }
}

function aspectToLabel(aspect: number): string {
  if (Math.abs(aspect - 16 / 9) < 0.01) return '16/9';
  if (Math.abs(aspect - 4 / 3) < 0.01) return '4/3';
  if (Math.abs(aspect - 3 / 4) < 0.01) return '3/4';
  if (Math.abs(aspect - 1) < 0.01) return '1';
  if (Math.abs(aspect - 9 / 16) < 0.01) return '9/16';
  return '16/9';
}

function evalAspect(label: string): number {
  if (label === '1') return 1;
  const [a, b] = label.split('/').map(Number);
  if (a && b) return a / b;
  return 16 / 9;
}

export const panels = new Panels();
