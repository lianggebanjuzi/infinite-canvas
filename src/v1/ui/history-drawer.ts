// src/v1/ui/history-drawer.ts
// 左侧悬浮历史图库抽屉 + 拖入手势（改造自 src/components/history-sidebar.ts）
// 增量（成图库收口）：B1 成图/文本分区 tab（默认成图）；B5 搜索（prompt/model/tags 过滤成图，outputText 过滤文本）
//   B2/B3 采纳/锁定动作 + 角标（同一 AssetStore，X1 同步之一）；A6 图库卡片 hover「复现」
// incremental-3 拆分（S1/S2）：历史图库专注「全部出图/文本记录」——移除采纳/锁定 hover 动作，
//   保留只读角标（已采纳/已锁定，天然不可点）；复现/拖入画布/搜索/tab 全部保留；
//   新增 setMutex（互斥回调，由 main.ts 编排，不内部 import 资产抽屉）与 getEntryByImageUrl（资产库复现 S9 反查）。
// 生成图自动加入（addImage 带搜索元数据）；拖拽缩略图到画布触发 A4 语义（由 interactions 处理落点）。
// R3 批次分组：写侧 batchId（run-engine 生成，jsonl 行携带）→ 读侧 view='batch' 按 batchId 分组为批次卡；
//   time 视图保持现有单图流水；无 batchId 旧行在 batch 视图下按单图回退展示；text 不入批次（text tab 隐藏视图切换）。
// 循环依赖注意（§8）：批次卡「查看大图」import openImageModal（来自 canvas/card-view），形成延迟使用型环
//   history-drawer → card-view → run-engine → history-drawer；Vite/Rollup 对仅运行时调用安全（asset-drawer 同款）。

import { flowState } from '../state/flow-state';
import { assetStore } from '../asset-store';
import { reproduceService } from '../reproduce';
import { openImageModal } from '../canvas/card-view';

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
  thumbnail?: string;       // 显式缩略图（新行；读侧 src=thumbnail||imageUrl 回退）
  originalPath?: string;    // 原图本地绝对路径（查看大图按需加载用）
  originalUrl?: string;     // file:// 引用（备用）
  batchId?: string;         // R3：一次生成的批次号（同批共用一个；旧行缺失 → batch 视图按单图回退）
  text?: string; // 文本记录：无图，展示 outputText 片段
}

/** addImage 元数据（搜索 + 图库复现 + 角标 + R3 批次用） */
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
  thumbnail?: string;       // 展示图=缩略图
  originalPath?: string;    // 原图本地绝对路径
  originalUrl?: string;     // file:// 引用（备用）
  batchId?: string;         // R3：批次号（同批全部成功图共用）
}

/** R3 展示项：batch 视图下 single（无 batchId 旧行 / time 视图全部）| batch（同 batchId 组） */
type HistoryDisplayItem =
  | { kind: 'single'; item: HistoryItem }
  | { kind: 'batch'; batchId: string; items: HistoryItem[] };

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
  /** R3 历史视图：batch（按批次分组，默认）/ time（按时间平铺）；text 不入批次，切到 text tab 时隐藏控件 */
  private view: 'batch' | 'time' = 'batch';
  private query = '';
  private unsubscribeAsset: (() => void) | null = null;
  private mutex: (() => void) | null = null;
  /** 渲染批次序号：分批渲染在途期间若发起新渲染，旧批次据序号作废（防重复插入） */
  private renderSeq = 0;

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

    // R3 视图切换（按批次 / 按时间；默认按批次，Q1 拍板）
    const viewWrap = document.getElementById('history-view');
    viewWrap?.querySelectorAll('.history-view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const view = ((btn as HTMLElement).dataset.view) as 'batch' | 'time' | undefined;
        if (!view) return;
        this.setView(view);
      });
    });
    this._syncViewButtons();
    this._syncViewVisibility();

    // 订阅 AssetStore：采纳/锁定变更 → 图库只读角标即时刷新（X1 同步之一）
    this.unsubscribeAsset = assetStore.subscribe(() => this.render());

    this.render();
  }

  /** 注入互斥回调（main.ts 编排：打开本抽屉时自动收起资产库；不内部 import 对方单例，避免循环依赖） */
  setMutex(fn: () => void): void {
    this.mutex = fn;
  }

  /** 生成图自动入列（带搜索/复现元数据；展示图=缩略图 + 原图引用 + R3 batchId） */
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
      thumbnail: meta.thumbnail,
      originalPath: meta.originalPath,
      originalUrl: meta.originalUrl,
      batchId: meta.batchId,
    });
    this.render();
    if (!this.open) this.openDrawer(true);
  }

  /** 载入 history.jsonl（打开项目时调用）：image 行 thumbnail 优先、imageUrl 回退，缺失再回退 nodeId 解析当前节点 imageUrl */
  loadFromHistory(entries: HistoryEntry[]): void {
    const resolved: HistoryItem[] = [];
    entries.forEach(e => {
      if (e.kind === 'image') {
        // 双轨兼容：新行 thumbnail 优先（缩略图），旧行回退 imageUrl（原 base64，仅打开慢）
        let src = typeof e.thumbnail === 'string' && e.thumbnail ? e.thumbnail : '';
        if (!src) src = typeof e.imageUrl === 'string' && e.imageUrl ? e.imageUrl : '';
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
          thumbnail: typeof e.thumbnail === 'string' ? e.thumbnail : undefined,
          originalPath: typeof e.originalPath === 'string' ? e.originalPath : undefined,
          originalUrl: typeof e.originalUrl === 'string' ? e.originalUrl : undefined,
          batchId: typeof e.batchId === 'string' ? e.batchId : undefined, // R3：旧行缺失 → undefined 按单图回退
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
    // R3：text 不入批次 → 切到文本 tab 时隐藏视图切换控件
    this._syncViewVisibility();
    this.render();
  }

  /** R3：切换历史视图（batch 按批次分组 / time 按时间平铺；text tab 下视图不生效） */
  setView(view: 'batch' | 'time'): void {
    if (this.view === view) return;
    this.view = view;
    this._syncViewButtons();
    this.render();
  }

  /** 同步视图切换按钮 active 态 */
  private _syncViewButtons(): void {
    document.querySelectorAll('.history-view-btn').forEach(btn => {
      const el = btn as HTMLElement;
      el.classList.toggle('active', el.dataset.view === this.view);
    });
  }

  /** 视图切换控件显隐：text tab（text 不入批次）隐藏；image tab 显示 */
  private _syncViewVisibility(): void {
    document.getElementById('history-view')?.classList.toggle('hidden', this.tab === 'text');
  }

  setQuery(q: string): void {
    this.query = (q || '').trim().toLowerCase();
    if (this.searchInput) this.searchInput.value = q;
    this.render();
  }

  toggle(): void {
    this.openDrawer(!this.open);
  }

  /** 收起抽屉（互斥回调用，main.ts 编排） */
  close(): void {
    this.openDrawer(false);
  }

  openDrawer(open: boolean): void {
    if (open && this.mutex) this.mutex(); // 互斥：开一个自动收起另一个（main.ts 编排）
    this.open = open;
    this.drawer?.classList.toggle('open', open);
  }

  /** 过滤 + 渲染（tab / 搜索 / R3 批次分组 / 采纳锁定角标 / hover 动作；分批插入，避免大量大图一次阻塞 JS 主线程） */
  private render(): void {
    this._syncTabCounts();
    if (!this.grid) return;
    const filtered = this._filtered();
    const display = this._buildDisplay(filtered);

    if (display.length === 0) {
      this.renderSeq++; // 作废在途分批渲染
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
    this.renderSeq++;
    const seq = this.renderSeq;
    this.grid.innerHTML = '';
    this._renderBatch(display, 0, seq);
  }

  /** 分批渲染（display 项）：每批 BATCH 项，requestIdleCallback 空闲时续批；seq 失配即被新渲染取代 */
  private _renderBatch(display: HistoryDisplayItem[], index: number, seq: number): void {
    if (seq !== this.renderSeq || !this.grid) return;
    const BATCH = 12;
    const end = Math.min(index + BATCH, display.length);
    for (let i = index; i < end; i++) {
      const d = display[i];
      if (d.kind === 'batch') {
        this._renderBatchCard(d);
      } else if (d.item.kind === 'text') {
        this._renderTextItem(d.item);
      } else {
        this._renderImageItem(d.item);
      }
    }
    if (end < display.length) {
      this._scheduleIdle(() => this._renderBatch(display, end, seq));
    }
  }

  private _scheduleIdle(fn: () => void): void {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => fn(), { timeout: 50 });
    } else {
      setTimeout(fn, 16);
    }
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

  /**
   * R3：把过滤后的流水项转换为展示项。
   * image tab + view==='batch'：按 batchId 分组（Map，无 batchId → single）；输出按组内最新时间戳倒序。
   * text tab / view==='time'：全部 single（保持现有平铺渲染路径，零改动）。
   */
  private _buildDisplay(items: HistoryItem[]): HistoryDisplayItem[] {
    if (this.tab === 'text' || this.view !== 'batch') {
      return items.map(item => ({ kind: 'single' as const, item }));
    }
    const groups = new Map<string, HistoryItem[]>();
    items.forEach(item => {
      if (item.batchId) {
        const arr = groups.get(item.batchId);
        if (arr) arr.push(item);
        else groups.set(item.batchId, [item]);
      }
    });
    const display: HistoryDisplayItem[] = [];
    groups.forEach((groupItems, batchId) => {
      display.push({ kind: 'batch', batchId, items: groupItems });
    });
    items.forEach(item => {
      if (!item.batchId) display.push({ kind: 'single', item });
    });
    // 按组内最新时间戳倒序（single = 自身时间戳；batch = 组内最新）
    display.sort((a, b) => {
      const ta = a.kind === 'batch' ? this._maxTs(a.items) : a.item.timestamp;
      const tb = b.kind === 'batch' ? this._maxTs(b.items) : b.item.timestamp;
      return tb - ta;
    });
    return display;
  }

  /** 组内最新时间戳 */
  private _maxTs(items: HistoryItem[]): number {
    return items.reduce((max, i) => Math.max(max, i.timestamp), 0);
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

  /** 成图卡：缩略图 + 只读角标（S2，采纳/锁定态仍提示但不可点）+ hover 动作（仅复现，S1）+ 拖入手势 */
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
        <button class="ht-act" data-act="reproduce">复现</button>
      </div>`;

    // 拖入手势（A4 语义保留）
    div.addEventListener('dragstart', (e: DragEvent) => {
      e.dataTransfer!.setData('application/history-image', item.src);
      e.dataTransfer!.setData('text/plain', item.src);
      div.style.opacity = '0.6';
    });
    div.addEventListener('dragend', () => { div.style.opacity = ''; });

    // hover 动作：仅复现（A6，采纳/锁定已按 S1 移除；角标只读，点击卡片本体不触发动作）
    div.addEventListener('click', (e: MouseEvent) => {
      const btn = (e.target as Element).closest('.ht-act') as HTMLElement | null;
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      if ((btn.dataset.act || '') === 'reproduce') {
        // A6：图库复现（trace 从 HistoryEntry 构造）
        void reproduceService.reproduceFromHistory(this._toEntry(item));
      }
    });

    this.grid.appendChild(div);
  }

  /** 按图 URL 反查 HistoryEntry（资产库复现 S9 用；本会话历史项未命中返回 null） */
  getEntryByImageUrl(url: string): HistoryEntry | null {
    if (!url) return null;
    const item = this.items.find(i => i.kind === 'image' && i.src === url);
    return item ? this._toEntry(item) : null;
  }

  /**
   * R3 批次卡：同 batchId 的成功图合并为一张卡。
   * 缩略图组（≤4 张 +「+N」角标）、右上成功计数 x/y（x=组内行数，y=items[0].count ?? x）、
   * 配方摘要（首行 prompt 截断 + model · 比例）；逐缩略图保留 拖拽 / hover 复现 / 点击查看大图。
   */
  private _renderBatchCard(group: { batchId: string; items: HistoryItem[] }): void {
    if (!this.grid) return;
    const items = group.items;
    const first = items[0];
    const done = items.length;
    const total = typeof first?.count === 'number' && first.count > 0 ? first.count : done;
    const visible = items.slice(0, 4);
    const extra = items.length - visible.length;
    const prompt = (first?.prompt || '').trim();
    const chipsHtml = this._batchChips(first);
    const maxTs = this._maxTs(items);

    const div = document.createElement('div');
    div.className = `history-batch history-batch-c${Math.min(4, visible.length)}`;
    div.title = `批次 ${group.batchId}`;
    div.innerHTML = `
      <div class="history-batch-head">
        <span class="history-batch-count" title="成功 ${done}/${total}">${done}/${total}</span>
        <span class="history-batch-time">${this._fmtTime(maxTs)}</span>
      </div>
      <div class="history-batch-thumbs">
        ${visible.map(item => `
          <div class="history-batch-thumb" style="background-image:url('${escapeUrl(item.src)}')" title="${escapeAttr(prompt || '查看大图')}"></div>
        `).join('')}
        ${extra > 0 ? `<div class="history-batch-more">+${extra}</div>` : ''}
      </div>
      <div class="history-batch-recipe">
        <div class="history-batch-prompt"${prompt ? ` title="${escapeAttr(prompt)}"` : ''}>${escapeHtml(prompt || '无提示词')}</div>
        ${chipsHtml ? `<div class="history-batch-chips">${chipsHtml}</div>` : ''}
      </div>
    `;

    // 逐缩略图：拖拽 / hover 复现 / 点击查看大图（分组不损失单图能力，A3）
    const thumbEls = div.querySelectorAll('.history-batch-thumb');
    visible.forEach((item, idx) => {
      const el = thumbEls[idx] as HTMLElement | undefined;
      if (!el) return;
      el.draggable = true;
      // 拖入画布（复用 application/history-image 语义）
      el.addEventListener('dragstart', (e: DragEvent) => {
        e.dataTransfer!.setData('application/history-image', item.src);
        e.dataTransfer!.setData('text/plain', item.src);
        el.style.opacity = '0.6';
      });
      el.addEventListener('dragend', () => { el.style.opacity = ''; });
      // 点击查看大图（openImageModal：先缩略图 + 按需加载原图；import 见文件头循环依赖说明）
      el.addEventListener('click', (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        void openImageModal(item.src, item.originalPath ? { path: item.originalPath } : null);
      });
      // hover 复现：逐张复现（参数为该图 trace）
      const repro = document.createElement('button');
      repro.className = 'history-batch-repro';
      repro.textContent = '复现';
      repro.title = '复现该图';
      repro.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation()); // 防拖动误触发
      repro.addEventListener('click', (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        void reproduceService.reproduceFromHistory(this._toEntry(item));
      });
      el.appendChild(repro);
    });

    this.grid.appendChild(div);
  }

  /** 批次卡配方摘要 chips（model · 比例；空则返回 ''） */
  private _batchChips(item: HistoryItem | undefined): string {
    if (!item) return '';
    const model = this._shortModel(item.model || '');
    const ratio = item.aspectRatio || '';
    return [model, ratio]
      .filter(Boolean)
      .map(s => `<span class="history-batch-chip">${escapeHtml(s)}</span>`)
      .join('');
  }

  /** 模型短名（"provider:key:model" → "model"） */
  private _shortModel(modelId: string): string {
    return modelId.split(':').pop() || modelId || '';
  }

  /** 时间短格式（HH:mm） */
  private _fmtTime(ts: number): string {
    return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }

  /** HistoryItem → HistoryEntry（图库复现用；会话内条目携带完整参数 + 缩略图/原图引用 + R3 batchId 保真） */
  private _toEntry(item: HistoryItem): HistoryEntry {
    return {
      kind: 'image',
      nodeId: item.nodeId || '',
      imageUrl: item.src,
      thumbnail: item.thumbnail,
      originalPath: item.originalPath,
      originalUrl: item.originalUrl,
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
      ...(item.batchId ? { batchId: item.batchId } : {}),
    };
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

/** 属性值转义（title 内嵌用户文本用） */
function escapeAttr(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** URL 转义（background-image 内嵌 dataURL 用） */
function escapeUrl(url: string): string {
  return String(url).replace(/'/g, "\\'").replace(/"/g, '\\"');
}

export const historyDrawer = new HistoryDrawer();
