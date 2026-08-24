// src/v1/ui/compare-panel.ts
// 对比面板（C1-C6）：多选成图 → 底部「对比(n)」→ 模态浮层并排对比（2/4/8 宫格）。
// 每格：大图 + prompt 摘要 + 模型/比例/分辨率 + 添加到资产库。
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

    // 订阅 AssetStore：面板内添加后即时刷新。
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
    const added = assetStore.isAddedByImageUrl(url);
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
        <button class="compare-act add${added ? ' on' : ''}" data-url="${escapeAttr(url)}" data-node="${node.id}" ${added ? 'disabled' : ''}>${added ? '已添加' : '添加到资产库'}</button>
      </div>`;

    const addBtn = cell.querySelector('.add') as HTMLElement | null;
    addBtn?.addEventListener('click', () => this._addToAssetLibrary(url, node.id));
    return cell;
  }

  /** 格内添加：展示图 URL、原图引用和配方一并写入资产记录。 */
  private _addToAssetLibrary(url: string, nodeId: string): void {
    if (assetStore.isAddedByImageUrl(url)) return;
    flowHistory.record();
    const node = flowState.getNode(nodeId);
    assetStore.addByUrl(url, nodeId, assetStore.metaFromNode(node), node?.imageOrigin?.path);
    showToast('已添加到资产库');
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
