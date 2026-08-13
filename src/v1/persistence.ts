// src/v1/persistence.ts
// .icproj 序列化/反序列化 —— 只有本模块可以读写 .icproj（共享约定第 5 条）
// restore 校验 format==='icv'（A9：非 icv 拒绝），3.0/3.1 统一走 migrateNode 归一迁移

import { flowState } from './state/flow-state';
import { Backend } from './api';
import { showToast } from './ui/toast';

/**
 * 旧节点归一迁移为统一「生成节点」。
 * - product-image：旧输入图 → refImages=[imageUrl]，imageUrl 置空、status 重置 idle（旧 done 无输出图，避免 done+空卡矛盾）。
 * - style-transfer / image-gen：type 统一 image-gen，refImages 保留（缺省补空）。
 * 连线 / 标题 / 参数保留。
 */
function migrateNode(raw: unknown): FlowNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const t = r.type as string;
  if (t !== 'product-image' && t !== 'style-transfer' && t !== 'image-gen') return null;
  if (typeof r.id !== 'string') return null;

  const rawParams = r.params && typeof r.params === 'object'
    ? (r.params as Record<string, unknown>)
    : {};

  const node: FlowNode = {
    id: r.id,
    type: 'image-gen',
    x: typeof r.x === 'number' ? r.x : 0,
    y: typeof r.y === 'number' ? r.y : 0,
    ratio: typeof r.ratio === 'number' && r.ratio > 0 ? r.ratio : 3 / 4,
    status: (['idle', 'run', 'done', 'stale', 'fail'] as NodeStatus[]).includes(r.status as NodeStatus) ? r.status as NodeStatus : 'idle',
    title: typeof r.title === 'string' ? r.title : '图片生成',
    params: { prompt: '', model: '', aspectRatio: '3:4', resolution: '2k', count: 1, ...rawParams },
    imageUrl: typeof r.imageUrl === 'string' ? r.imageUrl : null,
    refImages: [],
    error: typeof r.error === 'string' ? r.error : null,
    lastRunAt: typeof r.lastRunAt === 'number' ? r.lastRunAt : null,
  };

  if (t === 'product-image') {
    node.refImages = typeof r.imageUrl === 'string' ? [r.imageUrl] : [];
    node.imageUrl = null;
    node.status = 'idle';
  } else {
    node.refImages = Array.isArray(r.refImages)
      ? (r.refImages as unknown[]).filter((u): u is string => typeof u === 'string')
      : [];
  }
  return node;
}

class Persistence {
  private lastPath: string | null = null;

  /** 收集当前画布为 FlowProject */
  collect(): FlowProject {
    return {
      format: 'icv',
      version: '3.1',
      projectName: flowState.projectName,
      canvas: { ...flowState.canvas },
      nodes: flowState.nodes.map(n => ({ ...n, params: { ...(n.params || {}) }, refImages: [...(n.refImages || [])] })),
      edges: flowState.edges.map(e => ({ ...e })),
      createdAt: flowState.createdAt,
      updatedAt: Date.now(),
    };
  }

  /** 校验并恢复项目（A9：format!=='icv' → 提示不支持；3.0/3.1 均接受并迁移） */
  restore(raw: unknown): boolean {
    if (!raw || typeof raw !== 'object') {
      showToast('项目文件格式错误', false);
      return false;
    }
    const p = raw as Partial<FlowProject>;
    if (p.format !== 'icv') {
      showToast('旧版项目不支持，请新建', false);
      return false;
    }
    if (!Array.isArray(p.nodes)) {
      showToast('项目文件缺少节点数据', false);
      return false;
    }

    const nodes = (p.nodes as unknown[])
      .map(migrateNode)
      .filter((n): n is FlowNode => n !== null);

    const nodeIds = new Set(nodes.map(n => n.id));
    const edges = (Array.isArray(p.edges) ? p.edges : [])
      .filter(e => e && typeof e.id === 'string' && nodeIds.has(e.from) && nodeIds.has(e.to))
      .map(e => ({ id: e.id, from: e.from, to: e.to })) as FlowEdge[];

    flowState.replaceAll({
      format: 'icv',
      version: '3.1',
      projectName: typeof p.projectName === 'string' ? p.projectName : '未命名项目',
      canvas: {
        scale: typeof p.canvas?.scale === 'number' ? p.canvas.scale : 1,
        panX: typeof p.canvas?.panX === 'number' ? p.canvas.panX : 60,
        panY: typeof p.canvas?.panY === 'number' ? p.canvas.panY : 40,
      },
      nodes,
      edges,
      createdAt: typeof p.createdAt === 'number' ? p.createdAt : Date.now(),
      updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : Date.now(),
    });
    return true;
  }

  /** 保存（A2：图片 base64 内嵌；大体积时 Toast 提示） */
  async save(): Promise<void> {
    const data = this.collect();
    let sizeKB = 0;
    try { sizeKB = Math.round(JSON.stringify(data).length / 1024); } catch { sizeKB = 0; }

    let result = await Backend.saveProject(data);
    if (result.status === 'need_save_as') {
      result = await Backend.saveProjectAs(data);
      if (result.status === 'success') {
        this.lastPath = result.path ?? null;
        flowState.dirty = false;
        this._afterSave(sizeKB);
      } else if (result.status !== 'cancelled') {
        showToast('保存失败: ' + (result.message || ''), false);
      }
      return;
    }

    if (result.status === 'success') {
      this.lastPath = result.path ?? null;
      flowState.dirty = false;
      this._afterSave(sizeKB);
    } else {
      showToast('保存失败: ' + (result.message || ''), false);
    }
  }

  private _afterSave(sizeKB: number): void {
    flowState.notify();
    const hint = sizeKB > 2048 ? '（项目较大，图片已内嵌保存）' : '';
    showToast('项目已保存' + hint);
  }

  /** 打开项目（对话框） */
  async open(): Promise<void> {
    const result = await Backend.openProject();
    if (result.status === 'success' && result.data !== undefined && result.data !== null) {
      if (this.restore(result.data)) {
        this.lastPath = result.path ?? null;
        this.syncProjectNameInput();
        showToast('项目已打开');
      }
    } else if (result.status !== 'cancelled') {
      showToast('打开失败: ' + (result.message || ''), false);
    }
  }

  /** 同步项目名输入框 */
  syncProjectNameInput(): void {
    const input = document.getElementById('project-name') as HTMLInputElement | null;
    if (input) input.value = flowState.projectName;
  }
}

export const persistence = new Persistence();
