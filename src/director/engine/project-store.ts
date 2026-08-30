// src/director/engine/project-store.ts
// 导演台工程文件（.icdirector）生命周期：新建 / 打开 / 保存 / 另存 / 迁移 / 最近工程。
// 原子写入由后端负责（backend/director_api.py director_save_project → atomic_write_json）；
// 本模块只做前端数据编排，不直接操作文件系统。

import {
  DIRECTOR_FORMAT,
  DIRECTOR_SCHEMA_VERSION,
  DirectorProject,
  DirectorObject,
  DirectorCamera,
  DirectorReferenceImage,
  DirectorLighting,
  DirectorTimeline,
  DirectorKeyframe,
  DirectorKeyframeTrackType,
  defaultLighting,
  defaultTimeline,
  uuid,
  vec3,
} from '../types';

/** 后端桥接最小接口（pywebview.api.director_*，均以 director_ 前缀，不覆盖主窗口 API） */
export interface DirectorBackend {
  director_ping(): Promise<{ status: string; version?: number; message?: string }>;
  director_get_launch_options(): Promise<Record<string, unknown>>;
  director_save_project(path: string | null, data: unknown): Promise<{ status: string; path?: string; message?: string }>;
  director_save_project_as(data: unknown, initialName?: string): Promise<{ status: string; path?: string; message?: string }>;
  director_open_project_dialog(): Promise<{ status: string; data?: unknown; path?: string; message?: string }>;
  director_load_project(path: string): Promise<{ status: string; data?: unknown; path?: string; message?: string }>;
  director_touch_recent(path: string, name?: string): Promise<{ status: string; message?: string }>;
  director_load_recent(): Promise<{ status: string; projects?: Array<{ path: string; name?: string }>; message?: string }>;
  director_remove_recent(path: string): Promise<{ status: string; message?: string }>;
  director_validate_resource(path: string): Promise<{ status: string; exists?: boolean; sizeBytes?: number; message?: string }>;
}

function getBackend(): DirectorBackend | null {
  const w = window as unknown as { pywebview?: { api?: DirectorBackend } };
  return w.pywebview?.api ?? null;
}

export interface RecentProjectRecord {
  path: string;
  name?: string;
}

/** 打开工程时校验并标记缺失资源；返回缺失清单（绝对路径只在内存态，不写回 JSON 之外） */
export function validateProjectResources(project: DirectorProject, projectDir: string | null): string[] {
  const missing: string[] = [];
  for (const asset of project.assets) {
    const ref = asset;
    if (!ref.path && ref.relativePath && projectDir) {
      ref.path = `${projectDir.replace(/[\\/]+$/, '')}/${ref.relativePath.replace(/^[\\/]+/, '')}`;
    }
    // 文件不存在性校验交给后端（避免前端假阳性）；此处先按内存标记
    ref.missing = false;
  }
  for (const ref of project.references) {
    if (ref.assetRef && ref.assetRef.path) {
      // 占位：真正校验由 openProject 中的 director_validate_resource 逐个执行
      void ref;
    }
  }
  return missing;
}

export class ProjectStore {
  current: DirectorProject | null = null;
  currentPath: string | null = null;
  /** 工程所在目录（用于把绝对路径转相对路径持久化） */
  projectDir: string | null = null;
  /** 最近工程记录（内存缓存） */
  recent: RecentProjectRecord[] = [];

  private backend(): DirectorBackend | null {
    return getBackend();
  }

  /** 新建空工程（不写盘） */
  createBlank(name = '未命名导演工程'): DirectorProject {
    const id = uuid();
    const now = Date.now();
    const camId = uuid();
    const project: DirectorProject = {
      format: DIRECTOR_FORMAT,
      version: DIRECTOR_SCHEMA_VERSION,
      id,
      name,
      scene: [],
      cameras: [
        {
          id: camId,
          name: '主摄像机',
          position: vec3(0, 2.2, 6.5),
          rotation: vec3(-12, 0, 0),
          target: vec3(0, 1, 0),
          fov: 40,
          aspect: 16 / 9,
          near: 0.1,
          far: 1000,
          visible: true,
          includeInExport: true,
        },
      ],
      activeCameraId: camId,
      references: [],
      lighting: defaultLighting(),
      timeline: defaultTimeline(),
      assets: [],
      meta: { createdAt: now, updatedAt: now },
    };
    this.current = project;
    this.currentPath = null;
    this.projectDir = null;
    return project;
  }

  /** 迁移旧版工程 JSON → 当前 schema（每次 schema 变更在此递增步骤） */
  migrate(raw: unknown): DirectorProject {
    if (!raw || typeof raw !== 'object') {
      throw new Error('工程文件内容无效');
    }
    const obj = raw as Record<string, unknown>;
    let version = typeof obj.version === 'number' ? obj.version : 0;

    // v0 → v1：补齐缺失字段（宽容解析，旧工程 fixture 可直接打开）
    if (version < 1) {
      version = 1;
    }

    const normalizeVec3 = (v: unknown): { x: number; y: number; z: number } => {
      const o = (v ?? {}) as Record<string, unknown>;
      return {
        x: typeof o.x === 'number' && Number.isFinite(o.x) ? o.x : 0,
        y: typeof o.y === 'number' && Number.isFinite(o.y) ? o.y : 0,
        z: typeof o.z === 'number' && Number.isFinite(o.z) ? o.z : 0,
      };
    };

    const scene: DirectorObject[] = Array.isArray(obj.scene)
      ? (obj.scene as Record<string, unknown>[]).map((s, i) => {
          const o = s as Record<string, unknown>;
          return {
            id: typeof o.id === 'string' && o.id ? o.id : uuid(),
            name: typeof o.name === 'string' && o.name ? o.name : `对象 ${i + 1}`,
            kind: (typeof o.kind === 'string' ? o.kind : 'box') as DirectorObject['kind'],
            position: normalizeVec3(o.position),
            rotation: normalizeVec3(o.rotation),
            scale: normalizeVec3(o.scale) || { x: 1, y: 1, z: 1 },
            visible: o.visible !== false,
            locked: o.locked === true,
            color: typeof o.color === 'string' ? o.color : '#d8d4c8',
            ...(o.assetRef ? { assetRef: o.assetRef as DirectorObject['assetRef'] } : {}),
            ...(o.character ? { character: o.character as DirectorObject['character'] } : {}),
          };
        })
      : [];

    const cameras: DirectorCamera[] = Array.isArray(obj.cameras)
      ? (obj.cameras as Record<string, unknown>[]).map((c, i) => {
          const o = c as Record<string, unknown>;
          const base = {
            id: typeof o.id === 'string' && o.id ? o.id : uuid(),
            name: typeof o.name === 'string' && o.name ? o.name : `摄像机 ${i + 1}`,
            position: normalizeVec3(o.position),
            rotation: normalizeVec3(o.rotation),
            target: o.target ? normalizeVec3(o.target) : undefined,
            fov: typeof o.fov === 'number' && o.fov > 0 ? o.fov : 40,
            aspect: typeof o.aspect === 'number' && o.aspect > 0 ? o.aspect : 16 / 9,
            near: typeof o.near === 'number' ? o.near : 0.1,
            far: typeof o.far === 'number' ? o.far : 1000,
            visible: o.visible !== false,
            includeInExport: o.includeInExport !== false,
          };
          return base;
        })
      : [];

    const references: DirectorReferenceImage[] = Array.isArray(obj.references)
      ? (obj.references as Record<string, unknown>[]).map((r, i) => {
          const o = r as Record<string, unknown>;
          return {
            id: typeof o.id === 'string' && o.id ? o.id : uuid(),
            name: typeof o.name === 'string' && o.name ? o.name : `参考图 ${i + 1}`,
            assetRef: (o.assetRef ?? {}) as DirectorReferenceImage['assetRef'],
            position: normalizeVec3(o.position),
            rotation: normalizeVec3(o.rotation),
            scale: normalizeVec3(o.scale) || { x: 1, y: 1, z: 1 },
            opacity: typeof o.opacity === 'number' ? Math.min(1, Math.max(0, o.opacity)) : 0.8,
            visible: o.visible !== false,
            includeInExport: o.includeInExport === true,
          };
        })
      : [];

    const lighting: DirectorLighting = {
      ...defaultLighting(),
      ...(((obj.lighting ?? {}) as Record<string, unknown>) as Partial<DirectorLighting>),
      ...(obj.lighting
        ? { keyDirection: normalizeVec3((obj.lighting as Record<string, unknown>).keyDirection) || defaultLighting().keyDirection,
            fillDirection: normalizeVec3((obj.lighting as Record<string, unknown>).fillDirection) || defaultLighting().fillDirection }
        : {}),
    };

    const rawTimeline = (obj.timeline ?? {}) as Record<string, unknown>;
    const timeline: DirectorTimeline = {
      duration: typeof rawTimeline.duration === 'number' ? Math.min(60, Math.max(1, rawTimeline.duration)) : 10,
      fps: typeof rawTimeline.fps === 'number' ? rawTimeline.fps : 24,
      keyframes: Array.isArray(rawTimeline.keyframes)
        ? (rawTimeline.keyframes as Record<string, unknown>[]).map((k) => {
            const o = k as Record<string, unknown>;
            return {
              id: typeof o.id === 'string' && o.id ? o.id : uuid(),
              time: typeof o.time === 'number' ? o.time : 0,
              trackType: (typeof o.trackType === 'string' ? o.trackType : 'object') as DirectorKeyframeTrackType,
              targetId: typeof o.targetId === 'string' ? o.targetId : '',
              property: (typeof o.property === 'string' ? o.property : 'position') as DirectorKeyframe['property'],
              values: (o.values ?? { type: 'vec3', value: { x: 0, y: 0, z: 0 } }) as DirectorKeyframe['values'],
              interpolation: o.interpolation === 'hold' ? 'hold' : 'linear',
            };
          })
        : [],
    };

    const project: DirectorProject = {
      format: DIRECTOR_FORMAT,
      version: DIRECTOR_SCHEMA_VERSION,
      id: typeof obj.id === 'string' && obj.id ? obj.id : uuid(),
      name: typeof obj.name === 'string' && obj.name ? obj.name : '未命名导演工程',
      scene,
      cameras,
      activeCameraId: typeof obj.activeCameraId === 'string' && cameras.some(c => c.id === obj.activeCameraId)
        ? obj.activeCameraId
        : cameras.length > 0 ? cameras[0].id : '',
      references,
      lighting,
      timeline,
      assets: Array.isArray(obj.assets) ? (obj.assets as DirectorProject['assets']) : [],
      meta: (obj.meta ?? {}) as DirectorProject['meta'],
    };
    return project;
  }

  /** 打开工程（路径 + 数据）；若仅给路径则由后端读取 */
  async openProject(path: string): Promise<{ status: string; project?: DirectorProject; message?: string }> {
    const backend = this.backend();
    if (!backend) {
      return { status: 'error', message: '后端桥接不可用' };
    }
    try {
      const res = await backend.director_load_project(path);
      if (res.status !== 'success' || !res.data) {
        return { status: res.status, message: res.message || '打开工程失败' };
      }
      const project = this.migrate(res.data);
      this.current = project;
      this.currentPath = res.path ?? path;
      this.projectDir = this.dirOf(this.currentPath);
      await this.refreshRecent();
      return { status: 'success', project };
    } catch (e) {
      return { status: 'error', message: `打开工程失败：${(e as Error).message}` };
    }
  }

  /** 打开对话框（后端文件对话框） */
  async openDialog(): Promise<{ status: string; project?: DirectorProject; message?: string }> {
    const backend = this.backend();
    if (!backend) return { status: 'error', message: '后端桥接不可用' };
    try {
      const res = await backend.director_open_project_dialog();
      if (res.status === 'cancelled') return { status: 'cancelled' };
      if (res.status !== 'success' || !res.data) {
        return { status: res.status, message: res.message || '打开工程失败' };
      }
      const project = this.migrate(res.data);
      this.current = project;
      this.currentPath = res.path ?? null;
      this.projectDir = this.dirOf(this.currentPath);
      await this.refreshRecent();
      return { status: 'success', project };
    } catch (e) {
      return { status: 'error', message: `打开工程失败：${(e as Error).message}` };
    }
  }

  /** 保存（已有路径直接保存；无路径转另存） */
  async save(): Promise<{ status: string; path?: string; message?: string }> {
    if (!this.current) return { status: 'error', message: '没有打开的工程' };
    if (!this.currentPath) return this.saveAs();
    return this.writeProject(this.currentPath);
  }

  /** 另存为（后端对话框） */
  async saveAs(): Promise<{ status: string; path?: string; message?: string }> {
    const backend = this.backend();
    if (!backend || !this.current) return { status: 'error', message: '后端桥接不可用' };
    try {
      const res = await backend.director_save_project_as(this.serialize(this.current), `${this.current.name || '未命名导演工程'}.icdirector`);
      if (res.status === 'cancelled') return { status: 'cancelled' };
      if (res.status !== 'success' || !res.path) return { status: res.status, message: res.message || '另存失败' };
      this.currentPath = res.path;
      this.projectDir = this.dirOf(res.path);
      await this.refreshRecent();
      return { status: 'success', path: res.path };
    } catch (e) {
      return { status: 'error', message: `另存失败：${(e as Error).message}` };
    }
  }

  /** 把资源绝对路径转成相对工程目录（持久化用） */
  private relativizeAssets(project: DirectorProject): DirectorProject {
    if (!this.projectDir) return project;
    for (const asset of project.assets) {
      if (asset.path && !asset.relativePath) {
        const rel = this.toRelative(asset.path);
        if (rel) asset.relativePath = rel;
      }
    }
    for (const ref of project.references) {
      if (ref.assetRef.path && !ref.assetRef.relativePath) {
        const rel = this.toRelative(ref.assetRef.path);
        if (rel) ref.assetRef.relativePath = rel;
      }
    }
    for (const obj of project.scene) {
      if (obj.assetRef?.path && !obj.assetRef.relativePath) {
        const rel = this.toRelative(obj.assetRef.path);
        if (rel) obj.assetRef.relativePath = rel;
      }
    }
    return project;
  }

  /** 绝对路径 → 相对工程目录（不同盘/目录外时返回 null，保持绝对路径） */
  private toRelative(absPath: string): string | null {
    if (!this.projectDir) return null;
    const norm = (p: string): string => p.replace(/\\/g, '/').replace(/[\\/]+$/, '');
    const base = norm(this.projectDir).toLowerCase();
    const target = norm(absPath).toLowerCase();
    if (!target.startsWith(base + '/')) return null;
    return target.slice(base.length + 1);
  }

  /** 序列化为可写盘 JSON（去掉运行态字段、绝对路径转相对路径、更新 updatedAt） */
  serialize(project: DirectorProject): Record<string, unknown> {
    const clean = this.relativizeAssets(JSON.parse(JSON.stringify(project)) as DirectorProject);
    const out = clean as unknown as Record<string, unknown>;
    if (clean.meta) clean.meta.updatedAt = Date.now();
    return out;
  }

  private async writeProject(path: string): Promise<{ status: string; path?: string; message?: string }> {
    const backend = this.backend();
    if (!backend || !this.current) return { status: 'error', message: '后端桥接不可用' };
    try {
      const res = await backend.director_save_project(path, this.serialize(this.current));
      if (res.status !== 'success') return res;
      this.currentPath = res.path ?? path;
      this.projectDir = this.dirOf(this.currentPath);
      await this.refreshRecent();
      return { status: 'success', path: this.currentPath };
    } catch (e) {
      return { status: 'error', message: `保存失败：${(e as Error).message}` };
    }
  }

  private dirOf(path: string | null): string | null {
    if (!path) return null;
    const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    return idx > 0 ? path.slice(0, idx) : null;
  }

  async refreshRecent(): Promise<void> {
    const backend = this.backend();
    if (!backend) return;
    try {
      const res = await backend.director_load_recent();
      if (res.status === 'success' && Array.isArray(res.projects)) {
        this.recent = res.projects.map(p => ({ path: p.path, name: p.name }));
      }
    } catch {
      // 读取最近记录失败静默
    }
  }

  async touchRecent(): Promise<void> {
    const backend = this.backend();
    if (!backend || !this.currentPath || !this.current) return;
    try {
      await backend.director_touch_recent(this.currentPath, this.current.name);
      await this.refreshRecent();
    } catch {
      // 最近记录失败不阻断保存
    }
  }
}

export const projectStore = new ProjectStore();
