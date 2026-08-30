// src/director/ui/timeline-ui.ts
// 导演台时间轴 UI：播放/暂停、播放头、FPS、时长、轨道与关键帧渲染。
// 关键帧增/复制/粘贴/删除/插值 由 app（main.ts）绑定，本模块只负责渲染与播放控制。

import { timeline } from '../engine/timeline';
import { cameraManager } from '../engine/camera';
import { sceneManager } from '../engine/scene';
import { DirectorAppActions } from './app-actions';

export class TimelineUI {
  private actions: DirectorAppActions | null = null;
  private rulerEl!: HTMLElement;
  private playheadEl!: HTMLElement;
  private tracksEl!: HTMLElement;
  private timeEl!: HTMLElement;
  private playBtn!: HTMLElement;

  init(actions: DirectorAppActions): void {
    this.actions = actions;
    this.rulerEl = document.getElementById('d-tl-ruler') as HTMLElement;
    this.playheadEl = document.getElementById('d-tl-playhead') as HTMLElement;
    this.tracksEl = document.getElementById('d-tl-tracks') as HTMLElement;
    this.timeEl = document.getElementById('d-tl-time') as HTMLElement;
    this.playBtn = document.getElementById('d-tl-play') as HTMLElement;

    this.playBtn?.addEventListener('click', () => {
      timeline.togglePlay();
    });
    document.getElementById('d-tl-stop')?.addEventListener('click', () => {
      timeline.stop();
    });

    const fpsSelect = document.getElementById('d-tl-fps') as HTMLSelectElement;
    fpsSelect?.addEventListener('change', () => {
      timeline.setFps(parseInt(fpsSelect.value, 10) || 24);
      this.actions?.markDirty();
    });
    const durationInput = document.getElementById('d-tl-duration') as HTMLInputElement;
    durationInput?.addEventListener('change', () => {
      const v = parseInt(durationInput.value, 10);
      if (Number.isFinite(v)) {
        timeline.setDuration(v);
        durationInput.value = String(timeline.data.duration);
        this.actions?.markDirty();
      }
    });

    // 播放头拖动
    const rulerWrap = this.rulerEl?.parentElement;
    rulerWrap?.addEventListener('pointerdown', (e) => {
      const rect = rulerWrap.getBoundingClientRect();
      const t = ((e.clientX - rect.left) / rect.width) * timeline.data.duration;
      timeline.setPlayhead(t);
      const move = (ev: PointerEvent): void => {
        const r = rulerWrap.getBoundingClientRect();
        const tt = ((ev.clientX - r.left) / r.width) * timeline.data.duration;
        timeline.setPlayhead(tt);
      };
      const up = (): void => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    timeline.subscribe(() => this.render());
    this.render();
  }

  private render(): void {
    if (!this.timeEl) return;
    this.timeEl.textContent = `${timeline.playhead.toFixed(1)}s / ${timeline.data.duration.toFixed(1)}s`;
    this.playBtn.textContent = timeline.playing ? '⏸' : '▶';
    const fpsSelect = document.getElementById('d-tl-fps') as HTMLSelectElement;
    if (fpsSelect && fpsSelect.value !== String(timeline.data.fps)) fpsSelect.value = String(timeline.data.fps);
    const durationInput = document.getElementById('d-tl-duration') as HTMLInputElement;
    if (durationInput && durationInput.value !== String(timeline.data.duration)) durationInput.value = String(timeline.data.duration);

    const rulerWrap = this.rulerEl?.parentElement;
    if (this.playheadEl && rulerWrap) {
      const pct = (timeline.playhead / timeline.data.duration) * 100;
      this.playheadEl.style.left = `${Math.min(100, Math.max(0, pct))}%`;
    }

    if (this.rulerEl) {
      this.rulerEl.innerHTML = '';
      const seconds = Math.max(1, Math.ceil(timeline.data.duration));
      for (let s = 0; s <= seconds; s++) {
        const tick = document.createElement('span');
        tick.style.position = 'absolute';
        tick.style.left = `${(s / timeline.data.duration) * 100}%`;
        tick.style.top = '0';
        tick.style.fontSize = '10px';
        tick.style.color = 'var(--d-text-dim)';
        tick.style.transform = 'translateX(-50%)';
        tick.textContent = `${s}s`;
        this.rulerEl.appendChild(tick);
      }
    }

    this.renderTracks();
  }

  private renderTracks(): void {
    if (!this.tracksEl) return;
    const trackKeys = timeline.allTrackKeys();
    this.tracksEl.innerHTML = '';
    if (trackKeys.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'd-tl-track';
      empty.style.color = 'var(--d-text-dim)';
      empty.textContent = '暂无关键帧。选中对象/摄像机后点「＋ 关键帧」记录当前状态。';
      this.tracksEl.appendChild(empty);
      return;
    }
    for (const tk of trackKeys) {
      const row = document.createElement('div');
      row.className = 'd-tl-track';
      const name = document.createElement('span');
      name.className = 'd-tl-track-name';
      name.textContent = tk.label;
      row.appendChild(name);
      const kfs = timeline.keyframesFor(tk.trackType, tk.targetId, tk.property);
      const kfWrap = document.createElement('div');
      kfWrap.className = 'd-tl-track-kfs';
      for (const kf of kfs) {
        const kfEl = document.createElement('div');
        kfEl.className = 'd-tl-kf' + (kf.interpolation === 'hold' ? ' hold' : '') + (kf.id === timeline.selectedKeyframeId ? ' selected' : '');
        kfEl.style.left = `${(kf.time / timeline.data.duration) * 100}%`;
        kfEl.title = `t=${kf.time.toFixed(1)}s · ${kf.interpolation}`;
        kfEl.addEventListener('click', (e) => {
          e.stopPropagation();
          this.actions?.selectKeyframe(kf.id);
        });
        kfWrap.appendChild(kfEl);
      }
      row.appendChild(kfWrap);
      row.addEventListener('click', (e) => {
        const wrap = kfWrap.getBoundingClientRect();
        const rel = (e.clientX - wrap.left) / Math.max(1, wrap.width);
        timeline.setPlayhead(rel * timeline.data.duration);
      });
      this.tracksEl.appendChild(row);
    }
    const interpSelect = document.getElementById('d-kf-interp') as HTMLSelectElement;
    const sel = timeline.selectedKeyframeId ? timeline.data.keyframes.find(k => k.id === timeline.selectedKeyframeId) : null;
    if (interpSelect && sel) interpSelect.value = sel.interpolation;
  }

  /** 当前选中轨道（供 app.addKeyframeForSelection 使用） */
  currentTrack(): { trackType: 'camera' | 'object' | 'character'; targetId: string } | null {
    const camId = cameraManager.activeCameraId;
    const objId = sceneManager.selectedId;
    if (objId) {
      const handle = sceneManager.getHandle(objId);
      if (handle && handle.data.kind === 'character') {
        return { trackType: 'character', targetId: objId };
      }
      return { trackType: 'object', targetId: objId };
    }
    if (camId) return { trackType: 'camera', targetId: camId };
    return null;
  }
}

export const timelineUI = new TimelineUI();
