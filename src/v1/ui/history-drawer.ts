// src/v1/ui/history-drawer.ts
// 左侧悬浮历史图库抽屉 + 拖入手势（改造自 src/components/history-sidebar.ts）
// 增量（成图库收口）：
//   B1 成图/文本分区 tab（默认成图）；B5 搜索（prompt/model/tags 过滤成图，outputText 过滤文本）
//   B2/B3 采纳/锁定动作 + 角标（同一 AssetStore，X1 三处同步之一）；A6 图库卡片 hover「复现」
//   loadFromHistory 优先用 entry.imageUrl（新行），缺失回退按 nodeId 解析当前节点 imageUrl（旧行兼容，修信任层错位隐患）
// 生成图自动加入（addImage 带搜索元数据）；拖拽缩略图到画布触发 A4 语义（由 interactions 处理落点）。

import { flowState } from '../state/flow-state';
import { flowHistory } from '../state/history';
import { assetStore } from '../asset-store';
import { reproduceService } from '../reproduce';
import { showToast } from './toast';

/** 图库条目（image/text 分区展示） */
interface HistoryItem {
  src: string;
  timestamp: number;
  kind: 'image' | 'text';
  nodeId?: string;
  prompt?: string;
  model?: string;
  aspectRatio?: string;
  resolution?: string;
  count?: number;
  refImageUrls?: string[];
  refImageHashes?: string[];
  outputType?: string;
  text?: string; // 文本记录：无图，展示 outputText 片段
}

/** addImage 元数据（搜索 + 图库复现 + 角标用） */
export interface HistoryImageMeta {
  timestamp?: number;
  nodeId?: string;
  prompt?: string;
  model?: string;
  aspectRatio?: string;
  resolution?: string;
  count?: number;
  refImageUrls?: string[];
  refImageHashes?: string[];
  outputType?: string;
}

const ICON_CHECK = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const ICON_LOCK = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

class HistoryDrawer {
  private items: HistoryItem[] = [];
  private open = false;
  private drawer: HTMLElement | null = null;
  private grid: HTMLElement | null = null;
  private handle: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private emptyEl: HTMLElement | null = null;
  private tab: 'image' | 'text' = 'image';
  private query = '';
  private unsubscribeAsset: (() => void) | null = null;

  init(): void {
    this.drawer = document.getElementById('left-drawer');
    this.grid = document.getElementById('history-grid');
    this.handle = document.getElementById('drawer-handle');
    this.emptyEl = document.getElementById('history-empty');
    this.searchInput = document.getElementById('history-search') as HTMLInputElement | null;

    this.handle?.addEventListener('click', () => this.toggle());
    this.searchInput?.addEventListener('input', () => {
      this.query = (this.searchInput?.value || '').trim().toLowerCase();
      this.render();
    });

    // 分区 tab（B1：默认成图）
    const tabs = document.getElementById('history-tabs');
    tabs?.querySelectorAll('.history-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = ((btn as HTMLElement).dataset.tab) as 'image' | 'text' | undefined;
        if (!tab) return;
        this.setTab(tab);
      });
    });

    // 订阅 AssetStore：采纳/锁定变更 → 图库角标即时刷新（X1 三处同步之一）
    this.unsubscribeAsset = assetStore.subscribe(() => this.render());

    this.render();
  }

  /** 生成图自动入列（带搜索/复现元数据） */
  addImage(src: string, meta: HistoryImageMeta = {}): void {
    if (!src) return;
    this.items.unshift({
      src,
      timestamp: meta.timestamp ?? Date.now(),
      kind: 'image',
      nodeId: meta.nodeId,
      prompt: meta.prompt,
      model: meta.model,
      aspectRatio: meta.aspectRatio,
      resolution: meta.resolution,
      count: meta.count,
      refImageUrls: meta.refImageUrls,
      refImageHashes: meta.refImageHashes,
      outputType: meta.outputType,
    });
    this.render();
    if (!this.open) this.openDrawer(true);
  }

  /** 载入 history.jsonl（打开项目时调用）：image 行优先 entry.imageUrl（新行），缺失回退 nodeId 解析当前节点 imageUrl */
  loadFromHistory(entries: HistoryEntry[]): void {
    const resolved: HistoryItem[] = [];
    entries.forEach(e => {
      if (e.kind === 'image') {
        let src = typeof e.imageUrl === 'string' && e.imageUrl ? e.imageUrl : '';
        if (!src) {
          const node = flowState.getNode(e.nodeId);
          src = node && node.imageUrl ? node.imageUrl : '';
        }
        if (!src) return; // 无图（历史图已在后续会话被替换/删除）跳过
        resolved.push({
          src,
          timestamp: e.createdAt,
          kind: 'image',
          nodeId: e.nodeId,
          prompt: e.prompt,
          model: e.model,
          aspectRatio: e.aspectRatio,
          resolution: e.resolution,
          count: e.count,
          refImageUrls: Array.isArray(e.refImageUrls) ? e.refImageUrls : [],
          refImageHashes: Array.isArray(e.refImageHashes) ? e.refImageHashes : [],
          outputType: e.outputType,
        });
      } else {
        resolved.push({ src: '', timestamp: e.createdAt, kind: 'text', text: e.outputText || '' });
      }
    });
    // 保留本会话生成图；persisted 追加在后（文件为 append 顺序，反转为最新在前）
    this.items = [...this.items, ...resolved.reverse()];
    this.render();
  }

  setTab(tab: 'image' | 'text'): void {
    if (this.tab === tab) return;
    this.tab = tab;
    document.querySelectorAll('.history-tab').forEach(btn => {
      const el = btn as HTMLElement;
      el.classList.toggle('active', el.dataset.tab === tab);
    });
    this.render();
  }

  setQuery(q: string): void {
    this.query = (q || '').trim().toLowerCase();
    if (this.searchInput) this.searchInput.value = q;
    this.render();
  }

  toggle(): void {
    this.openDrawer(!this.open);
  }

  openDrawer(open: boolean): void {
    this.open = open;
    this.drawer?.classList.toggle('open', open);
  }

  /** 过滤 + 渲染（tab / 搜索 / 采纳锁定角标 / hover 动作） */
  private render(): void {
    this._syncTabCounts();
    if (!this.grid) return;
    const filtered = this._filtered();

    if (filtered.length === 0) {
      this.grid.innerHTML = '';
      if (this.emptyEl) {
        this.emptyEl.textContent = this.tab === 'image'
          ? (this.query ? '无匹配成图' : '暂无成图')
          : (this.query ? '无匹配文本' : '暂无文本记录');
        this.emptyEl.style.display = 'block';
      }
      return;
    }
    if (this.emptyEl) this.emptyEl.style.display = 'none';
    this.grid.innerHTML = '';

    filtered.forEach(item => {
      if (item.kind === 'text') {
        this._renderTextItem(item);
        return;
      }
      this._renderImageItem(item);
    });
  }

  /** B5/B6/B7：按 tab 过滤（image：prompt/model/tags；text：outputText） */
  private _filtered(): HistoryItem[] {
    const q = this.query;
    if (this.tab === 'text') {
      const list = this.items.filter(i => i.kind === 'text');
      if (!q) return list;
      return list.filter(i => (i.text || '').toLowerCase().includes(q));
    }
    const list = this.items.filter(i => i.kind === 'image');
    if (!q) return list;
    return list.filter(i => {
      if ((i.prompt || '').toLowerCase().includes(q)) return true;
      if ((i.model || '').toLowerCase().includes(q)) return true;
      // tags：命中当前图指纹记录的 tags（B6）
      const rec = i.src ? assetStore.getByImageUrl(i.src) : null;
      if (rec && rec.tags.some(t => t.toLowerCase().includes(q))) return true;
      return false;
    });
  }

  private _syncTabCounts(): void {
    const imageCount = this.items.filter(i => i.kind === 'image').length;
    const textCount = this.items.filter(i => i.kind === 'text').length;
    document.querySelectorAll('.history-tab').forEach(btn => {
      const el = btn as HTMLElement;
      const tab = el.dataset.tab;
      const countEl = el.querySelector('.history-tab-count') as HTMLElement | null;
      if (countEl) countEl.textContent = tab === 'image' ? ` (${imageCount})` : ` (${textCount})`;
    });
  }

  /** 文本记录缩略卡（不可拖为图片；B7 文本搜索命中后仍可展示） */
  private _renderTextItem(item: HistoryItem): void {
    if (!this.grid) return;
    const div = document.createElement('div');
    div.className = 'history-thumb history-text';
    div.textContent = item.text || '';
    div.title = new Date(item.timestamp).toLocaleString('zh-CN');
    this.grid.appendChild(div);
  }

  /** 成图卡：缩略图 + 采纳/锁定角标 + hover 动作（采纳/锁定/复现）+ 拖入手势 */
  private _renderImageItem(item: HistoryItem): void {
    if (!this.grid) return;
    const div = document.createElement('div');
    div.className = 'history-thumb';
    div.draggable = true;
    div.style.backgroundImage = `url('${item.src.replace(/'/g, "\\'")}')`;
    div.title = new Date(item.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

    const adopted = item.src ? assetStore.isAdoptedByImageUrl(item.src) : false;
    const locked = item.src ? assetStore.isLockedByImageUrl(item.src) : false;
    div.innerHTML = `
      <div class="ht-badges">
        ${adopted ? `<span class="ht-badge adopt" title="已采纳">${ICON_CHECK}</span>` : ''}
        ${locked ? `<span class="ht-badge lock" title="已锁定">${ICON_LOCK}</span>` : ''}
      </div>
      <div class="ht-actions">
        <button class="ht-act${adopted ? ' on' : ''}" data-act="adopt">${adopted ? '已采纳' : '采纳'}</button>
        <button class="ht-act${locked ? ' on' : ''}" data-act="lock">${locked ? '已锁定' : '锁定'}</button>
        <button class="ht-act" data-act="reproduce">复现</button>
      </div>`;

    // 拖入手势（A4 语义保留）
    div.addEventListener('dragstart', (e: DragEvent) => {
      e.dataTransfer!.setData('application/history-image', item.src);
      e.dataTransfer!.setData('text/plain', item.src);
      div.style.opacity = '0.6';
    });
    div.addEventListener('dragend', () => { div.style.opacity = ''; });

    // hover 动作：采纳/锁定（AssetStore 唯一写入口）/ 复现（A6）
    div.addEventListener('click', (e: MouseEvent) => {
      const btn = (e.target as Element).closest('.ht-act') as HTMLElement | null;
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const act = btn.dataset.act || '';
      if (act === 'adopt') {
        flowHistory.record(); // 用户手势入口：变更前入撤销栈（X3）
        if (assetStore.isAdoptedByImageUrl(item.src)) assetStore.unadoptByUrl(item.src);
        else assetStore.adoptByUrl(item.src, item.nodeId || '');
        showToast(assetStore.isAdoptedByImageUrl(item.src) ? '已采纳（自动锁定）' : '已取消采纳');
      } else if (act === 'lock') {
        flowHistory.record();
        assetStore.setLockedByUrl(item.src, item.nodeId || '', !assetStore.isLockedByImageUrl(item.src));
        showToast(assetStore.isLockedByImageUrl(item.src) ? '已锁定' : '已解锁');
      } else if (act === 'reproduce') {
        // A6：图库复现（trace 从 HistoryEntry 构造）
        void reproduceService.reproduceFromHistory(this._toEntry(item));
      }
    });

    this.grid.appendChild(div);
  }

  /** HistoryItem → HistoryEntry（图库复现用；会话内条目携带完整参数） */
  private _toEntry(item: HistoryItem): HistoryEntry {
    return {
      kind: 'image',
      nodeId: item.nodeId || '',
      imageUrl: item.src,
      prompt: item.prompt || '',
      model: item.model || '',
      aspectRatio: item.aspectRatio || '3:4',
      resolution: item.resolution || '2k',
      count: typeof item.count === 'number' ? item.count : 1,
      refImageHashes: Array.isArray(item.refImageHashes) ? item.refImageHashes : [],
      refImageUrls: Array.isArray(item.refImageUrls) ? item.refImageUrls : [],
      seed: null,
      createdAt: item.timestamp,
      parentId: null,
      outputType: (item.outputType === 'img2img' || item.outputType === 'outpaint' ? item.outputType : 'txt2img') as 'txt2img' | 'img2img' | 'outpaint',
    };
  }
}

export const historyDrawer = new HistoryDrawer();
