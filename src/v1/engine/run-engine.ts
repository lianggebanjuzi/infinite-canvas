// src/v1/engine/run-engine.ts
// 执行引擎：run(nodeId)/runSelected()/runAll() + 状态机转换 + 下游 stale + 批次并发
// 唯一生成入口：任何节点类型不得绕过引擎直连 backend（共享约定第 3 条）
//
// 双卡模型（3.4）：
//   - 生成节点 run → runBatch：N=clamp(count,1,4)（启动时快照 params.count）并发 N 个单张请求（count=1）
//   - 入口快照 getReferenceImages(nodeId) 分叉：
//       空（文生图）→ 第 1 张（按 index=0，非完成顺序）写回源节点自身 imageUrl（旧图先入历史）；
//                     第 2..N 张各建一个新 image-gen 产出节点（连右侧、parentId=源节点）；成功不清空 imageUrl。
//       非空（图生图）→ 第 1 张同样写回源节点自身（旧图先入历史、新图覆盖 imageUrl；锁定保护沿用）；
//                     第 2..N 张各建一个新 image-gen 产出节点（连右侧、parentId=源节点）；不再清空源节点 imageUrl。
//   - 重跑先 removeChildren 清掉旧的「纯引擎产出」子节点（安全策略见 flow-state；手动改造的保留并标 stale）
//   - 部分失败：有成功即 done + toast「成功 x/y」；全失败才 fail（旧图保留）
//   - busy 锁粒度=整个批次（批次内并发、批次间串行）
//
// 文本走线 / 反推归位（增量）：
//   - prompt 合成唯一入口 composeImagePrompt：上游文本（getUpstreamTextPrompts 连线序拼接）+ 自身 params.prompt（非空追加在后）
//   - 文本变化三处联动（运行成功/就地编辑/历史回填）统一 = 写 outputText + dirty.markUpstreamChanged；旁路覆盖下游 prompt 的旧函数已删除
//   - 文本节点 runTextGen 接入上游图（data:image 过滤 + 前置校验「图片格式不支持反推」），反推归位到文本节点自身
//   - 素材节点（isAsset）不可运行：run() 静默跳过（不 toast、不设 busy），canRun 亦拒绝

import { flowState } from '../state/flow-state';
import { dirty } from '../state/dirty';
import { flowHistory } from '../state/history';
import { nodeRegistry } from '../nodes/node-registry';
import { Backend, fetchImageModels } from '../api';
import { pollTask, PollResult } from './poller';
import { historyDrawer } from '../ui/history-drawer';
import { historyPersist } from '../history-persist';
import { linkView } from '../canvas/link-view';
import { CARD_W } from '../canvas/canvas-view';
import { showToast } from '../ui/toast';
import { assetStore } from '../asset-store';

/** 节点定义执行上下文（供 canRun/buildOptions 使用） */
const ctx: FlowContext = {
  getUpstreams: id => flowState.getUpstreams(id),
  getDownstreams: id => flowState.getDownstreams(id),
  getReferenceImages: id => flowState.getReferenceImages(id),
  getImageModels: fetchImageModels,
};

/** 批次进度（不持久化；cmd-panel 在 run 状态实时展示） */
interface BatchProgress {
  total: number;
  done: number;
  failed: number;
  lastError: string | null;
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
  /** 全局串行：同一时间只跑一个任务（避免 pywebview 轮询互相干扰；批次内并发、批次间串行） */
  private busy = false;

  /** 批次瞬时进度（不持久化）：nodeId → {total,done,failed} */
  private batchProgress = new Map<string, BatchProgress>();
  /** 本批次新建的产出节点 id 集合（供 markUpstreamChangedExcept 跳过） */
  private _createdCardIds = new Set<string>();
  /** 本批次是否出现过「生成图未落盘到用户配置目录」（P3：批次结束统一 toast 一次，避免逐张刷屏） */
  private _sawNotSavedToDisk = false;

  /** 读取批次进度（cmd-panel 选中 run 节点时展示「生成中 done/total」） */
  getBatchProgress(nodeId: string): { total: number; done: number; failed: number } | undefined {
    const p = this.batchProgress.get(nodeId);
    return p ? { total: p.total, done: p.done, failed: p.failed } : undefined;
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

  /** 是否正在生成（撤销/重做 busy 期间禁用、关闭弹窗 busy 时附加中断警示） */
  isBusy(): boolean {
    return this.busy;
  }

  async run(nodeId: string): Promise<void> {
    const node = flowState.getNode(nodeId);
    if (!node) return;
    if (node.status === 'run') return;
    if (this.busy) { showToast('已有任务在运行，请稍候', false); return; }
    // 素材节点（isAsset）数据层闸门：静默跳过（不 toast、不设 busy；防 run-all 噪音；canRun 亦拒绝）
    if (flowState.isAsset(nodeId)) return;

    const def = nodeRegistry.get(node.type);
    const check = def.canRun(node, ctx);
    if (typeof check === 'string') { showToast(check, false); return; }

    this.busy = true;
    flowHistory.suspend(); // 引擎内部状态/产出变更不入撤销栈（R5.5）
    try {
      if (node.type === 'text-gen') {
        await this.runTextGen(nodeId);
      } else {
        // 旧 modelType='text' 反推分支已删除（Q7）：image-gen 一律按 draw 走 runBatch
        await this.runBatch(nodeId);
      }
    } finally {
      flowHistory.resume();
      this.busy = false;
    }
  }

  /**
   * 扩图执行（image-gen 悬浮「扩图」入口专用）：前端合成白底底图 → banana 系列模型带图补全
   * → 新建 image-gen 产出节点连右侧。
   * 与 run() 完全独立：不从 run() 分派、不改 node.modelType、不把扩图参数持久化到节点 params
   * （首版不支持重跑，重跑走普通生成）。
   * 不破坏原图：源节点 imageUrl 不动（区别于 runBatch 图生图分支清空语义）；执行中源节点置 run + 流光，
   * 结束后恢复执行前状态（源节点本身未被改动）。
   * 复用：全局 busy 锁、Backend.generateImage + pollTask、createResultCard（parentId + suppressStale 连线 + 入历史）、
   * dirty.markUpstreamChangedExcept、toast。
   */
  async runOutpaint(nodeId: string, opts: OutpaintOptions): Promise<void> {
    const node = flowState.getNode(nodeId);
    if (!node) return;
    if (node.status === 'run') { showToast('该节点正在生成中', false); return; }
    if (this.busy) { showToast('已有任务在运行，请稍候', false); return; }
    const refs = opts.referenceImages || [];
    if (refs.length === 0) { showToast('请先合成扩图底图', false); return; }
    if (!opts.model) { showToast('请先在设置中配置 Nano Banana 系列模型', false); return; }

    this.busy = true;
    flowHistory.suspend(); // 引擎内部状态/产出节点不入撤销栈
    const prevStatus = node.status;
    try {
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
      if (!created || !created.task_id) {
        throw new Error('任务创建失败，未返回 task_id');
      }
      const result = await pollTask(created.task_id);
      if (!result.success) {
        throw new Error(result.error || '扩图失败');
      }
      // 展示图解析：缩略图优先；为空且有 originalPath → loadLocalImage 按路径取图（治本：大图不进轮询响应）
      const displayUrl = await this._resolveImageUrl(result);
      if (!displayUrl) throw new Error(result.error || '扩图成功但未返回图片数据');
      // P3：未配置图片保存路径 → 生成图未落盘（tempfile 兜底），人话提示不阻断
      if (result.savedToDisk === false) {
        showToast('图片保存路径未设置，生成图不会落盘到本地', false);
      }

      // 原图引用（图片性能优化：卡片主视觉=缩略图，大图按需加载用）
      const origin: ImageOrigin | null = result.originalPath
        ? { path: result.originalPath, url: result.originalUrl }
        : null;

      // 产出节点：x 固定在源节点右侧，y 向下避让同列已有卡片（与旧反推产出布局口径一致）
      const x = node.x + CARD_W + RESULT_GAP_X;
      let y = node.y;
      flowState.nodes.forEach(n => {
        if (n.id === node.id) return;
        if (Math.abs(n.x - x) >= CARD_W / 2) return; // 只统计同列（x 相近）卡片
        const nH = Math.round(CARD_W / (n.ratio > 0 ? n.ratio : 4 / 3));
        y = Math.max(y, n.y + nH + RESULT_GAP_Y);
      });
      const layout: ResultLayout = { x, cursorY: y };
      // R3：扩图产出（count=1 的批次）也生成 batchId，历史按批次视图下作为单张批次卡展示
      const batchId = `${nodeId}_${Date.now()}`;
      const card = await this.createResultCard(nodeId, displayUrl, layout, {
        model: opts.model,
        aspectRatio: opts.aspectRatio || '1:1',
        resolution: opts.resolution || '4k',
      }, { outputType: 'outpaint', refs: refs, batchId }, origin);

      // 新产出节点从 stale 传播豁免；源节点旧下游标 stale（与引擎其它成功链路口径一致）
      this._createdCardIds.clear();
      this._createdCardIds.add(card.id);
      dirty.markUpstreamChangedExcept(nodeId, this._createdCardIds);

      // 源节点恢复执行前状态（不破坏原图：imageUrl 不动、状态不误标 done）
      flowState.updateNode(nodeId, { status: prevStatus, error: null });
      showToast('扩图完成');
    } catch (e) {
      const message = (e as Error).message || '扩图失败';
      // 失败也不破坏源节点：恢复执行前状态，仅 toast 提示
      flowState.updateNode(nodeId, { status: prevStatus, error: null });
      showToast(message, false);
    } finally {
      linkView.setNodeFlowing(nodeId, false);
      flowHistory.resume();
      this.busy = false;
    }
  }

  /**
   * 文本处理执行（text-gen 专用）：命令驱动，同步调 chat_v2，无批次/无轮询/无产出节点。
   * 反推归位：文本节点有图片上游（素材/自建 imageUrl）时，chatV2 附带该图（data:image 约束沿用，W2-1）；
   *   上游图存在但无 data:image → 前置校验 fail「图片格式不支持反推」（W2-4，不静默丢图）；无图片上游 → 普通文本处理。
   * 输入：当前 outputText（可能空）+ 命令（instruction）+ 文本模型。
   * 成功分支：写 outputText → pushTextHistory → dirty.markUpstreamChanged（全下游标 stale，旁路已删除：不覆盖下游 prompt）→ toast。
   * 失败/空文本：fail + error，不写历史。
   * 前置：canRun 已通过；busy 锁已持有。
   */
  private async runTextGen(nodeId: string): Promise<void> {
    const node = flowState.getNode(nodeId);
    if (!node) return;

    // 1. 启动时快照命令与当前输出文本（buildOptions 只取一次，仅含 model）
    const params = node.params as unknown as TextGenParams;
    const command = (params.instruction || '').trim();
    const currentText = (node.outputText || '').trim();
    const def = nodeRegistry.get(node.type);
    const options = def.buildOptions(node, ctx);

    // 1.5 反推归位：接入上游图（getReferenceImages 取直接上游 imageUrl 一层；data:image 过滤 + 前置校验 W2-4）
    const refs = flowState.getReferenceImages(nodeId);
    if (refs.length > 0) {
      const dataImages = refs.filter(u => u.startsWith('data:image'));
      if (dataImages.length === 0) {
        flowState.updateNode(nodeId, { status: 'fail', error: '图片格式不支持反推' });
        showToast('图片格式不支持反推', false);
        return;
      }
      options.images = dataImages;
    }

    // 2. 置 run + 上游连线流光
    flowState.updateNode(nodeId, { status: 'run', error: null });
    linkView.setNodeFlowing(nodeId, true);

    try {
      // 3. 同步阻塞调用 chat_v2：system 固定文案，user 按「有无原文」拼装
      const system = '你是电商视觉文案处理助手，只输出处理后的文本，不要解释、不要引号';
      const user = currentText ? `原文：\n${currentText}\n\n指令：${command}` : command;
      const res = await Backend.chatV2(user, { ...options, metaPrompt: system });
      const text = (res.text || '').trim();
      if (!text) throw new Error('处理结果为空');

      // 4. 成功：写回输出文本 + 历史 + 标下游 stale（旁路已删除：不再覆盖下游 prompt，W3-1）
      flowState.updateNode(nodeId, { status: 'done', outputText: text, error: null, lastRunAt: Date.now() });
      flowState.pushTextHistory(nodeId, text);
      dirty.markUpstreamChanged(nodeId);
      // 文本 trace：node.trace 恒 null（类型定义如此），但仍追加一条 kind:'text' 流水
      void historyPersist.appendTrace(historyPersist.buildTextTrace(node));
      showToast('已完成');
    } catch (e) {
      // 5. 失败：fail + 原因；不写历史
      const message = (e as Error).message || '处理失败';
      flowState.updateNode(nodeId, { status: 'fail', error: message });
      showToast(message, false);
    } finally {
      linkView.setNodeFlowing(nodeId, false);
      // 命令是临时的：执行后清空（成功/失败均清），避免下次空输入点发送经 cmd-panel 兜底
      // （input.value || instruction）静默重跑旧命令；兜底逻辑本身保留，仅消费一次。
      flowState.updateNodeParams(nodeId, { instruction: '' });
    }
  }

  /**
   * prompt 合成唯一入口（共享约定第 2 条；禁止其它地方拼 prompt）：
   * 上游文本（flowState.getUpstreamTextPrompts 按连线序拼接）+ 自身 params.prompt（非空追加在后），join('\n')。
   * 用于 runBatch 实际请求、生成 trace 记录、cmd-panel 最终 prompt 预览（W3-2/W3-4）。
   */
  composeImagePrompt(nodeId: string): string {
    const parts = flowState.getUpstreamTextPrompts(nodeId);
    const node = flowState.getNode(nodeId);
    const p = node ? (node.params as unknown as StyleTransferParams) : null;
    const own = p && typeof p.prompt === 'string' ? p.prompt.trim() : '';
    if (own) parts.push(own);
    return parts.join('\n');
  }

  /**
   * 批次执行（生成节点专用）：并发 N 个单张请求，按入口参考图分叉为文生图/图生图。
   * 前置：canRun 已通过；busy 锁已持有。
   */
  private async runBatch(nodeId: string): Promise<void> {
    const node = flowState.getNode(nodeId);
    if (!node) return;

    // 1. 启动时快照参数与 options（buildOptions 只取一次、强制 count:1）
    const params = node.params as unknown as StyleTransferParams;
    // prompt 合成唯一入口：上游文本（连线序拼接）+ 自身 prompt（非空追加在后）（W3-2/Q5）
    const prompt = this.composeImagePrompt(nodeId);
    const total = Math.min(COUNT_MAX, Math.max(COUNT_MIN, Math.round(Number(params.count) || COUNT_MIN)));
    // R3：批次号 = 生成节点 id + 批次启动时刻（同批全部成功图共用；同节点重跑 → 时间戳不同 → 可区分）
    const batchId = `${nodeId}_${Date.now()}`;
    const def = nodeRegistry.get(node.type);
    const options = def.buildOptions(node, ctx);
    options.count = COUNT_MIN;

    // 1.5 入口快照参考图：空 → 文生图；非空 → 图生图。
    //     isTxt2Img 仅用于 outputType 标记（'txt2img'/'img2img'）与 trace 参考图透传，不再决定回写/清空分支（Q1）。
    const refs = flowState.getReferenceImages(nodeId);
    const isTxt2Img = refs.length === 0;

    // 2. 重跑顶掉：置 run 之前先清掉上次的「纯引擎产出」子节点（安全策略见 flow-state；
    //    手动改造的产出节点保留并标 stale；txt2img 无子节点时自然无操作）
    flowState.removeChildren(nodeId);

    // 3. 置 run + 上游连线流光
    flowState.updateNode(nodeId, { status: 'run', error: null });
    linkView.setNodeFlowing(nodeId, true);

    // 4. 批次进度（瞬时，不持久化）
    const progress: BatchProgress = { total, done: 0, failed: 0, lastError: null };
    this.batchProgress.set(nodeId, progress);
    this._createdCardIds.clear();
    this._sawNotSavedToDisk = false; // P3：批次级未落盘标记复位
    flowState.notify(); // 面板立即显示「生成中 0/total」

    // 5. 并发 N 个 worker（Promise.allSettled：互不阻塞，任一失败不影响兄弟）。
    //    布局游标在批次开始时快照生成节点位置，之后只随已放置卡片累计，完成顺序不定也不重叠。
    const layout: ResultLayout = { x: node.x + CARD_W + RESULT_GAP_X, cursorY: node.y };
    const jobs = Array.from({ length: total }, (_, i) =>
      this.runOneWorker(nodeId, prompt, options, layout, progress, isTxt2Img, i, refs, batchId));
    await Promise.allSettled(jobs);

    linkView.setNodeFlowing(nodeId, false);
    this.batchProgress.delete(nodeId);

    // 6. 汇总：有成功 → done + 旧下游标 stale（新产出节点跳过）。
    //    图生图/文生图统一回写自身（第 1 张在 worker 内写回；源节点 imageUrl 已为新图，不清空——W6-2）。
    const after = flowState.getNode(nodeId);
    if (!after) return; // 批次期间生成节点被删除
    if (progress.done > 0) {
      flowState.updateNode(nodeId, { status: 'done', error: null, lastRunAt: Date.now() });
      dirty.markUpstreamChangedExcept(nodeId, this._createdCardIds);
      showToast(`成功 ${progress.done}/${total}`);
      // P3：本批次出现过未落盘（未配置图片保存路径）→ 统一提示一次，不阻断结果展示
      if (this._sawNotSavedToDisk) {
        showToast('图片保存路径未设置，生成图不会落盘到本地', false);
      }
    } else {
      // 全失败：保留旧图，节点 fail（toast 带具体原因，避免「没图却不知为何」）
      flowState.updateNode(nodeId, { status: 'fail', error: progress.lastError || '生成失败' });
      showToast(progress.lastError ? `生成失败：${progress.lastError}` : '生成失败', false);
    }
  }

  /**
   * 单个 worker：创建单张生成任务 → 轮询 → 成功按分支处理（第 1 张写回自身 / 第 2..N 张建新产出节点）；失败计数。
   * Q1 统一回写口径：文生图/图生图一致——每批第 1 张（index=0）写回自身（旧图入历史、新图覆盖 imageUrl）；
   *   当前图锁定 → 不写回、改建产出节点 + toast；第 2..N 张各建产出节点（一张卡只承载一张主图）。
   */
  private async runOneWorker(
    genId: string,
    prompt: string,
    options: Record<string, unknown>,
    layout: ResultLayout,
    progress: BatchProgress,
    isTxt2Img: boolean,
    index: number,
    refs: string[],
    batchId: string, // R3：本批批次号，透传到该张成功图的 addImage / appendTrace
  ): Promise<void> {
    try {
      const created = await withTimeout(
        Backend.generateImage(prompt, { ...options, count: COUNT_MIN }),
        TASK_CREATE_TIMEOUT_MS,
        '任务创建超时',
      );
      if (!created || !created.task_id) {
        throw new Error('任务创建失败，未返回 task_id');
      }
      const result = await pollTask(created.task_id);
      if (result.success) {
        // 展示图解析：缩略图优先；为空且有 originalPath → loadLocalImage 按路径取图（治本：大图不进轮询响应）
        const displayUrl = await this._resolveImageUrl(result);
        if (!displayUrl) throw new Error(result.error || '生成成功但未返回图片数据');
        // P3：该张图未落盘到用户配置目录（tempfile 兜底）→ 标记，批次结束统一 toast
        if (result.savedToDisk === false) this._sawNotSavedToDisk = true;
        // 原图引用（图片性能优化：卡片主视觉=缩略图，大图按需加载用）
        const origin: ImageOrigin | null = result.originalPath
          ? { path: result.originalPath, url: result.originalUrl }
          : null;
        const outputType: GenerationTrace['outputType'] = isTxt2Img ? 'txt2img' : 'img2img';
        if (index === 0) {
          // 保护点 2：源节点当前 imageUrl（旧图）被锁定 → 不写回自身，改走新建产出节点（旧图保留，Q3）
          const gen = flowState.getNode(genId);
          const locked = !!gen && !!gen.imageUrl && assetStore.isLockedByImageUrl(gen.imageUrl);
          if (locked) {
            const card = await this.createResultCard(genId, displayUrl, layout, {}, {
              outputType,
              refs,
              batchId,
            }, origin, prompt);
            this._createdCardIds.add(card.id);
            progress.done += 1;
          } else {
            // 第 1 张（按 index=0，非完成顺序）写回源节点自身 imageUrl（文生图/图生图统一，Q1）
            await this._writeBackToSelf(genId, displayUrl, origin, batchId, outputType, prompt);
            progress.done += 1;
          }
        } else {
          // 第 2..N 张：出一张建一张（不等兄弟），立即创建新 image-gen 产出节点并自动连线
          const card = await this.createResultCard(genId, displayUrl, layout, {}, {
            outputType,
            refs,
            batchId,
          }, origin, prompt);
          this._createdCardIds.add(card.id);
          progress.done += 1;
        }
      } else {
        throw new Error(result.error || '生成失败');
      }
    } catch (e) {
      progress.failed += 1;
      progress.lastError = (e as Error).message || '生成失败';
    } finally {
      this._touchProgress(genId);
    }
  }

  /**
   * 第 1 张写回源节点自身：旧 imageUrl 先入历史图库保留，再覆盖为新图（不建新节点、不清空 imageUrl）。
   * 文生图/图生图统一（Q1）：outputType 参数化（'txt2img' | 'img2img'），透传到旧图 addImage 与新图 appendTrace，
   * 保证图生图回写的旧图入历史与 trace 标记正确（W6-1/W6-2）。
   * 写回后源节点即「有输出图」，下游仍可自动取作参考图（getReferenceImages 语义不变）。
   * origin：原图引用（缩略图 + 原图路径，查看大图按需加载用）；旧后端无 original_path 时为 null。
   * batchId：R3 本批批次号——仅新图 appendTrace 带（jsonl 行）；旧图 addImage 不带（旧图属上一次运行的批次）。
   * composedPrompt：本次实际使用的合成 prompt（上游文本 + 自身 prompt；trace 记录「线即真相」，W3-2）。
   */
  private async _writeBackToSelf(
    genId: string,
    imageUrl: string,
    origin: ImageOrigin | null = null,
    batchId?: string,
    outputType: GenerationTrace['outputType'] = 'txt2img',
    composedPrompt?: string,
  ): Promise<void> {
    const node = flowState.getNode(genId);
    if (!node) return;
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
    flowState.setNodeImage(genId, imageUrl, ratio && ratio > 0 ? ratio : undefined);
    // 写回自身：source of truth = node.trace，并追加一条 kind:'image' 流水（带 batchId）
    node.imageOrigin = origin; // 原图引用（缩略图 + 原图路径）
    const trace = historyPersist.buildImageTrace(node, [], outputType, imageUrl, composedPrompt);
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
    });
  }

  /**
   * 创建一张图生图产出节点（image-gen）：x=批次快照的 gen.x+CARD_W+48，y=累计底部游标 cursorY
   * （每建一张 cursorY 递增该卡高+28，从下往上紧密排布，任何比例组合都不重叠）；自动连线（suppressStale）；入历史图库。
   * params 继承上游（prompt/aspectRatio/resolution/count/model/textModel），modelType 强制 'draw'（产出节点不继承反推态）；
   * paramOverrides 覆盖默认继承值（扩图用：model=自动解析的 banana 模型、aspectRatio=目标比例、resolution='4k'）；
   * refImages 保持 []（参考图由 getReferenceImages 从上游自动派生，refImages 语义是用户主动挂载，不随产出节点携带）；
   * parentId=genId 标记引擎产出归属（重跑顶掉用）。
   * 原子占用：读取 cursorY 与写回之间无 await 间隙，并发 worker 不会读到同一 y。
   */
  private async createResultCard(
    genId: string,
    imageUrl: string,
    layout: ResultLayout,
    paramOverrides: Record<string, unknown> = {},
    trace: { outputType: GenerationTrace['outputType']; refs: string[]; batchId?: string } = { outputType: 'img2img', refs: [] },
    origin: ImageOrigin | null = null,
    composedPrompt?: string, // 本次实际使用的合成 prompt（上游文本 + 自身 prompt；trace/历史记录用，W3-2）
  ): Promise<FlowNode> {
    const gen = flowState.getNode(genId);
    if (!gen) throw new Error('生成节点已删除，产出节点创建失败');
    const ratio = await loadImageRatio(imageUrl);
    const r = ratio && ratio > 0 ? ratio : 4 / 3;
    const cardH = Math.round(CARD_W / r);
    const y = layout.cursorY;
    layout.cursorY = y + cardH + RESULT_GAP_Y;

    const gp = gen.params as unknown as StyleTransferParams;
    const node = flowState.addNode('image-gen', layout.x, y, {
      parentId: genId,
      imageUrl,
      imageOrigin: origin, // 原图引用（缩略图 + 原图路径，查看大图按需加载用）
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
    const nodeTrace = historyPersist.buildImageTrace(node, trace.refs, trace.outputType, imageUrl, composedPrompt);
    node.trace = nodeTrace;
    historyDrawer.addImage(imageUrl, {
      nodeId: node.id,
      prompt: typeof composedPrompt === 'string' ? composedPrompt : (typeof gp.prompt === 'string' ? gp.prompt : ''),
      model: typeof gp.model === 'string' ? gp.model : '',
      aspectRatio: typeof gp.aspectRatio === 'string' ? gp.aspectRatio : '4:3',
      resolution: typeof gp.resolution === 'string' ? gp.resolution : '2k',
      count: typeof gp.count === 'number' ? gp.count : 1,
      refImageUrls: trace.refs,
      refImageHashes: nodeTrace.refImageHashes,
      outputType: trace.outputType,
      thumbnail: imageUrl, // 展示图=缩略图
      originalPath: origin?.path,
      originalUrl: origin?.url,
      batchId: trace.batchId, // R3：同批全部成功图共用同一批次号
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
    });
    return node;
  }

  /** 批次进度变更后通知（产出节点创建已触发 notify；失败无产出节点场景需手动触发，保证面板进度刷新） */
  private _touchProgress(_nodeId: string): void {
    flowState.notify();
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
