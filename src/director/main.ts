// src/director/main.ts
// 导演台（4.4 MONOFORM 式导演台）独立入口：应用协调器。
// 负责：启动编排、工程 新建/打开/保存/另存、撤销/重做、所有 UI 动作实现、
// PNG/MP4 导出、回传画布（D5）。WebGL 不可用时降级为「静态说明 + 导入/导出选项」。

import './styles.css';

import { projectStore } from './engine/project-store';
import { directorUndo } from './engine/undo';
import { sceneManager } from './engine/scene';
import { cameraManager } from './engine/camera';
import { referenceManager } from './engine/reference';
import { lightingManager } from './engine/lighting';
import { characterManager } from './engine/character';
import { timeline } from './engine/timeline';
import { viewport, ViewMode, TransformTool } from './ui/viewport';
import { shell, ShellActions } from './ui/shell';
import { hierarchyPanel } from './ui/hierarchy';
import { panels } from './ui/panels';
import { monitor } from './ui/monitor';
import { timelineUI } from './ui/timeline-ui';
import { toast } from './ui/toast';
import { DirectorAppActions } from './ui/app-actions';
import { exportPng } from './export/png';
import { exportMp4, Mp4ExportResult } from './export/mp4';
import { importGltfViaDialog } from './import/gltf';
import {
  DirectorKeyframe,
  DirectorKeyframeValues,
  DirectorObjectKind,
  DirectorProject,
  vec3,
} from './types';

interface LaunchOptions {
  projectPath?: string;
  imagePath?: string;
  imageName?: string;
  sourceProjectId?: string;
  sourceNodeId?: string;
}

interface ReturnPayload {
  kind: 'png' | 'mp4';
  path: string;
  projectId: string;
  cameraId: string;
  time: number;
  shotId?: string;
  sourceProjectId?: string;
  sourceNodeId?: string;
}

function waitForPywebview(): Promise<void> {
  return new Promise(resolve => {
    const w = window as unknown as { pywebview?: unknown };
    if (w.pywebview) {
      resolve();
    } else {
      window.addEventListener('pywebviewready', () => resolve(), { once: true });
      setTimeout(() => resolve(), 2000);
    }
  });
}

class DirectorApp implements DirectorAppActions, ShellActions {
  private saveState: 'saved' | 'dirty' = 'saved';
  private webglOk = false;
  private launchOptions: LaunchOptions = {};
  private keyframeClipboard: DirectorKeyframe | null = null;
  private lastExport: { path: string; kind: 'png' | 'mp4' } | null = null;
  private mp4Exporting = false;
  private exportCancelled = false;
  private lastUndoPush = 0;

  // ── 启动 ──
  async boot(): Promise<void> {
    await waitForPywebview();
    await this.fetchLaunchOptions();

    // UI 初始化
    shell.init(this);
    hierarchyPanel.init(this);
    panels.init(this);
    timelineUI.init(this);
    monitor.init((mode) => { void mode; });
    this.bindTimelineKeyframeButtons();
    document.getElementById('d-export-cancel')?.addEventListener('click', () => this.cancelExport());

    // 引擎
    lightingManager.init();

    // 视口（WebGL）
    this.webglOk = viewport.init(() => this.onSelectionChanged());
    if (!this.webglOk) {
      shell.showWebglFallback();
      toast.error('WebGL 不可用：3D 视口已降级，仍可新建/打开/保存工程');
    }

    // 工程：优先打开传入路径，否则新建空工程
    if (this.launchOptions.projectPath) {
      const res = await projectStore.openProject(this.launchOptions.projectPath);
      if (res.status === 'success' && res.project) {
        this.applyProject(res.project);
        shell.showSuccess(`已打开工程：${res.project.name}`);
      } else {
        this.newProject();
      }
    } else {
      this.newProject();
    }

    // D5：画布选图作为参考图导入
    if (this.launchOptions.imagePath) {
      const name = this.launchOptions.imageName || '画布参考图';
      this.addReferenceFromPath(this.launchOptions.imagePath, name);
    }

    this.refreshShell();
    this.validateResourcesAfterOpen();
  }

  private async fetchLaunchOptions(): Promise<void> {
    try {
      const w = window as unknown as { pywebview?: { api?: { director_get_launch_options(): Promise<Record<string, unknown>> } } };
      const res = await w.pywebview?.api?.director_get_launch_options();
      if (res) {
        this.launchOptions = {
          projectPath: typeof res.projectPath === 'string' ? res.projectPath : undefined,
          imagePath: typeof res.imagePath === 'string' ? res.imagePath : undefined,
          imageName: typeof res.imageName === 'string' ? res.imageName : undefined,
          sourceProjectId: typeof res.sourceProjectId === 'string' ? res.sourceProjectId : undefined,
          sourceNodeId: typeof res.sourceNodeId === 'string' ? res.sourceNodeId : undefined,
        };
      }
    } catch {
      // 启动参数缺失时按空工程处理
    }
  }

  private bindTimelineKeyframeButtons(): void {
    document.getElementById('d-kf-add')?.addEventListener('click', () => this.addKeyframeForSelection());
    document.getElementById('d-kf-copy')?.addEventListener('click', () => this.copySelectedKeyframe());
    document.getElementById('d-kf-paste')?.addEventListener('click', () => this.pasteKeyframeAtPlayhead());
    document.getElementById('d-kf-delete')?.addEventListener('click', () => this.deleteSelectedKeyframe());
    document.getElementById('d-kf-interp')?.addEventListener('change', (e) => {
      const v = (e.target as HTMLSelectElement).value;
      this.setSelectedKeyframeInterpolation(v === 'hold' ? 'hold' : 'linear');
    });
  }

  // ── 工程应用/重建 ──
  private applyProject(project: DirectorProject): void {
    projectStore.current = project;
    this.rebuildAll();
  }

  private rebuildAll(): void {
    const project = projectStore.current;
    if (!project) return;
    sceneManager.rebuildFromProject(project);
    cameraManager.rebuildFromProject(project);
    referenceManager.rebuildFromProject(project);
    lightingManager.rebuildFromProject(project.lighting);
    timeline.rebuildFromProject(project);
    sceneManager.select(null);
    referenceManager.select(null);
    if (this.webglOk) viewport.refreshTransformAttachment();
    shell.setProjectName(project.name);
    monitor.refresh();
    panels.refreshAll();
    hierarchyPanel.refresh();
    this.saveState = 'dirty';
    this.refreshShell();
  }

  private newProject(): void {
    const project = projectStore.createBlank('未命名导演工程');
    directorUndo.reset();
    this.rebuildAll();
    this.markDirty();
    toast.info('已新建空导演工程');
  }

  // ── 快照与撤销 ──
  private takeSnapshot(): DirectorProject | null {
    if (!projectStore.current) return null;
    return JSON.parse(JSON.stringify(projectStore.current)) as DirectorProject;
  }

  private pushUndo(): void {
    const now = Date.now();
    if (now - this.lastUndoPush < 250) return; // 滑块连续输入节流
    this.lastUndoPush = now;
    const snap = this.takeSnapshot();
    if (snap) directorUndo.push(snap);
  }

  onUndo(): void {
    const current = projectStore.current;
    if (!current) return;
    const prev = directorUndo.undo(current);
    if (!prev) { shell.showInfo('没有可撤销的操作'); return; }
    projectStore.current = prev;
    this.rebuildAll();
    shell.showInfo('已撤销');
  }

  onRedo(): void {
    const current = projectStore.current;
    if (!current) return;
    const next = directorUndo.redo(current);
    if (!next) { shell.showInfo('没有可重做的操作'); return; }
    projectStore.current = next;
    this.rebuildAll();
    shell.showInfo('已重做');
  }

  canUndo(): boolean { return directorUndo.canUndo(); }
  canRedo(): boolean { return directorUndo.canRedo(); }

  // ── 文件 ──
  async onNew(): Promise<void> {
    if (this.saveState === 'dirty' && !window.confirm('当前工程有未保存修改，确定新建？')) return;
    this.newProject();
  }

  async onOpen(): Promise<void> {
    const res = await projectStore.openDialog();
    if (res.status === 'cancelled') return;
    if (res.status === 'success' && res.project) {
      directorUndo.reset();
      this.applyProject(res.project);
      this.validateResourcesAfterOpen();
      shell.showSuccess(`已打开工程：${res.project.name}`);
    } else {
      shell.showError(res.message || '打开工程失败');
    }
  }

  async onSave(): Promise<void> {
    if (!projectStore.current) return;
    this.syncTimelineToProject();
    const res = await projectStore.save();
    if (res.status === 'success') {
      this.saveState = 'saved';
      this.refreshShell();
      void projectStore.touchRecent();
      shell.showSuccess(`已保存：${res.path}`);
    } else if (res.status === 'cancelled') {
      // 无路径时 save() 转 saveAs，取消即返回
    } else {
      shell.showError(res.message || '保存失败');
    }
  }

  async onSaveAs(): Promise<void> {
    if (!projectStore.current) return;
    this.syncTimelineToProject();
    const res = await projectStore.saveAs();
    if (res.status === 'success') {
      this.saveState = 'saved';
      this.refreshShell();
      void projectStore.touchRecent();
      shell.showSuccess(`已另存为：${res.path}`);
    } else if (res.status === 'cancelled') {
      // 取消
    } else {
      shell.showError(res.message || '另存失败');
    }
  }

  private syncTimelineToProject(): void {
    if (projectStore.current) {
      timeline.syncToProject(projectStore.current);
      if (projectStore.current.meta) projectStore.current.meta.updatedAt = Date.now();
    }
  }

  /** 打开后校验引用资源是否存在（后端逐个校验，缺失 toast 提示） */
  private async validateResourcesAfterOpen(): Promise<void> {
    const project = projectStore.current;
    if (!project) return;
    const paths: string[] = [];
    for (const asset of project.assets) if (asset.path) paths.push(asset.path);
    for (const ref of project.references) if (ref.assetRef.path) paths.push(ref.assetRef.path);
    for (const obj of project.scene) if (obj.assetRef?.path) paths.push(obj.assetRef.path);
    if (paths.length === 0) return;
    try {
      const w = window as unknown as { pywebview?: { api?: { director_validate_resource(path: string): Promise<{ status: string; exists?: boolean }> } } };
      const missing: string[] = [];
      for (const p of paths) {
        try {
          const res = await w.pywebview?.api?.director_validate_resource(p);
          if (res && res.exists === false) missing.push(p);
        } catch {
          // 单条校验失败忽略
        }
      }
      if (missing.length > 0) {
        toast.error(`工程引用了 ${missing.length} 个缺失资源（图片/模型），相关对象已降级显示`);
      }
    } catch {
      // 后端不可用时跳过校验
    }
  }

  // ── 场景对象 ──
  addObject(kind: DirectorObjectKind): void {
    this.pushUndo();
    const project = projectStore.current;
    if (!project) return;
    const obj = sceneManager.createObjectData(kind);
    project.scene.push(obj);
    this.selectObject(obj.id);
    this.markDirty();
  }

  deleteObject(id: string): void {
    this.pushUndo();
    const project = projectStore.current;
    if (!project) return;
    project.scene = project.scene.filter(o => o.id !== id);
    sceneManager.removeObject(id);
    // 删除该对象的关键帧
    timeline.data.keyframes = timeline.data.keyframes.filter(k => !(k.targetId === id && k.trackType !== 'camera'));
    this.markDirty();
    this.refreshAll();
  }

  duplicateObject(id: string): void {
    this.pushUndo();
    const project = projectStore.current;
    const src = project?.scene.find(o => o.id === id);
    if (!project || !src) return;
    const copy = JSON.parse(JSON.stringify(src)) as typeof src;
    copy.id = crypto.randomUUID?.() ?? String(Date.now());
    copy.name = `${src.name} 副本`;
    copy.position = vec3(src.position.x + 0.5, src.position.y, src.position.z + 0.5);
    const handle = sceneManager.buildHandle(copy);
    sceneManager.handles.set(copy.id, handle);
    sceneManager.scene.add(handle.root);
    project.scene.push(copy);
    this.selectObject(copy.id);
    this.markDirty();
  }

  toggleObjectVisible(id: string): void {
    this.pushUndo();
    const project = projectStore.current;
    const obj = project?.scene.find(o => o.id === id);
    if (!obj) return;
    obj.visible = !obj.visible;
    const handle = sceneManager.getHandle(id);
    if (handle) handle.root.visible = obj.visible;
    this.markDirty();
    this.refreshAll();
  }

  toggleObjectLocked(id: string): void {
    this.pushUndo();
    const project = projectStore.current;
    const obj = project?.scene.find(o => o.id === id);
    if (!obj) return;
    obj.locked = !obj.locked;
    if (obj.locked && sceneManager.selectedId === id) {
      sceneManager.select(null);
      referenceManager.select(null);
      if (this.webglOk) viewport.refreshTransformAttachment();
      hierarchyPanel.setSelection(null);
    }
    this.markDirty();
    this.refreshAll();
  }

  selectObject(id: string | null): void {
    sceneManager.select(id);
    referenceManager.select(null);
    if (this.webglOk) viewport.refreshTransformAttachment();
    hierarchyPanel.setSelection(id);
    panels.refreshAll();
  }

  renameObject(id: string, name: string): void {
    this.pushUndo();
    const project = projectStore.current;
    const obj = project?.scene.find(o => o.id === id);
    if (!obj) return;
    obj.name = name;
    const handle = sceneManager.getHandle(id);
    if (handle) handle.root.name = name;
    this.markDirty();
    this.refreshAll();
  }

  onSelectionChanged(): void {
    hierarchyPanel.setSelection(sceneManager.selectedId);
    panels.refreshAll();
  }

  // ── 变换工具 ──
  setTool(tool: TransformTool): void {
    if (this.webglOk) viewport.setTool(tool);
  }

  setSpace(space: 'world' | 'local'): void {
    if (this.webglOk) viewport.setSpace(space);
  }

  setSnap(enabled: boolean, step: number): void {
    if (this.webglOk) viewport.setSnap(enabled, step);
  }

  groundSelected(): void {
    const id = sceneManager.selectedId;
    if (!id) { shell.showInfo('请先选中一个对象'); return; }
    this.pushUndo();
    sceneManager.groundObject(id);
    this.markDirty();
  }

  focusSelected(): void {
    if (this.webglOk) viewport.focusObject(sceneManager.selectedId);
  }

  // ── 导入 ──
  async importGltf(): Promise<void> {
    const res = await importGltfViaDialog();
    if (res.status === 'cancelled') return;
    if (res.status === 'error' || !res.object) {
      shell.showError(res.message || '导入模型失败');
      return;
    }
    this.pushUndo();
    const project = projectStore.current;
    if (project) {
      project.scene.push(res.object);
      if (res.assetRef) {
        project.assets = project.assets.filter(a => a.resourceId !== res.assetRef!.resourceId);
        project.assets.push(res.assetRef);
      }
    }
    this.selectObject(res.object.id);
    this.markDirty();
    const stats = res.stats;
    shell.showSuccess(`模型已导入：${stats ? `${(stats.vertices / 1000).toFixed(1)}k 顶点 · ${stats.textures} 贴图` : ''}`);
  }

  async importImage(): Promise<void> {
    const input = document.getElementById('d-file-input') as HTMLInputElement;
    if (!input) return;
    input.accept = 'image/*';
    input.value = '';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 50 * 1024 * 1024) {
        shell.showError('参考图超过 50MB 限制');
        return;
      }
      const dataUrl = await readFileAsDataUrl(file);
      // 保存到磁盘（获取可持久化的路径）
      const w = window as unknown as { pywebview?: { api?: { director_save_image_from_data_url(dataUrl: string, filename?: string): Promise<{ status: string; path?: string; message?: string }> } } };
      let path = '';
      try {
        const res = await w.pywebview?.api?.director_save_image_from_data_url(dataUrl, `director-ref-${Date.now()}.png`);
        if (res?.status === 'success' && res.path) path = res.path;
      } catch {
        // 后端不可用时仅内存引用
      }
      this.pushUndo();
      const ref = referenceManager.addFromDataUrl(path || dataUrl, file.name || '参考图');
      const project = projectStore.current;
      if (project) {
        project.references.push(ref);
        if (ref.assetRef) {
          project.assets = project.assets.filter(a => a.resourceId !== ref.assetRef!.resourceId);
          project.assets.push(ref.assetRef);
        }
      }
      referenceManager.select(ref.id);
      this.markDirty();
      this.refreshAll();
      shell.showSuccess(`参考图已添加：${ref.name}`);
    };
    input.click();
  }

  private addReferenceFromPath(path: string, name: string): void {
    this.pushUndo();
    const ref = referenceManager.addFromPath(path, name);
    const project = projectStore.current;
    if (project) {
      project.references.push(ref);
      if (ref.assetRef) {
        project.assets = project.assets.filter(a => a.resourceId !== ref.assetRef!.resourceId);
        project.assets.push(ref.assetRef);
      }
    }
    referenceManager.select(ref.id);
    this.markDirty();
    this.refreshAll();
  }

  // ── 摄像机 ──
  addCamera(): void {
    this.pushUndo();
    const project = projectStore.current;
    if (!project) return;
    const cam = cameraManager.createCamera('摄像机', this.webglOk ? {
      position: viewport.editCamera.position.clone(),
      rotation: viewport.editCamera.rotation.clone(),
    } : undefined);
    project.cameras.push(cam);
    project.activeCameraId = cam.id;
    cameraManager.setActive(cam.id);
    this.markDirty();
    this.refreshAll();
    monitor.refresh();
  }

  duplicateCamera(id: string): void {
    this.pushUndo();
    const project = projectStore.current;
    const copy = cameraManager.duplicateCamera(id);
    if (!project || !copy) return;
    project.cameras.push(copy);
    this.markDirty();
    this.refreshAll();
    monitor.refresh();
  }

  renameCamera(id: string): void {
    const cam = cameraManager.getCamera(id);
    if (!cam) return;
    const next = window.prompt('重命名摄像机', cam.name);
    if (next && next.trim()) {
      this.pushUndo();
      cameraManager.renameCamera(id, next.trim());
      this.markDirty();
      this.refreshAll();
      monitor.refresh();
    }
  }

  deleteCamera(id: string): void {
    if (cameraManager.cameras.length <= 1) {
      shell.showInfo('至少保留一台摄像机');
      return;
    }
    this.pushUndo();
    const project = projectStore.current;
    if (!project) return;
    cameraManager.deleteCamera(id);
    project.cameras = JSON.parse(JSON.stringify(cameraManager.cameras));
    project.activeCameraId = cameraManager.activeCameraId;
    // 删除该相机的关键帧
    timeline.data.keyframes = timeline.data.keyframes.filter(k => !(k.trackType === 'camera' && k.targetId === id));
    this.markDirty();
    this.refreshAll();
    monitor.refresh();
  }

  selectCamera(id: string): void {
    cameraManager.setActive(id);
    const project = projectStore.current;
    if (project) project.activeCameraId = id;
    this.markDirty();
    this.refreshAll();
    monitor.refresh();
  }

  setCameraFov(fov: number): void {
    this.pushUndo();
    const cam = cameraManager.getActive();
    const project = projectStore.current;
    if (cam && project) {
      cam.fov = fov;
      const pcam = project.cameras.find(c => c.id === cam.id);
      if (pcam) pcam.fov = fov;
      cameraManager.applyToThree(cam);
      this.markDirty();
    }
  }

  setCameraAspect(aspect: number): void {
    this.pushUndo();
    const cam = cameraManager.getActive();
    const project = projectStore.current;
    if (cam && project && aspect > 0) {
      cam.aspect = aspect;
      const pcam = project.cameras.find(c => c.id === cam.id);
      if (pcam) pcam.aspect = aspect;
      cameraManager.applyToThree(cam);
      this.markDirty();
    }
  }

  setCameraIncludeExport(include: boolean): void {
    this.pushUndo();
    const cam = cameraManager.getActive();
    const project = projectStore.current;
    if (cam && project) {
      cam.includeInExport = include;
      const pcam = project.cameras.find(c => c.id === cam.id);
      if (pcam) pcam.includeInExport = include;
      this.markDirty();
    }
  }

  // ── 参考图 ──
  addReference(): void {
    void this.importImage();
  }

  deleteReference(id: string): void {
    this.pushUndo();
    const project = projectStore.current;
    if (project) project.references = project.references.filter(r => r.id !== id);
    referenceManager.remove(id);
    this.markDirty();
    this.refreshAll();
  }

  selectReference(id: string | null): void {
    referenceManager.select(id);
    sceneManager.select(null);
    if (this.webglOk) viewport.refreshTransformAttachment();
    this.refreshAll();
  }

  setReferenceOpacity(id: string, opacity: number): void {
    this.pushUndo();
    const project = projectStore.current;
    const ref = project?.references.find(r => r.id === id);
    if (ref) ref.opacity = opacity;
    referenceManager.setOpacity(id, opacity);
    this.markDirty();
    this.refreshAll();
  }

  toggleReferenceVisible(id: string): void {
    this.pushUndo();
    const project = projectStore.current;
    const ref = project?.references.find(r => r.id === id);
    if (ref) ref.visible = !ref.visible;
    referenceManager.setVisible(id, ref?.visible ?? false);
    this.markDirty();
    this.refreshAll();
  }

  toggleReferenceExport(id: string): void {
    this.pushUndo();
    const project = projectStore.current;
    const ref = project?.references.find(r => r.id === id);
    if (ref) {
      ref.includeInExport = !ref.includeInExport;
      referenceManager.setIncludeInExport(id, ref.includeInExport);
    }
    this.markDirty();
    this.refreshAll();
  }

  // ── 光照 ──
  setLightingField(field: string, value: string | number): void {
    const project = projectStore.current;
    if (!project) return;
    const l = project.lighting;
    const num = typeof value === 'number' ? value : parseFloat(value);
    switch (field) {
      case 'exposure': l.exposure = num; break;
      case 'ambientIntensity': l.ambientIntensity = num; break;
      case 'ambientColor': l.ambientColor = value as string; break;
      case 'keyIntensity': l.keyIntensity = num; break;
      case 'keyColor': l.keyColor = value as string; break;
      case 'fillIntensity': l.fillIntensity = num; break;
      case 'fillColor': l.fillColor = value as string; break;
      case 'background': l.background = value as string; break;
      default: return;
    }
    lightingManager.apply(l);
    this.throttledLightingDirty();
    panels.refreshLighting();
  }

  private throttledLightingDirty(): void {
    this.pushUndo();
    this.markDirty();
  }

  restoreDefaultLighting(): void {
    this.pushUndo();
    const project = projectStore.current;
    if (!project) return;
    project.lighting = lightingManager.restoreDefault();
    this.markDirty();
    this.refreshAll();
  }

  // ── 人物 ──
  applyPosePreset(name: string): void {
    const id = sceneManager.selectedId ?? characterManager.firstCharacterId();
    if (!id) {
      shell.showInfo('场景中没有人物对象');
      return;
    }
    this.pushUndo();
    if (characterManager.applyPreset(id, name)) {
      characterManager.syncIkTargets(id);
      this.markDirty();
      this.refreshAll();
      shell.showSuccess(`已应用姿势：${name}`);
    } else {
      shell.showError('所选对象不是人物');
    }
  }

  storePose(): void {
    const id = sceneManager.selectedId ?? characterManager.firstCharacterId();
    if (!id) { shell.showInfo('场景中没有人物对象'); return; }
    this.pushUndo();
    if (characterManager.storePose(id)) {
      this.markDirty();
      this.refreshAll();
      shell.showSuccess('当前姿势已保存到工程');
    } else {
      shell.showError('所选对象不是人物');
    }
  }

  toggleIkMode(): void {
    if (!characterManager.hasCharacter()) {
      shell.showInfo('场景中没有人物对象，无法开启 IK');
      return;
    }
    characterManager.ikMode = !characterManager.ikMode;
    this.refreshAll();
    shell.showInfo(characterManager.ikMode ? 'IK 模式已开启：拖动白色末端小球调整手/脚' : 'IK 模式已关闭');
  }

  // ── 视图 ──
  setViewMode(mode: ViewMode): void {
    viewport.setViewMode(mode);
    monitor.setViewMode(mode);
  }

  // ── 时间轴关键帧 ──
  addKeyframeForSelection(): void {
    const track = timelineUI.currentTrack();
    if (!track) {
      shell.showInfo('请先选中一个对象或摄像机，再添加关键帧');
      return;
    }
    this.pushUndo();
    const time = timeline.playhead;
    const interp: DirectorKeyframe['interpolation'] = 'linear';

    if (track.trackType === 'camera') {
      const params = cameraManager.collectParams(track.targetId);
      if (params) {
        const values: DirectorKeyframeValues = { type: 'camera', value: params };
        timeline.addKeyframe('camera', track.targetId, 'camera', values, interp);
      }
    } else if (track.trackType === 'character') {
      const pose = characterManager.collectPose(track.targetId);
      if (pose) {
        const values: DirectorKeyframeValues = { type: 'pose', value: pose };
        timeline.addKeyframe('character', track.targetId, 'pose', values, interp);
      }
    } else {
      const handle = sceneManager.getHandle(track.targetId);
      if (!handle) return;
      sceneManager.readObjectTransform(handle.data, handle.root);
      const values: DirectorKeyframeValues = {
        type: 'vec3',
        value: { ...handle.data.position },
      };
      timeline.addKeyframe('object', track.targetId, 'position', values, interp);
    }
    this.markDirty();
    shell.showSuccess(`已在 ${time.toFixed(1)}s 添加关键帧`);
  }

  copySelectedKeyframe(): void {
    const id = timeline.selectedKeyframeId;
    if (!id) { shell.showInfo('请先点击选中一个关键帧'); return; }
    this.keyframeClipboard = timeline.copyKeyframe(id);
    if (this.keyframeClipboard) shell.showSuccess('关键帧已复制');
  }

  pasteKeyframeAtPlayhead(): void {
    if (!this.keyframeClipboard) { shell.showInfo('剪贴板为空（先复制关键帧）'); return; }
    this.pushUndo();
    const kf = timeline.pasteKeyframe(this.keyframeClipboard);
    if (kf) {
      timeline.selectedKeyframeId = kf.id;
      this.markDirty();
      shell.showSuccess(`已粘贴到 ${timeline.playhead.toFixed(1)}s`);
    }
  }

  deleteSelectedKeyframe(): void {
    const id = timeline.selectedKeyframeId;
    if (!id) { shell.showInfo('请先点击选中一个关键帧'); return; }
    this.pushUndo();
    timeline.removeKeyframe(id);
    timeline.selectedKeyframeId = null;
    this.markDirty();
    shell.showSuccess('关键帧已删除');
  }

  setSelectedKeyframeInterpolation(interp: 'linear' | 'hold'): void {
    const id = timeline.selectedKeyframeId;
    if (!id) return;
    this.pushUndo();
    timeline.setInterpolation(id, interp);
    this.markDirty();
  }

  selectKeyframe(id: string): void {
    timeline.selectedKeyframeId = id;
    panels.refreshAll();
  }

  // ── 导出 ──
  async onExportPng(): Promise<void> {
    const res = await exportPng();
    if (res.status === 'success') {
      this.lastExport = res.path ? { path: res.path, kind: 'png' } : this.lastExport;
      shell.showSuccess(res.path ? `PNG 已导出：${res.path}` : 'PNG 已生成（未保存）');
    } else {
      shell.showError(res.message || '导出 PNG 失败');
    }
  }

  async onExportMp4(): Promise<void> {
    if (this.mp4Exporting) {
      shell.showInfo('已有导出任务进行中');
      return;
    }
    this.mp4Exporting = true;
    this.exportCancelled = false;
    this.showExportProgress(true, '准备导出…', 0);
    shell.showInfo('开始导出视频（低分辨率/短时长验证）…可随时取消');
    const res = await exportMp4({
      height: 360,
      fps: Math.min(24, timeline.data.fps),
      onProgress: (done, total) => {
        const pct = Math.round((done / total) * 100);
        this.showExportProgress(true, `编码中 ${done}/${total} 帧（${pct}%）`, pct);
      },
      shouldCancel: () => this.exportCancelled,
    });
    this.mp4Exporting = false;
    this.showExportProgress(false, '', 0);
    this.handleMp4Result(res);
  }

  private handleMp4Result(res: Mp4ExportResult): void {
    if (res.status === 'success') {
      this.lastExport = res.path ? { path: res.path, kind: 'mp4' } : this.lastExport;
      const containerNote = res.container === 'webm' ? '（当前环境不支持 MP4，已回退 WebM/VP9）' : '';
      shell.showSuccess(res.path ? `视频已导出：${res.path}${containerNote}` : `视频已编码${containerNote}`);
    } else if (res.status === 'cancelled') {
      shell.showInfo('导出已取消，应用仍可继续使用');
    } else {
      shell.showError(res.message || '导出视频失败');
    }
  }

  cancelExport(): void {
    this.exportCancelled = true;
  }

  private showExportProgress(show: boolean, text: string, pct: number): void {
    const el = document.getElementById('d-export-progress');
    const textEl = document.getElementById('d-export-progress-text');
    const barEl = document.getElementById('d-export-progress-bar');
    if (!el) return;
    el.style.display = show ? 'flex' : 'none';
    if (textEl) textEl.textContent = text;
    if (barEl) barEl.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  }

  // ── 回传画布（D5）──
  async onReturnCanvas(): Promise<void> {
    // 优先回传最近一次导出；无则先导出一张 PNG
    let path = this.lastExport?.path ?? '';
    let kind: 'png' | 'mp4' = this.lastExport?.kind ?? 'png';
    if (!path) {
      const res = await exportPng();
      if (res.status === 'success' && res.path) {
        path = res.path;
        kind = 'png';
        this.lastExport = { path, kind };
      } else {
        shell.showError('请先成功导出一次，再回传画布');
        return;
      }
    }
    if (!projectStore.current) return;
    const camId = cameraManager.activeCameraId;
    const payload: ReturnPayload = {
      kind,
      path,
      projectId: projectStore.current.id,
      cameraId: camId,
      time: Math.round(timeline.playhead * 100) / 100,
      sourceProjectId: projectStore.current.meta?.sourceProjectId,
      sourceNodeId: projectStore.current.meta?.sourceNodeId,
    };
    try {
      const w = window as unknown as { pywebview?: { api?: { director_return_to_canvas(payload: ReturnPayload): Promise<{ status: string; message?: string }> } } };
      const res = await w.pywebview?.api?.director_return_to_canvas(payload);
      if (res?.status === 'success') {
        shell.showSuccess('已回传主画布（将作为素材节点插入）');
      } else {
        shell.showError(res?.message || '回传画布失败（主画布可能未打开）');
      }
    } catch (e) {
      shell.showError(`回传画布失败：${(e as Error).message}`);
    }
  }

  // ── 其他 ──
  onProjectNameChange(name: string): void {
    this.pushUndo();
    if (projectStore.current) {
      projectStore.current.name = name;
    }
    this.markDirty();
  }

  refreshTitle(): void {
    shell.setProjectName(projectStore.current?.name ?? '未命名导演工程');
  }

  markDirty(): void {
    this.saveState = 'dirty';
    this.refreshShell();
  }

  private refreshShell(): void {
    shell.refresh(this.saveState, this.canUndo(), this.canRedo());
    hierarchyPanel.refresh();
  }

  refreshAll(): void {
    hierarchyPanel.refresh();
    panels.refreshAll();
    monitor.refresh();
  }

  togglePlay(): void {
    timeline.togglePlay();
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

const app = new DirectorApp();
void app.boot();

// 调试桥接（可选）
const w = window as unknown as Record<string, unknown>;
w.directorApp = app;
