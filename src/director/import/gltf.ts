// src/director/import/gltf.ts
// GLB/GLTF 导入：大小/顶点/纹理限制、原始路径记录、缺资源提示。
// 通过后端文件对话框选择文件（获取真实绝对路径），base64 传回前端解析；
// GLTF 视为不可信文件：只解析几何/材质，不执行任何脚本。

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DirectorAssetRef, DirectorObject, uuid, vec3 } from '../types';
import { sceneManager } from '../engine/scene';

export const GLTF_LIMITS = {
  maxFileBytes: 200 * 1024 * 1024, // 200MB
  maxVertices: 2_000_000,          // 200 万顶点
  maxTextures: 64,                 // 64 张贴图
  maxTextureEdge: 4096,            // 4096 边
};

/**
 * 已解析 GLTF 场景缓存（键 = 原始路径）：撤销/重开时用 clone(true) 恢复真实模型，
 * 避免退回占位盒。几何/材质共享，dispose 由缓存持有者负责（scene.ts 对 gltf 跳过 dispose）。
 */
export const gltfGroupCache = new Map<string, THREE.Group>();

export interface GltfStats {
  fileSize: number;
  vertices: number;
  textures: number;
  meshCount: number;
}

export interface GltfImportResult {
  status: 'success' | 'error' | 'cancelled';
  object?: DirectorObject;
  assetRef?: DirectorAssetRef;
  stats?: GltfStats;
  message?: string;
}

interface GltfBackend {
  director_open_gltf_dialog(): Promise<{ status: string; path?: string; sizeBytes?: number; dataBase64?: string; message?: string }>;
}

function getBackend(): GltfBackend | null {
  const w = window as unknown as { pywebview?: { api?: GltfBackend } };
  return w.pywebview?.api ?? null;
}

/** 解析 GLB/GLTF 二进制，校验限制并统计资源 */
export function parseGltfBuffer(buffer: ArrayBuffer, fileSize: number): Promise<{ group: THREE.Group; stats: GltfStats }> {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.parse(
      buffer,
      '',
      (gltf) => {
        const stats = collectStats(gltf.scene, fileSize);
        if (stats.vertices > GLTF_LIMITS.maxVertices) {
          reject(new Error(`模型顶点数 ${stats.vertices.toLocaleString()} 超过限制 ${GLTF_LIMITS.maxVertices.toLocaleString()}，请简化后重试`));
          return;
        }
        if (stats.textures > GLTF_LIMITS.maxTextures) {
          reject(new Error(`模型贴图数 ${stats.textures} 超过限制 ${GLTF_LIMITS.maxTextures}`));
          return;
        }
        resolve({ group: gltf.scene, stats });
      },
      (err) => {
        // 缺资源/外部引用解析失败统一提示
        const reason = err instanceof Error ? err.message : String(err);
        reject(new Error(`模型解析失败：${reason}。GLTF 若引用外部 .bin/.png 资源，请改用自包含 GLB 文件。`));
      },
    );
  });
}

function collectStats(group: THREE.Object3D, fileSize: number): GltfStats {
  let vertices = 0;
  let textures = 0;
  let meshCount = 0;
  group.traverse(obj => {
    const mesh = obj as THREE.Mesh;
    if ((mesh as THREE.Mesh).isMesh) {
      meshCount += 1;
      const g = mesh.geometry as THREE.BufferGeometry | undefined;
      if (g && g.attributes && g.attributes.position) {
        vertices += g.attributes.position.count;
      }
    }
    const material = (obj as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    const mats = Array.isArray(material) ? material : material ? [material] : [];
    for (const m of mats) {
      const std = m as THREE.MeshStandardMaterial;
      if (std.map) textures += 1;
      if (std.normalMap) textures += 1;
      if (std.roughnessMap) textures += 1;
      if (std.metalnessMap) textures += 1;
      if (std.emissiveMap) textures += 1;
      if (std.aoMap) textures += 1;
    }
  });
  return { fileSize, vertices, textures, meshCount };
}

/** 通过后端对话框导入 GLB/GLTF 并加入场景 */
export async function importGltfViaDialog(): Promise<GltfImportResult> {
  const backend = getBackend();
  if (!backend) {
    return { status: 'error', message: '后端桥接不可用' };
  }
  let res;
  try {
    res = await backend.director_open_gltf_dialog();
  } catch (e) {
    return { status: 'error', message: `打开文件对话框失败：${(e as Error).message}` };
  }
  if (res.status === 'cancelled') return { status: 'cancelled' };
  if (res.status !== 'success' || !res.dataBase64 || !res.path) {
    return { status: 'error', message: res.message || '导入失败' };
  }
  const sizeBytes = res.sizeBytes ?? 0;
  if (sizeBytes > GLTF_LIMITS.maxFileBytes) {
    return { status: 'error', message: `文件大小 ${(sizeBytes / 1024 / 1024).toFixed(1)}MB 超过限制 ${(GLTF_LIMITS.maxFileBytes / 1024 / 1024).toFixed(0)}MB` };
  }
  // 路径校验：拒绝路径穿越（防御性；后端对话框只返回已存在文件）
  if (/\.\./.test(res.path)) {
    return { status: 'error', message: '非法路径' };
  }
  const ext = res.path.split('.').pop()?.toLowerCase() ?? '';
  if (ext !== 'glb' && ext !== 'gltf') {
    return { status: 'error', message: '仅支持 .glb / .gltf 文件' };
  }

  try {
    const binary = base64ToArrayBuffer(res.dataBase64);
    const { group, stats } = await parseGltfBuffer(binary, sizeBytes);

    const assetRef: DirectorAssetRef = {
      resourceId: uuid(),
      kind: 'gltf',
      name: res.path.split(/[\\/]/).pop() || '导入模型',
      path: res.path,
      sizeBytes,
    };

    const obj: DirectorObject = {
      id: uuid(),
      name: assetRef.name || '导入模型',
      kind: 'gltf',
      position: vec3(0, 0.5, 0),
      rotation: vec3(0, 0, 0),
      scale: vec3(1, 1, 1),
      visible: true,
      locked: false,
      color: '#bbbbbb',
      assetRef,
    };

    // 先登记 handle，再替换为真实 GLTF 场景
    const handle = sceneManager.buildHandle(obj);
    // 释放兜底占位盒
    handle.root.traverse(child => {
      const mesh = child as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | undefined;
      if (mat) mat.dispose();
    });
    handle.root.clear();
    // 归一化 GLTF 比例（适配导演台单位：米）
    const box = new THREE.Box3().setFromObject(group);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1e-4);
    if (maxDim > 3) {
      const s = 3 / maxDim;
      group.scale.setScalar(s);
    }
    const center = box.getCenter(new THREE.Vector3());
    group.position.set(-center.x, -box.min.y, -center.z);
    group.traverse(child => {
      child.castShadow = true;
      child.receiveShadow = true;
    });
    handle.root.add(group);
    handle.gltfScene = group;
    // 缓存原始组：撤销/重开时恢复真实模型
    gltfGroupCache.set(res.path, group);
    sceneManager.handles.set(obj.id, handle);
    sceneManager.scene.add(handle.root);

    return { status: 'success', object: obj, assetRef, stats };
  } catch (e) {
    return { status: 'error', message: (e as Error).message };
  }
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer as ArrayBuffer;
}
