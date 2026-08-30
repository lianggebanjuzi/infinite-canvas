// src/director/types.ts
// 导演台（4.4 MONOFORM 式导演台）独立工程类型定义。
// 与主画布 `.icproj` 完全隔离：format 固定为 'icdirector'，对象/相机/关键帧使用稳定 UUID。
// 资源以项目相对路径或稳定资源 ID 表达，不复制大文件进 JSON。

/** 导演台工程文件格式标识 */
export const DIRECTOR_FORMAT = 'icdirector' as const;

/** 当前 schema 版本；每次结构变更必须递增并写迁移函数（见 project-store.ts migrate） */
export const DIRECTOR_SCHEMA_VERSION = 1;

/** 三维向量（持久化为 JSON 的 {x,y,z}；旋转角一律用度） */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function vec3Equals(a: Vec3, b: Vec3, eps = 1e-6): boolean {
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps && Math.abs(a.z - b.z) < eps;
}

export function clampVec3(v: Vec3, min: number, max: number): Vec3 {
  const c = (n: number): number => Math.min(max, Math.max(min, n));
  return { x: c(v.x), y: c(v.y), z: c(v.z) };
}

/** 场景对象种类（原创占位几何 + 外部 GLTF + 人物白模） */
export type DirectorObjectKind =
  | 'box' | 'sphere' | 'cylinder' | 'cone' | 'plane' | 'capsule'
  | 'gltf'
  | 'character';

/** 场景对象 */
export interface DirectorObject {
  id: string;                 // 稳定 UUID
  name: string;
  kind: DirectorObjectKind;
  position: Vec3;
  rotation: Vec3;             // 欧拉角（度）
  scale: Vec3;
  visible: boolean;
  locked: boolean;
  color: string;              // 十六进制色（占位白模/几何体）
  /** GLTF 等外部模型引用（kind==='gltf' 时存在） */
  assetRef?: DirectorAssetRef;
  /** 人物状态（kind==='character' 时存在） */
  character?: DirectorCharacterState;
}

/** 人物姿势：关节本地欧拉角（度）快照 */
export interface DirectorCharacterState {
  rootPosition: Vec3;
  rootRotation: Vec3;
  poseName: string;
  /** 键 = 关节名（character-builder 命名），值 = 本地欧拉角（度） */
  joints: Record<string, Vec3>;
}

/** 导演台摄像机 */
export interface DirectorCamera {
  id: string;                 // 稳定 UUID
  name: string;
  position: Vec3;
  rotation: Vec3;             // 欧拉角（度）
  target?: Vec3;              // lookAt 目标（世界坐标；缺省时按 rotation 推导）
  fov: number;                // 垂直视场角（度）
  aspect: number;             // 画幅比例 width/height
  near: number;
  far: number;
  visible: boolean;           // 场景中是否显示相机图标/锥体
  includeInExport: boolean;   // 是否参与导出（默认 true）
}

/** 参考图（画布图片可作为参考图导入） */
export interface DirectorReferenceImage {
  id: string;                 // 稳定 UUID
  name: string;
  assetRef: DirectorAssetRef;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  opacity: number;            // 0..1
  visible: boolean;
  includeInExport: boolean;   // 是否进入导出
}

/** 外部资源引用（图片/GLTF/视频/音频）：大文件不复制进 JSON */
export interface DirectorAssetRef {
  resourceId: string;         // 稳定资源 ID（UUID）
  kind: 'image' | 'gltf' | 'video' | 'audio';
  name?: string;
  /** 绝对路径（仅内存态；打开/导入时填充） */
  path?: string;
  /** 相对工程目录路径（持久化优先，导出 ZIP 时据此收集资源） */
  relativePath?: string;
  sizeBytes?: number;
  /** 打开工程时校验：引用的文件缺失 */
  missing?: boolean;
}

/** 灯光（环境 + 主光 + 补光 + 曝光） */
export interface DirectorLighting {
  ambientColor: string;
  ambientIntensity: number;
  keyColor: string;
  keyIntensity: number;
  keyDirection: Vec3;
  fillColor: string;
  fillIntensity: number;
  fillDirection: Vec3;
  exposure: number;
  background: string;         // 场景背景色
}

/** 关键帧轨道类型 */
export type DirectorKeyframeTrackType = 'camera' | 'object' | 'character';

/** 插值方式 */
export type DirectorInterpolation = 'linear' | 'hold';

/** 关键帧值载荷 */
export type DirectorKeyframeValues =
  | { type: 'vec3'; value: Vec3 }
  | { type: 'camera'; value: DirectorCameraParams }
  | { type: 'pose'; value: DirectorCharacterState };

/** 摄像机关键帧参数（完整取景参数） */
export interface DirectorCameraParams {
  position: Vec3;
  rotation: Vec3;
  target?: Vec3;
  fov: number;
  aspect: number;
}

/** 关键帧 */
export interface DirectorKeyframe {
  id: string;                 // 稳定 UUID
  time: number;               // 秒（>=0 且 <= timeline.duration）
  trackType: DirectorKeyframeTrackType;
  targetId: string;           // 相机 id / 对象 id
  property: 'position' | 'rotation' | 'scale' | 'camera' | 'pose';
  values: DirectorKeyframeValues;
  interpolation: DirectorInterpolation;
}

/** 时间轴 */
export interface DirectorTimeline {
  duration: number;           // 1..60 秒
  fps: number;                // 12 / 24 / 30 / 60
  keyframes: DirectorKeyframe[];
}

/** 导演台工程（.icdirector JSON 根） */
export interface DirectorProject {
  format: 'icdirector';
  version: number;
  id: string;                 // 工程稳定 UUID
  name: string;
  scene: DirectorObject[];
  cameras: DirectorCamera[];
  activeCameraId: string;
  references: DirectorReferenceImage[];
  lighting: DirectorLighting;
  timeline: DirectorTimeline;
  assets: DirectorAssetRef[];
  /** 来源画布信息（D5：从主画布打开时记录；不暴露内部绝对路径） */
  meta?: {
    sourceProjectId?: string;
    sourceNodeId?: string;
    createdAt?: number;
    updatedAt?: number;
  };
}

/** 默认灯光（原创占位；与 MONOFORM 无任何资产关联） */
export function defaultLighting(): DirectorLighting {
  return {
    ambientColor: '#f2f0ea',
    ambientIntensity: 0.55,
    keyColor: '#fff6e8',
    keyIntensity: 1.35,
    keyDirection: vec3(2.2, 3.4, 1.6),
    fillColor: '#cfe0ff',
    fillIntensity: 0.5,
    fillDirection: vec3(-2.4, 1.2, -1.8),
    exposure: 1.0,
    background: '#1e1f24',
  };
}

/** 默认时间轴 */
export function defaultTimeline(): DirectorTimeline {
  return { duration: 10, fps: 24, keyframes: [] };
}

/** 生成稳定 UUID（浏览器 crypto 优先，回退 Math.random） */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const s = (): string => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `${s()}-${s()}-${s()}-${s()}-${s()}`;
}

/** 是否为合法 UUID（稳定 ID 校验） */
export function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
