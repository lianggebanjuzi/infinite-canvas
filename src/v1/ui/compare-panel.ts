// src/v1/ui/compare-panel.ts
// 对比面板（C1-C6）：多选成图 → 底部「对比(n)」→ 模态浮层并排对比（2/4/8 宫格）。
// 每格：大图 + prompt 摘要 + 模型/比例/分辨率 + 采纳/锁定（同一 AssetStore，X1 三处同步之一）。
// C4 不污染主链：面板为纯评估瞬时态——关闭仅清瞬时态，不删节点、不改连线、不标 stale、不自动入库。
// 面板挂 .overlay 类 → interactions.ts 已把 .overlay 排除在画布交互外，天然防冲突。

import { flowState } from '../state/flow-state';
import { flowHistory } from '../state/history';
import { assetStore } from '../asset-store';
import { showToast } from './toast';

class ComparePanel {
  private state: ComparePanelState = { open: false, nodeIds: [], grid: 2 };
  private overlay: HTMLElement | null = null;
  private gridEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private unsubscribeAsset: (() => void) | null = null;

  init(): void {
    this.overlay = document.getElementById('compare-overlay');
    if (!this.overlay) return;
    this.gridEl = document.getElementById('compare-grid');
    this.countEl = document.getElementById('compare-count');

    document.getElementById('compare-close')?.addEventListener('click', () => this.close());
    this.overlay.addEventListener('click', (e: MouseEvent) => {
      if (e.target === this.overlay) this.close();
    });

    // 宫格切换（C5 P1：2/4/8）
    this.overlay.querySelectorAll('.compare-grid-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = Number((btn as HTMLElement).dataset.grid) as 2 | 4 | 8;
        if (mode === 2 || mode === 4 || mode === 8) this.setGrid(mode);
      });
    });

    // 订阅 AssetStore：面板内采纳/锁定 → 格内角标即时刷新（X1）
    this.unsubscribeAsset = assetStore.subscribe(() => {
      if (this.state.open) this._render();
    });
  }

  /** 打开对比面板（底部「对比(n)」入口；C1：n = 可对比数，文本不计入，n<2 禁用由 bottom-bar 处理） */
  open(nodeIds: string[]): void {
    const nodes = this._comparableNodes(nodeIds);
    if (nodes.length < 2) {
      showToast('请至少选择 2 张成图进行对比', false);
      return;
    }
    this.state = {
      open: true,
      nodeIds: nodes.map(n => n.id),
      grid: nodes.length <= 2 ? 2 : (nodes.length <= 4 ? 4 : 8),
    };
    this.overlay?.classList.add('show');
    this._syncGridButtons();
    this._render();
  }

  /** 关闭：仅清瞬时态，不删节点/不改连线/不标 stale/不自动入库（C4） */
  close(): void {
    this.overlay?.classList.remove('show');
    this.state = { open: false, nodeIds: [], grid: 2 };
  }

  /** 宫格切换（C5 P1） */
  setGrid(mode: 2 | 4 | 8): void {
    if (!this.state.open) return;
    this.state.grid = mode;
    this._syncGridButtons();
    this._render();
  }

  /** 可对比节点：image-gen 且 imageUrl 非空（Q4 拍板：本期仅画布选中节点；文本节点不计入） */
  private _comparableNodes(ids: string[]): FlowNode[] {
    return ids
      .map(id => flowState.getNode(id))
      .filter((n): n is FlowNode => !!n && n.type === 'image-gen' && !!n.imageUrl);
  }

  private _render(): void {
    if (!this.gridEl) return;
    const nodes = this._comparableNodes(this.state.nodeIds);
    if (this.countEl) this.countEl.textContent = `(${nodes.length})`;
    this.gridEl.innerHTML = '';
    this.gridEl.className = `compare-grid grid-${this.state.grid}`;

    // 最多铺满当前宫格数；超出部分不渲染（可切换更高宫格查看全部）
    nodes.slice(0, this.state.grid).forEach(node => {
      this.gridEl!.appendChild(this._buildCell(node));
    });

    // 空余格位：8 宫格不满 8 张时补空占位，保持网格对齐
    const filled = Math.min(nodes.length, this.state.grid);
    for (let i = filled; i < this.state.grid; i++) {
      const empty = document.createElement('div');
      empty.className = 'compare-cell empty';
      this.gridEl.appendChild(empty);
    }
  }

  private _buildCell(node: FlowNode): HTMLElement {
    const url = node.imageUrl as string;
    const p = node.params as unknown as StyleTransferParams;
    const adopted = assetStore.isAdoptedByImageUrl(url);
    const locked = assetStore.isLockedByImageUrl(url);
    const prompt = (p.prompt || '').trim();

    const cell = document.createElement('div');
    cell.className = 'compare-cell';
    cell.innerHTML = `
      <div class="compare-cell-img" style="background-image:url('${url.replace(/'/g, "\\'")}')"></div>
      <div class="compare-cell-meta">
        <div class="compare-cell-prompt" title="${escapeHtml(prompt)}">${escapeHtml(prompt || '无提示词')}</div>
        <div class="compare-cell-params">${escapeHtml(p.aspectRatio || '3:4')} · ${escapeHtml((p.resolution || '2k').toUpperCase())} · ${escapeHtml(this._modelName(p.model || ''))}</div>
      </div>
      <div class="compare-cell-actions">
        <button class="compare-act adopt${adopted ? ' on' : ''}" data-url="${escapeAttr(url)}" data-node="${node.id}">${adopted ? '已采纳' : '采纳'}</button>
        <button class="compare-act lock${locked ? ' on' : ''}" data-url="${escapeAttr(url)}" data-node="${node.id}">${locked ? '已锁定' : '锁定'}</button>
      </div>`;

    const adoptBtn = cell.querySelector('.adopt') as HTMLElement | null;
    const lockBtn = cell.querySelector('.lock') as HTMLElement | null;
    adoptBtn?.addEventListener('click', () => this._cellAdopt(url, node.id));
    lockBtn?.addEventListener('click', () => this._cellLock(url, node.id));
    return cell;
  }

  /** 格内采纳（C3：面板内采纳写入同一 AssetStore；X1 三处同步；采纳自动锁定） */
  private _cellAdopt(url: string, nodeId: string): void {
    flowHistory.record(); // 面板内采纳入撤销栈（X3）
    if (assetStore.isAdoptedByImageUrl(url)) {
      assetStore.unadoptByUrl(url);
      showToast('已取消采纳');
    } else {
      // 采纳：展示图 URL + 原图引用一并写入资产记录（查看大图按需加载用）；
      // R2：传 metaFromNode(node)（trace 优先 / params 兜底）→ 配方随记录落盘 assets.json（修复跨项目复现空白）
      const node = flowState.getNode(nodeId);
      assetStore.adoptByUrl(url, nodeId, assetStore.metaFromNode(node), node?.imageOrigin?.path);
      showToast('已采纳（自动锁定）');
    }
  }

  /** 格内锁定/解锁（C6 P1：复用图库锁定语义，同一数据源） */
  private _cellLock(url: string, nodeId: string): void {
    flowHistory.record();
    const node = flowState.getNode(nodeId);
    assetStore.setLockedByUrl(url, nodeId, !assetStore.isLockedByImageUrl(url), node?.imageOrigin?.path);
    showToast(assetStore.isLockedByImageUrl(url) ? '已锁定' : '已解锁');
  }

  private _syncGridButtons(): void {
    this.overlay?.querySelectorAll('.compare-grid-btn').forEach(btn => {
      const el = btn as HTMLElement;
      el.classList.toggle('active', Number(el.dataset.grid) === this.state.grid);
    });
  }

  private _modelName(modelId: string): string {
    return modelId.split(':').pop() || modelId || '未选择';
  }
}

/** HTML 转义（prompt/模型名展示用，防注入） */
function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 属性值转义（data-url 内嵌 dataURL 用） */
function escapeAttr(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const comparePanel = new ComparePanel();
