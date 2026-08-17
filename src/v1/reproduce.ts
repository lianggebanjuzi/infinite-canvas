// src/v1/reproduce.ts
// 复现编排（ReproduceService）：把带 trace 的生成结果一键回填参数并重跑（A1-A5）。
// 入口：reproduceFromNode（画布节点，P0 主/次入口）/ reproduceFromHistory（图库，A6 P1）。
// 落点（Q1 拍板）：新建独立节点（不破坏原图、可与原图对比）；位置 = 源节点右下避让；选中并自动重跑。
// 纪律（共享约定第 7 条）：复现必须走 runEngine.run() 唯一生成入口；只读 trace，不改写 history。
// 参考图还原（A3 拍板，双通道）：trace.refImageUrls（新 trace）→ 按 refImageHashes 反查项目内图池 → 缺失计数 toast 不阻断。

import { flowState } from './state/flow-state';
import { selection } from './state/selection';
import { flowHistory } from './state/history';
import { runEngine } from './engine/run-engine';
import { historyPersist } from './history-persist';
import { fetchImageModels } from './api';
import { canvasView, CARD_W } from './canvas/canvas-view';
import { showToast } from './ui/toast';

/** 参考图解析结果 */
interface ResolvedRefs {
  urls: string[];
  missing: number;
}

/** 产出节点相对生成节点的横向间距（与 run-engine 批次避让口径一致） */
const RESULT_GAP_X = 48;
/** 产出节点纵向间距（卡片高之外额外 28px） */
const RESULT_GAP_Y = 28;

class ReproduceService {
  /** 画布节点复现（P0）：读 node.trace → 回填 → 新建独立节点 → 自动重跑 */
  async reproduceFromNode(nodeId: string): Promise<void> {
    if (runEngine.isBusy()) { showToast('已有任务在运行，请稍候', false); return; } // A7 busy 语义
    const node = flowState.getNode(nodeId);
    if (!node) return;
    if (!node.trace) { showToast('该节点没有生成档案，无法复现', false); return; } // A1：无 trace 不显示/不执行
    await this._reproduce(node.trace, node);
  }

  /** 图库复现（A6 P1）：从 history.jsonl 的 image 行 trace 新建独立节点并运行 */
  async reproduceFromHistory(entry: HistoryEntry): Promise<void> {
    if (runEngine.isBusy()) { showToast('已有任务在运行，请稍候', false); return; } // A7
    if (!entry || entry.kind !== 'image') return;
    const trace: GenerationTrace = {
      prompt: entry.prompt,
      model: entry.model,
      aspectRatio: entry.aspectRatio,
      resolution: entry.resolution,
      count: entry.count,
      refImageHashes: Array.isArray(entry.refImageHashes) ? entry.refImageHashes : [],
      refImageUrls: Array.isArray(entry.refImageUrls) ? entry.refImageUrls : [],
      seed: entry.seed ?? null,
      createdAt: entry.createdAt,
      parentId: entry.parentId ?? null,
      outputType: entry.outputType,
    };
    // 图库复现没有源节点：参考图只能按 hash 反查项目内图池（entry.refImageUrls 新行直接可用）
    await this._reproduce(trace, null);
  }

  /** 公共复现流水线：模型检查 → 参考图解析 → record → 新建节点 → 挂参考图 → 选中 → run */
  private async _reproduce(trace: GenerationTrace, source: FlowNode | null): Promise<void> {
    // A2：模型不可用仅 toast，不阻断其它字段回填
    await this.checkModelAvailable(trace.model);

    // A3：参考图解析（缺失 toast「N 张参考图缺失」，不阻断运行）
    const resolved = this.resolveRefImages(trace, source ?? undefined);
    if (resolved.missing > 0) showToast(`${resolved.missing} 张参考图缺失`, false);

    // 新建独立节点（Q1：不破坏原图）
    flowHistory.record(); // 用户手势入口：变更前入撤销栈（共享约定第 5 条）
    const pos = this._placeNodeNear(source);
    const newNode = this._createNodeFromTrace(trace, pos.x, pos.y);

    // 挂载解析出的参考图（refImages 语义 = 用户主动挂载；getReferenceImages 会将其纳入本次运行参考图）
    resolved.urls.forEach(url => flowState.addRefImage(newNode.id, url));

    selection.select(newNode.id);
    showToast('已复现，正在重新生成');
    // A4：自动重跑，必须走 runEngine.run() 唯一入口
    void runEngine.run(newNode.id);
  }

  /**
   * 参考图解析（A3，优先级）：
   * ① trace.refImageUrls（新 trace 直接可用，跨会话可靠）；
   * ② 未被 URL 覆盖的 refImageHashes 反查项目内图池（遍历 flowState.nodes 的 imageUrl ∪ refImages；优先源节点自身 refImages）；
   * ③ 仍未解析的 hash → missing 计数（调用方 toast，不阻断）。
   * 注意：URL 数 < hash 数（损坏/部分 trace）时，已解析的 hash 不计缺失、差额继续走 hash 反查，保证 missing 统计真实（QA O2）。
   */
  resolveRefImages(trace: GenerationTrace, hintNode?: FlowNode): ResolvedRefs {
    const urls: string[] = [];
    const seen = new Set<string>();
    let missing = 0;

    const refUrls = Array.isArray(trace.refImageUrls) ? trace.refImageUrls.filter(u => !!u) : [];
    const hashes = Array.isArray(trace.refImageHashes) ? trace.refImageHashes.filter(h => !!h) : [];

    // ① 新 trace 直接带 URL：直接可用（URL 即事实，跨会话可靠）
    refUrls.forEach(u => {
      if (u && !seen.has(u)) { seen.add(u); urls.push(u); }
    });
    // 已被 URL 通道覆盖的 hash（同一张图的 URL 与其指纹一一对应）——不再重复反查、不计缺失
    const covered = new Set(urls.map(u => historyPersist.hashRef(u)));

    // ② 未覆盖的 hash 反查图池（源节点优先 + 全画布）；仍未解析 → missing 计数
    const pool = this._imagePool(hintNode);
    hashes.forEach(h => {
      if (covered.has(h)) return; // 已由 URL 通道解析
      const match = pool.find(u => historyPersist.hashRef(u) === h);
      if (match) {
        if (!seen.has(match)) { seen.add(match); urls.push(match); }
        covered.add(h);
      } else {
        missing += 1;
      }
    });
    return { urls, missing };
  }

  /** 模型可用性检查（A2）：不可用 → toast「模型不可用，已保留原参数」，不阻断；无法判定视为可用 */
  async checkModelAvailable(model: string): Promise<boolean> {
    if (!model) return true;
    try {
      const models = await fetchImageModels();
      if (models.length > 0) {
        // multi-key：完整 id 是三段（provider:key:model）；旧项目 trace 可能是两段（provider:model），宽容匹配
        const available = models.some(m => m.id === model) || this._tolerantMatch(models, model);
        if (!available) {
          showToast('模型不可用，已保留原参数', false);
          return false;
        }
      }
    } catch {
      // 拉取失败不阻断
    }
    return true;
  }

  /** 旧两段 id（provider:model）宽容匹配：在已过滤模型中找同名模型（与 api.ts 惰性重写同语义） */
  private _tolerantMatch(models: Array<{ id: string }>, saved: string): boolean {
    const parts = saved.split(':');
    if (parts.length !== 2) return false;
    const [pid, mid] = parts;
    return models.some(m => m.id.startsWith(`${pid}:`) && m.id.endsWith(`:${mid}`));
  }

  /** 从 trace 配方创建复现节点（image-gen 独立节点，modelType 强制 draw；参数 = trace） */
  private _createNodeFromTrace(trace: GenerationTrace, x: number, y: number): FlowNode {
    const params: StyleTransferParams = {
      prompt: trace.prompt || '',
      model: trace.model || '',
      aspectRatio: trace.aspectRatio || '3:4',
      resolution: trace.resolution || '2k',
      count: typeof trace.count === 'number' ? trace.count : 1,
      modelType: 'draw', // 复现强制绘图态（产出节点语义，与 createResultCard 一致；text 反推产物 trace 恒 null 无入口）
      textModel: '',
    };
    return flowState.addNode('image-gen', x, y, {
      title: '复现结果',
      params: { ...params },
      status: 'idle',
      parentId: null,
      trace: null, // 新节点未生成，trace 由引擎成功后写入（source of truth）
    });
  }

  /**
   * 新节点位置：源节点右下方避让（复用批次产出避让算法：x=源.x+CARD_W+GAP，y 向下避让同列卡片）。
   * 无源节点（图库复现）→ 画布视口中心（世界坐标），避免与既有节点完全重叠。
   */
  private _placeNodeNear(source: FlowNode | null): { x: number; y: number } {
    if (!source) {
      const wrap = document.getElementById('canvas-wrap');
      if (wrap) {
        const rect = wrap.getBoundingClientRect();
        const world = canvasView.toWorldCoords(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return { x: world.x, y: world.y };
      }
      return { x: 320, y: 320 };
    }
    const x = source.x + CARD_W + RESULT_GAP_X;
    let y = source.y;
    flowState.nodes.forEach(n => {
      if (n.id === source.id) return;
      if (Math.abs(n.x - x) >= CARD_W / 2) return; // 只统计同列（x 相近）卡片
      const nH = Math.round(CARD_W / (n.ratio > 0 ? n.ratio : 3 / 4));
      y = Math.max(y, n.y + nH + RESULT_GAP_Y);
    });
    return { x, y };
  }

  /** 项目内图池（hash 反查用）：源节点自身 refImages/imageUrl 优先，再遍历全画布节点的 imageUrl ∪ refImages；去重保序 */
  private _imagePool(hintNode?: FlowNode): string[] {
    const pool: string[] = [];
    const seen = new Set<string>();
    const push = (u: string): void => {
      if (u && !seen.has(u)) { seen.add(u); pool.push(u); }
    };
    if (hintNode) {
      (hintNode.refImages || []).forEach(push);
      if (hintNode.imageUrl) push(hintNode.imageUrl);
    }
    flowState.nodes.forEach(n => {
      if (n.imageUrl) push(n.imageUrl);
      (n.refImages || []).forEach(push);
    });
    return pool;
  }
}

export const reproduceService = new ReproduceService();
