// src/v1/canvas/interactions.ts
// 交互层：卡片拖拽移动 / 单选多选 / Shift 框选 / 组拖 / 空白平移 /
// 历史图库拖入（A4：拖到输入节点→替换；拖到空白→新建输入）/ 右键菜单 / 文件选图

import { flowState } from '../state/flow-state';
import { selection } from '../state/selection';
import { dirty } from '../state/dirty';
import { canvasView, CARD_W } from './canvas-view';
import { cardView, openImageModal } from './card-view';
import { linkView } from './link-view';
import { runEngine } from '../engine/run-engine';
import { showToast } from '../ui/toast';
import { resolveDefaultModel } from '../api';

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
      if (e.button !== 0) return;
      const target = e.target as Element;

      if (target.closest('.ctx-menu') || target.closest('.cmd-panel') || target.closest('.action-bar') || target.closest('.link-plus') || target.closest('.link-del') || target.closest('.overlay')) {
        return;
      }

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

      // 空白处：Shift 框选 / 否则清空选中 + 平移
      if (e.shiftKey) {
        this._startFrameSelect(e);
        return;
      }
      selection.clear();
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
    });

    window.addEventListener('mousemove', (e: MouseEvent) => this._onMouseMove(e));
    window.addEventListener('mouseup', (e: MouseEvent) => this._onMouseUp(e));
    window.addEventListener('dblclick', (e: MouseEvent) => {
      const cardEl = (e.target as Element).closest('.pcard') as HTMLElement | null;
      if (!cardEl) return;
      const node = flowState.getNode(cardEl.dataset.nodeId || '');
      if (node && node.imageUrl) openImageModal(node.imageUrl);
    });
  }

  private _onCardMouseDown(e: MouseEvent, cardEl: HTMLElement): void {
    e.stopPropagation();
    if ((e.target as Element).closest('.pcard-act') || (e.target as Element).closest('.port')) return;

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
      if (!d.moved) {
        // 单击：空产品图卡片 → 打开文件选择
        if (d.nodeId) {
          const n = flowState.getNode(d.nodeId);
          if (n && n.type === 'product-image' && !n.imageUrl) {
            this.pendingFileNodeId = n.id;
            this.fileInput?.click();
          }
        }
      } else {
        flowState.updatedAt = Date.now();
        flowState.dirty = true;
        flowState.notify();
      }
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

    // 松手点必须是另一张卡的 in 端口，否则取消
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const inPort = el?.closest('.port.in') as HTMLElement | null;
    if (!inPort) return;
    const toCard = inPort.closest('.pcard') as HTMLElement | null;
    const toId = toCard?.dataset.nodeId;
    if (!toId) return;

    const res = flowState.connect(fromId, toId);
    if (!res.ok) showToast(res.error || '连线失败', false);
    else showToast('已创建连线');
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

  /** A4：拖到输入节点上→替换；拖到空白处→新建输入节点（自动接孤儿换风格节点） */
  private _dropImage(src: string, world: { x: number; y: number }, screenX: number, screenY: number, fileName?: string): void {
    const targetNode = this._nodeAt(screenX, screenY);
    const img = new Image();
    img.onload = () => {
      const ratio = img.naturalHeight / img.naturalWidth;

      if (targetNode && targetNode.type === 'product-image') {
        flowState.setNodeImage(targetNode.id, src, ratio);
        flowState.updateNode(targetNode.id, { status: 'done', error: null, lastRunAt: Date.now() });
        if (fileName) flowState.updateNodeParams(targetNode.id, { fileName });
        dirty.markUpstreamChanged(targetNode.id); // 下游 stale
        showToast('已替换产品图');
        return;
      }

      // 新建输入节点
      const node = flowState.addNode('product-image', world.x - CARD_W / 2, world.y - 40, {
        imageUrl: src,
        ratio,
        status: 'done',
        lastRunAt: Date.now(),
        params: fileName ? { fileName } : {},
      });
      if (fileName) flowState.updateNodeParams(node.id, { fileName });
      selection.select(node.id);
      // 若存在没有产品图上游的换风格节点 → 自动接入
      const orphanStyle = flowState.nodes.find(n => n.type === 'style-transfer' && !flowState.getUpstreams(n.id).some(u => u.type === 'product-image'));
      if (orphanStyle) {
        flowState.addEdge(node.id, orphanStyle.id);
        dirty.markUpstreamChanged(node.id);
        showToast('已新建输入节点并连接');
      } else {
        showToast('已新建输入节点');
      }
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
          const ratio = img.naturalHeight / img.naturalWidth;
          if (this.pendingFileNodeId) {
            const nodeId = this.pendingFileNodeId;
            flowState.setNodeImage(nodeId, src, ratio);
            flowState.updateNode(nodeId, { status: 'done', error: null, lastRunAt: Date.now() });
            flowState.updateNodeParams(nodeId, { fileName: file.name });
            dirty.markUpstreamChanged(nodeId);
            showToast('已选择产品图');
          }
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
    const menu = this._menuEl();
    menu.innerHTML = `
      <div class="ctx-hint">画布操作</div>
      <div class="ctx-item" data-act="new-product">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
        新建输入节点
      </div>
      <div class="ctx-item" data-act="new-style">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2a10 10 0 0 0 0 20 2.5 2.5 0 0 0 2.5-2.5c0-.6-.24-1.2-.7-1.6-.4-.5-.7-1-.7-1.6A2.5 2.5 0 0 1 15.6 14H19a3 3 0 0 0 3-3c0-5-4.6-9-10-9Z"/></svg>
        新建换风格节点
      </div>
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
    // 视口钳制
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth - 8) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
    if (rect.bottom > window.innerHeight - 8) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';

    menu.onclick = (e: MouseEvent) => {
      const item = (e.target as Element).closest('.ctx-item') as HTMLElement | null;
      if (!item) return;
      const act = item.dataset.act || '';
      const nodeId = menu.dataset.nodeId || '';
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
        flowState.removeNode(nodeId);
        selection.clear();
        break;
      }
      case 'insert-step': {
        const edgeId = this._menuEl().dataset.edgeId || '';
        const node = flowState.insertStep(edgeId);
        if (node) {
          dirty.markUpstreamChanged(node.id);
          selection.select(node.id);
          showToast('已插入新步骤');
        } else {
          showToast('插入步骤失败', false);
        }
        break;
      }
      case 'delete-edge': {
        const edgeId = this._menuEl().dataset.edgeId || '';
        flowState.removeEdge(edgeId);
        showToast('连线已删除');
        break;
      }
      case 'new-product': {
        const world = canvasView.toWorldCoords(window.innerWidth / 2, window.innerHeight / 2);
        const node = flowState.addNode('product-image', world.x - CARD_W / 2, world.y - 100);
        selection.select(node.id);
        this.pendingFileNodeId = node.id;
        this.fileInput?.click();
        break;
      }
      case 'new-style': {
        const world = canvasView.toWorldCoords(window.innerWidth / 2, window.innerHeight / 2);
        const node = flowState.addNode('style-transfer', world.x - CARD_W / 2 + 40, world.y - 100);
        selection.select(node.id);
        // 自动接第一个产品图节点（若有）
        const product = flowState.nodes.find(n => n.type === 'product-image');
        if (product) flowState.addEdge(product.id, node.id);
        // 回填默认模型
        void resolveDefaultModel().then(model => {
          if (model && !(flowState.getNode(node.id)?.params.model)) {
            flowState.updateNodeParams(node.id, { model });
          }
        });
        break;
      }
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
