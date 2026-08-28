// src/v1/ui/asset-drawer.ts
// 资产库页签（Phase 2：并入统一资源抽屉，渲染委托给本组件）：
// 显示已添加的图（按 updatedAt 倒序）。
// 数据源 = assetStore.getAssets()；订阅 assetStore 即时刷新。
// 卡片动作：放到画布（统一 resource-insert）/ 移除（变更前 flowHistory.record()）/ 查看大图（复用 #img-modal）/
//           复制配方（R2：一键复制 prompt 全文，无配方置灰）。
// R2 配方信息区：prompt 摘要（1-2 行截断，title 全文）+ model · 比例 · 分辨率 chips；无配方显示缺失占位。
// 搜索（S8 P1）：按 prompt / model / tags 过滤；空态/无匹配文案见共享知识 3（人话常量）。
// 抽屉开合与页签切换由 left-capsule 统一编排；本组件不再持有自己的抽屉开关。
// 对 historyDrawer 仅单向依赖 getEntryByImageUrl（旧记录配方反查，类图明示）。

import { flowHistory } from '../state/history';
import { assetStore } from '../asset-store';
import { historyDrawer } from './history-drawer';
import { insertImageAsAsset } from './resource-insert';
import { openImageModal } from '../canvas/card-view';
import { showToast } from './toast';

/** 空态文案（共享知识 3：人话常量，禁止改字面量） */
const EMPTY_TEXT = '还没有素材。可在画布或对比面板中添加图片到资产库。';
/** 搜索无结果文案（共享知识 3） */
const NO_MATCH_TEXT = '无匹配资产';

class AssetDrawer {
  private query = '';
  private grid: HTMLElement | null = null;
  private emptyEl: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private countEl: HTMLElement | null = null;
  private unsubscribeAsset: (() => void) | null = null;
  private tabOpenRequest: ((tab: 'assets') => void) | null = null;
  /** 渲染批次序号：分批渲染在途期间若发起新渲染，旧批次据序号作废（防重复插入） */
  private renderSeq = 0;

  init(): void {
    this.grid = document.getElementById('asset-grid');
    this.emptyEl = document.getElementById('asset-empty');
    this.searchInput = document.getElementById('asset-search') as HTMLInputElement | null;
    this.countEl = document.getElementById('asset-count');

    this.searchInput?.addEventListener('input', () => {
      this.query = (this.searchInput?.value || '').trim().toLowerCase();
      this.render();
    });

    // 订阅 AssetStore：添加、移除或标签变更后即时刷新。
    this.unsubscribeAsset = assetStore.subscribe(() => this.render());

    this.render();
  }

  /** 页签切到「资源」时由 leftCapsule 调用（重渲染 + 计数） */
  refresh(): void {
    this.render();
  }

  /** 资源总数（左侧页签计数用） */
  count(): number {
    return assetStore.getAssets().length;
  }

  /** 注入「打开抽屉并切到资源页签」回调（main.ts 编排：leftCapsule.openTo('assets')；不内部 import 对方单例，避免循环依赖） */
  setTabOpenRequest(fn: (tab: 'assets') => void): void {
    this.tabOpenRequest = fn;
  }

  /** 渲染：计数 / 空态 / 无匹配 / 卡片（S3/S6/S8；分批插入，避免大量大图一次阻塞 JS 主线程） */
  private render(): void {
    if (!this.grid) return;
    const all = assetStore.getAssets();
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

  /** 按 prompt / model / tags 过滤资产。 */
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

  /** 卡片：缩略图 + 配方信息区 / 动作（移除·查看·复制配方）/ 拖入手势。 */
  private _renderCard(item: AssetAsset): void {
    if (!this.grid) return;
    const div = document.createElement('div');
    div.className = 'history-thumb asset-thumb';
    // 图片性能优化：卡片主视觉 = 缩略图（thumbnailUrl 优先，旧记录回退 url 原 base64）
    const thumbUrl = item.thumbnailUrl || item.url;
    const hasUrl = !!thumbUrl;
    if (hasUrl) {
      div.draggable = true;
    } else {
      // 旧记录无 imageUrl：图源缺失占位卡（可移除，无缩略图、无可拖 URL）
      div.classList.add('asset-missing');
    }
    div.title = new Date(item.record.updatedAt).toLocaleString('zh-CN');
    // R2：配方信息区（prompt 摘要 1-2 行截断 + model · 比例 · 分辨率 chips；无配方 → 缺失占位）
    const recipeMeta = this._recipeMeta(item);
    const recipeHtml = this._recipeHtml(recipeMeta);
    const hasRecipe = !!recipeMeta && typeof recipeMeta.prompt === 'string' && recipeMeta.prompt.trim() !== '';
    div.innerHTML = `
      <div class="asset-card-img${hasUrl ? '' : ' no-img'}"${hasUrl ? ` style="background-image:url('${thumbUrl.replace(/'/g, "\\'")}')"` : ''}>
        ${hasUrl ? '' : '<div class="asset-placeholder">图源缺失</div>'}
      </div>
      ${recipeHtml}
      <div class="ht-actions asset-actions">
        <button class="ht-act" data-act="place">放到画布</button>
        <button class="ht-act" data-act="remove">移除</button>
        <button class="ht-act" data-act="view">查看</button>
        <button class="ht-act" data-act="copy"${hasRecipe ? '' : ' disabled title="配方缺失"'}>复制配方</button>
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

    // 卡片动作（AssetStore 唯一写入口；用户手势变更前记录撤销快照）
    div.addEventListener('click', (e: MouseEvent) => {
      const btn = (e.target as Element).closest('.ht-act') as HTMLElement | null;
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const act = btn.dataset.act || '';
      if (act === 'place') {
        // 放到画布：以当前视口中心创建素材节点（统一 resource-insert；不触发生成）
        if (hasUrl) {
          flowHistory.record();
          const node = insertImageAsAsset(thumbUrl, item.originalPath ? { path: item.originalPath } : null);
          if (node) showToast('已放到画布');
        }
      } else if (act === 'remove') {
        flowHistory.record();
        assetStore.remove(item.record.key);
        showToast('已从资产库移除');
      } else if (act === 'view') {
        // 查看大图：缩略图先显示 + 按需加载原图（有 originalPath 时桥接取原图，失败回退缩略图）
        if (hasUrl) this._viewImage(thumbUrl, item);
      } else if (act === 'copy') {
        // R2：复制配方（prompt 全文；无配方按钮已置灰）
        const meta = this._recipeMeta(item);
        this._copyPrompt(meta?.prompt || '');
      }
    });

    this.grid.appendChild(div);
  }

  /** 查看大图（复用 #img-modal；origin.path = 原图本地路径，按需加载；携带信息栏配方） */
  private _viewImage(url: string, item: AssetAsset): void {
    if (!url) return;
    const meta = this._recipeMeta(item);
    const rec = item.record;
    void openImageModal(url, item.originalPath ? { path: item.originalPath } : null,
      undefined,
      {
        model: rec.model ?? meta?.model,
        createdAt: rec.createdAt ?? meta?.createdAt,
        aspectRatio: rec.aspectRatio ?? meta?.aspectRatio,
        resolution: rec.resolution ?? meta?.resolution,
        prompt: rec.prompt ?? meta?.prompt,
      });
  }

  /**
   * AssetAsset → HistoryEntry（搜索 S8 / 旧记录配方反查用）。
   * R2 取数优先级（共享知识 8.3）：记录配方（持久化真相）→ meta（会话缓存）→ historyDrawer 反查兜底。
   */
  private _toEntry(item: AssetAsset): Extract<HistoryEntry, { kind: 'image' }> {
    const m = item.meta;
    if (!m) {
      // 无记录配方且无会话缓存：反查兜底（旧记录跨项目反查失败 → 空配方，与现状一致）
      const fallback = historyDrawer.getEntryByImageUrl(item.url);
      if (fallback && fallback.kind === 'image') return fallback;
    }
    const meta = this._recipeMeta(item);
    return {
      kind: 'image',
      nodeId: item.record.nodeId || '',
      imageUrl: item.url,
      prompt: meta?.prompt || '',
      model: meta?.model || '',
      aspectRatio: meta?.aspectRatio || '3:4',
      resolution: meta?.resolution || '2k',
      count: typeof meta?.count === 'number' ? meta.count : 1,
      refImageHashes: Array.isArray(meta?.refImageHashes) ? meta.refImageHashes : [],
      refImageUrls: Array.isArray(meta?.refImageUrls) ? meta.refImageUrls : [],
      seed: null,
      createdAt: meta?.createdAt || item.record.updatedAt,
      parentId: null,
      outputType: (meta?.outputType === 'img2img' || meta?.outputType === 'outpaint' ? meta.outputType : 'txt2img') as 'txt2img' | 'img2img' | 'outpaint',
    };
  }

  // ───────────────────────── R2 配方读侧（记录 → meta 合并，record 优先） ─────────────────────────

  /** 合并配方元数据：记录字段（持久化真相）优先，缺失字段回退会话 meta */
  private _recipeMeta(item: AssetAsset): AdoptMeta | undefined {
    const m = item.meta;
    if (!m) return undefined;
    const rec = item.record;
    return {
      prompt: rec.prompt ?? m.prompt,
      model: rec.model ?? m.model,
      aspectRatio: rec.aspectRatio ?? m.aspectRatio,
      resolution: rec.resolution ?? m.resolution,
      count: rec.count ?? m.count,
      refImageUrls: rec.refImageUrls ?? m.refImageUrls,
      refImageHashes: rec.refImageHashes ?? m.refImageHashes,
      outputType: rec.outputType ?? m.outputType,
      createdAt: rec.createdAt ?? m.createdAt,
    };
  }

  /** 配方信息区 HTML：prompt 摘要（1-2 行截断，title 全文）+ model · 比例 · 分辨率 chips；无配方 → 缺失占位 */
  private _recipeHtml(meta: AdoptMeta | undefined): string {
    const prompt = (meta?.prompt || '').trim();
    if (!prompt) {
      return '<div class="asset-recipe asset-recipe-missing" title="配方缺失（可经历史反查）">配方缺失（可经历史反查）</div>';
    }
    const model = this._shortModel(meta?.model || '');
    const ratio = meta?.aspectRatio || '';
    const resolution = meta?.resolution ? String(meta.resolution).toUpperCase() : '';
    const chips = [model, ratio, resolution]
      .filter(Boolean)
      .map(s => `<span class="asset-recipe-chip">${escapeHtml(s)}</span>`)
      .join('');
    return `
      <div class="asset-recipe" title="${escapeAttr(prompt)}">
        <div class="asset-recipe-prompt">${escapeHtml(prompt)}</div>
        ${chips ? `<div class="asset-recipe-chips">${chips}</div>` : ''}
      </div>`;
  }

  /** 模型短名（"provider:key:model" → "model"） */
  private _shortModel(modelId: string): string {
    return modelId.split(':').pop() || modelId || '';
  }

  /** 复制配方（prompt 全文；Clipboard API 优先，pywebview 旧内核无 API 时兜底 execCommand） */
  private _copyPrompt(prompt: string): void {
    const text = (prompt || '').trim();
    if (!text) { showToast('配方缺失', false); return; }
    const done = () => showToast('已复制配方');
    const fail = () => showToast('复制失败', false);
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      void navigator.clipboard.writeText(text).then(done, fail);
      return;
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    } catch {
      fail();
    }
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

export const assetDrawer = new AssetDrawer();
