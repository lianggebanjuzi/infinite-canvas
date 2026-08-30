// src/v1/engine/run-engine.ts
// 执行引擎：run(nodeId)/runSelected()/runAll() + 状态机转换 + 下游 stale + 批次限流队列（T03）
// 唯一生成入口：任何节点类型不得绕过引擎直连 backend（共享约定第 3 条）
//
// 批次模型（3.4 / B 批次改造）：
//   - 生成节点 run → runBatch：N=clamp(count,1,4) 或文本拆分段数（启动时快照）
//   - 经 batch-queue 限流执行（默认并发 2，可配 1~3）；删除 Promise.allSettled 全量并发
//   - Batch = 执行态事实源（batch-store）；Job 成功回调（onComplete）单向写回节点结果
//   - count=1 单图：第 1 张（也是唯一一张）写回源节点自身 imageUrl（旧图先入历史）
//   - count>1 与文本拆分：全部成功图写回 generatedImages（同一节点卡内浏览），首图兼作 imageUrl 预览；
//     废除自动建子卡（createResultCard 保留供扩图/历史兼容入口使用）
//   - 每 Job 独立 error；失败可逐条（retryJob）/全部（retryFailed）重试；成功图不因兄弟失败丢失
//   - 重跑先 removeChildren 清掉旧的「纯引擎产出」子节点（安全策略见 flow-state；手动改造的保留并标 stale；
//     用户拍板：历史子节点按现有安全策略处理，不额外删除）
//   - 批次汇总：全成功 done / 有成功有失败 partial-failed / 全失败 fail / 取消 idle（旧图保留）
//   - 运行保护粒度=单个节点；不同节点可并行，单个批次内部仍由队列限流
//
// 文本走线 / 反推归位（增量）：
//   - prompt 合成唯一入口 composeImagePrompt：上游文本（getUpstreamTextPrompts 连线序拼接）+ 自身 params.prompt（非空追加在后）
//   - 文本变化三处联动（运行成功/就地编辑/历史回填）统一 = 写 outputText + dirty.markUpstreamChanged；旁路覆盖下游 prompt 的旧函数已删除
//   - 文本节点由 textGeneration 接入上游图（data:image 过滤 + 前置校验「图片格式不支持反推」），反推归位到文本节点自身
//   - 素材节点（isAsset）不可运行：run() 静默跳过（不 toast、不设运行态），canRun 亦拒绝

import { flowState } from '../state/flow-state';
import { dirty } from '../state/dirty';
import { flowHistory } from '../state/history';
import { nodeRegistry } from '../nodes/node-registry';
import { Backend, fetchImageModels, fetchVideoModels, fetchAudioModels } from '../api';
import { pollTask, PollResult } from './poller';
import { batchStore } from '../state/batch-store';
import { batchQueue, readConcurrency, BatchCompleteFn, BatchJobCompleteFn, RunJobFn } from './batch-queue';
import { historyDrawer } from '../ui/history-drawer';
import { historyPersist } from '../history-persist';
import { linkView } from '../canvas/link-view';
import { CARD_W, imageCardHeight } from '../canvas/canvas-view';
import { showToast } from '../ui/toast';
import { OUTPAINT_PROMPT_PREFIX, composeOutpaintDataUrl, loadOutpaintImage } from './outpaint-util';
import { ActiveRun, MediaTaskRecoveryController } from './media-task-recovery';
import { MediaGenerationController } from './media-generation';
import { makeImageGenerationJob } from './image-generation-job';
import { TextGenerationController } from './text-generation';

/** 节点定义执行上下文（供 canRun/buildOptions 使用） */
const ctx: FlowContext = {
  getUpstreams: id => flowState.getUpstreams(id),
  getDownstreams: id => flowState.getDownstreams(id),
  getReferenceImages: id => flowState.getReferenceImages(id),
  getImageModels: fetchImageModels,
  getVideoModels: fetchVideoModels,
  getAudioModels: fetchAudioModels,
};

/** 批次执行处理器（run-engine 侧注册；重试时复用同一批 runJob/onComplete，保证与原始批次同源） */
interface BatchRunner {
  nodeId: string;
  runJob: RunJobFn;
  onJobComplete: BatchJobCompleteFn;
  onComplete: BatchCompleteFn;
}

/** 生成请求并发数上限/下限 */
const COUNT_MIN = 1;
const COUNT_MAX = 4;
/** 产出节点相对生成节点的横向间距 */
const RESULT_GAP_X = 48;
/** 产出节点纵向间距（卡片高之外额外 28px） */
const RESULT_GAP_Y = 28;

/** 产出节点布局游标（批次共享）：x 固定，y 按已放置卡片的累计底部递增，保证并发下任意比例组合不重叠 */
interface ResultLayout {
  x: number;
  cursorY: number;
}

/**
 * 加载图片并返回实际宽高比（naturalWidth / naturalHeight）。
 * 后端 image_url 不附带尺寸信息，需前端加载图片获取；加载失败/尺寸无效返回 null。
 * 带 10s 超时保护，避免加载异常阻塞状态回写。
 */
function loadImageRatio(url: string): Promise<number | null> {
  return new Promise(resolve => {
    const img = new Image();
    let settled = false;
    const timer = setTimeout(() => finish(null), 10000); // 10s 超时保护
    const finish = (ratio: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      resolve(ratio);
    };
    img.onload = () => {
      const ratio = img.naturalWidth > 0 && img.naturalHeight > 0
        ? img.naturalWidth / img.naturalHeight
        : null;
      finish(ratio);
    };
    img.onerror = () => finish(null);
    img.src = url;
  });
}

/** 任务创建单次调用超时（pywebview 桥接 Promise 永不 settle 的兜底；超时抛错走 catch → 计 fail，不会挂死批次） */
const TASK_CREATE_TIMEOUT_MS = 60000;

/**
 * 给 Promise 加单次超时：超时 reject 而非无限等待（桥接掉包场景兜底）。
 * 显式 then/clearTimeout 模式：源 Promise 稍后 settle 也不会产生 unhandled rejection。
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}（${Math.round(ms / 1000)}s 未响应）`)), ms);
    p.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}

class RunEngine {
  /** 按节点维护活动任务：不同节点可并行，同一节点仍由 status='run' 防重复启动。 */
  private activeRuns = new Map<string, ActiveRun>();
  /** 项目重开后的媒体任务查询恢复（不创建新任务）。 */
  private readonly mediaTaskRecovery = new MediaTaskRecoveryController(this.activeRuns, active => this._isActive(active));
  /** 视频与音频的新任务执行（不拥有全局活动运行表）。 */
  private readonly mediaGeneration = new MediaGenerationController({
    context: ctx,
    isActive: active => this._isActive(active),
    resolveReferenceImages: nodeId => this._resolveGenerationReferenceImages(nodeId),
    composePrompt: nodeId => this.composeImagePrompt(nodeId),
  });
  /** 文本的新任务执行（活动运行表与撤销历史仍由 RunEngine 所有）。 */
  private readonly textGeneration = new TextGenerationController({
    context: ctx,
    isActive: active => this._isActive(active),
  });

  /** 执行中批次处理器注册表（batchId → runJob/onComplete；供逐条/全部重试复用，新批次开始时清理同节点旧条目） */
  private _batchRunners = new Map<string, BatchRunner>();
  /** 读取批次进度（cmd-panel 选中 run 节点时展示「生成中 done/total」）；从 batch-store 派生（共享约定 1，禁止双写） */
  getBatchProgress(nodeId: string): { total: number; done: number; failed: number } | undefined {
    const batch = batchStore.getActiveBatch(nodeId) ?? batchStore.getLatestBatch(nodeId);
    if (!batch) return undefined;
    const s = batchStore.summarize(batch.id);
    return { total: s.total, done: s.succeeded, failed: s.failed };
  }

  /** 移除已结束批次在底部任务栏中的记录；不影响画布生成结果或历史。 */
  dismissBatch(batchId: string): boolean {
    const batch = batchStore.getBatch(batchId);
    if (!batch || batch.status === 'queued' || batch.status === 'running') return false;
    this._batchRunners.delete(batchId);
    return batchStore.removeFinishedBatch(batchId);
  }

  /**
   * 展示图解析（治本：done 响应不再携带大图 base64——缩略图失败时 image_url 为空）。
   * 优先级：缩略图 imageUrl → 按 originalPath 经 loadLocalImage 读原图（data URL）→ originalUrl；
   * 都不可用 → null（调用方判失败并给出明确提示，不静默白屏）。
   */
  private async _resolveImageUrl(result: PollResult): Promise<string | null> {
    if (result.imageUrl) return result.imageUrl;
    if (result.originalPath) {
      try {
        // 原图 base64 跨桥接按需传输：加 60s 单次超时，避免桥接悬挂导致节点永远卡「生成中」。
        // loadLocalImage 与轮询无关（一次性取图）；超时/失败落到 originalUrl 兜底或明确失败。
        const res = await withTimeout(
          Backend.loadLocalImage(result.originalPath),
          60000,
          '原图加载超时',
        );
        if (res.status === 'success' && res.data_url) return res.data_url;
      } catch {
        // 读取失败/超时落到 originalUrl 兜底
      }
    }
    if (result.originalUrl) return result.originalUrl;
    return null;
  }

  /**
   * 图生图提交专用的参考图快照。
   *
   * 画布节点的 imageUrl 是轻量缩略图，不能直接拿来当下一轮的模型输入；
   * 若上游结果已落盘，优先按 imageOrigin.path 读回原图。这样大图只在真正
   * 发起图生图时短暂经过桥接，不会常驻在节点/DOM 中。旧项目、手动参考图
   * 或原图读取失败时保留现有缩略图回退，避免阻断生成。
   */
  private async _resolveGenerationReferenceImages(nodeId: string): Promise<string[]> {
    const node = flowState.getNode(nodeId);
    if (!node) return [];

    const sourceSeen = new Set<string>();
    const result: string[] = [];

    const originFor = (displayUrl: string): ImageOrigin | null | undefined => {
      // 用户手动挂入的图也可能正好来自某个已有结果节点；命中时同样使用原图。
      const owner = flowState.nodes.find(candidate => candidate.imageUrl === displayUrl);
      return owner?.imageOrigin;
    };

    const append = async (displayUrl: string, origin?: ImageOrigin | null): Promise<void> => {
      if (!displayUrl || sourceSeen.has(displayUrl)) return;
      sourceSeen.add(displayUrl);

      let requestUrl = displayUrl;
      if (origin?.path) {
        try {
          const loaded = await withTimeout(
            Backend.loadLocalImage(origin.path),
            60000,
            '原图参考读取超时',
          );
          if (loaded.status === 'success' && loaded.data_url) {
            requestUrl = loaded.data_url;
          }
        } catch {
          // 原图在移动/清理后不可读时，保持缩略图兼容旧项目与临时目录结果。
        }
      }
      result.push(requestUrl);
    };

    // 保持既有顺序：节点主动挂载参考图在前，直接上游输出在后。
    for (const url of node.refImages || []) {
      await append(url, originFor(url));
    }
    for (const upstream of flowState.getUpstreams(nodeId)) {
      if (upstream.imageUrl) {
        await append(upstream.imageUrl, upstream.imageOrigin);
      } else {
        for (const url of upstream.refImages || []) {
          await append(url, originFor(url));
        }
      }
    }
    return result;
  }

  /**
   * 4.1-B @素材：把节点 params.mentions 中的图片类引用解析为参考图 data URL。
   * 解析顺序：mention.imageUrl（data:image 直接可用 / 其余原样）→ sourceNodeId 对应节点 imageUrl → originalPath 读原图。
   * 与现有 refs 去重保序，避免同一张图被连续引用两次。
   */
  private async _resolveMentionImages(nodeId: string, existingRefs: string[]): Promise<string[]> {
    const node = flowState.getNode(nodeId);
    if (!node) return existingRefs;
    const p = node.params as unknown as StyleTransferParams;
    const mentions = Array.isArray(p.mentions) ? p.mentions : [];
    if (mentions.length === 0) return existingRefs;
    const result = [...existingRefs];
    const seen = new Set(existingRefs);
    for (const m of mentions) {
      if (m.kind !== 'image') continue;
      let url = m.imageUrl || '';
      if (!url && m.sourceNodeId) {
        const src = flowState.getNode(m.sourceNodeId);
        if (src?.imageUrl) url = src.imageUrl;
      }
      if (!url && m.originalPath) {
        try {
          const loaded = await Backend.loadLocalImage(m.originalPath);
          if (loaded.status === 'success' && loaded.data_url) url = loaded.data_url;
        } catch {
          // 原图不可读时跳过该 mention（不阻断整体生成）
        }
      }
      if (url && !seen.has(url)) {
        seen.add(url);
        result.push(url);
      }
    }
    return result;
  }

  /** 4.1-B @素材：文本类 mention 的正文附加到提示词之后（作为显式上下文，不扫描画布）。 */
  private appendMentionText(nodeId: string, prompt: string): string {
    const node = flowState.getNode(nodeId);
    if (!node) return prompt;
    const p = node.params as unknown as StyleTransferParams;
    const mentions = Array.isArray(p.mentions) ? p.mentions : [];
    const extra = mentions
      .filter(m => m.kind === 'text' && typeof m.text === 'string' && m.text.trim().length > 0)
      .map(m => (m.text as string).trim())
      .join('\n');
    if (!extra) return prompt;
    return prompt ? `${prompt}\n${extra}` : extra;
  }

  /** 是否存在运行中的节点（撤销/重做与关闭保护仍在运行期禁用）。 */
  isBusy(): boolean {
    return this.activeRuns.size > 0;
  }

  /** Stop owning this local run without waiting for an upstream task that cannot be cancelled. */
  cancel(nodeId: string): boolean {
    const active = this.activeRuns.get(nodeId);
    if (!active) return false;

    active.cancelled = true;
    this.activeRuns.delete(nodeId);
    // 取消批次：剩余 Job → cancelled；在途 Job 由队列 hooks.isCancelled 停止（B-2 取消语义）
    const batch = batchStore.getActiveBatch(nodeId);
    if (batch) batchQueue.cancelBatch(batch.id);
    linkView.setNodeFlowing(nodeId, false);
    if (active.historySuspended) {
      flowHistory.resume();
      active.historySuspended = false;
    }
    const node = flowState.getNode(nodeId);
    if (node?.status === 'run') flowState.updateNode(nodeId, { status: 'idle', error: null });
    else flowState.notify();
    return true;
  }

  private _isActive(run: ActiveRun): boolean {
    return this.activeRuns.get(run.nodeId) === run && !run.cancelled;
  }

  async run(nodeId: string): Promise<void> {
    const node = flowState.getNode(nodeId);
    if (!node) return;
    if (node.status === 'run') return;
    // 素材节点（isAsset）数据层闸门：静默跳过（不 toast；防 run-all 噪音；canRun 亦拒绝）
    if (flowState.isAsset(nodeId)) return;

    const def = nodeRegistry.get(node.type);
    const check = def.canRun(node, ctx);
    if (typeof check === 'string') { showToast(check, false); return; }

    // 扩图是画布内一个持久化的 image-gen 步骤，但请求形态与普通绘图不同：
    // 先根据已连上的源图合成白色待补全画布，再交给既有扩图执行链路。
    if (node.type === 'image-gen' && (node.params as unknown as StyleTransferParams).mode === 'outpaint') {
      await this.runPersistedOutpaint(nodeId);
      return;
    }

    const active: ActiveRun = { nodeId, cancelled: false, historySuspended: true };
    this.activeRuns.set(nodeId, active);
    flowHistory.suspend(); // 引擎内部状态/产出变更不入撤销栈（R5.5）
    try {
      if (node.type === 'text-gen') {
        await this.textGeneration.run(nodeId, active);
      } else if (node.type === 'video-gen') {
        await this.mediaGeneration.runVideo(nodeId, active);
      } else if (node.type === 'audio-gen') {
        await this.mediaGeneration.runAudio(nodeId, active);
      } else {
        // 旧 modelType='text' 反推分支已删除（Q7）：image-gen 一律按 draw 走 runBatch
        await this.runBatch(nodeId, active);
      }
    } finally {
      if (active.historySuspended) {
        flowHistory.resume();
        active.historySuspended = false;
      }
      if (this.activeRuns.get(nodeId) === active) this.activeRuns.delete(nodeId);
    }
  }

  /** 是否存在运行中/待恢复的媒体任务（视频/音频；含跨会话可恢复的 params.videoTask/audioTask）。 */
  mediaTasksInProgress(): { nodeId: string; kind: 'video' | 'audio'; remoteTaskId?: string }[] {
    return this.mediaTaskRecovery.inProgress();
  }

  /** 项目打开后恢复进行中的视频/音频任务：accepted/processing 只查询原任务，不重投（4.0 §3.2）。 */
  recoverMediaTasks(): void {
    this.mediaTaskRecovery.recoverAll();
  }

  /** 运行已保存在画布中的扩图步骤（含节点参数的比例、提示词和可选摆放）。 */
  private async runPersistedOutpaint(nodeId: string): Promise<void> {
    const node = flowState.getNode(nodeId);
    if (!node) return;
    const p = node.params as unknown as StyleTransferParams;
    const refs = await this._resolveGenerationReferenceImages(nodeId);
    if (refs.length === 0) { showToast('扩图节点需要连接一张源图片', false); return; }
    const src = await loadOutpaintImage(refs[0]);
    if (!src) { showToast('源图片加载失败，无法扩图', false); return; }
    const aspectRatio = p.aspectRatio || '1:1';
    const dataUrl = composeOutpaintDataUrl(src, aspectRatio, p.outpaintPlacement);
    if (!dataUrl) { showToast('图片合成失败，无法扩图', false); return; }
    const detail = (p.prompt || '').trim();
    await this.runOutpaint(nodeId, {
      prompt: detail ? `${OUTPAINT_PROMPT_PREFIX}。${detail}` : OUTPAINT_PROMPT_PREFIX,
      referenceImages: [dataUrl],
      aspectRatio,
      model: p.model,
      resolution: p.resolution || '4k',
    });
  }

  /**
   * 扩图执行公共链路：画布内持久化扩图步骤与调节弹层共用。
   * 前端先提供白底合成图，再由扩图模型补全。新版图片操作条会将结果就地回写当前节点；
   * 旧的持久化扩图步骤则保留子节点产出，以兼容已有画布。
   */
  async runOutpaint(nodeId: string, opts: OutpaintOptions): Promise<void> {
    const node = flowState.getNode(nodeId);
    if (!node) return;
    if (node.status === 'run') { showToast('该节点正在生成中', false); return; }
    const refs = opts.referenceImages || [];
    if (refs.length === 0) { showToast('请先合成扩图底图', false); return; }
    if (!opts.model) { showToast('请先在设置中配置 Nano Banana 系列模型', false); return; }

    const active: ActiveRun = { nodeId, cancelled: false, historySuspended: true };
    this.activeRuns.set(nodeId, active);
    flowHistory.suspend(); // 引擎内部状态/产出节点不入撤销栈
    const prevStatus = node.status;
    const isWorkflowNode = (node.params as unknown as StyleTransferParams).mode === 'outpaint';
    const createdCardIds = new Set<string>();
    try {
      // 旧扩图步骤重跑时清理自己的纯结果；就地扩图绝不能删除当前图片已有的下游编排。
      if (!opts.replaceNode) flowState.removeChildren(nodeId);
      // 执行中：源节点 run + 上游连线流光（结束后恢复原状态）
      flowState.updateNode(nodeId, { status: 'run', error: null });
      linkView.setNodeFlowing(nodeId, true);

      // 单张扩图请求：count=1 + 合成底图参考图 + 目标比例 + 4k
      const created = await withTimeout(
        Backend.generateImage(opts.prompt, {
          model: opts.model,
          aspectRatio: opts.aspectRatio || '1:1',
          resolution: opts.resolution || '4k',
          count: COUNT_MIN,
          referenceImages: refs,
        }),
        TASK_CREATE_TIMEOUT_MS,
        '扩图任务创建超时',
      );
      if (!this._isActive(active)) return;
      if (!created || !created.task_id) {
        throw new Error('任务创建失败，未返回 task_id');
      }
      const result = await pollTask(created.task_id);
      if (!this._isActive(active)) return;
      if (!result.success) {
        throw new Error(result.error || '扩图失败');
      }
      // 展示图解析：缩略图优先；为空且有 originalPath → loadLocalImage 按路径取图（治本：大图不进轮询响应）
      const displayUrl = await this._resolveImageUrl(result);
      if (!this._isActive(active)) return;
      if (!displayUrl) throw new Error(result.error || '扩图成功但未返回图片数据');
      // P3：未配置图片保存路径 → 生成图未落盘（tempfile 兜底），人话提示不阻断
      if (result.savedToDisk === false) {
        showToast('图片保存路径未设置，生成图不会落盘到本地', false);
      }

      // 原图引用（图片性能优化：卡片主视觉=缩略图，大图按需加载用）
      const origin: ImageOrigin | null = result.originalPath
        ? { path: result.originalPath, url: result.originalUrl }
        : null;

      // R3：扩图产出（count=1 的批次）也生成 batchId，历史按批次视图下作为单张批次卡展示
      const batchId = `${nodeId}_${Date.now()}`;
      if (opts.replaceNode) {
        await this._writeBackToSelf(nodeId, displayUrl, origin, batchId, 'outpaint', opts.prompt, result.width, result.height, active);
        if (!this._isActive(active)) return;
        dirty.markUpstreamChanged(nodeId);
      } else {
        // 旧扩图步骤仍保留子节点产出，确保已保存的画布不改变其编排语义。
        const x = node.x + CARD_W + RESULT_GAP_X;
        let y = node.y;
        flowState.nodes.forEach(n => {
          if (n.id === node.id) return;
          if (Math.abs(n.x - x) >= CARD_W / 2) return;
          const nH = imageCardHeight(n.ratio);
          y = Math.max(y, n.y + nH + RESULT_GAP_Y);
        });
        const layout: ResultLayout = { x, cursorY: y };
        const card = await this.createResultCard(nodeId, displayUrl, layout, {
          model: opts.model,
          aspectRatio: opts.aspectRatio || '1:1',
          resolution: opts.resolution || '4k',
          mode: 'draw',
        }, { outputType: 'outpaint', refs: refs, batchId }, origin, opts.prompt, result.width, result.height, active);
        if (!this._isActive(active)) return;
        createdCardIds.add(card.id);
        dirty.markUpstreamChangedExcept(nodeId, createdCardIds);
      }

      // 画布扩图步骤本身收敛为 done；保留旧的一次性入口则仍恢复其源图节点原状态。
      flowState.updateNode(nodeId, { status: isWorkflowNode || opts.replaceNode ? 'done' : prevStatus, error: null, lastRunAt: Date.now() });
      showToast('扩图完成');
    } catch (e) {
      if (!this._isActive(active)) return;
      const message = (e as Error).message || '扩图失败';
      // 画布扩图节点需要把失败状态留在画布上，便于修改后重跑；旧入口保持源图不受影响。
      flowState.updateNode(nodeId, isWorkflowNode ? { status: 'fail', error: message } : { status: prevStatus, error: null });
      showToast(message, false);
    } finally {
      if (this._isActive(active)) linkView.setNodeFlowing(nodeId, false);
      if (active.historySuspended) {
        flowHistory.resume();
        active.historySuspended = false;
      }
      if (this.activeRuns.get(nodeId) === active) this.activeRuns.delete(nodeId);
    }
  }

  /**
   * prompt 合成唯一入口（共享约定第 2 条；禁止其它地方拼 prompt）：
   * 上游文本（flowState.getUpstreamTextPrompts 按连线序拼接）+ 自身 params.prompt（非空追加在后），join('\n')。
   * 用于 runBatch 实际请求、生成 trace 记录、cmd-panel 最终 prompt 预览（W3-2/W3-4）。
   */
  composeImagePrompt(nodeId: string): string {
    const splitPrompts = flowState.getUpstreamTextSplitPrompts(nodeId);
    // 拆分模式以槽位文本为完整提示词，不叠加图片节点自身提示词。
    if (splitPrompts.length > 0) return splitPrompts[0];
    const parts = flowState.getUpstreamTextPrompts(nodeId);
    const node = flowState.getNode(nodeId);
    const p = node ? (node.params as unknown as StyleTransferParams) : null;
    const own = p && typeof p.prompt === 'string' ? p.prompt.trim() : '';
    if (own) parts.push(own);
    return parts.join('\n');
  }

  /**
   * 批次执行（生成节点专用）：经 batch-queue 限流执行（默认并发 2，可配 1~3）。
   * 前置：canRun 已通过；当前节点已进入运行态。
   * B 批次改造（T03）：
   *   - 删除 Promise.allSettled 全量并发与瞬时 batchProgress；改为 batchStore.createBatch → batchQueue.submit；
   *   - Batch = 执行态事实源；Job 成功回调（onComplete）单向写回节点结果（imageUrl/generatedImages/trace 带 batchId+jobId）；
   *   - count=1 单图保持「第 1 张写回自身」；count>1 与文本拆分统一写回 generatedImages（废除自动建子卡；
   *     历史子节点按现有安全策略处理，不额外删除）；
   *   - 每 Job 独立 error（不再共享 lastError）；失败可逐条/全部重试（retryJob/retryFailed）。
   */
  private async runBatch(nodeId: string, active: ActiveRun): Promise<void> {
    const node = flowState.getNode(nodeId);
    if (!node) return;

    // 1. 启动时快照参数与 options（buildOptions 只取一次、强制 count:1）
    const params = node.params as unknown as StyleTransferParams;
    // prompt 合成唯一入口：上游文本（连线序拼接）+ 自身 prompt（非空追加在后）（W3-2/Q5）
    const splitPrompts = flowState.getUpstreamTextSplitPrompts(nodeId);
    const usesTextSplit = splitPrompts.length > 0;
    // 4.1-B @素材：文本类 mention 正文附加到提示词之后（token 的 @label 文本已在 params.prompt 中）
    const basePrompt = usesTextSplit ? splitPrompts[0] : this.composeImagePrompt(nodeId);
    const prompt = this.appendMentionText(nodeId, basePrompt);
    const total = usesTextSplit ? splitPrompts.length : Math.min(COUNT_MAX, Math.max(COUNT_MIN, Math.round(Number(params.count) || COUNT_MIN)));
    // R3：批次号 = 生成节点 id + 批次启动时刻（同批全部成功图共用；同节点重跑 → 时间戳不同 → 可区分）
    const batchId = `${nodeId}_${Date.now()}`;
    const def = nodeRegistry.get(node.type);
    const options = def.buildOptions(node, ctx);
    options.count = COUNT_MIN;

    // 1.5 入口快照参考图：空 → 文生图；非空 → 图生图。展示层仍持有
    // 缩略图，但提交给模型时优先读取上游原图，避免连续图生图损失色彩/细节。
    //     isTxt2Img 仅用于 outputType 标记（'txt2img'/'img2img'）与 trace 参考图透传，不再决定回写/清空分支（Q1）。
    const refs = await this._resolveGenerationReferenceImages(nodeId);
    // 4.1-B @素材：图片类 mention 并入参考图（显式 @引用即上下文，不扫描整张画布）
    const allRefs = await this._resolveMentionImages(nodeId, refs);
    options.referenceImages = allRefs;
    const isTxt2Img = allRefs.length === 0;
    if (!usesTextSplit && node.generatedImages?.length) {
      // 退出拆分模式后恢复普通图片节点的单图/批次行为。
      flowState.updateNode(nodeId, { generatedImages: [], activeGeneratedIndex: 0 });
    }

    // 2. 重跑顶掉：置 run 之前先清掉上次的「纯引擎产出」子节点（安全策略见 flow-state；
    //    手动改造的产出节点保留并标 stale；用户拍板：历史子节点按现有安全策略处理，不额外删除）
    flowState.removeChildren(nodeId);

    // 3. 置 run + 上游连线流光
    flowState.updateNode(nodeId, { status: 'run', error: null });
    linkView.setNodeFlowing(nodeId, true);

    // 每个批次独占其产出和落盘状态；节点间并行时不能共用引擎级可变状态。
    const createdCardIds = new Set<string>();
    const batchFlags = { sawNotSavedToDisk: false };
    // 新批次开始：同节点旧批次执行器失效（旧批次重试入口不再可用）
    for (const [bid, runner] of this._batchRunners) {
      if (runner.nodeId === nodeId) this._batchRunners.delete(bid);
    }
    flowState.notify(); // 面板立即显示「排队中 0/total」

    // 4. 同步创建批次（jobs.length === total）+ 注册执行器 + 提交队列（限流执行，不再全量并发）
    //    批次号由本函数预计算透传（避免 createBatch 内部再取 Date.now() 跨毫秒边界导致 submit 查不到批次）
    const prompts = usesTextSplit ? splitPrompts : Array.from({ length: total }, () => prompt);
    batchStore.createBatch({
      id: batchId,
      nodeId,
      source: usesTextSplit ? 'text-split' : 'manual-count',
      total,
      concurrency: readConcurrency(total),
      prompts,
    });
    const outputType: Exclude<GenerationTrace['outputType'], 'video' | 'audio'> = isTxt2Img ? 'txt2img' : 'img2img';
    const runJob = makeImageGenerationJob(
      { resolveDisplayUrl: result => this._resolveImageUrl(result) },
      options,
      () => { batchFlags.sawNotSavedToDisk = true; },
    );
    // count=1 单图路径保持「第 1 张写回自身」；count>1 与文本拆分写回 generatedImages；
    const isSingleImage = !usesTextSplit && total === 1;
    const onJobComplete = this._makeBatchJobComplete(nodeId, allRefs, outputType, isSingleImage, createdCardIds);
    const onComplete: BatchCompleteFn = async () => { /* 成功结果已逐张写回；终态只由下方汇总收敛。 */ };
    this._batchRunners.set(batchId, { nodeId, runJob, onJobComplete, onComplete });

    const finished = await batchQueue.submit(batchId, runJob, onJobComplete, onComplete);
    if (!this._isActive(active)) return; // 取消：cancel() 已置 idle；onComplete 对取消批次不写回

    linkView.setNodeFlowing(nodeId, false);

    // 5. 汇总（从 batch-store 派生；共享约定 1：禁止双写）
    const after = flowState.getNode(nodeId);
    if (!after) return; // 批次期间生成节点被删除
    const s = batchStore.summarize(batchId);
    if (finished?.status === 'cancelled') {
      // 取消：恢复 idle（与旧 cancel 语义一致；已成功 Job 结果由 onComplete 保留在节点，不丢）
      flowState.updateNode(nodeId, { status: 'idle', error: null });
      return;
    }
    if (s.succeeded > 0) {
      // 有成功 → done（全成功）/ partial-failed（有成功有失败）；旧下游标 stale（新产出节点跳过）
      flowState.updateNode(nodeId, {
        status: s.failed > 0 ? 'partial-failed' : 'done',
        error: null,
        lastRunAt: Date.now(),
      });
      dirty.markUpstreamChangedExcept(nodeId, createdCardIds);
      showToast(s.failed > 0 ? `成功 ${s.succeeded}/${s.total}，失败 ${s.failed}` : `成功 ${s.succeeded}/${s.total}`);
      // P3：本批次出现过未落盘（未配置图片保存路径）→ 统一提示一次，不阻断结果展示
      if (batchFlags.sawNotSavedToDisk) {
        showToast('图片保存路径未设置，生成图不会落盘到本地', false);
      }
    } else {
      // 全失败：保留旧图，节点 fail（toast 带具体原因，避免「没图却不知为何」）
      const err = batchStore.firstError(batchId) || '生成失败';
      flowState.updateNode(nodeId, { status: 'fail', error: err });
      showToast(`生成失败：${err}`, false);
    }
  }

  /**
   * 单张完成写回回调：每个 Job 成功后立即更新节点，因此用户可在其它任务仍运行时浏览结果。
   * - count=1 单图 → _writeBackToSelf；count>1 / 文本拆分 → 更新当前已完成的 generatedImages；
   * - 取消批次不写回（与现状 cancel 语义一致）；Job 独立成功图不因兄弟失败丢失（B-3）。
   */
  private _makeBatchJobComplete(
    nodeId: string,
    refs: string[],
    outputType: Exclude<GenerationTrace['outputType'], 'video' | 'audio'>,
    isSingleImage: boolean,
    createdCardIds: Set<string>,
  ): BatchJobCompleteFn {
    return async (batch, job) => {
      const node = flowState.getNode(nodeId);
      if (!node) return;
      if (batch.status === 'cancelled') return; // 取消不写回（与现状 cancel 语义一致；Job 结果仍保留在 batch-store）
      if (job.status !== 'succeeded' || !job.image) return;
      if (isSingleImage) {
        const im = job.image;
        const origin: ImageOrigin | null = im.originalPath ? { path: im.originalPath, url: im.originalUrl } : null;
        await this._writeBackToSelf(nodeId, im.url, origin, batch.id, outputType, job.prompt, im.width, im.height, undefined, job.id);
      } else {
        await this._applyBatchJobResult(nodeId, batch, job, refs, outputType);
      }
    };
  }

  /** 批量单图即时写回：节点列表取当前全部成功 Job，但历史/流水只追加刚完成的一张，避免重复记录。 */
  private async _applyBatchJobResult(
    nodeId: string,
    batch: GenerationBatch,
    completedJob: GenerationJob,
    refs: string[],
    outputType: Exclude<GenerationTrace['outputType'], 'video' | 'audio'>,
  ): Promise<void> {
    const node = flowState.getNode(nodeId);
    if (!node || !completedJob.image) return;
    const completedRatio = await loadImageRatio(completedJob.image.url);
    // 图片尺寸加载期间其它 Job 仍可能完成；以存储中的最新成功集为准，不能把它们覆盖掉。
    const liveBatch = batchStore.getBatch(batch.id);
    const ordered = (liveBatch?.jobs ?? batch.jobs)
      .filter(j => j.status === 'succeeded' && !!j.image)
      .sort((a, b) => a.index - b.index);
    if (ordered.length === 0) return;
    const first = ordered[0];
    const im = first.image!;
    // 若较低 index 的图片已先到达，沿用它已写入的比例；不能误把当前 Job 的比例套到另一张预览图上。
    const ratio = im.url === completedJob.image.url ? completedRatio : null;
    flowState.setNodeImage(nodeId, im.url, ratio && ratio > 0 ? ratio : undefined, im.width, im.height);
    node.imageOrigin = im.originalPath ? { path: im.originalPath, url: im.originalUrl } : null;
    node.generatedImages = ordered.map(j => ({
      url: j.image!.url,
      prompt: j.prompt,
      origin: j.image!.originalPath ? { path: j.image!.originalPath, url: j.image!.originalUrl } : null,
      width: j.image!.width,
      height: j.image!.height,
    }));
    node.activeGeneratedIndex = 0;
    const trace = historyPersist.buildImageTrace(node, refs, outputType, im.url, first.prompt, batch.id, first.id);
    if (im.width) trace.imageWidth = im.width;
    if (im.height) trace.imageHeight = im.height;
    node.trace = trace;
    const p = node.params as unknown as StyleTransferParams;
    const jIm = completedJob.image;
    const rowTrace = historyPersist.buildImageTrace(node, refs, outputType, jIm.url, completedJob.prompt, batch.id, completedJob.id);
    void historyPersist.appendTrace({
      kind: 'image', nodeId: node.id, ...rowTrace, imageUrl: jIm.url, thumbnail: jIm.url,
      originalPath: jIm.originalPath, originalUrl: jIm.originalUrl, batchId: batch.id, jobId: completedJob.id,
    });
    historyDrawer.addImage(jIm.url, {
      nodeId: node.id, prompt: completedJob.prompt, model: p.model || '',
      aspectRatio: p.aspectRatio || '4:3', resolution: p.resolution || '2k', count: batch.total,
      outputType, thumbnail: jIm.url, originalPath: jIm.originalPath, originalUrl: jIm.originalUrl,
      batchId: batch.id, width: jIm.width, height: jIm.height,
    });
    flowState.notify();
  }

  /**
   * 第 1 张写回源节点自身：旧 imageUrl 先入历史图库保留，再覆盖为新图（不建新节点、不清空 imageUrl）。
   * 文生图/图生图统一（Q1）：outputType 参数化（'txt2img' | 'img2img'），透传到旧图 addImage 与新图 appendTrace，
   * 保证图生图回写的旧图入历史与 trace 标记正确（W6-1/W6-2）。
   * 写回后源节点即「有输出图」，下游仍可自动取作参考图（getReferenceImages 语义不变）。
   * origin：原图引用（缩略图 + 原图路径，查看大图按需加载用）；旧后端无 original_path 时为 null。
   * batchId：R3 本批批次号——新图 addImage 与 appendTrace 均带（jsonl 行）；旧图 addImage 不带（旧图属上一次运行的批次）。
   * composedPrompt：本次实际使用的合成 prompt（上游文本 + 自身 prompt；trace 记录「线即真相」，W3-2）。
   * imageWidth/imageHeight：原图真实像素（后端 PIL im.size 透传；旧后端缺失为 undefined）。
   * jobId：B-6 追溯——任务编号（count=1 批次 j0）；透传到新图 trace / jsonl 行 / 图库条目。
   * 新图入库（B3）：无论旧图是否存在，写回成功后都要把「新图」addImage 入历史图库（旧实现只入旧图，
   * 首次生成新图从不入库，导致图库缺生成图）。
   */
  private async _writeBackToSelf(
    genId: string,
    imageUrl: string,
    origin: ImageOrigin | null = null,
    batchId?: string,
    outputType: Exclude<GenerationTrace['outputType'], 'video' | 'audio'> = 'txt2img',
    composedPrompt?: string,
    imageWidth?: number,
    imageHeight?: number,
    active?: ActiveRun,
    jobId?: string, // B-6 追溯：任务编号（count=1 批次 j0）
  ): Promise<void> {
    const node = flowState.getNode(genId);
    if (!node || (active && !this._isActive(active))) return;
    if (node.imageUrl && node.imageUrl !== imageUrl) {
      const p = node.params as unknown as StyleTransferParams;
      historyDrawer.addImage(node.imageUrl, { // 旧图入历史图库保留（带搜索元数据 + 原图引用；不带当前 batchId）
        nodeId: node.id,
        prompt: typeof composedPrompt === 'string' ? composedPrompt : (typeof p.prompt === 'string' ? p.prompt : ''),
        model: typeof p.model === 'string' ? p.model : '',
        aspectRatio: typeof p.aspectRatio === 'string' ? p.aspectRatio : '4:3',
        resolution: typeof p.resolution === 'string' ? p.resolution : '2k',
        count: typeof p.count === 'number' ? p.count : 1,
        outputType,
        thumbnail: node.imageUrl, // 展示图=缩略图
        originalPath: node.imageOrigin?.path,
        originalUrl: node.imageOrigin?.url,
      });
    }
    const ratio = await loadImageRatio(imageUrl);
    if (active && !this._isActive(active)) return;
    flowState.setNodeImage(genId, imageUrl, ratio && ratio > 0 ? ratio : undefined, imageWidth, imageHeight);
    // 写回自身：source of truth = node.trace，并追加一条 kind:'image' 流水（带 batchId/jobId）
    node.imageOrigin = origin; // 原图引用（缩略图 + 原图路径）
    const trace = historyPersist.buildImageTrace(node, [], outputType, imageUrl, composedPrompt, batchId, jobId);
    if (typeof imageWidth === 'number' && imageWidth > 0) trace.imageWidth = imageWidth;
    if (typeof imageHeight === 'number' && imageHeight > 0) trace.imageHeight = imageHeight;
    node.trace = trace;
    void historyPersist.appendTrace({
      kind: 'image',
      nodeId: node.id,
      ...trace,
      imageUrl,
      thumbnail: imageUrl,
      originalPath: origin?.path,
      originalUrl: origin?.url,
      ...(batchId ? { batchId } : {}),
      ...(jobId ? { jobId } : {}),
    });
    // B3：新图本身也要入历史图库（带完整 meta：nodeId/prompt/model/aspectRatio/resolution/count/outputType/
    // thumbnail/originalPath/originalUrl/batchId/真实像素）——旧实现只入旧图，首次生成新图从不入库。
    const p2 = node.params as unknown as StyleTransferParams;
    historyDrawer.addImage(imageUrl, {
      nodeId: node.id,
      prompt: typeof composedPrompt === 'string' ? composedPrompt : (typeof p2.prompt === 'string' ? p2.prompt : ''),
      model: typeof p2.model === 'string' ? p2.model : '',
      aspectRatio: typeof p2.aspectRatio === 'string' ? p2.aspectRatio : '4:3',
      resolution: typeof p2.resolution === 'string' ? p2.resolution : '2k',
      count: typeof p2.count === 'number' ? p2.count : 1,
      outputType,
      thumbnail: imageUrl, // 展示图=缩略图
      originalPath: origin?.path,
      originalUrl: origin?.url,
      ...(batchId ? { batchId } : {}),
      ...(jobId ? { jobId } : {}),
      width: imageWidth,
      height: imageHeight,
    });
  }

  /**
   * 创建一张图生图产出节点（image-gen）：x=批次快照的 gen.x+CARD_W+48，y=累计底部游标 cursorY
   * （每建一张 cursorY 递增该卡高+28，从下往上紧密排布，任何比例组合都不重叠）；自动连线（suppressStale）；入历史图库。
   * params 继承上游（prompt/aspectRatio/resolution/count/model/textModel），modelType 强制 'draw'（产出节点不继承反推态）；
   * paramOverrides 覆盖默认继承值（扩图兼容路径用：model、aspectRatio、resolution='4k'）；
   * refImages 保持 []（参考图由 getReferenceImages 从上游自动派生，refImages 语义是用户主动挂载，不随产出节点携带）；
   * parentId=genId 标记引擎产出归属（重跑顶掉用）。
   * 原子占用：读取 cursorY 与写回之间无 await 间隙，并发 worker 不会读到同一 y。
   */
  private async createResultCard(
    genId: string,
    imageUrl: string,
    layout: ResultLayout,
    paramOverrides: Record<string, unknown> = {},
    trace: { outputType: Exclude<GenerationTrace['outputType'], 'video' | 'audio'>; refs: string[]; batchId?: string; jobId?: string } = { outputType: 'img2img', refs: [] },
    origin: ImageOrigin | null = null,
    composedPrompt?: string, // 本次实际使用的合成 prompt（上游文本 + 自身 prompt；trace/历史记录用，W3-2）
    imageWidth?: number,     // 原图真实像素宽（后端 PIL im.size 透传；旧后端缺失为 undefined）
    imageHeight?: number,    // 原图真实像素高
    active?: ActiveRun,
  ): Promise<FlowNode> {
    const gen = flowState.getNode(genId);
    if (!gen) throw new Error('生成节点已删除，产出节点创建失败');
    const ratio = await loadImageRatio(imageUrl);
    if (active && !this._isActive(active)) throw new Error('任务已暂停');
    const r = ratio && ratio > 0 ? ratio : 4 / 3;
    const cardH = imageCardHeight(r);
    const y = layout.cursorY;
    layout.cursorY = y + cardH + RESULT_GAP_Y;

    const gp = gen.params as unknown as StyleTransferParams;
    const node = flowState.addNode('image-gen', layout.x, y, {
      parentId: genId,
      imageUrl,
      imageOrigin: origin, // 原图引用（缩略图 + 原图路径，查看大图按需加载用）
      imageWidth: typeof imageWidth === 'number' && imageWidth > 0 ? imageWidth : undefined,
      imageHeight: typeof imageHeight === 'number' && imageHeight > 0 ? imageHeight : undefined,
      ratio: r,
      status: 'done',
      error: null,
      lastRunAt: Date.now(),
      title: '生成结果',
      params: {
        prompt: gp.prompt || '',
        model: gp.model || '',
        aspectRatio: gp.aspectRatio || '4:3',
        resolution: gp.resolution || '2k',
        count: gp.count || 1,
        modelType: 'draw', // 强制绘图态：产出节点不继承反推态
        textModel: gp.textModel || '',
        ...paramOverrides,
      },
    });
    // 自动建卡连线：suppressStale 避免刚 done 的产出节点被立即打回 stale
    flowState.addEdge(genId, node.id, { suppressStale: true });
    // 生成档案：写 node.trace（source of truth）+ 追加一条 kind:'image' 流水（imageUrl 冗余：跨会话图库解析优先用行内 URL）
    const nodeTrace = historyPersist.buildImageTrace(node, trace.refs, trace.outputType, imageUrl, composedPrompt, trace.batchId, trace.jobId);
    if (typeof imageWidth === 'number' && imageWidth > 0) nodeTrace.imageWidth = imageWidth;
    if (typeof imageHeight === 'number' && imageHeight > 0) nodeTrace.imageHeight = imageHeight;
    node.trace = nodeTrace;
    // 历史条目必须与刚创建的结果节点同源。扩图等公共执行入口可通过
    // paramOverrides 覆盖父步骤参数，不能再回读 gen 的旧配置。
    const resultParams = node.params as unknown as StyleTransferParams;
    historyDrawer.addImage(imageUrl, {
      nodeId: node.id,
      prompt: typeof composedPrompt === 'string' ? composedPrompt : (typeof gp.prompt === 'string' ? gp.prompt : ''),
      model: typeof resultParams.model === 'string' ? resultParams.model : '',
      aspectRatio: typeof resultParams.aspectRatio === 'string' ? resultParams.aspectRatio : '4:3',
      resolution: typeof resultParams.resolution === 'string' ? resultParams.resolution : '2k',
      count: typeof resultParams.count === 'number' ? resultParams.count : 1,
      refImageUrls: trace.refs,
      refImageHashes: nodeTrace.refImageHashes,
      outputType: trace.outputType,
      thumbnail: imageUrl, // 展示图=缩略图
      originalPath: origin?.path,
      originalUrl: origin?.url,
      batchId: trace.batchId, // R3：同批全部成功图共用同一批次号
      jobId: trace.jobId,     // B-6：任务编号（扩图/历史兼容入口）
      width: imageWidth,
      height: imageHeight,
    });
    void historyPersist.appendTrace({
      kind: 'image',
      nodeId: node.id,
      ...nodeTrace,
      imageUrl,
      thumbnail: imageUrl,
      originalPath: origin?.path,
      originalUrl: origin?.url,
      ...(trace.batchId ? { batchId: trace.batchId } : {}),
      ...(trace.jobId ? { jobId: trace.jobId } : {}),
    });
    return node;
  }

  /**
   * 重试单个失败 Job（B-3）：复用原批次快照的 options/参考图/写回逻辑（_batchRunners），重新入队执行。
   * 运行保护粒度 = 当前节点批次；其它节点可继续运行。
   */
  async retryJob(nodeId: string, batchId: string, jobId: string): Promise<void> {
    const node = flowState.getNode(nodeId);
    if (!node) return;
    if (node.status === 'run') { showToast('该节点正在生成中', false); return; }
    const runner = this._batchRunners.get(batchId);
    if (!runner) { showToast('批次信息已失效，请重新运行', false); return; }
    const job = batchStore.getJob(batchId, jobId);
    if (!job || (job.status !== 'failed' && job.status !== 'cancelled')) return;

    const active: ActiveRun = { nodeId, cancelled: false, historySuspended: true };
    this.activeRuns.set(nodeId, active);
    flowHistory.suspend();
    try {
      flowState.updateNode(nodeId, { status: 'run', error: null });
      linkView.setNodeFlowing(nodeId, true);
      const finished = await batchQueue.retryJob(batchId, jobId, runner.runJob, runner.onJobComplete, runner.onComplete);
      linkView.setNodeFlowing(nodeId, false);
      this._applyRetryOutcome(nodeId, batchId, finished);
    } finally {
      if (active.historySuspended) { flowHistory.resume(); active.historySuspended = false; }
      if (this.activeRuns.get(nodeId) === active) this.activeRuns.delete(nodeId);
    }
  }

  /** 重试全部失败项（B-3）；重试本身也走队列（P2-3 顺带满足）。 */
  async retryFailed(nodeId: string, batchId: string): Promise<void> {
    const node = flowState.getNode(nodeId);
    if (!node) return;
    if (node.status === 'run') { showToast('该节点正在生成中', false); return; }
    const runner = this._batchRunners.get(batchId);
    if (!runner) { showToast('批次信息已失效，请重新运行', false); return; }
    const failed = (batchStore.getBatch(batchId)?.jobs.filter(j => j.status === 'failed') ?? []);
    if (failed.length === 0) { showToast('没有可重试的失败项', false); return; }

    const active: ActiveRun = { nodeId, cancelled: false, historySuspended: true };
    this.activeRuns.set(nodeId, active);
    flowHistory.suspend();
    try {
      flowState.updateNode(nodeId, { status: 'run', error: null });
      linkView.setNodeFlowing(nodeId, true);
      const finished = await batchQueue.retryFailed(batchId, runner.runJob, runner.onJobComplete, runner.onComplete);
      linkView.setNodeFlowing(nodeId, false);
      this._applyRetryOutcome(nodeId, batchId, finished);
    } finally {
      if (active.historySuspended) { flowHistory.resume(); active.historySuspended = false; }
      if (this.activeRuns.get(nodeId) === active) this.activeRuns.delete(nodeId);
    }
  }

  /** 重试结束后把节点状态/错误收敛为批次派生终态（done / partial-failed / fail / idle） */
  private _applyRetryOutcome(nodeId: string, batchId: string, finished: GenerationBatch | null): void {
    const after = flowState.getNode(nodeId);
    if (!after || !finished) return;
    const s = batchStore.summarize(batchId);
    if (finished.status === 'cancelled') {
      flowState.updateNode(nodeId, { status: 'idle', error: null });
      return;
    }
    if (s.succeeded > 0) {
      flowState.updateNode(nodeId, {
        status: s.failed > 0 ? 'partial-failed' : 'done',
        error: null,
        lastRunAt: Date.now(),
      });
      showToast(s.failed > 0 ? `成功 ${s.succeeded}/${s.total}，失败 ${s.failed}` : `成功 ${s.succeeded}/${s.total}`);
    } else {
      const err = batchStore.firstError(batchId) || '生成失败';
      flowState.updateNode(nodeId, { status: 'fail', error: err });
      showToast(`生成失败：${err}`, false);
    }
  }

  /** A5：运行选中。单选=运行当前卡；多选=按拓扑序运行整组 */
  async runSelected(): Promise<void> {
    const ids = [...flowState.selectedIds];
    if (ids.length === 0) { showToast('请先选中节点', false); return; }
    if (ids.length === 1) { await this.run(ids[0]); return; }
    await this.runAll(ids);
  }

  /** 运行全部/一组（按拓扑序；遇失败停止，避免依赖链空跑） */
  async runAll(ids?: string[]): Promise<void> {
    const targets = ids && ids.length > 0 ? ids : flowState.nodes.map(n => n.id);
    const sorted = this._topoSort(targets);
    for (const id of sorted) {
      const node = flowState.getNode(id);
      if (!node || node.status === 'done') continue;
      await this.run(id);
      const after = flowState.getNode(id);
      if (after && after.status === 'fail') break;
    }
  }

  /** Kahn 拓扑排序（参照 pipeline-engine._topoSort） */
  private _topoSort(ids: string[]): string[] {
    const idSet = new Set(ids);
    const inDegree = new Map<string, number>();
    const adjList = new Map<string, string[]>();
    ids.forEach(id => {
      inDegree.set(id, 0);
      adjList.set(id, []);
    });
    ids.forEach(id => {
      flowState.getEdgesFrom(id).forEach(edge => {
        if (idSet.has(edge.to)) {
          adjList.get(id)!.push(edge.to);
          inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
        }
      });
    });
    const queue: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }
    const result: string[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      result.push(id);
      (adjList.get(id) || []).forEach(neighbor => {
        inDegree.set(neighbor, (inDegree.get(neighbor) ?? 1) - 1);
        if (inDegree.get(neighbor) === 0) queue.push(neighbor);
      });
    }
    // 环保护：未能排入的节点追加在末尾（模板默认无环）
    ids.forEach(id => { if (!result.includes(id)) result.push(id); });
    return result;
  }
}

export const runEngine = new RunEngine();
