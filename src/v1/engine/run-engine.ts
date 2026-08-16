// src/v1/engine/run-engine.ts
// 执行引擎：run(nodeId)/runSelected()/runAll() + 状态机转换 + 下游 stale + 批次并发
// 唯一生成入口：任何节点类型不得绕过引擎直连 backend（共享约定第 3 条）
//
// 双卡模型（3.4）：
//   - 生成节点 run → runBatch：N=clamp(count,1,4)（启动时快照 params.count）并发 N 个单张请求（count=1）
//   - 入口快照 getReferenceImages(nodeId) 分叉：
//       空（文生图）→ 第 1 张（按 index=0，非完成顺序）写回源节点自身 imageUrl（旧图先入历史）；
//                     第 2..N 张各建一个新 image-gen 产出节点（连右侧、parentId=源节点）；成功不清空 imageUrl。
//       非空（图生图）→ 每张建一个新 image-gen 产出节点（自动连线 suppressStale）；成功时源节点旧 imageUrl 入历史后清空。
//   - 重跑先 removeChildren 清掉旧的「纯引擎产出」子节点（安全策略见 flow-state；手动改造的保留并标 stale）
//   - 部分失败：有成功即 done + toast「成功 x/y」；全失败才 fail（旧图保留）
//   - busy 锁粒度=整个批次（批次内并发、批次间串行）

import { flowState } from '../state/flow-state';
import { dirty } from '../state/dirty';
import { flowHistory } from '../state/history';
import { nodeRegistry } from '../nodes/node-registry';
import { Backend, fetchImageModels } from '../api';
import { pollTask } from './poller';
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
 * 文本结果统一联动：覆盖直接 image-gen 下游的 params.prompt + 标记下游 stale。
 * runTextGen 成功、卡片就地编辑保存、历史回填共用，
 * 与处理成功后的联动口径完全一致：只覆盖直接下游（getDownstreams 一层），不递归、不 toast（toast 由调用方负责）。
 */
export function applyTextToDownstream(nodeId: string, text: string): void {
  const downstreams = flowState.getDownstreams(nodeId).filter(d => d.type === 'image-gen');
  downstreams.forEach(d => flowState.updateNodeParams(d.id, { prompt: text })); // 覆盖动作本身不标 stale
  dirty.markUpstreamChanged(nodeId);
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

class RunEngine {
  /** 全局串行：同一时间只跑一个任务（避免 pywebview 轮询互相干扰；批次内并发、批次间串行） */
  private busy = false;

  /** 批次瞬时进度（不持久化）：nodeId → {total,done,failed} */
  private batchProgress = new Map<string, BatchProgress>();
  /** 本批次新建的产出节点 id 集合（供 markUpstreamChangedExcept 跳过） */
  private _createdCardIds = new Set<string>();

  /** 读取批次进度（cmd-panel 选中 run 节点时展示「生成中 done/total」） */
  getBatchProgress(nodeId: string): { total: number; done: number; failed: number } | undefined {
    const p = this.batchProgress.get(nodeId);
    return p ? { total: p.total, done: p.done, failed: p.failed } : undefined;
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

    const def = nodeRegistry.get(node.type);
    const check = def.canRun(node, ctx);
    if (typeof check === 'string') { showToast(check, false); return; }

    this.busy = true;
    flowHistory.suspend(); // 引擎内部状态/产出变更不入撤销栈（R5.5）
    try {
      if (node.type === 'text-gen') {
        await this.runTextGen(nodeId);
      } else if (node.type === 'image-gen' && (node.params as unknown as StyleTransferParams).modelType === 'text') {
        await this.runImageReverse(nodeId);
      } else {
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
      const created = await Backend.generateImage(opts.prompt, {
        model: opts.model,
        aspectRatio: opts.aspectRatio || '1:1',
        resolution: opts.resolution || '4k',
        count: COUNT_MIN,
        referenceImages: refs,
      });
      if (!created || !created.task_id) {
        throw new Error('任务创建失败，未返回 task_id');
      }
      const result = await pollTask(created.task_id);
      if (!result.success || !result.imageUrl) {
        throw new Error(result.error || '扩图失败');
      }

      // 产出节点：x 固定在源节点右侧，y 向下避让同列已有卡片（与 runImageReverse 口径一致）
      const x = node.x + CARD_W + RESULT_GAP_X;
      let y = node.y;
      flowState.nodes.forEach(n => {
        if (n.id === node.id) return;
        if (Math.abs(n.x - x) >= CARD_W / 2) return; // 只统计同列（x 相近）卡片
        const nH = Math.round(CARD_W / (n.ratio > 0 ? n.ratio : 3 / 4));
        y = Math.max(y, n.y + nH + RESULT_GAP_Y);
      });
      const layout: ResultLayout = { x, cursorY: y };
      const card = await this.createResultCard(nodeId, result.imageUrl, layout, {
        model: opts.model,
        aspectRatio: opts.aspectRatio || '1:1',
        resolution: opts.resolution || '4k',
      }, { outputType: 'outpaint', refs: refs });

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
   * 输入：当前 outputText（可能空）+ 命令（instruction）+ 文本模型。
   *   有 outputText → prompt = system + user「原文：{outputText} 指令：{命令}」
   *   无 outputText → prompt = system + user「{命令}」
   * 成功分支：写 outputText → pushTextHistory → 覆盖直接 image-gen 下游 prompt → dirty.markUpstreamChanged（stale 统一入口）→ toast。
   * 失败/空文本：fail + error，不覆盖下游、不写历史。
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

      // 4. 成功：写回输出文本 + 历史 + 覆盖直接 image-gen 下游 prompt + 标 stale
      flowState.updateNode(nodeId, { status: 'done', outputText: text, error: null, lastRunAt: Date.now() });
      flowState.pushTextHistory(nodeId, text);
      applyTextToDownstream(nodeId, text);
      // 文本 trace：node.trace 恒 null（类型定义如此），但仍追加一条 kind:'text' 流水
      void historyPersist.appendTrace(historyPersist.buildTextTrace(node));
      showToast('已完成');
    } catch (e) {
      // 5. 失败：fail + 原因；不覆盖下游、不写历史
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
   * 图片节点「文本模型反推」（image-gen + modelType='text' 专用）：
   * 用该图（node.imageUrl 或第一张参考图）+ 命令 + 文本模型调 chat_v2，
   * 结果文本输出到一个新建 text-gen 节点（放源图片节点右侧，向下避让同列卡片）。
   * 前置：canRun 已通过（已选文本模型 + 命令 + 有图）；busy 锁已持有。
   */
  private async runImageReverse(nodeId: string): Promise<void> {
    const node = flowState.getNode(nodeId);
    if (!node) return;
    const p = node.params as unknown as StyleTransferParams;
    const command = (p.prompt || '').trim();
    const textModel = (p.textModel || '').trim();
    const imageUrl = node.imageUrl || flowState.getReferenceImages(nodeId)[0] || '';

    // 反推依赖多模态图片：仅支持 data:image 内嵌图（旧项目 http URL 等后端 chatV2 会静默丢弃 → 前置校验）
    if (!imageUrl.startsWith('data:image')) {
      flowState.updateNode(nodeId, { status: 'fail', error: '图片格式不支持反推' });
      showToast('图片格式不支持反推', false);
      return;
    }

    flowState.updateNode(nodeId, { status: 'run', error: null });
    linkView.setNodeFlowing(nodeId, true);

    try {
      const system = '你是电商视觉文案处理助手，只输出处理后的文本，不要解释、不要引号';
      const res = await Backend.chatV2(command, { model: textModel, images: [imageUrl], metaPrompt: system });
      const text = (res.text || '').trim();
      if (!text) throw new Error('反推结果为空');

      // 新建文本节点承接结果：x 固定在源图片节点右侧，y 向下避让同列已有卡片
      // （产出节点/历史反推卡/任意同列节点，取最大底部 + 间距），避免与已有产出节点/重复反推完全重叠。
      const x = node.x + CARD_W + RESULT_GAP_X;
      let y = node.y;
      flowState.nodes.forEach(n => {
        if (n.id === node.id) return;
        if (Math.abs(n.x - x) >= CARD_W / 2) return; // 只统计同列（x 相近）卡片
        const nH = Math.round(CARD_W / (n.ratio > 0 ? n.ratio : 3 / 4));
        y = Math.max(y, n.y + nH + RESULT_GAP_Y);
      });
      const newNode = flowState.addNode('text-gen', x, y, {
        title: '文本反推', // 与 persistence 3.2 旧文件默认标题一致
        outputText: text,
        status: 'done',
        params: { instruction: '', model: textModel },
        lastRunAt: Date.now(),
      });
      flowState.pushTextHistory(newNode.id, text);
      flowState.updateNode(nodeId, { status: 'done', error: null, lastRunAt: Date.now() });
      void historyPersist.appendTrace(historyPersist.buildTextTrace(newNode));
      showToast('已生成文本节点');
    } catch (e) {
      const message = (e as Error).message || '反推失败';
      flowState.updateNode(nodeId, { status: 'fail', error: message });
      showToast(message, false);
    } finally {
      linkView.setNodeFlowing(nodeId, false);
    }
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
    const prompt = (params.prompt || '').trim();
    const total = Math.min(COUNT_MAX, Math.max(COUNT_MIN, Math.round(Number(params.count) || COUNT_MIN)));
    const def = nodeRegistry.get(node.type);
    const options = def.buildOptions(node, ctx);
    options.count = COUNT_MIN;

    // 1.5 入口快照参考图：空 → 文生图（第 1 张写回自身）；非空 → 图生图（每张建新产出节点）
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
    flowState.notify(); // 面板立即显示「生成中 0/total」

    // 5. 并发 N 个 worker（Promise.allSettled：互不阻塞，任一失败不影响兄弟）。
    //    布局游标在批次开始时快照生成节点位置，之后只随已放置卡片累计，完成顺序不定也不重叠。
    const layout: ResultLayout = { x: node.x + CARD_W + RESULT_GAP_X, cursorY: node.y };
    const jobs = Array.from({ length: total }, (_, i) =>
      this.runOneWorker(nodeId, prompt, options, layout, progress, isTxt2Img, i, refs));
    await Promise.allSettled(jobs);

    linkView.setNodeFlowing(nodeId, false);
    this.batchProgress.delete(nodeId);

    // 6. 汇总：有成功 → done + 旧下游标 stale（新产出节点跳过）；
    //    图生图分支源节点旧 imageUrl 入历史后清空（回参考图占位）；文生图分支不清 imageUrl（第 1 张已写回自身）。
    //    保护点 3（P1）：源节点旧 imageUrl 被锁定 → 不清空（保留主视觉，符合 v3「好结果不被重跑顶掉」）。
    const after = flowState.getNode(nodeId);
    if (!after) return; // 批次期间生成节点被删除
    if (progress.done > 0) {
      if (!isTxt2Img && after.imageUrl) {
        if (assetStore.isLockedByImageUrl(after.imageUrl)) {
          // 参考图锁定：保留显示（不清空主视觉）+ toast
          showToast('参考图已锁定，保留显示', false);
        } else {
          // 图生图：旧 imageUrl 先入历史图库保留，再清空（回参考图占位）
          // 注意：setNodeImage(id, null) 忽略 null 不清空 imageUrl，必须用 updateNode({imageUrl:null})
          const p = after.params as unknown as StyleTransferParams;
          historyDrawer.addImage(after.imageUrl, {
            nodeId: after.id,
            prompt: typeof p.prompt === 'string' ? p.prompt : '',
            model: typeof p.model === 'string' ? p.model : '',
            aspectRatio: typeof p.aspectRatio === 'string' ? p.aspectRatio : '3:4',
            resolution: typeof p.resolution === 'string' ? p.resolution : '2k',
            count: typeof p.count === 'number' ? p.count : 1,
            outputType: 'img2img',
          });
          flowState.updateNode(nodeId, { imageUrl: null });
        }
      }
      flowState.updateNode(nodeId, { status: 'done', error: null, lastRunAt: Date.now() });
      dirty.markUpstreamChangedExcept(nodeId, this._createdCardIds);
      showToast(`成功 ${progress.done}/${total}`);
    } else {
      // 全失败：保留旧图，节点 fail
      flowState.updateNode(nodeId, { status: 'fail', error: progress.lastError || '生成失败' });
      showToast('生成失败', false);
    }
  }

  /**
   * 单个 worker：创建单张生成任务 → 轮询 → 成功按分支处理（文生图第 1 张写回自身 / 其余建新产出节点）；失败计数。
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
  ): Promise<void> {
    try {
      const created = await Backend.generateImage(prompt, { ...options, count: COUNT_MIN });
      if (!created || !created.task_id) {
        throw new Error('任务创建失败，未返回 task_id');
      }
      const result = await pollTask(created.task_id);
      if (result.success && result.imageUrl) {
        if (isTxt2Img && index === 0) {
          // 保护点 2：源节点当前 imageUrl（旧图）被锁定 → 不写回自身，改走新建产出节点（旧图保留，Q3）
          const gen = flowState.getNode(genId);
          const locked = !!gen && !!gen.imageUrl && assetStore.isLockedByImageUrl(gen.imageUrl);
          if (locked) {
            const card = await this.createResultCard(genId, result.imageUrl, layout, {}, {
              outputType: 'txt2img',
              refs,
            });
            this._createdCardIds.add(card.id);
            progress.done += 1;
          } else {
            // 文生图第 1 张（按 index=0，非完成顺序）写回源节点自身 imageUrl
            await this._writeBackToSelf(genId, result.imageUrl);
            progress.done += 1;
          }
        } else {
          // 图生图全部 + 文生图第 2..N 张：出一张建一张（不等兄弟），立即创建新 image-gen 产出节点并自动连线
          const card = await this.createResultCard(genId, result.imageUrl, layout, {}, {
            outputType: isTxt2Img ? 'txt2img' : 'img2img',
            refs,
          });
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
   * 文生图第 1 张写回源节点自身：旧 imageUrl 先入历史图库保留，再覆盖为新图（不建新节点、不清空 imageUrl）。
   * 写回后源节点即「有输出图」，下游仍可自动取作参考图（getReferenceImages 语义不变）。
   */
  private async _writeBackToSelf(genId: string, imageUrl: string): Promise<void> {
    const node = flowState.getNode(genId);
    if (!node) return;
    if (node.imageUrl && node.imageUrl !== imageUrl) {
      const p = node.params as unknown as StyleTransferParams;
      historyDrawer.addImage(node.imageUrl, { // 旧图入历史图库保留（带搜索元数据）
        nodeId: node.id,
        prompt: typeof p.prompt === 'string' ? p.prompt : '',
        model: typeof p.model === 'string' ? p.model : '',
        aspectRatio: typeof p.aspectRatio === 'string' ? p.aspectRatio : '3:4',
        resolution: typeof p.resolution === 'string' ? p.resolution : '2k',
        count: typeof p.count === 'number' ? p.count : 1,
        outputType: 'txt2img',
      });
    }
    const ratio = await loadImageRatio(imageUrl);
    flowState.setNodeImage(genId, imageUrl, ratio && ratio > 0 ? ratio : undefined);
    // 文生图第 1 张写回自身：source of truth = node.trace，并追加一条 kind:'image' 流水
    const trace = historyPersist.buildImageTrace(node, [], 'txt2img', imageUrl);
    node.trace = trace;
    void historyPersist.appendTrace({ kind: 'image', nodeId: node.id, ...trace, imageUrl });
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
    trace: { outputType: GenerationTrace['outputType']; refs: string[] } = { outputType: 'img2img', refs: [] },
  ): Promise<FlowNode> {
    const gen = flowState.getNode(genId);
    if (!gen) throw new Error('生成节点已删除，产出节点创建失败');
    const ratio = await loadImageRatio(imageUrl);
    const r = ratio && ratio > 0 ? ratio : 3 / 4;
    const cardH = Math.round(CARD_W / r);
    const y = layout.cursorY;
    layout.cursorY = y + cardH + RESULT_GAP_Y;

    const gp = gen.params as unknown as StyleTransferParams;
    const node = flowState.addNode('image-gen', layout.x, y, {
      parentId: genId,
      imageUrl,
      ratio: r,
      status: 'done',
      error: null,
      lastRunAt: Date.now(),
      title: '生成结果',
      params: {
        prompt: gp.prompt || '',
        model: gp.model || '',
        aspectRatio: gp.aspectRatio || '3:4',
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
    const nodeTrace = historyPersist.buildImageTrace(node, trace.refs, trace.outputType, imageUrl);
    node.trace = nodeTrace;
    historyDrawer.addImage(imageUrl, {
      nodeId: node.id,
      prompt: typeof gp.prompt === 'string' ? gp.prompt : '',
      model: typeof gp.model === 'string' ? gp.model : '',
      aspectRatio: typeof gp.aspectRatio === 'string' ? gp.aspectRatio : '3:4',
      resolution: typeof gp.resolution === 'string' ? gp.resolution : '2k',
      count: typeof gp.count === 'number' ? gp.count : 1,
      refImageUrls: trace.refs,
      refImageHashes: nodeTrace.refImageHashes,
      outputType: trace.outputType,
    });
    void historyPersist.appendTrace({ kind: 'image', nodeId: node.id, ...nodeTrace, imageUrl });
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
