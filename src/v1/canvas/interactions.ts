// src/v1/canvas/interactions.ts
// 交互层：卡片拖拽移动 / 单选多选 / Shift 框选 / 组拖 / 空白平移 /
// 历史图库拖入（A4：拖到输入节点→替换；拖到空白→新建输入）/ 右键菜单 / 文件选图

import { flowState } from '../state/flow-state';
import { selection } from '../state/selection';
import { dirty } from '../state/dirty';
import { flowHistory } from '../state/history';
import { nodeRegistry } from '../nodes/node-registry';
import { canvasView, CARD_W, IMAGE_CARD_MAX_H, imageCardHeight } from './canvas-view';
import { cardView, openNodeImageModal } from './card-view';
import { linkView, connectionDescription } from './link-view';
import { runEngine } from '../engine/run-engine';
import { showToast } from '../ui/toast';
import { floatingPanels } from '../ui/floating-panels';
import { Backend, fetchImageModels, fetchChatModels, fetchVideoModels } from '../api';
import { createContinueStep, createOutpaintStep, createVideoStep, canContinueFrom } from '../ui/action-bar';
import { insertImageAsAsset, attachImageToNode } from '../ui/resource-insert';
import { imageEditor } from '../ui/image-editor/image-editor';

const DRAG_THRESHOLD = 3;

/** 文本卡缩放钳制范围（世界坐标 px；最小 160×120，最大 640×800） */
const RESIZE_MIN_W = 160;
const RESIZE_MIN_H = 120;
const RESIZE_MAX_W = 640;
const RESIZE_MAX_H = 800;

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

type DragMode = 'node' | 'pan' | 'select' | 'connect' | 'resize';

interface DragState {
  mode: DragMode;
  startX: number;
  startY: number;
  moved: boolean;
  nodeId: string | null;
  group: Array<{ id: string; x: number; y: number }> | null;
  panVx: number;
  panVy: number;
  selX: number;
  selY: number;
  /** resize 起始卡片宽高（世界坐标；拖拽累计用，避免浮点漂移） */
  resizeW: number;
  resizeH: number;
}

class Interactions {
  private wrap: HTMLElement | null = null;
  private selBox: HTMLElement | null = null;
  private fileInput: HTMLInputElement | null = null;
  private pendingFileNodeId: string | null = null;
  private drag: DragState | null = null;
  private _dragSnapshots = new Map<string, { x: number; y: number }>();
  /** 拖动守卫：最近一次节点按下-松开是否发生了位移（超过 DRAG_THRESHOLD）——卡片文本点击进入编辑前排除拖拽后的 click */
  private _lastNodeDragMoved = false;
  /** 拖动期间合并渲染请求，避免每个 mousemove 都同步重排卡片与连线。 */
  private _renderFrame: number | null = null;

  init(): void {
    this.wrap = document.getElementById('canvas-wrap');
    this.selBox = document.getElementById('selection-box');
    this.fileInput = document.getElementById('file-input') as HTMLInputElement | null;
    if (!this.wrap) return;
    this._bindMouse();
    this._bindDrop();
    this._bindFileInput();
    this._bindContextMenu();
  }

  // ───────────────────────── 鼠标：选择/拖拽/框选/平移 ─────────────────────────
  private _bindMouse(): void {
    const wrap = this.wrap!;

    wrap.addEventListener('mousedown', (e: MouseEvent) => {
      const target = e.target as Element;

      // 悬浮面板/控件区域不响应画布交互（中键/左键均跳过）
      if (target.closest('.ctx-menu') || target.closest('.cmd-panel') || target.closest('.action-bar') || target.closest('.link-plus') || target.closest('.link-del') || target.closest('.overlay') || target.closest('.canvas-minimap')) {
        return;
      }

      // 中键：画布平移（preventDefault 避免浏览器 autoscroll 图标；不改动选中态）
      if (e.button === 1) {
        e.preventDefault();
        // 悬浮框的定位依赖画布坐标；平移时先收起，松手后再按最终位置恢复，避免它们在结束瞬间跳位。
        floatingPanels.suspendForPan();
        this.drag = {
          mode: 'pan',
          startX: e.clientX,
          startY: e.clientY,
          moved: false,
          nodeId: null,
          group: null,
          panVx: flowState.canvas.panX,
          panVy: flowState.canvas.panY,
          selX: 0,
          selY: 0,
          resizeW: 0,
          resizeH: 0,
        };
        canvasView.startPan(e.clientX, e.clientY);
        return;
      }

      if (e.button !== 0) return;

      // 端口：out 端口按住拖线（手动连线 P0）；in 端口不响应 mousedown
      const portEl = target.closest('.port') as HTMLElement | null;
      if (portEl) {
        if (portEl.classList.contains('out')) {
          this._startConnectDrag(e, portEl);
        }
        return;
      }

      const cardEl = target.closest('.pcard') as HTMLElement | null;
      if (cardEl) {
        this._onCardMouseDown(e, cardEl);
        return;
      }

      // 空白处：Shift 框选 / 否则仅取消选中（左键不再平移，平移只走中键）
      // Tab 化：点画布空白统一收起悬浮面板（收起只走 Esc / 点空白）；hide() 幂等，未显示时无副作用。
      // 注意：放在 Shift 分支之前——Shift+点空白框选同样属于「点画布空白」，一并收起。
      floatingPanels.hide();
      cardView.collapseAllFans();
      if (e.shiftKey) {
        this._startFrameSelect(e);
        return;
      }
      selection.clear();
    });

    window.addEventListener('mousemove', (e: MouseEvent) => this._onMouseMove(e));
    window.addEventListener('mouseup', (e: MouseEvent) => this._onMouseUp(e));
    window.addEventListener('dblclick', (e: MouseEvent) => {
      const cardEl = (e.target as Element).closest('.pcard') as HTMLElement | null;
      if (!cardEl) return;
      const node = flowState.getNode(cardEl.dataset.nodeId || '');
      if (!node) return;
      // 有图 → 与右上「查看大图」走同一图片信息弹窗；空图片卡（无输出图且无参考图，非文本卡）双击 → 弹文件选择器加载参考图
      if (node.imageUrl) { openNodeImageModal(node.id, node.activeGeneratedIndex || 0); return; }
      if (node.type !== 'text-gen' && (!node.refImages || node.refImages.length === 0)) {
        this.openFilePickerForRef(node.id);
      }
    });
  }

  private _onCardMouseDown(e: MouseEvent, cardEl: HTMLElement): void {
    e.stopPropagation();
    // resize 把手在卡片内：必须先拦截走缩放分支并 return，不能让卡片拖拽把把手也带走
    if ((e.target as Element).closest('.pcard-resize')) {
      this._startResizeDrag(e, cardEl);
      return;
    }
    if ((e.target as Element).closest('.pcard-act') || (e.target as Element).closest('.port')) return;
    // 卡内批次控件（折叠叠图入口/展开缩略图/上下切换）：点击不触发卡片拖拽与选中
    if ((e.target as Element).closest('.stack-layer, .fan-thumb, .image-gallery-nav')) return;
    this._lastNodeDragMoved = false; // 本次按下重置拖动守卫（随后 click 依据本次是否位移判定）

    const nodeId = cardEl.dataset.nodeId || '';
    const node = flowState.getNode(nodeId);
    if (!node) return;

    // 选中语义：Shift 追加/切换；无 Shift 且未选中 → 单选；已选中 → 保留整组
    if (e.shiftKey) {
      selection.toggle(nodeId);
    } else if (!selection.isSelected(nodeId)) {
      selection.select(nodeId, false);
    }

    const multi = selection.isSelected(nodeId) && selection.size > 1;
    const group = multi
      ? selection.ids
          .map(id => flowState.getNode(id))
          .filter((n): n is FlowNode => !!n)
          .map(n => ({ id: n.id, x: n.x, y: n.y }))
      : null;

    this.drag = {
      mode: 'node',
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      nodeId,
      group,
      panVx: 0,
      panVy: 0,
      selX: 0,
      selY: 0,
      resizeW: 0,
      resizeH: 0,
    };
    // 拖动起始快照（单节点用，避免累计漂移）
    this._dragSnapshots.set(nodeId, { x: node.x, y: node.y });
  }

  /**
   * 文本卡右下角缩放拖拽（text-gen 专属）：记起始宽高，变更前入撤销栈。
   * 拖拽中直接写 node.w/node.h（世界坐标），复用 _scheduleDragRender 合并渲染。
   */
  private _startResizeDrag(e: MouseEvent, cardEl: HTMLElement): void {
    const nodeId = cardEl.dataset.nodeId || '';
    const node = flowState.getNode(nodeId);
    if (!node) return;
    this._lastNodeDragMoved = false;
    if (!selection.isSelected(nodeId)) selection.select(nodeId, false); // 与节点拖拽一致：操作卡片即选中
    // 用户手势：变更前入撤销栈（参照连线/新建惯例）
    flowHistory.record();
    this.drag = {
      mode: 'resize',
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      nodeId,
      group: null,
      panVx: 0,
      panVy: 0,
      selX: 0,
      selY: 0,
      resizeW: node.w ?? CARD_W,
      resizeH: node.h ?? cardView.cardHeight(node),
    };
  }

  private _onMouseMove(e: MouseEvent): void {
    if (!this.drag) return;
    const d = this.drag;

    if (d.mode === 'pan') {
      canvasView.movePan(e.clientX, e.clientY);
      return;
    }

    if (d.mode === 'select') {
      this._updateFrameSelect(e);
      return;
    }

    if (d.mode === 'connect') {
      // 橡皮筋临时线跟随鼠标（世界坐标）
      const world = canvasView.toWorldCoords(e.clientX, e.clientY);
      linkView.updateTempLine(world.x, world.y);
      this._updateDroppable(e);
      return;
    }

    if (d.mode === 'resize') {
      // 超过阈值才开始缩放（与 node 拖拽一致，避免误触）
      if (!d.moved && Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) > DRAG_THRESHOLD) {
        d.moved = true;
      }
      if (!d.moved) return;
      const dx = (e.clientX - d.startX) / flowState.canvas.scale;
      const dy = (e.clientY - d.startY) / flowState.canvas.scale;
      const node = d.nodeId ? flowState.getNode(d.nodeId) : null;
      if (node) {
        // 图片默认锁定原图比例；自由缩放仅改节点布局，不会改动或重新编码原图。
        const nextW = clamp(d.resizeW + dx, RESIZE_MIN_W, RESIZE_MAX_W);
        if (node.type === 'image-gen' && (node.imageAspectLocked ?? true)) {
          node.w = nextW;
          node.h = clamp(nextW / (node.ratio > 0 ? node.ratio : 4 / 3), RESIZE_MIN_H, RESIZE_MAX_H);
        } else {
          node.w = nextW;
          node.h = clamp(d.resizeH + dy, RESIZE_MIN_H, RESIZE_MAX_H);
        }
      }
      this._scheduleDragRender();
      return;
    }

    // node 模式：超过阈值才开始移动
    if (!d.moved && Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) > DRAG_THRESHOLD) {
      d.moved = true;
    }
    if (!d.moved) return;

    const dx = (e.clientX - d.startX) / flowState.canvas.scale;
    const dy = (e.clientY - d.startY) / flowState.canvas.scale;

    if (d.group && d.group.length > 1) {
      // 组拖：以每张卡片的起始坐标累计
      d.group.forEach(g => {
        const n = flowState.getNode(g.id);
        if (n) { n.x = g.x + dx; n.y = g.y + dy; }
      });
    } else if (d.nodeId) {
      // 单拖：以拖动起始快照累计，避免浮点漂移
      const snap = this._dragSnapshots.get(d.nodeId);
      if (snap) {
        const n = flowState.getNode(d.nodeId);
        if (n) { n.x = snap.x + dx; n.y = snap.y + dy; }
      }
    }

    this._scheduleDragRender();
  }

  private _scheduleDragRender(): void {
    if (this._renderFrame !== null) return;
    this._renderFrame = requestAnimationFrame(() => {
      this._renderFrame = null;
      const d = this.drag;
      const nodeIds = d?.group && d.group.length > 1
        ? d.group.map(n => n.id)
        : (d?.nodeId ? [d.nodeId] : []);
      // 拖动中只同步受影响卡片的几何属性；完整内容在 mouseup 的状态提交后统一刷新。
      // 这样不会每帧为全部节点重建参考图缩略行（其中可能包含大型 data URL）。
      cardView.updateDragGeometry(nodeIds);
      linkView.renderAll();
    });
  }

  private _onMouseUp(e: MouseEvent): void {
    const d = this.drag;
    if (!d) return;

    if (d.mode === 'node' || d.mode === 'resize') {
      this._lastNodeDragMoved = d.moved; // 记录本次按下-松开是否发生位移（拖动守卫：供 click 处理器排除拖拽后的误入编辑）
      if (this._renderFrame !== null) {
        cancelAnimationFrame(this._renderFrame);
        this._renderFrame = null;
      }
      if (d.moved) {
        flowState.updatedAt = Date.now();
        flowState.dirty = true;
        flowState.notify();
      }
      // 单击仅选中，不再自动弹文件选择器（曾因触发范围=整卡容易误触弹出；加载图改由三个明确入口：
      // 双击空卡 / 指令面板「添加参考图」按钮 / 拖图到卡片）
      this._dragSnapshots.clear();
    }

    if (d.mode === 'select') {
      this._finishFrameSelect();
    }

    if (d.mode === 'pan') {
      canvasView.endPan();
      floatingPanels.resumeAfterPan();
    }

    if (d.mode === 'connect') {
      this._finishConnect(e);
    }

    this.drag = null;
  }

  // ───────────────────────── 端口拖拽连线（手动连线 P0） ─────────────────────────
  private _lastDroppable: HTMLElement | null = null;

  /** 打开文件选择器，为指定节点追加参考图（空卡单击 / 指令面板「添加参考图」共用） */
  openFilePickerForRef(nodeId: string): void {
    if (!nodeId) return;
    this.pendingFileNodeId = nodeId;
    this.fileInput?.click();
  }

  /** 拖动守卫：本次节点按下-松开是否发生了位移（moved）——卡片文本点击进入编辑态前调用，moved=true 则不进入 */
  wasNodeDragMoved(): boolean {
    return this._lastNodeDragMoved;
  }

  private _startConnectDrag(e: MouseEvent, portEl: HTMLElement): void {
    e.stopPropagation();
    const cardEl = portEl.closest('.pcard') as HTMLElement | null;
    const nodeId = cardEl?.dataset.nodeId || '';
    if (!nodeId) return;

    this.drag = {
      mode: 'connect',
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      nodeId,
      group: null,
      panVx: 0,
      panVy: 0,
      selX: 0,
      selY: 0,
      resizeW: 0,
      resizeH: 0,
    };
    portEl.classList.add('dragging');
    linkView.startTempLine(nodeId);
  }

  private _updateDroppable(e: MouseEvent): void {
    this._clearDroppable();
    // C-5：拖线时高亮全部兼容入端口（canConnect 查表结果，A-3 端口契约）
    const fromId = this.drag?.nodeId;
    if (fromId) {
      document.querySelectorAll('.port.in').forEach(port => {
        const cardEl = (port as HTMLElement).closest('.pcard') as HTMLElement | null;
        const toId = cardEl?.dataset.nodeId || '';
        if (toId && toId !== fromId && flowState.canConnect(fromId, toId) === null) {
          port.classList.add('compatible');
        }
      });
    }
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const inPort = el?.closest('.port.in') as HTMLElement | null;
    if (inPort) {
      inPort.classList.add('droppable');
      this._lastDroppable = inPort;
    }
  }

  private _clearDroppable(): void {
    if (this._lastDroppable) {
      this._lastDroppable.classList.remove('droppable');
      this._lastDroppable = null;
    }
    document.querySelectorAll('.port.dragging').forEach(p => p.classList.remove('dragging'));
    document.querySelectorAll('.port.compatible').forEach(p => p.classList.remove('compatible'));
  }

  private _finishConnect(e: MouseEvent): void {
    const fromId = this.drag?.nodeId;
    linkView.clearTempLine();
    this._clearDroppable();
    if (!fromId) return;

    // 松手点元素（屏幕坐标）；命中悬浮面板（指令面板/操作条）时穿透：临时隐藏面板取下层元素，
    // 使「拖线结束落在面板上方」仍能命中面板下层被遮住的卡片（松手在目标卡任意位置即连线）。
    let el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const panel = el?.closest('.cmd-panel, .action-bar') as HTMLElement | null;
    if (panel) {
      const prevDisplay = panel.style.display;
      panel.style.display = 'none';
      el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      panel.style.display = prevDisplay;
    }

    // 松手命中目标卡（非源卡、canConnect 允许）任意区域 → 连线（不必精确落 .port.in；
    // .port.in 高亮提示由 _updateDroppable 在拖动中提供）
    const targetCard = el?.closest('.pcard') as HTMLElement | null;
    if (targetCard) {
      const toId = targetCard.dataset.nodeId;
      if (toId && toId !== fromId) {
        // 只有校验可通过才入撤销栈（避免无效连线留下无操作快照）
        if (flowState.canConnect(fromId, toId) === null) flowHistory.record();
        const res = flowState.connect(fromId, toId);
        if (!res.ok) showToast(res.error || '连线失败', false);
        else showToast(connectionDescription(fromId, toId)); // C-5：连线完成显示传输语义
      }
      return;
    }

    // 松手在空白/非法位置 → 弹出「新建节点」菜单（可作下游类型，过滤产品图）
    this._showNewNodeMenu(e.clientX, e.clientY, fromId);
  }

  // ───────────────────────── 拖线松手 → 新建节点菜单（P0） ─────────────────────────

  /** 可作下游的节点类型（注册表 creatable 定义；候选过滤见 _showNewNodeMenu 按 from 类型，W1-2） */
  private _newNodeCandidates(): NodeDefinition[] {
    return nodeRegistry.list().filter(d => d.creatable !== false);
  }

  /** 松手处弹「新建节点」菜单：选择类型 → 建节点并自动连上拖出的线。
   *  候选按 from 类型过滤（W1-2）：
   *    from=图片节点（含素材）→ [文本, 图片生成]（图片可作文本反推输入 / 图片参考图）；
   *    from=文本节点 → 仅 [图片生成]（文本→文本 链式不做；素材不进入新建菜单，天然无「新建素材」项）。
   */
  private _showNewNodeMenu(screenX: number, screenY: number, fromId: string): void {
    const fromNode = flowState.getNode(fromId);
    const all = this._newNodeCandidates();
    const candidates = all.filter(d => {
      if (d.type === 'text-gen') {
        // 文本候选：仅当 from 是图片节点（素材/自建）——图片→文本 反推输入（W1-1）
        return !!fromNode && fromNode.type === 'image-gen';
      }
      if (d.type === 'text-split') return !!fromNode && fromNode.type === 'text-gen';
      if (d.type === 'video-gen') return !!fromNode && (fromNode.type === 'image-gen' || fromNode.type === 'text-gen');
      // image-gen 候选：from 是文本（关键词）或图片（参考图）均可
      return !!fromNode && (fromNode.type === 'image-gen' || fromNode.type === 'text-gen' || fromNode.type === 'text-split');
    });
    if (candidates.length === 0) return;

    const menu = this._menuEl();
    menu.innerHTML = `
      <div class="ctx-hint">松手新建节点并连接</div>
      ${candidates.map(d => `
      <div class="ctx-item" data-act="create-node" data-node-type="${d.type}">
        ${this._nodeTypeIcon(d.type)}
        ${d.label}
      </div>`).join('')}
      <div class="ctx-sep"></div>
      <div class="ctx-item danger" data-act="cancel-connect">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        取消
      </div>`;
    menu.dataset.nodeId = fromId; // 拖出端口的源节点
    menu.dataset.edgeId = '';
    menu.dataset.newX = String(screenX);
    menu.dataset.newY = String(screenY);
    this._showMenu(menu, screenX, screenY);
  }

  /** 在松手处（世界坐标，节点中心对准松手点）创建节点并自动连上拖出的线 */
  private _createNodeFromMenu(type: string, fromId: string, screenX: number, screenY: number): void {
    const def = nodeRegistry.get(type as NodeType);
    const world = canvasView.toWorldCoords(screenX, screenY);
    const h = CARD_W / (def.defaultRatio > 0 ? def.defaultRatio : 4 / 3);
    flowHistory.record();
    const node = flowState.addNode(type as NodeType, world.x - CARD_W / 2, world.y - h / 2);
    selection.select(node.id);
    if (fromId && flowState.canConnect(fromId, node.id) === null) {
      flowState.addEdge(fromId, node.id);
      showToast(`已新建「${def.label}」并连接`);
    }
    this._fillDefaultModelFor(node.id);
  }

  /** 新节点优先沿用当前项目最近选择的同类模型；未选择过才取第一个可用模型。 */
  private _fillDefaultModelFor(nodeId: string): void {
    const node = flowState.getNode(nodeId);
    if (!node) return;
    if (node.type === 'text-split') return;
    const kind = node.type === 'text-gen' ? 'chat' : (node.type === 'video-gen' ? 'video' : 'drawing');
    const loader = kind === 'chat' ? fetchChatModels : (kind === 'video' ? fetchVideoModels : fetchImageModels);
    void loader().then(models => {
      const cur = flowState.getNode(nodeId);
      if (!cur || (cur.params.model as string | undefined)) return;
      const saved = flowState.getModelDefault(kind);
      const model = saved && models.some(item => item.id === saved)
        ? saved
        : (models.find(item => item.id)?.id || '');
      if (model) {
        flowState.updateNodeParams(nodeId, { model });
      }
    });
  }

  private _nodeTypeIcon(_type: string): string {
    return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/><path d="M12 9v6M9 12h6"/></svg>';
  }

  // ───────────────────────── Shift 框选 ─────────────────────────
  private _startFrameSelect(e: MouseEvent): void {
    const rect = this.wrap!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    this.drag = {
      mode: 'select',
      startX: x,
      startY: y,
      moved: false,
      nodeId: null,
      group: null,
      panVx: 0,
      panVy: 0,
      selX: x,
      selY: y,
      resizeW: 0,
      resizeH: 0,
    };
    if (this.selBox) {
      this.selBox.style.display = 'block';
      this.selBox.style.left = x + 'px';
      this.selBox.style.top = y + 'px';
      this.selBox.style.width = '0px';
      this.selBox.style.height = '0px';
    }
  }

  private _updateFrameSelect(e: MouseEvent): void {
    if (!this.drag || !this.selBox) return;
    const rect = this.wrap!.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    this.selBox.style.left = Math.min(cx, this.drag.selX) + 'px';
    this.selBox.style.top = Math.min(cy, this.drag.selY) + 'px';
    this.selBox.style.width = Math.abs(cx - this.drag.selX) + 'px';
    this.selBox.style.height = Math.abs(cy - this.drag.selY) + 'px';
  }

  private _finishFrameSelect(): void {
    if (!this.selBox) return;
    const sb = this.selBox.getBoundingClientRect();
    this.selBox.style.display = 'none';
    const hit: string[] = [];
    flowState.nodes.forEach(node => {
      const el = cardView.getEl(node.id);
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.left < sb.right && r.right > sb.left && r.top < sb.bottom && r.bottom > sb.top) {
        hit.push(node.id);
      }
    });
    selection.set(hit);
  }

  // ───────────────────────── 历史图 / 文件拖入（A4） ─────────────────────────
  private _bindDrop(): void {
    const wrap = this.wrap!;

    wrap.addEventListener('dragover', (e: DragEvent) => {
      const types = e.dataTransfer?.types || [];
      if (types.includes('application/history-image') || types.includes('Files') || types.includes('text/plain')) {
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'copy';
      }
    });

    wrap.addEventListener('drop', (e: DragEvent) => {
      const types = e.dataTransfer?.types || [];
      const hasHistory = types.includes('application/history-image');
      const hasFiles = types.includes('Files');
      if (!hasHistory && !hasFiles) return;
      e.preventDefault();

      const world = canvasView.toWorldCoords(e.clientX, e.clientY);
      const historySrc = e.dataTransfer?.getData('application/history-image') || e.dataTransfer?.getData('text/plain') || '';
      const files = Array.from(e.dataTransfer?.files || []);

      if (historySrc) {
        void this._dropImage(historySrc, world, e.clientX, e.clientY);
        return;
      }
      if (files.length > 0) {
        const imageFiles = files.filter(f => f.type.startsWith('image/'));
        if (imageFiles.length > 0) {
          // 在异步读取文件前命中一次目标卡，避免首张素材创建后，后续图片
          // 被误判为投到了刚创建的素材卡上。
          const targetNode = this._nodeAt(e.clientX, e.clientY);
          if (targetNode && flowState.isAssetNode(targetNode)) {
            showToast('素材节点不能添加参考图', false);
            return;
          }

          // FileReader 与原图落盘都是异步操作；串行执行才能让 FileList 的第 N 张
          // 严格对应模型请求里的第 N 张参考图（图 1 / 图 2 / 图 3）。
          void this._dropFilesInOrder(imageFiles, world, e.clientX, e.clientY, targetNode);
        }
      }
    });
  }

  /** 多文件按 FileList 原始顺序串行读取、落盘并挂载；绝不以异步完成顺序决定参考图顺序。 */
  private async _dropFilesInOrder(
    files: File[],
    world: { x: number; y: number },
    screenX: number,
    screenY: number,
    targetNode: FlowNode | null,
  ): Promise<void> {
    const columns = Math.min(3, files.length);
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const src = await this._readFileAsDataUrl(file);
      if (!src) {
        showToast(`图片加载失败：${file.name}`, false);
        continue;
      }
      const col = index % columns;
      const row = Math.floor(index / columns);
      const offsetX = (col - (columns - 1) / 2) * (CARD_W + 48);
      const offsetY = row * (IMAGE_CARD_MAX_H + 48);
      await this._dropImage(
        src,
        { x: world.x + offsetX, y: world.y + offsetY },
        screenX,
        screenY,
        file.name,
        targetNode,
        // 放到文本节点时，素材会按该节点左侧的网格排布；否则使用投放点网格。
        targetNode?.type === 'text-gen'
          ? { x: -col * (CARD_W + 48), y: offsetY }
          : undefined,
      );
    }
  }

  private _readFileAsDataUrl(file: File): Promise<string | null> {
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.onabort = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  /**
   * 拖图进画布（W5/A4 口径；素材节点创建统一收敛到 resource-insert，禁止三处各自建不同格式）：
   *   落到文本节点卡 → 自动建素材节点并连线（素材→文本 反推输入，W1-3/Q4）；
   *   落到素材节点 → 拒绝（素材是链首数据，不接收上游，toast 提示）；
   *   落到自建 image-gen 卡 → 追加参考图（现状保留，经 attachImageToNode）；
   *   空白处 → 建素材节点（image-gen + isAsset:true，整卡显图、角标「素材」、不可运行）。
   */
  private _dropImage(
    src: string,
    world: { x: number; y: number },
    screenX: number,
    screenY: number,
    _fileName?: string,
    targetNodeOverride?: FlowNode | null,
    assetPositionOffset?: { x: number; y: number },
  ): Promise<void> {
    const targetNode = targetNodeOverride === undefined
      ? this._nodeAt(screenX, screenY)
      : targetNodeOverride;
    return new Promise(resolve => {
      const img = new Image();
      img.onload = async () => {
        try {
      const ratio = img.naturalWidth / img.naturalHeight;
      const r = ratio > 0 ? ratio : 4 / 3;
      const imported = _fileName ? await this._prepareImportedImage(src, _fileName) : { displayUrl: src, origin: null };

      if (targetNode) {
        // 素材节点不接收上游图
        if (flowState.isAssetNode(targetNode)) {
          showToast('素材节点不能添加参考图', false);
          return;
        }
        // 文本节点：自动建素材节点并连线（素材→文本；素材放文本左侧避免覆盖松手点）
        if (targetNode.type === 'text-gen') {
          const pos = this._assetPositionNear(targetNode, r);
          pos.x += assetPositionOffset?.x ?? 0;
          pos.y += assetPositionOffset?.y ?? 0;
          flowHistory.record();
          const assetNode = insertImageAsAsset(imported.displayUrl, imported.origin, pos, {
            ratio: r, imageWidth: img.naturalWidth, imageHeight: img.naturalHeight,
          });
          if (assetNode) {
            flowState.addEdge(assetNode.id, targetNode.id);
            selection.select(assetNode.id);
            showToast('已创建素材节点并连接');
          }
          return;
        }
        // 自建图片节点：追加参考图（统一 resource-insert，不自动生成）
        attachImageToNode(imported.displayUrl, targetNode.id);
        return;
      }

      // 空白处：建素材节点（image-gen + isAsset:true，imageUrl=图本身；替代现状「refImages 生成节点」）
      const h = imageCardHeight(r);
      flowHistory.record();
      insertImageAsAsset(imported.displayUrl, imported.origin, { x: world.x - CARD_W / 2, y: world.y - h / 2 }, {
        ratio: r, imageWidth: img.naturalWidth, imageHeight: img.naturalHeight,
      });
      showToast('已创建素材节点');
        } catch {
          showToast('图片处理失败', false);
        } finally {
          resolve();
        }
      };
      img.onerror = () => {
        showToast('图片加载失败', false);
        resolve();
      };
      img.src = src;
    });
  }

  /** 手动导入图片走与生成结果相同的双轨：卡片展示缩略图，原图只保留本地路径供查看。 */
  private async _prepareImportedImage(src: string, filename: string): Promise<{ displayUrl: string; origin: ImageOrigin | null }> {
    try {
      const saved = await Backend.prepareImportedImage(src, filename);
      if (saved.status === 'success' && saved.thumbnail_data_url && saved.path) {
        return {
          displayUrl: saved.thumbnail_data_url,
          origin: { path: saved.path, url: saved.url },
        };
      }
    } catch {
      // 保存/生成缩略图失败时保留原有导入行为，不阻断用户继续放图。
    }
    return { displayUrl: src, origin: null };
  }

  /** 命中检测：返回 (x,y) 处最上层的节点 */
  private _nodeAt(screenX: number, screenY: number): FlowNode | null {
    const el = document.elementFromPoint(screenX, screenY) as HTMLElement | null;
    const cardEl = el?.closest('.pcard') as HTMLElement | null;
    if (!cardEl) return null;
    return flowState.getNode(cardEl.dataset.nodeId || '') ?? null;
  }

  /** 素材节点落位：目标卡左侧（上游位置，x 相隔一卡宽 + 间距；y 与目标卡垂直居中），避免覆盖目标卡 */
  private _assetPositionNear(target: FlowNode, r: number): { x: number; y: number } {
    const targetH = cardView.cardHeight(target);
    const assetH = imageCardHeight(r);
    return {
      x: target.x - CARD_W - 48,
      y: target.y + Math.round((targetH - assetH) / 2),
    };
  }

  // ───────────────────────── 文件选择选图 ─────────────────────────
  private _bindFileInput(): void {
    this.fileInput?.addEventListener('change', () => {
      const file = this.fileInput?.files?.[0];
      if (!file) { this.pendingFileNodeId = null; return; }
      const reader = new FileReader();
      reader.onload = (ev) => {
        const src = ev.target?.result as string;
        if (!src) { this.pendingFileNodeId = null; return; }
        const img = new Image();
        img.onload = async () => {
          if (this.pendingFileNodeId) {
            const nodeId = this.pendingFileNodeId;
            const target = flowState.getNode(nodeId);
            if (target) {
              const ratio = img.naturalWidth / img.naturalHeight;
              const r = ratio > 0 ? ratio : 4 / 3;
              const imported = await this._prepareImportedImage(src, file.name);
              // 素材节点不接收上游图
              if (flowState.isAssetNode(target)) {
                showToast('素材节点不能添加参考图', false);
                this.pendingFileNodeId = null;
                return;
              }
              // 文本节点：同拖图口径——自动建素材节点并连线（素材→文本 反推输入；素材放文本左侧）
              if (target.type === 'text-gen') {
                const pos = this._assetPositionNear(target, r);
                flowHistory.record();
                const assetNode = insertImageAsAsset(imported.displayUrl, imported.origin, pos, {
                  ratio: r, imageWidth: img.naturalWidth, imageHeight: img.naturalHeight,
                });
                if (assetNode) {
                  flowState.addEdge(assetNode.id, target.id);
                  selection.select(assetNode.id);
                  showToast('已创建素材节点并连接');
                }
                this.pendingFileNodeId = null;
                return;
              }
              // 自建图片节点：追加参考图（统一 resource-insert，不自动生成）
              attachImageToNode(imported.displayUrl, nodeId);
            }
          }
          this.pendingFileNodeId = null;
        };
        img.onerror = () => {
          showToast('图片加载失败', false);
          this.pendingFileNodeId = null;
        };
        img.src = src;
      };
      reader.readAsDataURL(file);
      this.fileInput!.value = '';
    });
  }

  // ───────────────────────── 右键菜单（A5：运行入口） ─────────────────────────
  private _bindContextMenu(): void {
    const wrap = this.wrap!;

    // 统一在 document 层处理：先隐藏旧菜单，再决定是否显示新菜单
    document.addEventListener('contextmenu', (e: MouseEvent) => {
      const target = e.target as Element;
      if (target.closest('.ctx-menu')) return; // 菜单内右键不干扰
      this._hideMenu();
      if (!wrap.contains(target)) return;      // 不在画布区域 → 交给浏览器原生菜单
      e.preventDefault();

      // 右键目标是连线（路径/中点 +/删除按钮）→ 连线菜单
      const edgeId = this._edgeIdFromTarget(target);
      if (edgeId) {
        const edge = flowState.edges.find(ed => ed.id === edgeId);
        if (edge) { this._showLinkMenu(e.clientX, e.clientY, edge); return; }
      }

      const cardEl = target.closest('.pcard') as HTMLElement | null;
      if (cardEl) {
        const node = flowState.getNode(cardEl.dataset.nodeId || '');
        if (node) this._showCardMenu(e.clientX, e.clientY, node);
      } else {
        this._showCanvasMenu(e.clientX, e.clientY);
      }
    });

    document.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as Element;
      if (target.closest('.ctx-menu')) return; // 菜单项点击由 onclick 处理
      // 屏蔽"菜单显示后 250ms 内的 click"：拖线/右键等交互 mousedown+mouseup 结束后，
      // 浏览器会补发一次 click（target 为共同祖先、不在菜单内），会立即误关刚弹出的菜单。
      // 防抖只屏蔽同一次交互派生的事件，不影响稍后正常的点外关闭。
      const menu = this._menuEl();
      const shownAt = Number(menu.dataset.shownAt || 0);
      if (Date.now() - shownAt < 250) return;
      this._hideMenu();
    });
  }

  /** 从右键目标解析连线 id（路径/中点 +/删除按钮均可） */
  private _edgeIdFromTarget(target: Element): string {
    if (target.closest('.link-path')) return (target.closest('.link-path') as HTMLElement).dataset.edgeId || '';
    if (target.closest('.link-plus')) return (target.closest('.link-plus') as HTMLElement).dataset.edgeId || '';
    if (target.closest('.link-del')) return (target.closest('.link-del') as HTMLElement).dataset.edgeId || '';
    return '';
  }

  private _showLinkMenu(x: number, y: number, edge: FlowEdge): void {
    const menu = this._menuEl();
    menu.innerHTML = `
      <div class="ctx-hint">连线操作</div>
      <div class="ctx-item" data-act="insert-step">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        插入步骤
      </div>
      <div class="ctx-sep"></div>
      <div class="ctx-item danger" data-act="delete-edge">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        删除连线
      </div>`;
    menu.dataset.nodeId = '';
    menu.dataset.edgeId = edge.id;
    this._showMenu(menu, x, y);
  }

  private _showCardMenu(x: number, y: number, node: FlowNode): void {
    const isAsset = flowState.isAssetNode(node); // 素材节点不显示「运行当前卡」「重新运行」（判分支 #6）
    // 继续创作守卫与操作条 / createContinueStep 共用同一函数（见 action-bar.ts）。
    const canContinue = canContinueFrom(node);
    const menu = this._menuEl();
    menu.innerHTML = `
      ${canContinue ? `
      <div class="ctx-item" data-act="continue">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        继续创作
      </div>` : ''}
      ${isAsset ? '' : `
      <div class="ctx-item" data-act="run">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l14 9-14 9V3Z"/></svg>
        运行当前卡
      </div>`}
      ${!isAsset && node.status === 'fail' ? `
      <div class="ctx-item" data-act="error">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>
        查看失败原因
      </div>` : ''}
      ${!isAsset && node.status === 'stale' ? `
      <div class="ctx-item" data-act="run">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z"/></svg>
        重新运行
      </div>` : ''}
      ${node.type === 'image-gen' && ((node.params as unknown as StyleTransferParams).mode !== 'outpaint') && (node.imageUrl || flowState.getReferenceImages(node.id).length > 0) ? `
      <div class="ctx-item" data-act="crop">裁剪图片</div>
      <div class="ctx-item" data-act="split">切图</div>
      <div class="ctx-item" data-act="expand">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
        创建扩图步骤
      </div>` : ''}
      ${node.type === 'image-gen' && (node.imageUrl || flowState.getReferenceImages(node.id).length > 0) ? `
      <div class="ctx-item" data-act="video">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="13" height="16" rx="2"/><path d="m16 10 5-3v10l-5-3z"/></svg>
        生成视频
      </div>` : ''}
      <div class="ctx-sep"></div>
      <div class="ctx-item danger" data-act="delete">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        删除节点
      </div>`;
    menu.dataset.nodeId = node.id;
    menu.dataset.edgeId = '';
    this._showMenu(menu, x, y);
  }

  private _showCanvasMenu(x: number, y: number): void {
    const candidates = this._newNodeCandidates();
    const menu = this._menuEl();
    menu.innerHTML = `
      <div class="ctx-hint">画布操作</div>
      ${candidates.map(d => `
      <div class="ctx-item" data-act="new-node" data-node-type="${d.type}">
        ${this._nodeTypeIcon(d.type)}
        新建${d.label}
      </div>`).join('')}
      <div class="ctx-sep"></div>
      <div class="ctx-item" data-act="run-selected">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l14 9-14 9V3Z"/></svg>
        运行选中 ${selection.size > 0 ? `(${selection.size})` : ''}
      </div>
      <div class="ctx-item" data-act="run-all">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l14 9-14 9V3Z"/><path d="M19 3v18"/></svg>
        运行全部
      </div>`;
    menu.dataset.nodeId = '';
    menu.dataset.edgeId = '';
    this._showMenu(menu, x, y);
  }

  private _menuEl(): HTMLElement {
    let menu = document.getElementById('ctx-menu') as HTMLElement | null;
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'ctx-menu';
      menu.className = 'ctx-menu';
      document.body.appendChild(menu);
    }
    return menu;
  }

  private _showMenu(menu: HTMLElement, x: number, y: number): void {
    menu.classList.add('show');
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    // 记录显示时间戳：屏蔽同一次拖线/右键交互派生 click 的误关（见 document click 关闭逻辑）
    menu.dataset.shownAt = String(Date.now());
    // 视口钳制
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth - 8) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
    if (rect.bottom > window.innerHeight - 8) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';

    menu.onclick = (e: MouseEvent) => {
      const item = (e.target as Element).closest('.ctx-item') as HTMLElement | null;
      if (!item) return;
      const act = item.dataset.act || '';
      const nodeId = menu.dataset.nodeId || '';
      // 新建节点菜单：把选中项的类型暂存到菜单 dataset，供 _handleMenuAction 使用
      if (item.dataset.nodeType) menu.dataset.newType = item.dataset.nodeType;
      this._handleMenuAction(act, nodeId);
      this._hideMenu();
    };
  }

  private _handleMenuAction(act: string, nodeId: string): void {
    switch (act) {
      case 'run': {
        const node = flowState.getNode(nodeId);
        if (node) {
          selection.select(nodeId);
          void runEngine.run(nodeId);
        }
        break;
      }
      case 'error': {
        const node = flowState.getNode(nodeId);
        if (node && node.error) showToast(node.error, false);
        break;
      }
      case 'expand': {
        const node = flowState.getNode(nodeId);
        if (node) void createOutpaintStep(node);
        break;
      }
      case 'crop': {
        const node = flowState.getNode(nodeId);
        if (node) void imageEditor.openCrop(node.id);
        break;
      }
      case 'split': {
        const node = flowState.getNode(nodeId);
        if (node) void imageEditor.openSplit(node.id);
        break;
      }
      case 'continue': {
        const node = flowState.getNode(nodeId);
        if (node) void createContinueStep(node);
        break;
      }
      case 'video': {
        const node = flowState.getNode(nodeId);
        if (node) void createVideoStep(node);
        break;
      }
      case 'delete': {
        flowHistory.record();
        runEngine.cancel(nodeId);
        flowState.removeNode(nodeId);
        selection.clear();
        break;
      }
      case 'insert-step': {
        const edgeId = this._menuEl().dataset.edgeId || '';
        flowHistory.record();
        const node = flowState.insertStep(edgeId);
        if (node) {
          dirty.markUpstreamChanged(node.id);
          selection.select(node.id);
          this._fillDefaultModelFor(node.id);
          showToast('已插入新步骤');
        } else {
          showToast('插入步骤失败', false);
        }
        break;
      }
      case 'delete-edge': {
        const edgeId = this._menuEl().dataset.edgeId || '';
        flowHistory.record();
        flowState.removeEdge(edgeId);
        showToast('连线已删除');
        break;
      }
      case 'new-node': {
        // 画布右键「新建」：按菜单选中类型创建（遍历 creatable candidates，自动含 text-gen）
        const menu = this._menuEl();
        const type = menu.dataset.newType || 'image-gen';
        const world = canvasView.toWorldCoords(window.innerWidth / 2, window.innerHeight / 2);
        const def = nodeRegistry.get(type as NodeType);
        const h = CARD_W / (def.defaultRatio > 0 ? def.defaultRatio : 4 / 3);
        flowHistory.record();
        const node = flowState.addNode(type as NodeType, world.x - CARD_W / 2, world.y - h / 2);
        selection.select(node.id);
        this._fillDefaultModelFor(node.id);
        break;
      }
      case 'create-node': {
        // 拖线松手弹菜单 → 建新节点并自动连上拖出的线
        const menu = this._menuEl();
        const type = menu.dataset.newType || '';
        const x = Number(menu.dataset.newX || 0);
        const y = Number(menu.dataset.newY || 0);
        if (type) this._createNodeFromMenu(type, nodeId, x, y);
        break;
      }
      case 'cancel-connect':
        // 取消拖线新建（仅关闭菜单，不建节点）
        break;
      case 'run-selected':
        void runEngine.runSelected();
        break;
      case 'run-all':
        void runEngine.runAll();
        break;
    }
  }

  private _hideMenu(): void {
    const menu = document.getElementById('ctx-menu');
    if (menu) menu.classList.remove('show');
  }
}

export const interactions = new Interactions();
