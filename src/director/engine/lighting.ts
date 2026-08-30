// src/director/engine/lighting.ts
// 导演台光照管理：环境光 + 主光（方向光）+ 补光（方向光）+ 曝光。
// 默认灯光恢复；灯光数据持久化在工程 lighting 字段。

import * as THREE from 'three';
import { DirectorLighting, defaultLighting, vec3 } from '../types';
import { sceneManager } from './scene';

export class LightingManager {
  lighting: DirectorLighting = defaultLighting();

  private ambient!: THREE.AmbientLight;
  private key!: THREE.DirectionalLight;
  private fill!: THREE.DirectionalLight;
  private renderer: THREE.WebGLRenderer | null = null;

  /** 初始化灯光对象（视口就绪后调用一次） */
  init(): void {
    if (this.ambient) return;
    this.ambient = new THREE.AmbientLight(0xffffff, 0.55);
    this.key = new THREE.DirectionalLight(0xffffff, 1.35);
    this.fill = new THREE.DirectionalLight(0xffffff, 0.5);
    sceneManager.scene.add(this.ambient, this.key, this.fill);
    this.apply(this.lighting);
  }

  setRenderer(renderer: THREE.WebGLRenderer): void {
    this.renderer = renderer;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = this.lighting.exposure;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
  }

  /** 应用灯光数据到场景与渲染器 */
  apply(lighting: DirectorLighting): void {
    this.lighting = { ...lighting };
    if (!this.ambient) return;
    this.ambient.color.set(lighting.ambientColor);
    this.ambient.intensity = lighting.ambientIntensity;
    this.key.color.set(lighting.keyColor);
    this.key.intensity = lighting.keyIntensity;
    this.key.position.set(lighting.keyDirection.x, lighting.keyDirection.y, lighting.keyDirection.z);
    this.fill.color.set(lighting.fillColor);
    this.fill.intensity = lighting.fillIntensity;
    this.fill.position.set(lighting.fillDirection.x, lighting.fillDirection.y, lighting.fillDirection.z);
    sceneManager.setBackground(lighting.background);
    if (this.renderer) this.renderer.toneMappingExposure = lighting.exposure;
  }

  /** 恢复默认灯光 */
  restoreDefault(): DirectorLighting {
    const d = defaultLighting();
    this.apply(d);
    return d;
  }

  /** 从工程数据重建 */
  rebuildFromProject(lighting: DirectorLighting): void {
    this.apply(lighting);
  }

  /** 生成用于持久化的灯光数据（深拷贝） */
  toData(): DirectorLighting {
    return {
      ...this.lighting,
      keyDirection: vec3(this.lighting.keyDirection.x, this.lighting.keyDirection.y, this.lighting.keyDirection.z),
      fillDirection: vec3(this.lighting.fillDirection.x, this.lighting.fillDirection.y, this.lighting.fillDirection.z),
    };
  }
}

export const lightingManager = new LightingManager();
