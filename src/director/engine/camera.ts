// src/director/engine/camera.ts
// 导演台摄像机管理：多摄像机 CRUD / 复制 / 重命名 / 切换 / 位置旋转 / 焦距 / 画幅。
// 每个 DirectorCamera 对应一个 THREE.PerspectiveCamera（编辑/监看/导出共用同一套参数，保证导出一致）。

import * as THREE from 'three';
import {
  DirectorCamera,
  DirectorCameraParams,
  DirectorProject,
  vec3,
  uuid,
} from '../types';

export class CameraManager {
  cameras: DirectorCamera[] = [];
  activeCameraId = '';
  /** 摄像机 id → Three 相机 */
  threeCameras = new Map<string, THREE.PerspectiveCamera>();

  /** 从工程数据重建（打开工程/撤销恢复时调用） */
  rebuildFromProject(project: DirectorProject): void {
    this.cameras = project.cameras.map(c => ({ ...c, position: { ...c.position }, rotation: { ...c.rotation }, target: c.target ? { ...c.target } : undefined }));
    this.activeCameraId = project.activeCameraId;
    this.threeCameras.clear();
    for (const cam of this.cameras) {
      this.threeCameras.set(cam.id, this.buildThreeCamera(cam));
    }
    if (!this.activeCameraId && this.cameras.length > 0) {
      this.activeCameraId = this.cameras[0].id;
    }
  }

  private buildThreeCamera(data: DirectorCamera): THREE.PerspectiveCamera {
    const cam = new THREE.PerspectiveCamera(data.fov, data.aspect, data.near, data.far);
    cam.position.set(data.position.x, data.position.y, data.position.z);
    cam.rotation.set(
      THREE.MathUtils.degToRad(data.rotation.x),
      THREE.MathUtils.degToRad(data.rotation.y),
      THREE.MathUtils.degToRad(data.rotation.z),
    );
    if (data.target) {
      cam.lookAt(new THREE.Vector3(data.target.x, data.target.y, data.target.z));
    } else {
      cam.updateMatrixWorld();
    }
    cam.updateProjectionMatrix();
    return cam;
  }

  getActive(): DirectorCamera | null {
    return this.cameras.find(c => c.id === this.activeCameraId) ?? null;
  }

  getActiveThreeCamera(): THREE.PerspectiveCamera | null {
    return this.threeCameras.get(this.activeCameraId) ?? null;
  }

  getCamera(id: string): DirectorCamera | undefined {
    return this.cameras.find(c => c.id === id);
  }

  /** 新建摄像机（从当前编辑相机取景初始化） */
  createCamera(name = '摄像机', from?: { position: THREE.Vector3; rotation: THREE.Euler }): DirectorCamera {
    const cam: DirectorCamera = {
      id: uuid(),
      name,
      position: vec3(from?.position.x ?? 0, from?.position.y ?? 2.2, from?.position.z ?? 6.5),
      rotation: vec3(
        THREE.MathUtils.radToDeg(from?.rotation.x ?? -0.2),
        THREE.MathUtils.radToDeg(from?.rotation.y ?? 0),
        THREE.MathUtils.radToDeg(from?.rotation.z ?? 0),
      ),
      target: vec3(0, 1, 0),
      fov: 40,
      aspect: 16 / 9,
      near: 0.1,
      far: 1000,
      visible: true,
      includeInExport: true,
    };
    this.cameras.push(cam);
    this.threeCameras.set(cam.id, this.buildThreeCamera(cam));
    return cam;
  }

  /** 复制摄像机（新 id，名称加「副本」） */
  duplicateCamera(id: string): DirectorCamera | null {
    const src = this.getCamera(id);
    if (!src) return null;
    const copy: DirectorCamera = {
      ...JSON.parse(JSON.stringify(src)),
      id: uuid(),
      name: `${src.name} 副本`,
    };
    this.cameras.push(copy);
    this.threeCameras.set(copy.id, this.buildThreeCamera(copy));
    return copy;
  }

  renameCamera(id: string, name: string): void {
    const cam = this.getCamera(id);
    if (cam && name.trim()) cam.name = name.trim();
  }

  deleteCamera(id: string): boolean {
    const idx = this.cameras.findIndex(c => c.id === id);
    if (idx < 0) return false;
    if (this.cameras.length <= 1) return false; // 至少保留一台摄像机
    this.cameras.splice(idx, 1);
    this.threeCameras.delete(id);
    if (this.activeCameraId === id) {
      this.activeCameraId = this.cameras[Math.min(idx, this.cameras.length - 1)].id;
    }
    return true;
  }

  setActive(id: string): void {
    if (this.getCamera(id)) this.activeCameraId = id;
  }

  /** 把 DirectorCamera 参数同步到 Three 相机 */
  applyToThree(data: DirectorCamera): void {
    const cam = this.threeCameras.get(data.id);
    if (!cam) return;
    cam.position.set(data.position.x, data.position.y, data.position.z);
    cam.rotation.set(
      THREE.MathUtils.degToRad(data.rotation.x),
      THREE.MathUtils.degToRad(data.rotation.y),
      THREE.MathUtils.degToRad(data.rotation.z),
    );
    if (data.target) {
      cam.lookAt(new THREE.Vector3(data.target.x, data.target.y, data.target.z));
    }
    cam.fov = data.fov;
    cam.aspect = data.aspect;
    cam.near = data.near;
    cam.far = data.far;
    cam.updateProjectionMatrix();
  }

  /** 从 Three 相机回读参数（编辑相机取景后同步数据） */
  readFromThree(data: DirectorCamera, cam: THREE.PerspectiveCamera): void {
    data.position = vec3(cam.position.x, cam.position.y, cam.position.z);
    data.rotation = vec3(
      THREE.MathUtils.radToDeg(cam.rotation.x),
      THREE.MathUtils.radToDeg(cam.rotation.y),
      THREE.MathUtils.radToDeg(cam.rotation.z),
    );
    // 保留 lookAt 目标近似（相机无目标时用前方 5 米点）
    const dir = cam.getWorldDirection(new THREE.Vector3());
    const targetPos = cam.position.clone().add(dir.multiplyScalar(5));
    data.target = vec3(targetPos.x, targetPos.y, targetPos.z);
    data.fov = cam.fov;
    data.aspect = cam.aspect;
  }

  /** 应用摄像机关键帧参数 */
  applyKeyframeParams(id: string, params: DirectorCameraParams): void {
    const data = this.getCamera(id);
    if (!data) return;
    data.position = { ...params.position };
    data.rotation = { ...params.rotation };
    data.target = params.target ? { ...params.target } : undefined;
    data.fov = params.fov;
    data.aspect = params.aspect;
    this.applyToThree(data);
  }

  /** 采集当前摄像机完整参数（写关键帧用） */
  collectParams(id: string): DirectorCameraParams | null {
    const data = this.getCamera(id);
    if (!data) return null;
    return {
      position: { ...data.position },
      rotation: { ...data.rotation },
      target: data.target ? { ...data.target } : undefined,
      fov: data.fov,
      aspect: data.aspect,
    };
  }

  /** 在场景中同步所有相机图标（可见性） */
  syncVisibility(): void {
    for (const cam of this.cameras) {
      const three = this.threeCameras.get(cam.id);
      if (three) three.visible = cam.visible;
    }
  }
}

export const cameraManager = new CameraManager();
