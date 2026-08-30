// src/director/ui/app-actions.ts
// 导演台 UI → 应用协调器的动作接口（避免 UI 模块与 main.ts 循环依赖）。
// main.ts 实现这些动作（内含 undo.push + 工程数据同步 + 场景重建）。

import { DirectorObjectKind } from '../types';
import { TransformTool, ViewMode } from './viewport';

export interface DirectorAppActions {
  // 场景对象
  addObject(kind: DirectorObjectKind): void;
  deleteObject(id: string): void;
  duplicateObject(id: string): void;
  toggleObjectVisible(id: string): void;
  toggleObjectLocked(id: string): void;
  selectObject(id: string | null): void;
  renameObject(id: string, name: string): void;
  // 变换工具
  setTool(tool: TransformTool): void;
  setSpace(space: 'world' | 'local'): void;
  setSnap(enabled: boolean, step: number): void;
  groundSelected(): void;
  focusSelected(): void;
  // 导入
  importGltf(): void;
  importImage(): void;
  // 摄像机
  addCamera(): void;
  duplicateCamera(id: string): void;
  renameCamera(id: string): void;
  deleteCamera(id: string): void;
  selectCamera(id: string): void;
  setCameraFov(fov: number): void;
  setCameraAspect(aspect: number): void;
  setCameraIncludeExport(include: boolean): void;
  // 参考图
  addReference(): void;
  deleteReference(id: string): void;
  selectReference(id: string | null): void;
  setReferenceOpacity(id: string, opacity: number): void;
  toggleReferenceVisible(id: string): void;
  toggleReferenceExport(id: string): void;
  // 光照
  setLightingField(field: string, value: string | number): void;
  restoreDefaultLighting(): void;
  // 人物
  applyPosePreset(name: string): void;
  storePose(): void;
  toggleIkMode(): void;
  // 视图
  setViewMode(mode: ViewMode): void;
  // 时间轴
  addKeyframeForSelection(): void;
  copySelectedKeyframe(): void;
  pasteKeyframeAtPlayhead(): void;
  deleteSelectedKeyframe(): void;
  setSelectedKeyframeInterpolation(interp: 'linear' | 'hold'): void;
  selectKeyframe(id: string): void;
  // 工程
  markDirty(): void;
  refreshAll(): void;
}
