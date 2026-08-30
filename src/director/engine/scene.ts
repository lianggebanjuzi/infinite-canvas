// src/director/engine/scene.ts
// 导演台 3D 场景管理：Three.js 场景、网格、坐标轴、对象创建/增删/状态同步。
// 原创占位几何体（不使用任何参考项目资产）；外部 GLTF 走 import/gltf.ts。

import * as THREE from 'three';
import {
  DirectorObject,
  DirectorObjectKind,
  DirectorProject,
  vec3,
  uuid,
} from '../types';
import { snapVec3 } from './transform';
import { buildCharacterMesh } from '../assets/character-builder';
import { createPlaceholderGeometry } from '../assets/placeholder';
import { gltfGroupCache } from '../import/gltf';

/** 场景内每个对象的 Three 包装（含其内部的 GLTF/角色组） */
export interface SceneObjectHandle {
  data: DirectorObject;
  root: THREE.Object3D;
  /** 角色骨骼关节表（kind==='character' 时存在）：键 = 关节名，值 = Object3D */
  joints?: Map<string, THREE.Object3D>;
  /** IK 末端目标（kind==='character' 时存在）：handL/handR/footL/footR */
  ikTargets?: Map<string, THREE.Object3D>;
  /** GLTF 场景根（kind==='gltf' 时存在，用于 dispose） */
  gltfScene?: THREE.Group;
}

const OBJECT_NAMES: Record<DirectorObjectKind, string> = {
  box: '立方体',
  sphere: '球体',
  cylinder: '圆柱',
  cone: '圆锥',
  plane: '平面',
  capsule: '胶囊',
  gltf: '导入模型',
  character: '人物',
};

export class SceneManager {
  scene: THREE.Scene;
  grid: THREE.GridHelper;
  axes: THREE.AxesHelper;
  handles = new Map<string, SceneObjectHandle>();
  selectedId: string | null = null;

  /** 变换工具空间（'world' | 'local'）与吸附配置（UI 共享状态） */
  transformSpace: 'world' | 'local' = 'world';
  snapEnabled = false;
  snapStep = 0.25;

  constructor() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#1e1f24');
    this.grid = new THREE.GridHelper(20, 20, 0x4a4d57, 0x33363f);
    this.grid.position.y = 0;
    this.scene.add(this.grid);
    this.axes = new THREE.AxesHelper(1.2);
    this.axes.position.set(0, 0.01, 0);
    this.scene.add(this.axes);
  }

  setBackground(color: string): void {
    this.scene.background = new THREE.Color(color);
  }

  /** 清空所有对象（保留网格/坐标轴/灯光由调用方重建） */
  clearObjects(): void {
    for (const handle of this.handles.values()) {
      this.disposeHandle(handle);
    }
    this.handles.clear();
    this.selectedId = null;
  }

  private disposeHandle(handle: SceneObjectHandle): void {
    this.scene.remove(handle.root);
    if (handle.gltfScene) {
      // GLTF 几何/材质与 gltfGroupCache 共享：不在此 dispose，由缓存持有
      return;
    }
    handle.root.traverse(obj => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach(m => m.dispose());
      else if (mat) mat.dispose();
    });
  }

  /** 按工程 scene 数组重建所有对象（打开工程/撤销恢复时调用） */
  rebuildFromProject(project: DirectorProject): void {
    this.clearObjects();
    for (const obj of project.scene) {
      const handle = this.buildHandle(obj);
      this.handles.set(obj.id, handle);
      this.scene.add(handle.root);
    }
  }

  /** 由 DirectorObject 数据构建 Three 对象 */
  buildHandle(data: DirectorObject): SceneObjectHandle {
    let root: THREE.Object3D;
    let joints: Map<string, THREE.Object3D> | undefined;
    let ikTargets: Map<string, THREE.Object3D> | undefined;
    let gltfScene: THREE.Group | undefined;

    if (data.kind === 'character') {
      const built = buildCharacterMesh(data.color || '#e6e2d8');
      root = built.group;
      joints = built.joints;
      ikTargets = built.ikTargets;
      // 初始姿态
      if (data.character) {
        this.applyCharacterPose(data, built.joints);
      }
    } else if (data.kind === 'gltf' && data.assetRef) {
      root = new THREE.Group();
      // 优先用已解析缓存恢复真实模型（撤销/重开路径）；无缓存则兜底占位盒
      const cached = data.assetRef.path ? gltfGroupCache.get(data.assetRef.path) : undefined;
      if (cached) {
        const clone = cached.clone(true);
        clone.traverse(child => {
          child.castShadow = true;
          child.receiveShadow = true;
        });
        root.add(clone);
        gltfScene = clone;
      } else {
        const box = new THREE.Mesh(
          new THREE.BoxGeometry(0.6, 0.6, 0.6),
          new THREE.MeshStandardMaterial({ color: 0xbbbbbb, roughness: 0.8 }),
        );
        root.add(box);
      }
    } else {
      const geometry = createPlaceholderGeometry(data.kind);
      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(data.color || '#d8d4c8'),
        roughness: 0.75,
        metalness: 0.05,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = data.kind === 'plane';
      root = mesh;
    }

    root.name = data.name || OBJECT_NAMES[data.kind];
    root.userData.directorObjectId = data.id;
    this.applyObjectState(data, root);
    return { data, root, joints, ikTargets, gltfScene };
  }

  /** 把 DirectorObject 状态同步到 Three 对象（位置/旋转/缩放/可见性） */
  applyObjectState(data: DirectorObject, root: THREE.Object3D): void {
    root.position.set(data.position.x, data.position.y, data.position.z);
    root.rotation.set(
      THREE.MathUtils.degToRad(data.rotation.x),
      THREE.MathUtils.degToRad(data.rotation.y),
      THREE.MathUtils.degToRad(data.rotation.z),
    );
    root.scale.set(data.scale.x, data.scale.y, data.scale.z);
    root.visible = data.visible;
  }

  /** 从 Three 对象回读变换到 DirectorObject（拖拽/变换控件后同步数据） */
  readObjectTransform(data: DirectorObject, root: THREE.Object3D): void {
    data.position = vec3(root.position.x, root.position.y, root.position.z);
    data.rotation = vec3(
      THREE.MathUtils.radToDeg(root.rotation.x),
      THREE.MathUtils.radToDeg(root.rotation.y),
      THREE.MathUtils.radToDeg(root.rotation.z),
    );
    data.scale = vec3(root.scale.x, root.scale.y, root.scale.z);
  }

  /** 新增对象（未写入工程；调用方负责 undo.push + 落工程数组） */
  createObjectData(kind: DirectorObjectKind, name?: string, color?: string): DirectorObject {
    const obj: DirectorObject = {
      id: uuid(),
      name: name || OBJECT_NAMES[kind],
      kind,
      position: vec3(0, 0.5, 0),
      rotation: vec3(0, 0, 0),
      scale: vec3(1, 1, 1),
      visible: true,
      locked: false,
      color: color || this.defaultColor(kind),
      ...(kind === 'character' ? { character: this.defaultCharacterState() } : {}),
    };
    const handle = this.buildHandle(obj);
    this.handles.set(obj.id, handle);
    this.scene.add(handle.root);
    return obj;
  }

  private defaultColor(kind: DirectorObjectKind): string {
    switch (kind) {
      case 'character': return '#e6e2d8';
      case 'plane': return '#c8c6bd';
      default: return '#d8d4c8';
    }
  }

  private defaultCharacterState(): DirectorObject['character'] {
    return {
      rootPosition: vec3(0, 0, 0),
      rootRotation: vec3(0, 0, 0),
      poseName: 'tpose',
      joints: {},
    };
  }

  /** 应用角色姿态（IK 目标与关节角） */
  applyCharacterPose(data: DirectorObject, joints: Map<string, THREE.Object3D> | undefined): void {
    if (!data.character || !joints) return;
    const st = data.character;
    for (const [name, angles] of Object.entries(st.joints || {})) {
      const joint = joints.get(name);
      if (!joint) continue;
      joint.rotation.set(
        THREE.MathUtils.degToRad(angles.x),
        THREE.MathUtils.degToRad(angles.y),
        THREE.MathUtils.degToRad(angles.z),
      );
    }
    // 根位置/旋转作用于 group 之上（角色根节点即 group；rootPosition 作用于 group.position）
  }

  /** 回读角色关节角到 DirectorObject.character（保存姿态时调用） */
  readCharacterPose(data: DirectorObject, joints: Map<string, THREE.Object3D> | undefined): void {
    if (!data.character || !joints) return;
    const st = data.character;
    st.joints = {};
    for (const [name, joint] of joints.entries()) {
      st.joints[name] = vec3(
        THREE.MathUtils.radToDeg(joint.rotation.x),
        THREE.MathUtils.radToDeg(joint.rotation.y),
        THREE.MathUtils.radToDeg(joint.rotation.z),
      );
    }
  }

  getHandle(id: string): SceneObjectHandle | undefined {
    return this.handles.get(id);
  }

  select(id: string | null): void {
    this.selectedId = id;
  }

  /** 聚焦选中对象：返回建议的编辑相机目标位置（由视口移动相机） */
  focusTarget(id: string | null): { center: THREE.Vector3; radius: number } | null {
    const handle = id ? this.handles.get(id) : undefined;
    if (!handle) return null;
    const box = new THREE.Box3().setFromObject(handle.root);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 0.5);
    return { center, radius };
  }

  /** 贴地：把对象 y 对齐到地面（保留 x/z；被锁定对象跳过） */
  groundObject(id: string): void {
    const handle = this.handles.get(id);
    if (!handle || handle.data.locked) return;
    // 对几何体：用包围盒下缘贴地更精确；简单起见用 position.y = 半高
    const box = new THREE.Box3().setFromObject(handle.root);
    const minY = box.min.y;
    handle.root.position.y += -minY;
    this.readObjectTransform(handle.data, handle.root);
  }

  /** 删除对象 */
  removeObject(id: string): void {
    const handle = this.handles.get(id);
    if (!handle) return;
    this.disposeHandle(handle);
    this.handles.delete(id);
    if (this.selectedId === id) this.selectedId = null;
  }

  /** 吸附当前位置（编辑态）；返回是否发生改变 */
  snapObjectPosition(id: string): boolean {
    const handle = this.handles.get(id);
    if (!handle || handle.data.locked) return false;
    const snapped = snapVec3(handle.data.position, this.snapStep);
    const changed = snapped.x !== handle.data.position.x
      || snapped.y !== handle.data.position.y
      || snapped.z !== handle.data.position.z;
    if (changed) {
      handle.data.position = snapped;
      handle.root.position.set(snapped.x, snapped.y, snapped.z);
    }
    return changed;
  }
}

export const sceneManager = new SceneManager();
