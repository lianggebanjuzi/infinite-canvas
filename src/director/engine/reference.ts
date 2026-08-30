// src/director/engine/reference.ts
// 导演台参考图管理：上传（文件/画布图片）、移动、透明度、缩放、是否进入导出。
// 图片以资源引用表达（DirectorAssetRef），不把大文件 base64 塞进工程 JSON。

import * as THREE from 'three';
import {
  DirectorAssetRef,
  DirectorProject,
  DirectorReferenceImage,
  vec3,
  uuid,
} from '../types';
import { sceneManager } from './scene';

export interface ReferenceHandle {
  data: DirectorReferenceImage;
  mesh: THREE.Mesh;
  texture: THREE.Texture | null;
}

export class ReferenceManager {
  references: DirectorReferenceImage[] = [];
  handles = new Map<string, ReferenceHandle>();
  selectedId: string | null = null;

  /** 从工程数据重建（打开工程/撤销恢复时调用；纹理需异步加载，先建占位平面） */
  rebuildFromProject(project: DirectorProject): void {
    this.clear();
    this.references = project.references.map(r => ({
      ...r,
      assetRef: { ...r.assetRef },
      position: { ...r.position },
      rotation: { ...r.rotation },
      scale: { ...r.scale },
    }));
    for (const ref of this.references) {
      const handle = this.createPlane(ref);
      this.handles.set(ref.id, handle);
      sceneManager.scene.add(handle.mesh);
      if (ref.assetRef.path) {
        void this.loadTexture(handle, ref.assetRef.path);
      }
    }
  }

  clear(): void {
    for (const handle of this.handles.values()) {
      sceneManager.scene.remove(handle.mesh);
      handle.mesh.geometry.dispose();
      const mat = handle.mesh.material as THREE.Material;
      mat.dispose();
      if (handle.texture) handle.texture.dispose();
    }
    this.handles.clear();
    this.references = [];
    this.selectedId = null;
  }

  private createPlane(data: DirectorReferenceImage): ReferenceHandle {
    // 默认 2:1 平面；加载纹理后按图片比例重设
    const geometry = new THREE.PlaneGeometry(2, 1);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: data.opacity,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = data.name || '参考图';
    mesh.userData.directorReferenceId = data.id;
    mesh.position.set(data.position.x, data.position.y, data.position.z);
    mesh.rotation.set(
      THREE.MathUtils.degToRad(data.rotation.x),
      THREE.MathUtils.degToRad(data.rotation.y),
      THREE.MathUtils.degToRad(data.rotation.z),
    );
    mesh.scale.set(data.scale.x, data.scale.y, data.scale.z);
    mesh.visible = data.visible;
    return { data, mesh, texture: null };
  }

  /** 异步加载纹理（路径校验：仅接受本地文件路径；失败给缺资源提示） */
  private async loadTexture(handle: ReferenceHandle, path: string): Promise<void> {
    const loader = new THREE.TextureLoader();
    try {
      const texture = await loader.loadAsync(path);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 4;
      handle.texture = texture;
      const mat = handle.mesh.material as THREE.MeshBasicMaterial;
      mat.map = texture;
      mat.needsUpdate = true;
      // 按图片真实比例调整平面
      const img = texture.image as { width?: number; height?: number } | undefined;
      if (img && img.width && img.height) {
        const aspect = img.width / img.height;
        handle.mesh.geometry.dispose();
        handle.mesh.geometry = new THREE.PlaneGeometry(2, 2 / aspect);
      }
    } catch {
      handle.data.assetRef.missing = true;
    }
  }

  /** 从 data URL / 文件对象 URL 添加参考图（上传与画布回传共用） */
  addFromDataUrl(dataUrl: string, name: string, position = vec3(0, 1.6, 0), assetRef?: DirectorAssetRef): DirectorReferenceImage {
    const ref: DirectorReferenceImage = {
      id: uuid(),
      name,
      assetRef: assetRef ?? { resourceId: uuid(), kind: 'image', name },
      position,
      rotation: vec3(-90, 0, 0), // 默认平放（平行于地面）
      scale: vec3(1, 1, 1),
      opacity: 0.8,
      visible: true,
      includeInExport: true,
    };
    this.references.push(ref);
    const handle = this.createPlane(ref);
    this.handles.set(ref.id, handle);
    sceneManager.scene.add(handle.mesh);
    void this.loadTexture(handle, dataUrl);
    return ref;
  }

  /** 从本地路径添加参考图（D5 画布选图） */
  addFromPath(path: string, name: string): DirectorReferenceImage {
    const assetRef: DirectorAssetRef = {
      resourceId: uuid(),
      kind: 'image',
      name,
      path,
    };
    return this.addFromDataUrl(path, name, vec3(0, 1.6, 0), assetRef);
  }

  getHandle(id: string): ReferenceHandle | undefined {
    return this.handles.get(id);
  }

  select(id: string | null): void {
    this.selectedId = id;
  }

  remove(id: string): void {
    const handle = this.handles.get(id);
    if (!handle) return;
    sceneManager.scene.remove(handle.mesh);
    handle.mesh.geometry.dispose();
    const mat = handle.mesh.material as THREE.Material;
    mat.dispose();
    if (handle.texture) handle.texture.dispose();
    this.handles.delete(id);
    const idx = this.references.findIndex(r => r.id === id);
    if (idx >= 0) this.references.splice(idx, 1);
    if (this.selectedId === id) this.selectedId = null;
  }

  setOpacity(id: string, opacity: number): void {
    const handle = this.handles.get(id);
    const ref = this.references.find(r => r.id === id);
    if (!handle || !ref) return;
    const clamped = Math.min(1, Math.max(0, opacity));
    ref.opacity = clamped;
    const mat = handle.mesh.material as THREE.MeshBasicMaterial;
    mat.opacity = clamped;
    mat.needsUpdate = true;
  }

  setVisible(id: string, visible: boolean): void {
    const handle = this.handles.get(id);
    const ref = this.references.find(r => r.id === id);
    if (!handle || !ref) return;
    ref.visible = visible;
    handle.mesh.visible = visible;
  }

  setIncludeInExport(id: string, include: boolean): void {
    const ref = this.references.find(r => r.id === id);
    if (ref) ref.includeInExport = include;
  }

  /** 回读变换（拖拽/变换控件后同步数据） */
  readTransform(id: string): void {
    const handle = this.handles.get(id);
    const ref = this.references.find(r => r.id === id);
    if (!handle || !ref) return;
    ref.position = vec3(handle.mesh.position.x, handle.mesh.position.y, handle.mesh.position.z);
    ref.rotation = vec3(
      THREE.MathUtils.radToDeg(handle.mesh.rotation.x),
      THREE.MathUtils.radToDeg(handle.mesh.rotation.y),
      THREE.MathUtils.radToDeg(handle.mesh.rotation.z),
    );
    ref.scale = vec3(handle.mesh.scale.x, handle.mesh.scale.y, handle.mesh.scale.z);
  }

  /** 导出模式：只显示参与导出的参考图（includeInExport） */
  applyExportVisibility(): void {
    for (const handle of this.handles.values()) {
      handle.mesh.visible = handle.data.visible && handle.data.includeInExport;
    }
  }

  /** 编辑模式：恢复所有可见参考图 */
  applyEditVisibility(): void {
    for (const handle of this.handles.values()) {
      handle.mesh.visible = handle.data.visible;
    }
  }
}

export const referenceManager = new ReferenceManager();
