// src/v1/ui/history-drawer.ts
// 历史图库页签（Phase 2：并入统一资源抽屉，渲染委托给本组件）。
// 左侧悬浮历史图库 + 拖入手势（改造自 src/components/history-sidebar.ts）
// 增量（成图库收口）：B1 成图/文本分区 tab（默认成图）；B5 搜索（prompt/model/tags 过滤成图，outputText 过滤文本）
// 4.2-C：新增 video/audio 分区 tab，展示状态/模型/prompt/来源/时长/远端任务 ID（jsonl 已有 video 行，读侧渲染）。
// 历史图库专注「全部出图/文本/媒体记录」；复制提示词/拖入画布/搜索/tab 全部保留；
//   新增 setTabOpenRequest（由 main.ts 编排：打开抽屉并切到历史页签，不内部 import 资源抽屉避免循环依赖）
//   与 getEntryByImageUrl（资产库配方反查）。
// 生成图自动加入（addImage 带搜索元数据）；拖拽缩略图到画布触发 A4 语义（由 interactions 处理落点）。
// 卡片动作（Phase 2）：复制提示词 / 放到画布（resource-insert）/ 保存到资源（assetStore）/ 继续创作（resource-insert + createContinueStep）。
// 2026-08-19 用户拍板：批次视图（按批次/按时间切换 + 批次卡）已移除，读侧不再分组，历史图库恒按时间平铺；
//   batchId 写侧/数据层保留（addImage meta、jsonl 行、_toEntry 透传），向后兼容，未来可能恢复读侧分组。

import { flowState } from '../state/flow-state';
import { flowHistory } from '../state/history';
import { assetStore } from '../asset-store';
import { insertHistoryImageToCanvas, startCreateFromResource } from './resource-insert';
import { openImageModal } from '../canvas/card-view';
import { showToast } from './toast';

/** 图库条目（image/text/video/audio 分区展示） */
interface HistoryItem {
  src: string;
  timestamp: number;
  kind: 'image' | 'text' | 'video' | 'audio';
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
  jobId?: string;           // B-6 追溯：任务编号（与 batchId 并列；旧行缺失 → 读侧回退，不报错）
  width?: number;           // 原图真实像素宽（PIL im.size；旧行缺失 → 展示回退 resolution+aspectRatio）
  height?: number;          // 原图真实像素高
  text?: string; // 文本记录：无图，展示 outputText 片段
  // ── 4.2-C：视频/音频字段 ──
  mediaUrl?: string;        // 播放地址（file:// 或 data URL）
  mediaPath?: string;       // 本地绝对路径
  duration?: number;
  mimeType?: string;
  seconds?: number;
  format?: string;
  remoteTaskId?: string;
  taskState?: string;
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
  jobId?: string;           // B-6 追溯：任务编号（与 batchId 并列；旧数据缺失 → 读侧回退）
  width?: number;           // 原图真实像素宽
  height?: number;          // 原图真实像素高
}

/** 4.2-C：媒体历史元数据（video/audio 添加用）。 */
export interface HistoryMediaMeta {
  timestamp?: number;
  nodeId?: string;
  prompt?: string;
  model?: string;
  seconds?: number;
  format?: string;
  references?: string[];
  originalPath?: string;
  mediaUrl?: string;
  duration?: number;
  mimeType?: string;
  remoteTaskId?: string;
  taskState?: string;
}

type HistoryTab = 'image' | 'text' | 'video' | 'audio';

class HistoryDrawer {
  private items: HistoryItem[] = [];
  private grid: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private emptyEl: HTMLElement | null = null;
  private tab: HistoryTab = 'image';
  private query = '';
  private unsubscribeAsset: (() => void) | null = null;
  private tabOpenRequest: ((tab: 'history') => void) | null = null;
  /** 渲染批次序号：分批渲染在途期间若发起新渲染，旧批次据序号作废（防重复插入） */
  private renderSeq = 0;

  init(): void {
    this.grid = document.getElementById('history-grid');
    this.emptyEl = document.getElementById('history-empty');
    this.searchInput = document.getElementById('history-search') as HTMLInputElement | null;

    // 抽屉把手（收起）由 left-capsule 统一绑定；本组件不再持有自己的开合入口。
    this.searchInput?.addEventListener('input', () => {
      this.query = (this.searchInput?.value || '').trim().toLowerCase();
      this.render();
    });

    // 分区 tab（B1：默认成图；4.2-C：video/audio）
    const tabs = document.getElementById('history-tabs');
    tabs?.querySelectorAll('.history-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = ((btn as HTMLElement).dataset.tab) as HistoryTab | undefined;
        if (!tab) return;
        this.setTab(tab);
      });
    });

    // 订阅 AssetStore：资产标签变化时刷新搜索结果。
    this.unsubscribeAsset = assetStore.subscribe(() => this.render());

    this.render();
  }

  /** 注入「打开抽屉并切到历史页签」回调（main.ts 编排：leftCapsule.openTo('history')；不内部 import 对方单例，避免循环依赖） */
  setTabOpenRequest(fn: (tab: 'history') => void): void {
    this.tabOpenRequest = fn;
  }

  /** 页签切到「历史」时由 leftCapsule 调用（重渲染 + 计数） */
  refresh(): void {
    this.render();
  }

  /** 成图数量（左侧页签计数用） */
  count(): number {
    return this.items.filter(i => i.kind === 'image').length;
  }

  /** 生成图自动入列（带搜索/复现元数据；展示图=缩略图 + 原图引用 + R3 batchId + 真实像素） */
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
      jobId: meta.jobId,
      width: meta.width,
      height: meta.height,
    });
    this.render();
    this.tabOpenRequest?.('history');
  }

  /** 4.2-C：视频历史入列（会话内即时展示；jsonl 行由 run-engine 写入）。 */
  addVideo(meta: HistoryMediaMeta = {}): void {
    const url = meta.mediaUrl || '';
    if (!url && !meta.originalPath) return;
    this.items.unshift({
      src: url || meta.originalPath || '',
      timestamp: meta.timestamp ?? Date.now(),
      kind: 'video',
      nodeId: meta.nodeId,
      prompt: meta.prompt,
      model: meta.model,
      seconds: meta.seconds,
      format: meta.format,
      originalPath: meta.originalPath,
      mediaUrl: url,
      mediaPath: meta.originalPath,
      duration: meta.duration,
      mimeType: meta.mimeType,
      remoteTaskId: meta.remoteTaskId,
      taskState: meta.taskState,
    });
    this.render();
    this.tabOpenRequest?.('history');
  }

  /** 4.2-C：音频历史入列。 */
  addAudio(meta: HistoryMediaMeta = {}): void {
    const url = meta.mediaUrl || '';
    if (!url && !meta.originalPath) return;
    this.items.unshift({
      src: url || meta.originalPath || '',
      timestamp: meta.timestamp ?? Date.now(),
      kind: 'audio',
      nodeId: meta.nodeId,
      prompt: meta.prompt,
      model: meta.model,
      seconds: meta.seconds,
      format: meta.format,
      originalPath: meta.originalPath,
      mediaUrl: url,
      mediaPath: meta.originalPath,
      duration: meta.duration,
      mimeType: meta.mimeType,
      remoteTaskId: meta.remoteTaskId,
      taskState: meta.taskState,
    });
    this.render();
    this.tabOpenRequest?.('history');
  }

  /** 载入 history.jsonl（打开项目时调用）：image 行 thumbnail 优先、imageUrl 回退，缺失再回退 nodeId 解析当前节点 imageUrl；video/audio 行读侧渲染 */
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
          jobId: typeof e.jobId === 'string' ? e.jobId : undefined,       // B-6：旧行缺失 → undefined 回退
          width: typeof e.imageWidth === 'number' && e.imageWidth > 0 ? e.imageWidth : undefined,
          height: typeof e.imageHeight === 'number' && e.imageHeight > 0 ? e.imageHeight : undefined,
        });
      } else if (e.kind === 'text') {
        resolved.push({ src: '', timestamp: e.createdAt, kind: 'text', text: e.outputText || '' });
      } else if (e.kind === 'video') {
        // 4.2-C：视频历史行（读侧渲染；播放地址优先行内 videoUrl，否则按 originalPath 本地直读）
        const url = typeof e.videoUrl === 'string' ? e.videoUrl : '';
        const path = typeof e.originalPath === 'string' ? e.originalPath : '';
        if (!url && !path) return;
        resolved.push({
          src: url || path,
          timestamp: e.createdAt,
          kind: 'video',
          nodeId: e.nodeId,
          prompt: e.prompt,
          model: e.model,
          seconds: e.seconds,
          aspectRatio: e.aspectRatio,
          resolution: e.resolution,
          originalPath: path,
          mediaUrl: url || (path ? fileUrlFromPath(path) : ''),
          mediaPath: path,
          duration: typeof e.duration === 'number' ? e.duration : undefined,
          remoteTaskId: typeof e.remoteTaskId === 'string' ? e.remoteTaskId : undefined,
          taskState: typeof e.taskState === 'string' ? e.taskState : undefined,
        });
      } else if (e.kind === 'audio') {
        const url = typeof e.audioUrl === 'string' ? e.audioUrl : '';
        const path = typeof e.originalPath === 'string' ? e.originalPath : '';
        if (!url && !path) return;
        resolved.push({
          src: url || path,
          timestamp: e.createdAt,
          kind: 'audio',
          nodeId: e.nodeId,
          prompt: e.prompt,
          model: e.model,
          seconds: e.seconds,
          format: e.format,
          originalPath: path,
          mediaUrl: url || (path ? fileUrlFromPath(path) : ''),
          mediaPath: path,
          duration: typeof e.duration === 'number' ? e.duration : undefined,
          mimeType: typeof e.mimeType === 'string' ? e.mimeType : undefined,
          remoteTaskId: typeof e.remoteTaskId === 'string' ? e.remoteTaskId : undefined,
          taskState: typeof e.taskState === 'string' ? e.taskState : undefined,
        });
      }
    });
    // 保留本会话生成图；persisted 追加在后（文件为 append 顺序，反转为最新在前）
    this.items = [...this.items, ...resolved.reverse()];
    this.render();
  }

  /** 新建空项目/从工作流创建副本时清空旧项目的会话与落盘历史。 */
  clear(): void {
    this.items = [];
    this.render();
  }

  setTab(tab: HistoryTab): void {
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

  /** 过滤 + 渲染（tab / 搜索 / hover 动作；恒按时间平铺；分批插入，避免大量大图一次阻塞 JS 主线程） */
  private render(): void {
    this._syncTabCounts();
    if (!this.grid) return;
    const items = this._filtered();

    if (items.length === 0) {
      this.renderSeq++; // 作废在途分批渲染
      this.grid.innerHTML = '';
      if (this.emptyEl) {
        this.emptyEl.textContent = this._emptyText(this.query);
        this.emptyEl.style.display = 'block';
      }
      return;
    }
    if (this.emptyEl) this.emptyEl.style.display = 'none';
    this.renderSeq++;
    const seq = this.renderSeq;
    this.grid.innerHTML = '';
    this._renderBatch(items, 0, seq);
  }

  private _emptyText(q: string): string {
    if (q) return '无匹配记录';
    switch (this.tab) {
      case 'text': return '暂无文本记录';
      case 'video': return '暂无视频记录';
      case 'audio': return '暂无音频记录';
      default: return '暂无成图';
    }
  }

  /** 分批渲染（HistoryItem 平铺）：每批 BATCH 项，requestIdleCallback 空闲时续批；seq 失配即被新渲染取代 */
  private _renderBatch(items: HistoryItem[], index: number, seq: number): void {
    if (seq !== this.renderSeq || !this.grid) return;
    const BATCH = 12;
    const end = Math.min(index + BATCH, items.length);
    for (let i = index; i < end; i++) {
      const item = items[i];
      if (item.kind === 'text') {
        this._renderTextItem(item);
      } else if (item.kind === 'video') {
        this._renderVideoItem(item);
      } else if (item.kind === 'audio') {
        this._renderAudioItem(item);
      } else {
        this._renderImageItem(item);
      }
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

  /** B5/B6/B7：按 tab 过滤（image：prompt/model/tags；text：outputText；video/audio：prompt/model/远端任务） */
  private _filtered(): HistoryItem[] {
    const q = this.query;
    if (this.tab === 'text') {
      const list = this.items.filter(i => i.kind === 'text');
      if (!q) return list;
      return list.filter(i => (i.text || '').toLowerCase().includes(q));
    }
    if (this.tab === 'video') {
      const list = this.items.filter(i => i.kind === 'video');
      if (!q) return list;
      return list.filter(i => {
        if ((i.prompt || '').toLowerCase().includes(q)) return true;
        if ((i.model || '').toLowerCase().includes(q)) return true;
        if ((i.remoteTaskId || '').toLowerCase().includes(q)) return true;
        return false;
      });
    }
    if (this.tab === 'audio') {
      const list = this.items.filter(i => i.kind === 'audio');
      if (!q) return list;
      return list.filter(i => {
        if ((i.prompt || '').toLowerCase().includes(q)) return true;
        if ((i.model || '').toLowerCase().includes(q)) return true;
        if ((i.remoteTaskId || '').toLowerCase().includes(q)) return true;
        return false;
      });
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
   * R3 批次分组已移除（2026-08-19 用户拍板）：读侧不再按 batchId 分组，
   * 过滤结果恒按时间平铺渲染（text 卡照常显示）。batchId 仅在数据层保留（_toEntry 透传，向后兼容）。
   */
  private _syncTabCounts(): void {
    const counts: Record<HistoryTab, number> = {
      image: this.items.filter(i => i.kind === 'image').length,
      text: this.items.filter(i => i.kind === 'text').length,
      video: this.items.filter(i => i.kind === 'video').length,
      audio: this.items.filter(i => i.kind === 'audio').length,
    };
    document.querySelectorAll('.history-tab').forEach(btn => {
      const el = btn as HTMLElement;
      const tab = el.dataset.tab as HistoryTab | undefined;
      const countEl = el.querySelector('.history-tab-count') as HTMLElement | null;
      if (countEl && tab) countEl.textContent = ` (${counts[tab] ?? 0})`;
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

  /** 成图卡：图片完整显示（不裁切）+ 底部常驻按钮行（复制/放到画布/存到资源/继续创作）+ 拖入手势 + 点击查看大图 */
  private _renderImageItem(item: HistoryItem): void {
    if (!this.grid) return;
    const div = document.createElement('div');
    div.className = 'history-thumb';
    div.draggable = true;
    div.title = new Date(item.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

    const hasPrompt = !!(item.prompt || '').trim();
    div.innerHTML = `
      <div class="ht-media"><img class="ht-img" src="${escapeAttr(item.src)}" alt="" draggable="false" loading="lazy"></div>
      <div class="ht-actions ht-actions-static">
        <button class="ht-act" data-act="copy"${hasPrompt ? '' : ' disabled title="无提示词可复制"'}>复制提示词</button>
        <button class="ht-act" data-act="place">放到画布</button>
        <button class="ht-act" data-act="save-asset">存到资源</button>
        <button class="ht-act" data-act="continue">继续创作</button>
      </div>`;

    // 拖入手势（A4 语义保留）
    div.addEventListener('dragstart', (e: DragEvent) => {
      e.dataTransfer!.setData('application/history-image', item.src);
      e.dataTransfer!.setData('text/plain', item.src);
      div.style.opacity = '0.6';
    });
    div.addEventListener('dragend', () => { div.style.opacity = ''; });

    // 底部按钮行：复制 / 放到画布 / 存到资源 / 继续创作（常驻可见，非 hover；stopPropagation 防误触拖拽/查看大图）
    div.addEventListener('click', (e: MouseEvent) => {
      const btn = (e.target as Element).closest('.ht-act') as HTMLElement | null;
      if (btn) {
        e.preventDefault();
        e.stopPropagation();
        const act = btn.dataset.act || '';
        if (act === 'copy') {
          this._copyPrompt(item.prompt || '');
        } else if (act === 'place') {
          // 放到画布：以当前视口中心创建素材节点（统一 resource-insert；不触发生成）
          flowHistory.record();
          if (insertHistoryImageToCanvas(item)) showToast('已放到画布');
        } else if (act === 'save-asset') {
          // 保存到资源：只写资产索引（历史保留；R-01 资源页即时出现由 assetStore 订阅驱动）
          flowHistory.record();
          assetStore.addByUrl(item.src, item.nodeId || '', this._adoptMeta(item), item.originalPath);
          showToast('已保存到资源');
        } else if (act === 'continue') {
          // 用作下一步：先放素材节点，再走统一 createContinueStep（来源由边派生为参考图）
          void startCreateFromResource(item.src, {
            ratio: this._ratioOf(item),
            imageWidth: item.width,
            imageHeight: item.height,
            originalPath: item.originalPath,
          });
        }
        return;
      }
      // 点击图片本体 → 查看大图（携带 info：模型/时间/比例/分辨率/提示词）
      e.preventDefault();
      e.stopPropagation();
      void openImageModal(item.src, item.originalPath ? { path: item.originalPath } : null,
        { width: item.width, height: item.height },
        { model: item.model, createdAt: item.timestamp, aspectRatio: item.aspectRatio, resolution: item.resolution, prompt: item.prompt });
    });

    this.grid.appendChild(div);
  }

  /** 4.2-C：视频历史卡（播放/复制提示词/存到资源/打开查看器；展示状态/模型/时长/远端任务）。 */
  private _renderVideoItem(item: HistoryItem): void {
    if (!this.grid) return;
    const div = document.createElement('div');
    div.className = 'history-thumb history-media';
    const url = item.mediaUrl || item.src || '';
    const hasPrompt = !!(item.prompt || '').trim();
    const duration = typeof item.duration === 'number' ? `${Math.round(item.duration)} 秒` : (typeof item.seconds === 'number' ? `${item.seconds} 秒` : '时长未知');
    const remote = item.remoteTaskId ? `远端 ${item.remoteTaskId.slice(0, 10)}…` : '';
    const state = this._taskStateLabel(item.taskState);
    div.innerHTML = `
      <div class="ht-media ht-media-media">
        <video class="ht-media-video" src="${escapeAttr(url)}" muted preload="metadata" playsinline></video>
        <span class="ht-media-badge">视频</span>
      </div>
      <div class="ht-media-meta">${escapeHtml([state, duration, remote].filter(Boolean).join(' · '))}</div>
      <div class="ht-actions ht-actions-static">
        <button class="ht-act" data-act="copy"${hasPrompt ? '' : ' disabled title="无提示词可复制"'}>复制提示词</button>
        <button class="ht-act" data-act="save-asset">存到资源</button>
        <button class="ht-act" data-act="open">打开查看器</button>
      </div>`;
    div.addEventListener('click', (e: MouseEvent) => {
      const btn = (e.target as Element).closest('.ht-act') as HTMLElement | null;
      if (btn) {
        e.preventDefault();
        e.stopPropagation();
        const act = btn.dataset.act || '';
        if (act === 'copy') this._copyPrompt(item.prompt || '');
        else if (act === 'save-asset') this._saveMediaToAsset(item);
        else if (act === 'open') {
          const nodeId = item.nodeId;
          if (nodeId && flowState.getNode(nodeId)?.video) {
            window.dispatchEvent(new CustomEvent('icv:open-video', { detail: { nodeId } }));
          } else {
            this._openMediaFallback(item);
          }
        }
      }
    });
    this.grid.appendChild(div);
  }

  /** 4.2-C：音频历史卡（播放/复制提示词/存到资源/打开查看器）。 */
  private _renderAudioItem(item: HistoryItem): void {
    if (!this.grid) return;
    const div = document.createElement('div');
    div.className = 'history-thumb history-media';
    const url = item.mediaUrl || item.src || '';
    const hasPrompt = !!(item.prompt || '').trim();
    const duration = typeof item.duration === 'number' ? `${Math.round(item.duration)} 秒` : (typeof item.seconds === 'number' ? `${item.seconds} 秒` : '时长未知');
    const remote = item.remoteTaskId ? `远端 ${item.remoteTaskId.slice(0, 10)}…` : '';
    const state = this._taskStateLabel(item.taskState);
    div.innerHTML = `
      <div class="ht-media ht-media-media ht-media-audio">
        <div class="ht-media-audio-wave">${this._waveHtml(18)}</div>
        <audio class="ht-media-audio-el" src="${escapeAttr(url)}" preload="none"></audio>
        <span class="ht-media-badge">音频</span>
      </div>
      <div class="ht-media-meta">${escapeHtml([state, duration, remote].filter(Boolean).join(' · '))}</div>
      <div class="ht-actions ht-actions-static">
        <button class="ht-act" data-act="copy"${hasPrompt ? '' : ' disabled title="无提示词可复制"'}>复制提示词</button>
        <button class="ht-act" data-act="save-asset">存到资源</button>
        <button class="ht-act" data-act="open">打开查看器</button>
      </div>`;
    div.addEventListener('click', (e: MouseEvent) => {
      const btn = (e.target as Element).closest('.ht-act') as HTMLElement | null;
      if (btn) {
        e.preventDefault();
        e.stopPropagation();
        const act = btn.dataset.act || '';
        if (act === 'copy') this._copyPrompt(item.prompt || '');
        else if (act === 'save-asset') this._saveMediaToAsset(item);
        else if (act === 'open') {
          const nodeId = item.nodeId;
          if (nodeId && flowState.getNode(nodeId)?.audio) {
            window.dispatchEvent(new CustomEvent('icv:open-audio', { detail: { nodeId } }));
          } else {
            this._openMediaFallback(item);
          }
        }
      }
    });
    this.grid.appendChild(div);
  }

  /** 媒体历史 → 资产库（kind 由条目决定；配方用 prompt/model）。 */
  private _saveMediaToAsset(item: HistoryItem): void {
    const url = item.mediaUrl || item.src || '';
    const path = item.mediaPath || item.originalPath || '';
    if (!url) return;
    flowHistory.record();
    const kind = item.kind === 'video' ? 'video' : 'audio';
    assetStore.addByMediaUrl(url, item.nodeId || '', kind, path || undefined, {
      prompt: item.prompt || undefined,
      model: item.model || undefined,
      createdAt: item.timestamp,
    }, {
      duration: item.duration, mimeType: item.mimeType,
      remoteTaskId: item.remoteTaskId,
    });
    showToast('已保存到资源');
  }

  /** 查看器恢复兜底：无对应节点时用历史条目字段直接播放。 */
  private _openMediaFallback(item: HistoryItem): void {
    const url = item.mediaUrl || item.src || '';
    if (!url) { showToast('媒体文件不可用', false); return; }
    const modal = document.createElement('div');
    modal.className = 'video-viewer-overlay';
    modal.innerHTML = `<section class="video-viewer-panel" role="dialog" aria-modal="true">
      <header><strong>${item.kind === 'video' ? '视频' : '音频'}查看器</strong><button data-act="close" title="关闭">×</button></header>
      ${item.kind === 'video' ? `<video class="video-viewer-media" src="${escapeAttr(url)}" controls playsinline></video>` : `<audio class="video-viewer-media" src="${escapeAttr(url)}" controls playsinline></audio>`}
      <div class="video-viewer-meta">${escapeHtml(item.prompt || item.model || '')}</div>
    </section>`;
    modal.addEventListener('click', e => {
      const t = e.target as HTMLElement;
      if (t === modal || t.dataset.act === 'close') modal.remove();
    });
    document.body.appendChild(modal);
  }

  private _taskStateLabel(state?: string): string {
    switch (state) {
      case 'succeeded': return '已完成';
      case 'failed': return '已失败';
      case 'uncertain': return '结果不确定';
      case 'processing': return '处理中';
      case 'accepted': return '已提交';
      default: return '';
    }
  }

  private _waveHtml(bars: number): string {
    let html = '';
    let seed = 5;
    const next = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let i = 0; i < bars; i++) {
      const h = Math.round(20 + next() * 60);
      html += `<i style="height:${h}%"></i>`;
    }
    return html;
  }

  /** 历史条目 → 素材节点落位用比例（优先记录比例，否则按展示图宽高推算，兜底 4/3） */
  private _ratioOf(item: HistoryItem): number | undefined {
    if (item.width && item.height && item.width > 0 && item.height > 0) return item.width / item.height;
    return undefined;
  }

  /** 历史条目 → AdoptMeta（保存到资源时带入配方；无配方字段返回 undefined，保持旧行为） */
  private _adoptMeta(item: HistoryItem): AdoptMeta | undefined {
    const meta: AdoptMeta = {
      prompt: item.prompt,
      model: item.model,
      aspectRatio: item.aspectRatio,
      resolution: item.resolution,
      count: typeof item.count === 'number' ? item.count : undefined,
      refImageUrls: Array.isArray(item.refImageUrls) && item.refImageUrls.length > 0 ? item.refImageUrls : undefined,
      refImageHashes: Array.isArray(item.refImageHashes) && item.refImageHashes.length > 0 ? item.refImageHashes : undefined,
      outputType: item.outputType,
      createdAt: item.timestamp,
    };
    const hasAny = !!meta.prompt || !!meta.model || !!meta.aspectRatio || !!meta.resolution
      || meta.count !== undefined
      || (Array.isArray(meta.refImageUrls) && meta.refImageUrls.length > 0)
      || (Array.isArray(meta.refImageHashes) && meta.refImageHashes.length > 0)
      || !!meta.outputType || !!meta.createdAt;
    return hasAny ? meta : undefined;
  }

  /** 按图 URL 反查 HistoryEntry（资产库复现 S9 用；本会话历史项未命中返回 null） */
  getEntryByImageUrl(url: string): HistoryEntry | null {
    if (!url) return null;
    const item = this.items.find(i => i.kind === 'image' && i.src === url);
    return item ? this._toEntry(item) : null;
  }

  /** 4.1-B @素材：历史图片条目只读快照（供 cmd-panel 资源选择器搜索/插入）。 */
  listImages(): HistoryItem[] {
    return this.items.filter(i => i.kind === 'image' && (i.src || i.thumbnail)).map(i => ({ ...i }));
  }

  /** 4.2-C：按节点查最近视频历史条目（video-viewer 从历史恢复用）。 */
  getVideoEntryByNode(nodeId: string): { originalPath?: string; videoUrl?: string; duration?: number } | null {
    const item = this.items.find(i => i.kind === 'video' && i.nodeId === nodeId);
    if (!item) return null;
    return { originalPath: item.mediaPath || item.originalPath, videoUrl: item.mediaUrl, duration: item.duration };
  }

  /** 4.2-C：按节点查最近音频历史条目（audio-viewer 从历史恢复用）。 */
  getAudioEntryByNode(nodeId: string): { originalPath?: string; audioUrl?: string; duration?: number } | null {
    const item = this.items.find(i => i.kind === 'audio' && i.nodeId === nodeId);
    if (!item) return null;
    return { originalPath: item.mediaPath || item.originalPath, audioUrl: item.mediaUrl, duration: item.duration };
  }

  /** 复制提示词（Clipboard API 优先，pywebview 旧内核/非安全上下文无 API 时兜底 execCommand；成功 toast） */
  private _copyPrompt(prompt: string): void {
    const text = (prompt || '').trim();
    if (!text) { showToast('无提示词可复制', false); return; }
    const done = () => showToast('提示词已复制');
    const fail = () => showToast('复制失败', false);
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      void navigator.clipboard.writeText(text).then(done, fail);
      return;
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      let copied = false;
      try {
        copied = document.execCommand('copy'); // WebView2 仍支持；返回 false 表示复制被拒
      } finally {
        // 无论如何都从 DOM 移除，避免残留隐藏 textarea
        document.body.removeChild(ta);
      }
      if (copied) done();
      else fail();
    } catch {
      fail();
    }
  }

  /** HistoryItem → HistoryEntry（资产库复现 S9 经 getEntryByImageUrl 反查用；会话内条目携带完整参数 + 缩略图/原图引用 + R3 batchId + 真实像素） */
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
      ...(typeof item.width === 'number' && item.width > 0 ? { imageWidth: item.width } : {}),
      ...(typeof item.height === 'number' && item.height > 0 ? { imageHeight: item.height } : {}),
    };
  }
}

/** 本地绝对路径 → file:// URL（与 video-viewer/audio-viewer 同构） */
function fileUrlFromPath(filePath: string): string {
  const normalized = String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  return normalized ? encodeURI(`file:///${normalized}`) : '';
}

/** 属性值转义（title 内嵌用户文本用） */
function escapeAttr(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const historyDrawer = new HistoryDrawer();
