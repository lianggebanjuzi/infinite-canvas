// src/v1/canvas/canvas-view.ts
// 画布容器：缩放/平移/点阵背景/坐标换算（改造自 src/core/canvas.ts，去 Minimap 依赖）

import { flowState } from '../state/flow-state';
import { selection } from '../state/selection';
import { cardView } from './card-view';
import { linkView } from './link-view';
import { showToast } from '../ui/toast';

/** 卡片固定宽度（原型 CARD_W=260） */
export const CARD_W = 260;
/** 超长图片在画布中的最大卡片高度；完整原图仍可通过查看大图打开。 */
export const IMAGE_CARD_MAX_H = 520;
/** 文本卡最大高度（A-2：长文本不撑高画布，内容区内滚；用户拍板保持 520 上限，不采纳 PRD 180） */
export const TEXT_CARD_MAX_H = 520;
/** 批次卡/多图卡最大高度（A-2：多图不撑高画布；用户拍板保持 520 上限，不采纳 PRD 260） */
export const BATCH_CARD_MAX_H = 520;

/** 图片卡统一高度：保持原比例，但限制超长图，避免单个素材撑满画布。 */
export function imageCardHeight(ratio: number, width = CARD_W): number {
  const safeRatio = ratio > 0 ? ratio : 4 / 3;
  return Math.min(IMAGE_CARD_MAX_H, Math.round(width / safeRatio));
}

/** 点阵间距（px）：与 app.css .canvas-wrap background-size 同步，缩放时按 scale 联动 */
const DOT_SPACING = 28;

class CanvasView {
  wrap: HTMLElement | null = null;
  canvasEl: HTMLElement | null = null;
  private _panning = false;
  private _panStart: { mx: number; my: number; vx: number; vy: number } | null = null;
  /** 平移与浏览器绘制同频，避免高频 mousemove 对带图片画布重复提交 transform。 */
  private _panFrame: number | null = null;
  private minimap: HTMLElement | null = null;
  private minimapCollapsed = true;
  private minimapDrag = false;

  /** 实时读取 flowState.canvas（避免 replaceAll 后引用过期） */
  get view(): FlowCanvasState { return flowState.canvas; }

  init(): void {
    this.wrap = document.getElementById('canvas-wrap');
    this.canvasEl = document.getElementById('canvas');
    if (!this.wrap || !this.canvasEl) return;

    linkView.init(this.canvasEl);
    this.applyView();
    this._bindEvents();
    this._initMinimap();
    document.getElementById('btn-fit-canvas')?.addEventListener('click', () => this.fitAll());
    document.getElementById('btn-focus-selected')?.addEventListener('click', () => this.focusSelected());

    // 状态变更 → 重渲染
    flowState.subscribe(() => {
      this.applyView();
      cardView.renderAll();
      linkView.renderAll();
      this._renderMinimap();
    });
  }

  applyView(): void {
    if (!this.canvasEl) return;
    const { panX, panY, scale } = this.view;
    this.canvasEl.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    // 点阵背景在 wrap（视口，无 transform）上按屏幕空间平铺：position=pan 使网格原点与世界原点（经 transform 后位于 pan）对齐，网格随世界移动；
    // size 乘 scale → 密度随缩放联动；视口裁剪 → 永不露白
    if (this.wrap) {
      this.wrap.style.backgroundPosition = `${panX}px ${panY}px`;
      this.wrap.style.backgroundSize = `${DOT_SPACING * scale}px ${DOT_SPACING * scale}px`;
    }
    this._renderMinimap();
  }

  /** 屏幕坐标 → 世界坐标（画布坐标系） */
  toWorldCoords(screenX: number, screenY: number): { x: number; y: number } {
    const rect = this.wrap?.getBoundingClientRect() ?? { left: 0, top: 0 };
    const { panX, panY, scale } = this.view;
    return {
      x: (screenX - rect.left - panX) / scale,
      y: (screenY - rect.top - panY) / scale,
    };
  }

  /** 世界坐标 → wrap 内屏幕坐标（用于悬浮面板定位） */
  worldToWrap(x: number, y: number): { x: number; y: number } {
    const { panX, panY, scale } = this.view;
    return { x: panX + x * scale, y: panY + y * scale };
  }

  private _bindEvents(): void {
    if (!this.wrap) return;

    // 滚轮缩放（以鼠标为锚点）
    this.wrap.addEventListener('wheel', (e: WheelEvent) => {
      const target = e.target as Element;
      // 卡片内容的阅读/编辑优先于画布缩放：文本、拆分槽位、结果栏及所有可滚动面板
      // 都保留原生滚动。只有真正落在画布空白处时才缩放。
      if (target.closest('.pcard-text, .pcard-text-editor, .split-body, .split-input, .property-editor, .task-panel, .result-viewer, .cmd-input, .project-name, .settings-input, textarea, input')) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.92 : 1.08;
      const ns = Math.min(2, Math.max(0.3, this.view.scale * delta));
      const rect = this.wrap!.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const { panX, panY, scale } = this.view;
      this.view.panX = mx - (mx - panX) * (ns / scale);
      this.view.panY = my - (my - panY) * (ns / scale);
      this.view.scale = ns;
      // 缩放只改 #canvas 的 transform，卡片/连线均用世界坐标自动跟随，无需重建 DOM
      this.applyView();
    }, { passive: false });

    // 平移的 mousedown/move/up 都由 interactions.ts 统一处理，避免同一 mousemove 重复 applyView。
  }

  /** 4.1-A 小地图：只画节点边界和当前视窗，不加载任何缩略图。 */
  private _initMinimap(): void {
    if (!this.wrap || this.minimap) return;
    const map = document.createElement('div');
    map.className = 'canvas-minimap is-collapsed';
    map.innerHTML = '<button class="minimap-toggle" type="button" title="展开小地图">⌁</button><div class="minimap-stage"><div class="minimap-nodes"></div><div class="minimap-viewport"></div></div>';
    this.wrap.appendChild(map);
    this.minimap = map;
    const toggle = map.querySelector('.minimap-toggle') as HTMLButtonElement;
    toggle.addEventListener('click', e => { e.stopPropagation(); this.minimapCollapsed = !this.minimapCollapsed; map.classList.toggle('is-collapsed', this.minimapCollapsed); toggle.title = this.minimapCollapsed ? '展开小地图' : '收起小地图'; this._renderMinimap(); });
    const stage = map.querySelector('.minimap-stage') as HTMLElement;
    stage.addEventListener('mousedown', e => { this.minimapDrag = true; this._moveFromMinimap(e); e.preventDefault(); e.stopPropagation(); });
    window.addEventListener('mousemove', e => { if (this.minimapDrag) this._moveFromMinimap(e); });
    window.addEventListener('mouseup', () => { this.minimapDrag = false; });
    this._renderMinimap();
  }

  private _minimapBounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    if (flowState.nodes.length === 0) return { minX: -400, minY: -300, maxX: 400, maxY: 300 };
    const b = flowState.nodes.reduce((acc, node) => {
      const w = node.w ?? CARD_W, h = node.h ?? cardView.cardHeight(node);
      acc.minX = Math.min(acc.minX, node.x); acc.minY = Math.min(acc.minY, node.y);
      acc.maxX = Math.max(acc.maxX, node.x + w); acc.maxY = Math.max(acc.maxY, node.y + h); return acc;
    }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
    const pad = 120; return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
  }

  private _renderMinimap(): void {
    const map = this.minimap, wrap = this.wrap;
    if (!map || !wrap) return;
    const stage = map.querySelector('.minimap-stage') as HTMLElement | null;
    const dots = map.querySelector('.minimap-nodes') as HTMLElement | null;
    const viewport = map.querySelector('.minimap-viewport') as HTMLElement | null;
    if (!stage || !dots || !viewport) return;
    const b = this._minimapBounds(), r = stage.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return;
    const spanX = Math.max(1, b.maxX - b.minX), spanY = Math.max(1, b.maxY - b.minY);
    dots.innerHTML = flowState.nodes.map(node => {
      const w = node.w ?? CARD_W, h = node.h ?? cardView.cardHeight(node);
      return `<i style="left:${(node.x - b.minX) / spanX * 100}%;top:${(node.y - b.minY) / spanY * 100}%;width:${Math.max(2, w / spanX * 100)}%;height:${Math.max(2, h / spanY * 100)}%"></i>`;
    }).join('');
    const viewLeft = -this.view.panX / this.view.scale, viewTop = -this.view.panY / this.view.scale;
    const viewW = wrap.clientWidth / this.view.scale, viewH = wrap.clientHeight / this.view.scale;
    viewport.style.left = `${(viewLeft - b.minX) / spanX * 100}%`; viewport.style.top = `${(viewTop - b.minY) / spanY * 100}%`;
    viewport.style.width = `${Math.min(100, viewW / spanX * 100)}%`; viewport.style.height = `${Math.min(100, viewH / spanY * 100)}%`;
    const shouldSuggest = flowState.nodes.length > 12 || spanX > wrap.clientWidth / this.view.scale * 2 || spanY > wrap.clientHeight / this.view.scale * 2;
    map.classList.toggle('has-suggestion', this.minimapCollapsed && shouldSuggest);
  }

  private _moveFromMinimap(e: MouseEvent): void {
    const stage = this.minimap?.querySelector('.minimap-stage') as HTMLElement | null;
    if (!stage || !this.wrap) return;
    const rect = stage.getBoundingClientRect(), b = this._minimapBounds();
    const x = b.minX + Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * (b.maxX - b.minX);
    const y = b.minY + Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)) * (b.maxY - b.minY);
    this.view.panX = this.wrap.clientWidth / 2 - x * this.view.scale;
    this.view.panY = this.wrap.clientHeight / 2 - y * this.view.scale;
    this.applyView();
  }

  /** 供 interactions 调用：中键拖动画布平移 */
  startPan(clientX: number, clientY: number): void {
    this._startPan(clientX, clientY);
  }

  movePan(clientX: number, clientY: number): void {
    this._movePan({ clientX, clientY } as MouseEvent);
  }

  endPan(): void {
    this._endPan();
  }

  /** 将所有节点（含卡片实际高度）缩放并居中到可视范围。 */
  fitAll(): void {
    if (!this.wrap || flowState.nodes.length === 0) {
      showToast('画布中还没有节点', false);
      return;
    }
    const bounds = flowState.nodes.reduce((acc, node) => {
      const width = node.w ?? CARD_W;
      const height = node.h ?? cardView.cardHeight(node);
      acc.minX = Math.min(acc.minX, node.x);
      acc.minY = Math.min(acc.minY, node.y);
      acc.maxX = Math.max(acc.maxX, node.x + width);
      acc.maxY = Math.max(acc.maxY, node.y + height);
      return acc;
    }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
    const rect = this.wrap.getBoundingClientRect();
    const padding = 96;
    const width = Math.max(1, bounds.maxX - bounds.minX);
    const height = Math.max(1, bounds.maxY - bounds.minY);
    const scale = Math.min(1.35, Math.max(0.3, Math.min((rect.width - padding * 2) / width, (rect.height - padding * 2) / height)));
    this._centerWorldPoint((bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, scale);
  }

  /** 将单选节点置于画布中心，保留当前缩放级别。 */
  focusSelected(): void {
    const node = selection.single();
    if (!node) {
      showToast('请先选中一个节点', false);
      return;
    }
    const width = node.w ?? CARD_W;
    const height = node.h ?? cardView.cardHeight(node);
    this._centerWorldPoint(node.x + width / 2, node.y + height / 2, this.view.scale);
  }

  private _centerWorldPoint(x: number, y: number, scale: number): void {
    if (!this.wrap) return;
    const rect = this.wrap.getBoundingClientRect();
    this.view.scale = scale;
    this.view.panX = rect.width / 2 - x * scale;
    this.view.panY = rect.height / 2 - y * scale;
    flowState.updatedAt = Date.now();
    flowState.dirty = true;
    flowState.notify();
  }

  private _startPan(mx: number, my: number): void {
    this._panning = true;
    this._panStart = { mx, my, vx: this.view.panX, vy: this.view.panY };
    if (this.wrap) this.wrap.style.cursor = 'grabbing';
  }

  private _movePan(e: MouseEvent): void {
    if (!this._panning || !this._panStart) return;
    this.view.panX = this._panStart.vx + (e.clientX - this._panStart.mx);
    this.view.panY = this._panStart.vy + (e.clientY - this._panStart.my);
    if (this._panFrame !== null) return;
    this._panFrame = requestAnimationFrame(() => {
      this._panFrame = null;
      this.applyView();
    });
  }

  private _endPan(): void {
    if (!this._panning) return;
    this._panning = false;
    this._panStart = null;
    if (this._panFrame !== null) {
      cancelAnimationFrame(this._panFrame);
      this._panFrame = null;
      this.applyView(); // 松手时立刻提交最后一次鼠标位置，不等待下一帧。
    }
    if (this.wrap) this.wrap.style.cursor = '';
    flowState.updatedAt = Date.now();
    flowState.dirty = true;
    flowState.notify();
  }
}

export const canvasView = new CanvasView();
