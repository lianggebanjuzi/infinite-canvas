// src/director/assets/placeholder.ts
// 导演台原创占位资产：程序化生成的占位几何体。
// 全部由 Three.js 基础几何体组合/参数化生成，不复制 MONOFORM 或任何参考项目的资产。

import * as THREE from 'three';
import { DirectorObjectKind } from '../types';

/**
 * 创建占位几何体（原创参数化；所有几何体共享单位尺寸，便于统一缩放）。
 * @param kind 对象种类
 */
export function createPlaceholderGeometry(kind: DirectorObjectKind): THREE.BufferGeometry {
  switch (kind) {
    case 'box':
      return new THREE.BoxGeometry(1, 1, 1);
    case 'sphere':
      return new THREE.SphereGeometry(0.5, 24, 18);
    case 'cylinder':
      return new THREE.CylinderGeometry(0.5, 0.5, 1, 20);
    case 'cone':
      return new THREE.ConeGeometry(0.5, 1, 20);
    case 'plane':
      return new THREE.PlaneGeometry(2, 2);
    case 'capsule':
      return new THREE.CapsuleGeometry(0.5, 0.5, 8, 16);
    case 'gltf':
      // GLTF 模型由导入流程提供；这里兜底一个小占位盒
      return new THREE.BoxGeometry(0.6, 0.6, 0.6);
    case 'character':
      // 人物由 character-builder 整体构建，不在此生成单一几何体
      return new THREE.BoxGeometry(0.2, 0.2, 0.2);
    default:
      return new THREE.BoxGeometry(1, 1, 1);
  }
}

/** 创建占位材质（白色调标准材质） */
export function createPlaceholderMaterial(color = '#d8d4c8'): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    roughness: 0.75,
    metalness: 0.05,
  });
}
