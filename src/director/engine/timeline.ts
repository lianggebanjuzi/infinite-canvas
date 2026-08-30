// src/director/engine/timeline.ts
// 导演台时间轴：1–60s / FPS / 播放头 / 播放暂停；
// 镜头、对象 transform、角色状态关键帧；线性/保持插值。

import * as THREE from 'three';
import {
  DirectorCharacterState,
  DirectorKeyframe,
  DirectorKeyframeTrackType,
  DirectorKeyframeValues,
  DirectorProject,
  DirectorTimeline,
  Vec3,
  uuid,
  vec3,
} from '../types';
import { sceneManager } from './scene';
import { cameraManager } from './camera';
import { characterManager } from './character';
import { referenceManager } from './reference';

export interface TimelineTrackKey {
  trackType: DirectorKeyframeTrackType;
  targetId: string;
  property: DirectorKeyframe['property'];
}

export class Timeline {
  data: DirectorTimeline = { duration: 10, fps: 24, keyframes: [] };
  playhead = 0;
  playing = false;
  private rafId: number | null = null;
  private lastTime = 0;
  private listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private notify(): void {
    this.listeners.forEach(fn => {
      try { fn(); } catch { /* 单个订阅者异常不影响整体 */ }
    });
  }

  rebuildFromProject(project: DirectorProject): void {
    this.data = {
      duration: project.timeline.duration,
      fps: project.timeline.fps,
      keyframes: JSON.parse(JSON.stringify(project.timeline.keyframes)) as DirectorKeyframe[],
    };
    this.playhead = 0;
    this.stop();
    this.notify();
  }

  /** 把时间轴数据写回工程（保存/另存前调用） */
  syncToProject(project: DirectorProject): void {
    project.timeline = {
      duration: this.data.duration,
      fps: this.data.fps,
      keyframes: JSON.parse(JSON.stringify(this.data.keyframes)) as DirectorKeyframe[],
    };
  }

  setDuration(seconds: number): void {
    this.data.duration = Math.min(60, Math.max(1, Math.round(seconds)));
    if (this.playhead > this.data.duration) this.playhead = this.data.duration;
    this.notify();
  }

  setFps(fps: number): void {
    this.data.fps = [12, 24, 30, 60].includes(fps) ? fps : 24;
    this.notify();
  }

  setPlayhead(time: number): void {
    const t = Math.min(this.data.duration, Math.max(0, time));
    this.playhead = t;
    this.applyFrame(t);
    this.notify();
  }

  play(): void {
    if (this.playing) return;
    this.playing = true;
    this.lastTime = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
    this.notify();
  }

  pause(): void {
    this.playing = false;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.notify();
  }

  stop(): void {
    this.pause();
    this.setPlayhead(0);
  }

  togglePlay(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  private tick = (now: number): void => {
    if (!this.playing) return;
    const dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    let next = this.playhead + dt;
    if (next >= this.data.duration) {
      next = this.data.duration;
      this.playhead = next;
      this.applyFrame(next);
      this.pause();
      this.notify();
      return;
    }
    this.playhead = next;
    this.applyFrame(next);
    this.notify();
    this.rafId = requestAnimationFrame(this.tick);
  };

  /** 轨道键（trackType + targetId + property） */
  trackKeyOf(kf: DirectorKeyframe): string {
    return `${kf.trackType}:${kf.targetId}:${kf.property}`;
  }

  /** 该轨道的关键帧（按时间排序） */
  keyframesFor(trackType: DirectorKeyframeTrackType, targetId: string, property: DirectorKeyframe['property']): DirectorKeyframe[] {
    return this.data.keyframes
      .filter(k => k.trackType === trackType && k.targetId === targetId && k.property === property)
      .sort((a, b) => a.time - b.time);
  }

  /** 添加/更新当前时间关键帧（捕获目标当前状态） */
  addKeyframe(trackType: DirectorKeyframeTrackType, targetId: string, property: DirectorKeyframe['property'], values: DirectorKeyframeValues, interpolation: DirectorKeyframe['interpolation'] = 'linear'): DirectorKeyframe {
    const time = this.playhead;
    const existing = this.data.keyframes.find(k =>
      k.trackType === trackType && k.targetId === targetId && k.property === property && Math.abs(k.time - time) < 0.001);
    if (existing) {
      existing.values = values;
      existing.interpolation = interpolation;
      this.notify();
      return existing;
    }
    const kf: DirectorKeyframe = {
      id: uuid(),
      time,
      trackType,
      targetId,
      property,
      values,
      interpolation,
    };
    this.data.keyframes.push(kf);
    this.notify();
    return kf;
  }

  removeKeyframe(id: string): void {
    this.data.keyframes = this.data.keyframes.filter(k => k.id !== id);
    this.notify();
  }

  /** 复制关键帧（粘贴缓冲） */
  copyKeyframe(id: string): DirectorKeyframe | null {
    const kf = this.data.keyframes.find(k => k.id === id);
    return kf ? JSON.parse(JSON.stringify(kf)) as DirectorKeyframe : null;
  }

  /** 粘贴到当前时间（新 id；无缓冲返回 null） */
  pasteKeyframe(buffer: DirectorKeyframe | null): DirectorKeyframe | null {
    if (!buffer) return null;
    const kf: DirectorKeyframe = {
      ...JSON.parse(JSON.stringify(buffer)),
      id: uuid(),
      time: this.playhead,
    };
    // 同轨道同时间去重
    this.data.keyframes = this.data.keyframes.filter(k =>
      !(k.trackType === kf.trackType && k.targetId === kf.targetId && k.property === kf.property && Math.abs(k.time - kf.time) < 0.001));
    this.data.keyframes.push(kf);
    this.notify();
    return kf;
  }

  setInterpolation(id: string, interp: DirectorKeyframe['interpolation']): void {
    const kf = this.data.keyframes.find(k => k.id === id);
    if (kf) {
      kf.interpolation = interp;
      this.notify();
    }
  }

  /** 求值：给定时间，返回该轨道的插值结果（无关键帧返回 null） */
  evaluate(trackType: DirectorKeyframeTrackType, targetId: string, property: DirectorKeyframe['property'], time: number): DirectorKeyframeValues | null {
    const kfs = this.keyframesFor(trackType, targetId, property);
    if (kfs.length === 0) return null;
    if (time <= kfs[0].time) return cloneValues(kfs[0].values);
    if (time >= kfs[kfs.length - 1].time) return cloneValues(kfs[kfs.length - 1].values);

    let a = kfs[0];
    let b = kfs[kfs.length - 1];
    for (let i = 0; i < kfs.length - 1; i++) {
      if (time >= kfs[i].time && time <= kfs[i + 1].time) {
        a = kfs[i];
        b = kfs[i + 1];
        break;
      }
    }
    if (a.interpolation === 'hold') return cloneValues(a.values);
    const span = Math.max(1e-6, b.time - a.time);
    const t = (time - a.time) / span;
    return interpolateValues(a.values, b.values, t);
  }

  /** 把当前时间帧应用到场景/相机/角色（播放与拖播放头共用） */
  applyFrame(time: number): void {
    const t = Math.min(this.data.duration, Math.max(0, time));

    // 场景对象 transform
    for (const handle of sceneManager.handles.values()) {
      const obj = handle.data;
      if (obj.locked) continue;

      const pos = this.evaluate('object', obj.id, 'position', t);
      const rot = this.evaluate('object', obj.id, 'rotation', t);
      const scl = this.evaluate('object', obj.id, 'scale', t);
      if (pos && pos.type === 'vec3') obj.position = { ...pos.value };
      if (rot && rot.type === 'vec3') obj.rotation = { ...rot.value };
      if (scl && scl.type === 'vec3') obj.scale = { ...scl.value };
      sceneManager.applyObjectState(obj, handle.root);

      // 角色姿势关键帧
      if (obj.kind === 'character') {
        const pose = this.evaluate('character', obj.id, 'pose', t);
        if (pose && pose.type === 'pose') {
          characterManager.applyPoseKeyframe(obj.id, pose.value);
        } else if (obj.character) {
          characterManager.applyStoredPose(obj.id, obj.character);
        }
      }
    }

    // 摄像机
    for (const cam of cameraManager.cameras) {
      const camKf = this.evaluate('camera', cam.id, 'camera', t);
      if (camKf && camKf.type === 'camera') {
        cameraManager.applyKeyframeParams(cam.id, camKf.value);
      } else {
        cameraManager.applyToThree(cam);
      }
    }
    void referenceManager;
  }

  /** 全部轨道键（UI 轨道列表用） */
  allTrackKeys(): Array<{ key: string; trackType: DirectorKeyframeTrackType; targetId: string; property: DirectorKeyframe['property']; label: string }> {
    const seen = new Map<string, { key: string; trackType: DirectorKeyframeTrackType; targetId: string; property: DirectorKeyframe['property']; label: string }>();
    for (const kf of this.data.keyframes) {
      const key = this.trackKeyOf(kf);
      if (seen.has(key)) continue;
      seen.set(key, {
        key,
        trackType: kf.trackType,
        targetId: kf.targetId,
        property: kf.property,
        label: this.trackLabel(kf),
      });
    }
    return [...seen.values()];
  }

  private trackLabel(kf: DirectorKeyframe): string {
    const name = kf.trackType === 'camera'
      ? cameraManager.getCamera(kf.targetId)?.name ?? '摄像机'
      : sceneManager.getHandle(kf.targetId)?.data.name ?? '对象';
    const propLabel: Record<DirectorKeyframe['property'], string> = {
      position: '位置', rotation: '旋转', scale: '缩放', camera: '取景', pose: '姿势',
    };
    return `${name} · ${propLabel[kf.property]}`;
  }

  get selectedKeyframeId(): string | null {
    return this._selectedKeyframeId;
  }
  set selectedKeyframeId(id: string | null) {
    this._selectedKeyframeId = id;
    this.notify();
  }
  private _selectedKeyframeId: string | null = null;
}

function cloneValues(v: DirectorKeyframeValues): DirectorKeyframeValues {
  return JSON.parse(JSON.stringify(v)) as DirectorKeyframeValues;
}

function lerpVec(a: Vec3, b: Vec3, t: number): Vec3 {
  return vec3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
}

function interpolateValues(a: DirectorKeyframeValues, b: DirectorKeyframeValues, t: number): DirectorKeyframeValues {
  if (a.type === 'vec3' && b.type === 'vec3') {
    return { type: 'vec3', value: lerpVec(a.value, b.value, t) };
  }
  if (a.type === 'camera' && b.type === 'camera') {
    return {
      type: 'camera',
      value: {
        position: lerpVec(a.value.position, b.value.position, t),
        rotation: lerpVec(a.value.rotation, b.value.rotation, t),
        target: a.value.target && b.value.target ? lerpVec(a.value.target, b.value.target, t) : (a.value.target ?? b.value.target),
        fov: a.value.fov + (b.value.fov - a.value.fov) * t,
        aspect: a.value.aspect + (b.value.aspect - a.value.aspect) * t,
      },
    };
  }
  if (a.type === 'pose' && b.type === 'pose') {
    // 姿势：关节角线性插值（逐关节）
    const joints: Record<string, Vec3> = {};
    const allNames = new Set([...Object.keys(a.value.joints), ...Object.keys(b.value.joints)]);
    for (const name of allNames) {
      const ja = a.value.joints[name] ?? { x: 0, y: 0, z: 0 };
      const jb = b.value.joints[name] ?? { x: 0, y: 0, z: 0 };
      joints[name] = lerpVec(ja, jb, t);
    }
    const state: DirectorCharacterState = {
      rootPosition: lerpVec(a.value.rootPosition, b.value.rootPosition, t),
      rootRotation: lerpVec(a.value.rootRotation, b.value.rootRotation, t),
      poseName: t < 0.5 ? a.value.poseName : b.value.poseName,
      joints,
    };
    return { type: 'pose', value: state };
  }
  return cloneValues(t < 0.5 ? a : b);
}

export const timeline = new Timeline();
