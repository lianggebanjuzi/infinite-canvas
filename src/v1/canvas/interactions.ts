// src/v1/canvas/interactions.ts
// 交互层：卡片拖拽移动 / 单选多选 / Shift 框选 / 组拖 / 空白平移 /
// 历史图库拖入（A4：拖到输入节点→替换；拖到空白→新建输入）/ 右键菜单 / 文件选图

import { flowState } from '../state/flow-state';
import { selection } from '../state/selection';
import { dirty } from '../state/dirty';
import { flowHistory } from '../state/history';
import { nodeRegistry } from '../nodes/node-registry';
import { canvasView, CARD_W } from './canvas-view';
import { cardView, openImageModal } from './card-view';
import { linkView } from './link-view';
import { runEngine } from '../engine/run-engine';
import { showToast } from '../ui/toast';
import { resolveDefaultModel, resolveDefaultChatModel } from '../api';

const DRAG_THRESHOLD = 3;

type DragMode = 'node' | 'pan' | 'select' | 'connect';

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
      if (target.closest('.ctx-menu') || target.closest('.cmd-panel') || target.closest('.action-bar') || target.closest('.link-plus') || target.closest('.link-del') || target.closest('.overlay')) {
        return;
      }

      // 中键：画布平移（preventDefault 避免浏览器 autoscroll 图标；不改动选中态）
      if (e.button === 1) {
        e.preventDefault();
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
      // 有图 → 查看大图；空图片卡（无输出图且无参考图，非文本卡）双击 → 弹文件选择器加载参考图
      if (node.imageUrl) { openImageModal(node.imageUrl); return; }
      if (node.type !== 'text-gen' && (!node.refImages || node.refImages.length === 0)) {
        this.openFilePickerForRef(node.id);
      }
    });
  }

  private _onCardMouseDown(e: MouseEvent, cardEl: HTMLElement): void {
    e.stopPropagation();
    if ((e.target as Element).closest('.pcard-act') || (e.target as Element).closest('.port')) return;
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
    };
    // 拖动起始快照（单节点用，避免累计漂移）
    this._dragSnapshots.set(nodeId, { x: node.x, y: node.y });
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

    cardView.renderAll();
    linkView.renderAll();
  }

  private _onMouseUp(e: MouseEvent): void {
    const d = this.drag;
    if (!d) return;

    if (d.mode === 'node') {
      this._lastNodeDragMoved = d.moved; // 记录本次按下-松开是否发生位移（拖动守卫：供 click 处理器排除拖拽后的误入编辑）
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
    };
    portEl.classList.add('dragging');
    linkView.startTempLine(nodeId);
  }

  private _updateDroppable(e: MouseEvent): void {
    this._clearDroppable();
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
        else showToast('已创建连线');
      }
      return;
    }

    // 松手在空白/非法位置 → 弹出「新建节点」菜单（可作下游类型，过滤产品图）
    this._showNewNodeMenu(e.clientX, e.clientY, fromId);
  }

  // ───────────────────────── 拖线松手 → 新建节点菜单（P0） ─────────────────────────

  /** 可作下游的节点类型（统一生成节点：仅 image-gen 一项；text-gen 不作为连线接收端，由菜单过滤） */
  private _newNodeCandidates(): NodeDefinition[] {
    return nodeRegistry.list().filter(d => d.creatable !== false);
  }

  /** 松手处弹「新建节点」菜单：选择类型 → 建节点并自动连上拖出的线 */
  private _showNewNodeMenu(screenX: number, screenY: number, fromId: string): void {
    // 过滤不可作 fromId 下游的类型：text-gen 永远不能作为连线接收端（canConnect 拒绝 to=text-gen），
    // 列入候选会静默创建未连接节点；空白处右键新建（_showCanvasMenu）不受影响，仍可建独立 text-gen。
    const candidates = this._newNodeCandidates().filter(d => d.type !== 'text-gen');
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
    const h = CARD_W / (def.defaultRatio > 0 ? def.defaultRatio : 3 / 4);
    flowHistory.record();
    const node = flowState.addNode(type as NodeType, world.x - CARD_W / 2, world.y - h / 2);
    selection.select(node.id);
    if (fromId && flowState.canConnect(fromId, node.id) === null) {
      flowState.addEdge(fromId, node.id);
      showToast(`已新建「${def.label}」并连接`);
    }
    this._fillDefaultModelFor(node.id);
  }

  /** 新节点默认模型回填（类型感知：text-gen → chat 默认模型，其余 → 绘图默认模型） */
  private _fillDefaultModelFor(nodeId: string): void {
    const node = flowState.getNode(nodeId);
    if (!node) return;
    const resolver = node.type === 'text-gen' ? resolveDefaultChatModel : resolveDefaultModel;
    void resolver().then(model => {
      const cur = flowState.getNode(nodeId);
      if (model && cur && !(cur.params.model as string | undefined)) {
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
        this._dropImage(historySrc, world, e.clientX, e.clientY);
        return;
      }
      if (files.length > 0) {
        const file = files.find(f => f.type.startsWith('image/'));
        if (file) {
          const reader = new FileReader();
          reader.onload = (ev) => {
            const src = ev.target?.result as string;
            if (src) this._dropImage(src, world, e.clientX, e.clientY, file.name);
          };
          reader.readAsDataURL(file);
        }
      }
    });
  }

  /** 拖图进画布：命中节点 → 追加参考图；空白处 → 新建「生成节点」（refImages=[src]） */
  private _dropImage(src: string, world: { x: number; y: number }, screenX: number, screenY: number, _fileName?: string): void {
    const targetNode = this._nodeAt(screenX, screenY);
    const img = new Image();
    img.onload = () => {
      const ratio = img.naturalWidth / img.naturalHeight;
      const r = ratio > 0 ? ratio : 3 / 4;

      if (targetNode) {
        // 文本节点不接收图片：拒绝挂载参考图
        if (targetNode.type === 'text-gen') {
          showToast('文本节点不接收图片', false);
          return;
        }
        flowHistory.record();
        flowState.addRefImage(targetNode.id, src);
        dirty.markStale(targetNode.id);
        showToast('已添加参考图');
        return;
      }

      // 空白处：新建统一生成节点，图片作为参考图（不再是输出图）
      const h = CARD_W / r;
      flowHistory.record();
      const node = flowState.addNode('image-gen', world.x - CARD_W / 2, world.y - h / 2, {
        refImages: [src],
        ratio: r,
      });
      selection.select(node.id);
      this._fillDefaultModelFor(node.id);
      showToast('已新建生成节点');
    };
    img.onerror = () => showToast('图片加载失败', false);
    img.src = src;
  }

  /** 命中检测：返回 (x,y) 处最上层的节点 */
  private _nodeAt(screenX: number, screenY: number): FlowNode | null {
    const el = document.elementFromPoint(screenX, screenY) as HTMLElement | null;
    const cardEl = el?.closest('.pcard') as HTMLElement | null;
    if (!cardEl) return null;
    return flowState.getNode(cardEl.dataset.nodeId || '') ?? null;
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
        img.onload = () => {
          if (this.pendingFileNodeId) {
            const nodeId = this.pendingFileNodeId;
            const target = flowState.getNode(nodeId);
            // 文本节点不接收图片：拒绝选图挂载
            if (target && target.type === 'text-gen') {
              showToast('文本节点不接收图片', false);
              this.pendingFileNodeId = null;
              return;
            }
            flowHistory.record();
            flowState.addRefImage(nodeId, src);
            dirty.markStale(nodeId);
            showToast('已添加参考图');
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
    const menu = this._menuEl();
    menu.innerHTML = `
      <div class="ctx-item" data-act="run">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l14 9-14 9V3Z"/></svg>
        运行当前卡
      </div>
      ${node.status === 'fail' ? `
      <div class="ctx-item" data-act="error">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>
        查看失败原因
      </div>` : ''}
      ${node.status === 'stale' ? `
      <div class="ctx-item" data-act="run">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z"/></svg>
        重新运行
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
      case 'delete': {
        flowHistory.record();
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
        const h = CARD_W / (def.defaultRatio > 0 ? def.defaultRatio : 3 / 4);
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
