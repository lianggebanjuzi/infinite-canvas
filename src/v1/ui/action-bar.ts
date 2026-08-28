// src/v1/ui/action-bar.ts
// 卡片上方操作条：仅单选出现，贴卡上沿，智能避让翻转（原型行为）
// 首版动作按钮：扩图已接入；其余为后续版本能力，点击提示（复现已移除——配方信息保留即够用）

import { flowState } from '../state/flow-state';
import { selection } from '../state/selection';
import { canvasView, CARD_W, imageCardHeight } from '../canvas/canvas-view';
import { cardView } from '../canvas/card-view';
import { showToast } from './toast';
import { cmdPanel } from './cmd-panel';
import { outpaintPanel } from './outpaint-panel';
import { floatingPanels } from './floating-panels';
import { flowHistory } from '../state/history';
import { imageEditor } from './image-editor/image-editor';

class ActionBar {
  private el: HTMLElement | null = null;

  init(): void {
    this.el = document.getElementById('action-bar');
    if (!this.el) return;

    // 「继续创作」是图片优先体验的主入口。动态插入可避免把一次性的
    // 交互实现散落到静态页面结构中，也让旧页面壳保持兼容。
    if (!this.el.querySelector('[data-action="continue"]')) {
      this.el.insertAdjacentHTML('afterbegin', `
        <button class="act-btn act-continue" data-action="continue" title="以这张图为参考开始下一步">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          继续创作
        </button>
        <div class="act-sep act-continue-sep"></div>`);
    }
    if (!this.el.querySelector('[data-action="video"]')) {
      this.el.insertAdjacentHTML('afterbegin', `<button class="act-btn" data-action="video" title="基于当前图片生成视频">生成视频</button>`);
    }
    if (!this.el.querySelector('[data-action="crop"]')) {
      const more = this.el.querySelector('.act-more-wrap');
      more?.insertAdjacentHTML('beforebegin', `
        <button class="act-btn act-image-edit" data-action="crop" title="裁剪图片">裁剪</button>
        <button class="act-btn act-image-edit" data-action="split" title="按网格切分图片">切图</button>
        <button class="act-btn act-image-edit" data-action="aspect-lock" title="切换图片节点尺寸锁定">锁定比例</button>
        <div class="act-sep act-image-edit-sep"></div>`);
    }

    this.el.querySelectorAll('.act-btn').forEach(btn => {
      (btn as HTMLElement).addEventListener('click', (e: MouseEvent) => {
        const action = ((e.currentTarget as HTMLElement).dataset.action) || '';
        this._handleAction(action);
      });
    });

    flowState.subscribe(() => this.sync());
  }

  private _handleAction(action: string): void {
    const node = selection.single();
    if (!node) return;

    if (action === 'download') {
      if (node.imageUrl) {
        const a = document.createElement('a');
        a.href = node.imageUrl;
        a.download = (node.title || 'image') + '.png';
        a.click();
      } else {
        showToast('该节点还没有可下载的图片', false);
      }
      return;
    }
    if (action === 'expand') {
      const p = node.params as unknown as StyleTransferParams;
      // 扩图成为画布中的一个可见步骤：图片 → 扩图节点 → 结果。配置会保留在节点内，可随时复跑。
      if (p.mode === 'outpaint') void outpaintPanel.open(node.id);
      else void createOutpaintStep(node);
      return;
    }
    if (action === 'continue') {
      void createContinueStep(node);
      return;
    }
    if (action === 'video') {
      void createVideoStep(node);
      return;
    }
    if (action === 'crop') { void imageEditor.openCrop(node.id); return; }
    if (action === 'split') { void imageEditor.openSplit(node.id); return; }
    if (action === 'aspect-lock') {
      flowHistory.record();
      flowState.updateNode(node.id, { imageAspectLocked: !(node.imageAspectLocked ?? true) });
      showToast((node.imageAspectLocked ?? true) ? '已锁定图片比例' : '已启用自由缩放');
      return;
    }
    if (action === 'more') {
      const menu = document.getElementById('act-more-menu');
      if (menu) menu.hidden = !menu.hidden;
    }
  }

  sync(): void {
    if (!this.el) return;
    // Tab 化：面板默认收起；仅当 Tab 呼出（floatingPanels.isVisible()）时才显示/定位
    // 显示态下切换选中节点：仍走下方逻辑刷新内容/位置（跟随新选中节点），不会误收起
    if (!floatingPanels.isVisible()) {
      this.el.classList.remove('show', 'pos-below');
      return;
    }
    const node = selection.single();
    // 文本节点没有图片创作语义；素材则是「继续创作」最常见的起点，不能再一并隐藏。
    if (!node || node.type === 'text-gen' || node.type === 'text-split') {
      this.el.classList.remove('show', 'pos-below');
      return;
    }

    const expand = this.el.querySelector('[data-action="expand"]') as HTMLElement | null;
    const continueButton = this.el.querySelector('[data-action="continue"]') as HTMLElement | null;
    const videoButton = this.el.querySelector('[data-action="video"]') as HTMLElement | null;
    const isAsset = flowState.isAssetNode(node);
    const hasImage = node.type === 'image-gen' && (Boolean(node.imageUrl) || flowState.getReferenceImages(node.id).length > 0);
    this.el.querySelectorAll('.act-image-edit, .act-image-edit-sep').forEach(button => {
      (button as HTMLElement).classList.toggle('act-hidden', !hasImage);
    });
    const lockButton = this.el.querySelector('[data-action="aspect-lock"]') as HTMLButtonElement | null;
    if (lockButton) {
      const locked = node.imageAspectLocked ?? true;
      lockButton.textContent = locked ? '锁定比例' : '自由缩放';
      lockButton.title = locked ? '当前锁定比例；点击允许自由缩放' : '当前自由缩放；点击锁定比例';
    }
    // 继续创作守卫与 createContinueStep / 右键菜单共用同一判定，避免三处条件分叉。
    continueButton?.classList.toggle('act-hidden', !canContinueFrom(node));
    videoButton?.classList.toggle('act-hidden', !canContinueFrom(node));
    // 导入素材本身就是最常见的扩图起点。仅隐藏尚未实现的「更多」动作，
    // 不能把「扩图」一并藏掉，否则用户必须先创建无意义的继续创作中间节点。
    (expand as HTMLElement | null)?.classList.toggle('act-hidden', !canContinueFrom(node));
    this.el.querySelectorAll('[data-action="more"]').forEach(button => {
      (button as HTMLElement).classList.toggle('act-hidden', isAsset);
    });
    const moreMenu = document.getElementById('act-more-menu');
    if (moreMenu && isAsset) moreMenu.hidden = true;
    const isOutpaint = (node.params as unknown as StyleTransferParams).mode === 'outpaint';
    if (expand) {
      expand.lastChild!.textContent = isOutpaint ? ' 调整扩图' : ' 扩图';
      expand.title = isOutpaint ? '调整扩图画布' : '新建扩图步骤';
    }

    const wrap = canvasView.wrap;
    if (!wrap) return;
    const wr = wrap.getBoundingClientRect();
    const { x: cx0, y: topY } = canvasView.worldToWrap(node.x + CARD_W / 2, node.y);
    const botY = canvasView.worldToWrap(0, node.y + (node.h ?? cardView.cardHeight(node))).y;

    // 与指令面板同侧翻转：面板在上 → 操作条在下
    const cpH = (document.getElementById('cmd-panel') as HTMLElement)?.offsetHeight || 240;
    const flip = (wr.height - botY) < cpH + 24 && topY > cpH + 70;
    this.el.classList.toggle('pos-below', flip);

    const abCx = Math.min(Math.max(cx0, 200), wr.width - 200);
    this.el.style.left = abCx + 'px';
    this.el.style.top = (flip ? botY : topY) + 'px';
    this.el.classList.add('show');
  }
}

/** 从任意图片节点创建画布内扩图步骤；操作条与右键菜单共享，避免两套行为分叉。 */
export async function createOutpaintStep(source: FlowNode): Promise<void> {
    if (!source.imageUrl && flowState.getReferenceImages(source.id).length === 0) {
      showToast('该节点还没有可用于扩图的图片', false);
      return;
    }
    flowHistory.record();
    const sourceHeight = cardView.cardHeight(source);
    const node = flowState.addNode('image-gen', source.x + CARD_W + 48, source.y + Math.max(0, (sourceHeight - CARD_W / (4 / 3)) / 2), {
      title: '扩图',
      params: {
        prompt: '', model: '', aspectRatio: '1:1', resolution: '4k', count: 1,
        mode: 'outpaint',
      },
    });
    // 新建配置节点不应因刚建立的输入线被标为 stale；它尚未生成过结果。
    flowState.addEdge(source.id, node.id, { suppressStale: true });
    selection.select(node.id);
    showToast('已创建扩图步骤：请在弹窗中调整比例、原图位置和提示词');
    // 扩图的关键参数必须先在同一个可视化画布里确认；直接打开而非要求用户
    // 再去寻找操作条，避免“已经连上了但不知道在哪改比例/摆放”的断层。
    void outpaintPanel.open(node.id);
}

/**
 * 继续创作可用性守卫（唯一入口）：仅 image-gen 且有实际图片或可用参考图的节点
 * 才能开启下一步。操作条、右键菜单与 createContinueStep 共用，避免三处判定分叉。
 */
export function canContinueFrom(source: FlowNode | null | undefined): boolean {
  return !!source
    && source.type === 'image-gen'
    && (Boolean(source.imageUrl) || flowState.getReferenceImages(source.id).length > 0);
}

/** 继续创作下游卡之间保留的垂直间距（世界坐标 px） */
const CONTINUE_STEP_GAP = 24;

/**
 * 为新的下游步骤挑选不与既有下游垂直重叠的 y 坐标：
 * 从源卡顶部开始，按「新卡高 + 间距」逐档下移；若某档与任一已有下游的垂直区间相交则继续下移。
 * 落在所有下游最底端之下时必然通过，因此循环有界（至多 siblings.length + 1 档）。
 */
function nextFreeSlotY(source: FlowNode, siblings: FlowNode[], newH: number): number {
  const step = newH + CONTINUE_STEP_GAP;
  const occupied = siblings.map(s => {
    const h = s.h ?? imageCardHeight(s.ratio);
    return { top: s.y, bottom: s.y + h };
  });
  const maxK = siblings.length + 1;
  for (let k = 0; k <= maxK; k += 1) {
    const candidate = source.y + k * step;
    const overlaps = occupied.some(o => candidate < o.bottom && candidate + newH > o.top);
    if (!overlaps) return candidate;
  }
  // 防御性回退：所有下游最底端之下（正常循环不会到达这里）。
  const bottom = occupied.reduce((max, o) => Math.max(max, o.bottom), source.y);
  return bottom + CONTINUE_STEP_GAP;
}

/**
 * 从一张现有图片开启下一步，而不是复制图片或覆盖原步骤。
 * 新节点仅保存它自己的想法和设置；来源图由连线派生为参考图，因而画布、历史和后续
 * 的结果卡始终指向同一份图片资料。
 */
export async function createContinueStep(
  source: FlowNode,
  options: { recordHistory?: boolean } = {},
): Promise<void> {
  if (!canContinueFrom(source)) {
    showToast('请选择一张已有图片后再继续创作', false);
    return;
  }

  if (options.recordHistory !== false) flowHistory.record();
  const siblings = flowState.getDownstreams(source.id).filter(node => node.type === 'image-gen');
  const params = source.params as unknown as StyleTransferParams;
  const ratio = source.ratio > 0 ? source.ratio : 4 / 3;
  // 新卡尚未生成，高度按继承的比例推算；与画布实际渲染高度（imageCardHeight）一致。
  const newH = imageCardHeight(ratio);
  const node = flowState.addNode('image-gen', source.x + CARD_W + 48, nextFreeSlotY(source, siblings, newH), {
    title: '继续创作',
    ratio,
    params: {
      // 提示词是一次创作记录自己的想法，不悄悄复用上一轮文字；其它常用设置沿用，减少重复配置。
      prompt: '',
      model: params.model || '',
      aspectRatio: params.aspectRatio || '4:3',
      resolution: params.resolution || '2k',
      count: 1,
      mode: 'draw',
    },
  });
  flowState.addEdge(source.id, node.id, { suppressStale: true });
  // getReferenceImages 只解析直接上游。若来源节点自身尚无输出图或手动参考图、
  // 仅通过一条连线拿到图片，单连 source → node 会让新步骤丢失这张图。
  // 因此把能提供图片的直接上游也复用为 node 的输入边；仍不把图片写入 refImages，
  // 且保留 source → node 这条主谱系边。
  if (!source.imageUrl && (source.refImages || []).length === 0) {
    flowState.getUpstreams(source.id)
      .filter(upstream => upstream.type === 'image-gen'
        && (Boolean(upstream.imageUrl) || (upstream.refImages || []).length > 0))
      .forEach(upstream => flowState.addEdge(upstream.id, node.id, { suppressStale: true }));
  }
  selection.select(node.id);
  showToast('已以当前图片创建下一步，输入想法即可生成');
  cmdPanel.focusInput();
}

/** 从图片建立视频步骤：只建立 reference 连线，不把图片复制或塞入节点 JSON。 */
export async function createVideoStep(source: FlowNode): Promise<void> {
  if (!canContinueFrom(source)) { showToast('请选择一张图片后再生成视频', false); return; }
  flowHistory.record();
  const sourceHeight = cardView.cardHeight(source);
  const node = flowState.addNode('video-gen', source.x + CARD_W + 48, source.y + Math.max(0, (sourceHeight - CARD_W / (16 / 9)) / 2), {
    title: '视频生成',
  });
  flowState.addEdge(source.id, node.id, { suppressStale: true });
  selection.select(node.id);
  showToast('已创建视频步骤：输入动态描述后生成');
  cmdPanel.focusInput();
}

export const actionBar = new ActionBar();
