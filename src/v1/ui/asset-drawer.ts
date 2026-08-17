// src/v1/ui/asset-drawer.ts
// 资产库抽屉（incremental-3，S3-S9）：只显示 AssetStore 中 adopted=true 的图（按 updatedAt 倒序）。
// 数据源 = assetStore.getAdoptedAssets()；订阅 assetStore 即时刷新（X1 四处同步之一，S7）。
// 卡片动作：取消采纳（X3 变更前 flowHistory.record()）/ 锁定·解锁 / 查看大图（复用 #img-modal）/
//           拖入画布（复用 application/history-image 拖拽语义）/ 复现（S9 P1：meta 内存缓存优先，
//           缺失时经 historyDrawer.getEntryByImageUrl 反查 HistoryEntry 构造）。
// 搜索（S8 P1）：按 prompt / model / tags 过滤；空态/无匹配文案见共享知识 3（人话常量）。
// 抽屉互斥（S5）：setMutex 由 main.ts 编排，不内部 import 历史图库单例做关闭（避免循环依赖）；
//           对 historyDrawer 仅单向依赖 getEntryByImageUrl（复现反查，类图明示）。

import { flowHistory } from '../state/history';
import { assetStore } from '../asset-store';
import { reproduceService } from '../reproduce';
import { historyDrawer } from './history-drawer';
import { openImageModal } from '../canvas/card-view';
import { showToast } from './toast';

const ICON_CHECK = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const ICON_LOCK = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

/** 空态文案（共享知识 3：人话常量，禁止改字面量） */
const EMPTY_TEXT = '还没有采纳的图。在画布或对比面板采纳满意的成图后，会出现在这里。';
/** 搜索无结果文案（共享知识 3） */
const NO_MATCH_TEXT = '无匹配资产';

class AssetDrawer {
  private open = false;
  private query = '';
  private drawer: HTMLElement | null = null;
  private grid: HTMLElement | null = null;
  private handle: HTMLElement | null = null;
  private emptyEl: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private countEl: HTMLElement | null = null;
  private unsubscribeAsset: (() => void) | null = null;
  private mutex: (() => void) | null = null;
  /** 渲染批次序号：分批渲染在途期间若发起新渲染，旧批次据序号作废（防重复插入） */
  private renderSeq = 0;

  init(): void {
    this.drawer = document.getElementById('asset-drawer');
    this.grid = document.getElementById('asset-grid');
    this.handle = document.getElementById('asset-handle');
    this.emptyEl = document.getElementById('asset-empty');
    this.searchInput = document.getElementById('asset-search') as HTMLInputElement | null;
    this.countEl = document.getElementById('asset-count');

    this.handle?.addEventListener('click', () => this.toggle());
    this.searchInput?.addEventListener('input', () => {
      this.query = (this.searchInput?.value || '').trim().toLowerCase();
      this.render();
    });

    // 订阅 AssetStore：任一采纳/锁定变更 → 资产库即时刷新（X1，S7：资产库与画布/历史/对比四处同步）
    this.unsubscribeAsset = assetStore.subscribe(() => this.render());

    this.render();
  }

  /** 注入互斥回调（main.ts 编排：打开本抽屉时自动收起历史图库） */
  setMutex(fn: () => void): void {
    this.mutex = fn;
  }

  toggle(): void {
    this.openDrawer(!this.open);
  }

  openDrawer(open: boolean): void {
    if (open && this.mutex) this.mutex(); // 互斥：开一个自动收起另一个（S5）
    this.open = open;
    this.drawer?.classList.toggle('open', open);
  }

  close(): void {
    this.openDrawer(false);
  }

  /** 渲染：计数 / 空态 / 无匹配 / 卡片（S3/S6/S8；分批插入，避免大量大图一次阻塞 JS 主线程） */
  private render(): void {
    if (!this.grid) return;
    const all = assetStore.getAdoptedAssets();
    if (this.countEl) this.countEl.textContent = `(${all.length})`;

    const filtered = this._filtered(all);
    if (filtered.length === 0) {
      this.renderSeq++; // 作废在途分批渲染
      this.grid.innerHTML = '';
      if (this.emptyEl) {
        this.emptyEl.textContent = this.query ? NO_MATCH_TEXT : EMPTY_TEXT;
        this.emptyEl.style.display = 'block';
      }
      return;
    }
    if (this.emptyEl) this.emptyEl.style.display = 'none';
    this.renderSeq++;
    const seq = this.renderSeq;
    this.grid.innerHTML = '';
    this._renderBatch(filtered, 0, seq);
  }

  /** 分批渲染：每批 BATCH 项，requestIdleCallback 空闲时续批；seq 失配即被新渲染取代 */
  private _renderBatch(items: AssetAsset[], index: number, seq: number): void {
    if (seq !== this.renderSeq || !this.grid) return;
    const BATCH = 12;
    const end = Math.min(index + BATCH, items.length);
    for (let i = index; i < end; i++) {
      this._renderCard(items[i]);
    }
    if (end < items.length) {
      this._scheduleIdle(() => this._renderBatch(items, end, seq));
    }
  }

  private _scheduleIdle(fn: () => void): void {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => fn(), { timeout: 50 });
    } else {
      setTimeout(fn, 16);
    }
  }

  /** S8：按 prompt / model / tags 过滤已采纳图 */
  private _filtered(all: AssetAsset[]): AssetAsset[] {
    const q = this.query;
    if (!q) return all;
    return all.filter(item => {
      const entry = this._toEntry(item);
      if ((entry.prompt || '').toLowerCase().includes(q)) return true;
      if ((entry.model || '').toLowerCase().includes(q)) return true;
      if (item.record.tags.some(t => t.toLowerCase().includes(q))) return true;
      return false;
    });
  }

  /** 卡片：缩略图 / 采纳+锁定角标 / hover 动作（取消采纳·锁定·查看·复现）/ 拖入手势（S4） */
  private _renderCard(item: AssetAsset): void {
    if (!this.grid) return;
    const div = document.createElement('div');
    div.className = 'history-thumb asset-thumb';
    // 图片性能优化：卡片主视觉 = 缩略图（thumbnailUrl 优先，旧记录回退 url 原 base64）
    const thumbUrl = item.thumbnailUrl || item.url;
    const hasUrl = !!thumbUrl;
    if (hasUrl) {
      div.draggable = true;
      div.style.backgroundImage = `url('${thumbUrl.replace(/'/g, "\\'")}')`;
    } else {
      // 旧记录无 imageUrl（incremental-2 写入）：图源缺失占位卡（可取消采纳/锁定，无缩略图、无可拖 URL）
      div.classList.add('asset-missing');
    }
    div.title = new Date(item.record.updatedAt).toLocaleString('zh-CN');
    const locked = item.record.locked;
    div.innerHTML = `
      <div class="ht-badges">
        <span class="ht-badge adopt" title="已采纳">${ICON_CHECK}</span>
        ${locked ? `<span class="ht-badge lock" title="已锁定">${ICON_LOCK}</span>` : ''}
      </div>
      ${hasUrl ? '' : '<div class="asset-placeholder">图源缺失</div>'}
      <div class="ht-actions asset-actions">
        <button class="ht-act" data-act="unadopt">取消采纳</button>
        <button class="ht-act${locked ? ' on' : ''}" data-act="lock">${locked ? '已锁定' : '锁定'}</button>
        <button class="ht-act" data-act="view">查看</button>
        <button class="ht-act" data-act="reproduce">复现</button>
      </div>`;

    // 拖入手势（复用 history-image 拖拽语义；拖入画布传递缩略图 data URL，构图参考足够；无 URL 的占位卡不可拖）
    if (hasUrl) {
      div.addEventListener('dragstart', (e: DragEvent) => {
        e.dataTransfer!.setData('application/history-image', thumbUrl);
        e.dataTransfer!.setData('text/plain', thumbUrl);
        div.style.opacity = '0.6';
      });
      div.addEventListener('dragend', () => { div.style.opacity = ''; });
    }

    // hover 动作（AssetStore 唯一写入口；X3 用户手势变更前 record）
    div.addEventListener('click', (e: MouseEvent) => {
      const btn = (e.target as Element).closest('.ht-act') as HTMLElement | null;
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const act = btn.dataset.act || '';
      if (act === 'unadopt') {
        flowHistory.record(); // X3：资产库取消采纳入撤销栈
        assetStore.unadopt(item.record.key);
        showToast('已取消采纳');
      } else if (act === 'lock') {
        flowHistory.record(); // X3：锁定变更入撤销栈
        const nextLocked = !item.record.locked;
        assetStore.setLocked(item.record.key, item.record.nodeId, nextLocked);
        showToast(nextLocked ? '已锁定' : '已解锁');
      } else if (act === 'view') {
        // 查看大图：缩略图先显示 + 按需加载原图（有 originalPath 时桥接取原图，失败回退缩略图）
        if (hasUrl) this._viewImage(thumbUrl, item);
      } else if (act === 'reproduce') {
        // S9：复现（meta 优先；缺失时 _toEntry 内部经 historyDrawer 反查）
        void reproduceService.reproduceFromHistory(this._toEntry(item));
      }
    });

    this.grid.appendChild(div);
  }

  /** 查看大图（复用 #img-modal；origin.path = 原图本地路径，按需加载） */
  private _viewImage(url: string, item: AssetAsset): void {
    if (!url) return;
    void openImageModal(url, item.originalPath ? { path: item.originalPath } : null);
  }

  /** AssetAsset → HistoryEntry（复现 S9 / 搜索 S8 用）：meta 内存缓存优先；缺失时经 historyDrawer.getEntryByImageUrl 反查 */
  private _toEntry(item: AssetAsset): Extract<HistoryEntry, { kind: 'image' }> {
    const m = item.meta;
    if (!m) {
      const fallback = historyDrawer.getEntryByImageUrl(item.url);
      if (fallback && fallback.kind === 'image') return fallback;
    }
    return {
      kind: 'image',
      nodeId: item.record.nodeId || '',
      imageUrl: item.url,
      prompt: m?.prompt || '',
      model: m?.model || '',
      aspectRatio: m?.aspectRatio || '3:4',
      resolution: m?.resolution || '2k',
      count: typeof m?.count === 'number' ? m.count : 1,
      refImageHashes: Array.isArray(m?.refImageHashes) ? m.refImageHashes : [],
      refImageUrls: Array.isArray(m?.refImageUrls) ? m.refImageUrls : [],
      seed: null,
      createdAt: m?.createdAt || item.record.updatedAt,
      parentId: null,
      outputType: (m?.outputType === 'img2img' || m?.outputType === 'outpaint' ? m.outputType : 'txt2img') as 'txt2img' | 'img2img' | 'outpaint',
    };
  }
}

export const assetDrawer = new AssetDrawer();
