// src/director/ui/viewport.ts
// 导演台 3D 视口：渲染循环（DPR 上限）、编辑相机 + OrbitControls、TransformControls（W/E/R）、
// 摄像机视角（与监看器/导出一致）、对象拾取、参考图拾取、IK 目标拖拽。
// 失焦暂停动画循环；隐藏窗口不持续编码（导出时由 mp4.ts 检查 document.hidden）。

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { sceneManager } from '../engine/scene';
import { cameraManager } from '../engine/camera';
import { referenceManager } from '../engine/reference';
import { lightingManager } from '../engine/lighting';
import { timeline } from '../engine/timeline';
import { characterManager } from '../engine/character';
import { toast } from './toast';

export type ViewMode = 'edit' | 'camera';
export type TransformTool = 'translate' | 'rotate' | 'scale';

export class Viewport {
  canvas!: HTMLCanvasElement;
  monitorCanvas!: HTMLCanvasElement;
  renderer!: THREE.WebGLRenderer;
  monitorRenderer!: THREE.WebGLRenderer;
  editCamera!: THREE.PerspectiveCamera;
  orbit!: OrbitControls;
  transform!: TransformControls;

  viewMode: ViewMode = 'edit';
  tool: TransformTool = 'translate';
  private rafId: number | null = null;
  private running = false;
  private lastFrameTime = 0;
  /** 点击 vs 拖拽区分 */
  private pointerDownPos: { x: number; y: number } | null = null;
  private pointerMoved = false;
  /** IK 拖拽状态 */
  private ikDrag: { targetName: string; objectId: string; plane: THREE.Plane; offset: THREE.Vector3 } | null = null;

  private resizeObserver: ResizeObserver | null = null;
  private onSelectionChange: (() => void) | null = null;

  /** 初始化视口（WebGL 可用时调用；失败返回 false） */
  init(onSelectionChange?: () => void): boolean {
    this.onSelectionChange = onSelectionChange ?? null;
    this.canvas = document.getElementById('d-gl-canvas') as HTMLCanvasElement;
    this.monitorCanvas = document.getElementById('d-monitor-canvas') as HTMLCanvasElement;
    if (!this.canvas) return false;

    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        antialias: true,
        alpha: false,
      });
    } catch {
      return false;
    }

    // DPR 上限 2（性能约束）
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    lightingManager.setRenderer(this.renderer);

    // 编辑相机（透视）
    this.editCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    this.editCamera.position.set(4.5, 3.2, 6.5);
    this.editCamera.lookAt(0, 1, 0);

    // OrbitControls
    this.orbit = new OrbitControls(this.editCamera, this.canvas);
    this.orbit.target.set(0, 1, 0);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.minDistance = 0.5;
    this.orbit.maxDistance = 200;

    // TransformControls（挂到编辑相机；相机视角下隐藏）
    this.transform = new TransformControls(this.editCamera, this.canvas);
    this.transform.setMode(this.tool);
    this.transform.setSpace(sceneManager.transformSpace === 'local' ? 'local' : 'world');
    this.transform.setSize(0.7);
    sceneManager.scene.add(this.transform.getHelper());
    this.transform.addEventListener('dragging-changed', (e: { value: unknown }) => {
      this.orbit.enabled = !Boolean(e.value);
    });
    this.transform.addEventListener('objectChange', () => {
      const sel = sceneManager.selectedId;
      if (sel) {
        const handle = sceneManager.getHandle(sel);
        if (handle) sceneManager.readObjectTransform(handle.data, handle.root);
      }
      const refSel = referenceManager.selectedId;
      if (refSel) referenceManager.readTransform(refSel);
    });

    // 监听选择变化：附加 TransformControls 到选中对象
    this.attachTransformToSelection();

    // 事件
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);

    // 尺寸自适应
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas.parentElement ?? this.canvas);
    this.resize();

    // 失焦/隐藏暂停
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('focus', this.onFocus);

    this.start();
    return true;
  }

  private attachTransformToSelection(): void {
    if (!this.transform) return;
    this.transform.detach();
    if (this.viewMode !== 'edit') return;
    const id = sceneManager.selectedId;
    if (!id) return;
    const handle = sceneManager.getHandle(id);
    if (!handle || handle.data.locked) return;
    if (handle.data.kind === 'character') {
      // 人物根节点参与整体变换
    }
    this.transform.attach(handle.root);
  }

  /** 供 app 在选中变化后重新附加变换控件（公开入口） */
  refreshTransformAttachment(): void {
    this.attachTransformToSelection();
  }

  setTool(tool: TransformTool): void {
    this.tool = tool;
    if (!this.transform) return; // WebGL 不可用降级
    this.transform.setMode(tool);
  }

  setSpace(space: 'world' | 'local'): void {
    sceneManager.transformSpace = space;
    if (!this.transform) return;
    this.transform.setSpace(space === 'local' ? 'local' : 'world');
  }

  setSnap(enabled: boolean, step: number): void {
    sceneManager.snapEnabled = enabled;
    sceneManager.snapStep = step > 0 ? step : 0.25;
    if (!this.transform) return;
    if (this.tool === 'translate') {
      this.transform.setTranslationSnap(enabled ? sceneManager.snapStep : null);
    } else if (this.tool === 'rotate') {
      this.transform.setRotationSnap(enabled ? 15 : null);
    } else if (this.tool === 'scale') {
      this.transform.setScaleSnap(enabled ? 0.1 : null);
    }
  }

  setViewMode(mode: ViewMode): void {
    this.viewMode = mode;
    if (!this.orbit) return; // WebGL 不可用降级
    this.orbit.enabled = mode === 'edit';
    if (this.transform) this.transform.enabled = mode === 'edit';
    this.attachTransformToSelection();
  }

  resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const w = Math.max(64, parent.clientWidth);
    const h = Math.max(64, parent.clientHeight);
    this.renderer.setSize(w, h, false);
    this.editCamera.aspect = w / h;
    this.editCamera.updateProjectionMatrix();
    // 监看器画布
    const monParent = this.monitorCanvas.parentElement;
    if (monParent) {
      const mw = Math.max(64, monParent.clientWidth - 2);
      const mh = Math.max(48, monParent.clientHeight - 22);
      this.monitorCanvas.width = Math.min(480, Math.round(mw));
      this.monitorCanvas.height = Math.round(this.monitorCanvas.width * 9 / 16);
      if (!this.monitorRenderer) {
        try {
          this.monitorRenderer = new THREE.WebGLRenderer({
            canvas: this.monitorCanvas,
            antialias: true,
            alpha: false,
          });
          this.monitorRenderer.setPixelRatio(1);
          this.monitorRenderer.toneMapping = THREE.ACESFilmicToneMapping;
          this.monitorRenderer.outputColorSpace = THREE.SRGBColorSpace;
        } catch {
          // 监看器降级：无 WebGL 时留空
        }
      }
      if (this.monitorRenderer) {
        this.monitorRenderer.setSize(this.monitorCanvas.width, this.monitorCanvas.height, false);
        this.monitorRenderer.toneMappingExposure = lightingManager.lighting.exposure;
      }
    }
  }

  /** 聚焦对象（F 键/面板按钮） */
  focusObject(id: string | null): void {
    const target = sceneManager.focusTarget(id);
    if (!target) return;
    this.orbit.target.copy(target.center);
    const dist = target.radius * 3.2;
    const dir = this.editCamera.position.clone().sub(this.orbit.target).normalize();
    this.editCamera.position.copy(this.orbit.target).add(dir.multiplyScalar(dist));
    this.orbit.update();
  }

  // ── 渲染循环 ──
  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrameTime = performance.now();
    this.rafId = requestAnimationFrame(this.loop);
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  private onVisibility = (): void => {
    if (document.hidden) this.stop();
    else this.start();
  };

  private onBlur = (): void => {
    this.stop();
  };

  private onFocus = (): void => {
    this.start();
  };

  private loop = (now: number): void => {
    if (!this.running) return;
    const dt = now - this.lastFrameTime;
    this.lastFrameTime = now;

    // 时间轴播放推进由 timeline 自己管理；这里只渲染
    this.orbit.update();

    const activeCam = cameraManager.getActiveThreeCamera();
    if (this.viewMode === 'camera' && activeCam) {
      this.renderer.render(sceneManager.scene, activeCam);
    } else {
      this.renderer.render(sceneManager.scene, this.editCamera);
    }

    // 监看器（仅窗口可见时渲染）
    if (!document.hidden && this.monitorRenderer && activeCam) {
      this.monitorRenderer.toneMappingExposure = lightingManager.lighting.exposure;
      this.monitorRenderer.render(sceneManager.scene, activeCam);
    }

    void dt;
    this.rafId = requestAnimationFrame(this.loop);
  };

  // ── 拾取与选择 ──
  private onPointerDown = (e: PointerEvent): void => {
    if (this.viewMode !== 'edit') return;
    this.pointerDownPos = { x: e.clientX, y: e.clientY };
    this.pointerMoved = false;
    // IK 目标优先拾取
    if (characterManager.ikMode) {
      const hit = this.pickIkTarget(e);
      if (hit) {
        this.beginIkDrag(hit.objectId, hit.targetName, e);
        return;
      }
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.pointerDownPos) {
      const dx = e.clientX - this.pointerDownPos.x;
      const dy = e.clientY - this.pointerDownPos.y;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) this.pointerMoved = true;
    }
    if (this.ikDrag) {
      this.updateIkDrag(e);
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (this.ikDrag) {
      this.endIkDrag();
      this.pointerDownPos = null;
      return;
    }
    if (this.pointerMoved || this.pointerDownPos === null) {
      this.pointerDownPos = null;
      return;
    }
    this.pointerDownPos = null;
    this.handleClick(e);
  };

  private handleClick(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.editCamera);

    // 参考图优先（可单独选中）
    const refMeshes: THREE.Object3D[] = [];
    for (const handle of referenceManager.handles.values()) {
      if (handle.mesh.visible) refMeshes.push(handle.mesh);
    }
    const refHits = raycaster.intersectObjects(refMeshes, false);
    if (refHits.length > 0) {
      const refId = refHits[0].object.userData.directorReferenceId as string | undefined;
      if (refId) {
        referenceManager.select(refId);
        sceneManager.select(null);
        this.attachTransformToSelection();
        this.onSelectionChange?.();
        return;
      }
    }

    // 场景对象
    const targets: THREE.Object3D[] = [];
    for (const handle of sceneManager.handles.values()) {
      if (handle.root.visible) targets.push(handle.root);
    }
    const hits = raycaster.intersectObjects(targets, true);
    let hitId: string | null = null;
    for (const hit of hits) {
      let node: THREE.Object3D | null = hit.object;
      while (node) {
        const id = node.userData.directorObjectId as string | undefined;
        if (id) { hitId = id; break; }
        node = node.parent;
      }
      if (hitId) break;
    }
    sceneManager.select(hitId);
    referenceManager.select(null);
    this.attachTransformToSelection();
    this.onSelectionChange?.();
  }

  // ── IK 拖拽 ──
  private pickIkTarget(e: PointerEvent): { objectId: string; targetName: string } | null {
    const objectId = characterManager.firstCharacterId();
    if (!objectId) return null;
    const handle = sceneManager.getHandle(objectId);
    if (!handle || !handle.ikTargets) return null;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.editCamera);
    const meshes: THREE.Object3D[] = [];
    for (const t of handle.ikTargets.values()) meshes.push(t);
    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;
    const name = hits[0].object.userData.ikTarget as string | undefined;
    if (!name) return null;
    return { objectId, targetName: name };
  }

  private beginIkDrag(objectId: string, targetName: string, e: PointerEvent): void {
    const handle = sceneManager.getHandle(objectId);
    if (!handle || !handle.ikTargets) return;
    const target = handle.ikTargets.get(targetName);
    if (!target) return;
    // 记录 objectId 供拖拽结束保存
    this.ikDrag = {
      objectId,
      targetName,
      plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), -target.getWorldPosition(new THREE.Vector3()).y),
      offset: new THREE.Vector3(),
    };
    // 用相机方向构造与视线垂直的平面更好；这里用 Y 平面足够
    this.ikDrag.plane.setFromNormalAndCoplanarPoint(
      this.editCamera.getWorldDirection(new THREE.Vector3()),
      target.getWorldPosition(new THREE.Vector3()),
    );
    this.updateIkDrag(e);
  }

  private updateIkDrag(e: PointerEvent): void {
    if (!this.ikDrag) return;
    const handle = sceneManager.getHandle(this.ikDrag.objectId);
    if (!handle || !handle.ikTargets) return;
    const target = handle.ikTargets.get(this.ikDrag.targetName);
    if (!target) return;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.editCamera);
    const hit = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(this.ikDrag.plane, hit)) {
      target.position.copy(hit);
      characterManager.solveIkForTarget(this.ikDrag.objectId, this.ikDrag.targetName);
    }
  }

  private endIkDrag(): void {
    if (this.ikDrag) {
      const handle = sceneManager.getHandle(this.ikDrag.objectId);
      if (handle && handle.joints) {
        sceneManager.readCharacterPose(handle.data, handle.joints);
        if (handle.data.character) handle.data.character.poseName = 'custom';
      }
      characterManager.syncIkTargets(this.ikDrag.objectId);
      this.ikDrag = null;
      toast.info('IK 姿态已更新（可用「保存姿势」写入工程）');
    }
  }

  dispose(): void {
    this.stop();
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('focus', this.onFocus);
    this.canvas?.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas?.removeEventListener('pointermove', this.onPointerMove);
    this.canvas?.removeEventListener('pointerup', this.onPointerUp);
    this.resizeObserver?.disconnect();
  }
}

export const viewport = new Viewport();
