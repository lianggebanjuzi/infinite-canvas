// src/v1/asset-store.ts
// 资产库单一数据源：ImageAssetRecord 管理 + 订阅通知 + 持久化 + 撤销快照。
// 任何 UI（画布角标/图库/对比面板/资产库）只读写这一个 store，四处同步天然成立（X1）。
// 索引键 = 图指纹 hashRef(imageUrl)（唯一定位「一张图」而非「一个节点」）。
// 持久化：主索引 <图片保存目录>/assets.json（未配置降级 APP_DIR/assets.json，原子写；incremental-3 起）。
// 写路径：add/remove/addTags → 置 dirty + notify + 防抖 300ms 落盘；撤销 applySnapshot 后立即落盘回退。
// 内存缓存：urlByKey（图 URL，资产库渲染用）/ metaByKey（添加时刻元数据，复现用；不持久化）。

import { flowState } from './state/flow-state';
import { historyPersist } from './history-persist';
import { Backend } from './api';
import { showToast } from './ui/toast';

/** 落盘防抖间隔（ms）：小变更合并写避免逐次 IO */
const PERSIST_DEBOUNCE_MS = 300;

/** 未配置图片保存路径的降级提示（共享知识 3：人话常量，禁止改字面量） */
const TOAST_DEGRADED = '请先在设置中配置图片保存路径';

class AssetStore {
  private records = new Map<string, ImageAssetRecord>();
  private urlByKey = new Map<string, string>();
  private metaByKey = new Map<string, AdoptMeta>();
  private listeners = new Set<() => void>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private inited = false;

  init(): void {
    if (this.inited) return;
    this.inited = true;
    // 无额外初始化动作：打开项目后由 persistence.open 调 loadFromBackend()
  }

  /** 打开项目后恢复资产库；失败静默回退空索引。 */
  async loadFromBackend(): Promise<void> {
    try {
      const res = await Backend.loadAssets();
      this.records.clear();
      this.urlByKey.clear();
      this.metaByKey.clear();
      if (res.status === 'success' && Array.isArray(res.records)) {
        res.records.forEach(r => {
          if (r && typeof r.key === 'string') {
            const rec = this._normalize(r);
            // 兼容旧数据：过去移除会留下 adopted=false 的记录，加载时将它视为已移除。
            if (r.added === false || r.adopted === false) return;
            this.records.set(rec.key, rec);
            if (rec.imageUrl) this.urlByKey.set(rec.key, rec.imageUrl);
          }
        });
        this.notify();
      } else {
        // empty / error：迁移策略 = 无索引 → 空资产库
        this.notify();
      }
    } catch {
      this.records.clear();
      this.urlByKey.clear();
    }
  }

  // ───────────────────────── 写入口（唯一写路径） ─────────────────────────

  /** 添加到资产库。imageUrl 写入（资产库显示用）；originalPath 写入原图引用；
   *  meta 添加时元数据：除写内存 metaByKey 外，还会把配方字段合并写入记录本体（_applyRecipe），
   *  随现有 300ms 防抖落盘 assets.json，成为跨项目/跨会话的持久化真相（见 AdoptMeta 注释）。 */
  add(key: string, nodeId: string, imageUrl?: string, originalPath?: string, meta?: AdoptMeta): void {
    const rec = this._getOrCreate(key, nodeId, imageUrl, originalPath);
    if (imageUrl) this.urlByKey.set(key, imageUrl);
    // 重复添加也刷新配方。
    if (meta) {
      this.metaByKey.set(key, meta);
      this._applyRecipe(rec, meta);
    }
    rec.added = true;
    rec.updatedAt = Date.now();
    this._appendProjectName(rec);
    this._afterChange();
  }

  /** 从资产库移除。删除记录而不是保留隐藏状态。 */
  remove(key: string): void {
    if (!this.records.delete(key)) return;
    this.urlByKey.delete(key);
    this.metaByKey.delete(key);
    this._afterChange();
  }

  /** 追加标签（B6 P1；搜索纳入） */
  addTags(key: string, tags: string[]): void {
    const rec = this.records.get(key);
    if (!rec) return;
    const merged = [...rec.tags];
    (tags || []).forEach(t => {
      const trimmed = String(t || '').trim();
      if (trimmed && !merged.includes(trimmed)) merged.push(trimmed);
    });
    if (merged.length === rec.tags.length) return;
    rec.tags = merged;
    rec.updatedAt = Date.now();
    this._afterChange();
  }

  // ───────────────────────── URL 便捷入口（UI 层统一走这里，禁止手算 hash） ─────────────────────────

  /** 按图 URL 添加（内部转 key + 写 imageUrl/缩略图/原图引用）。 */
  addByUrl(url: string, nodeId: string, meta?: AdoptMeta, originalPath?: string): void {
    if (!url) return;
    this.add(this._keyOf(url), nodeId, url, originalPath, meta);
  }

  /** 按图 URL 从资产库移除。 */
  removeByUrl(url: string): void {
    if (!url) return;
    const rec = this.getByImageUrl(url);
    if (rec) this.remove(rec.key);
  }

  /** 按图 URL 追加标签 */
  addTagsByUrl(url: string, tags: string[]): void {
    if (!url) return;
    const rec = this.getByImageUrl(url);
    if (rec) this.addTags(rec.key, tags);
  }

  // ───────────────────────── 配方构造（添加/读侧共享） ─────────────────────────

  /** 从生成节点构造添加元数据（写侧）：node.trace 优先（source of truth），缺失时 node.params 兜底；
   *  无可用配方返回 undefined（调用方传 undefined = 不写配方，保持旧行为）。 */
  metaFromNode(node: FlowNode | null | undefined): AdoptMeta | undefined {
    if (!node) return undefined;
    const t = node.trace;
    if (t) {
      return {
        prompt: typeof t.prompt === 'string' ? t.prompt : undefined,
        model: typeof t.model === 'string' ? t.model : undefined,
        aspectRatio: typeof t.aspectRatio === 'string' ? t.aspectRatio : undefined,
        resolution: typeof t.resolution === 'string' ? t.resolution : undefined,
        count: typeof t.count === 'number' ? t.count : undefined,
        refImageUrls: Array.isArray(t.refImageUrls) ? t.refImageUrls.filter((u): u is string => typeof u === 'string') : undefined,
        refImageHashes: Array.isArray(t.refImageHashes) ? t.refImageHashes.filter((h): h is string => typeof h === 'string') : undefined,
        outputType: typeof t.outputType === 'string' ? t.outputType : undefined,
        createdAt: typeof t.createdAt === 'number' ? t.createdAt : undefined,
      };
    }
    // 无 trace 兜底：params（无 prompt 即无可用配方）
    const p = (node.params || {}) as unknown as StyleTransferParams;
    const prompt = typeof p.prompt === 'string' ? p.prompt : '';
    if (!prompt) return undefined;
    const refs = Array.isArray(node.refImages) ? node.refImages.filter((u): u is string => typeof u === 'string') : [];
    return {
      prompt,
      model: typeof p.model === 'string' ? p.model : undefined,
      aspectRatio: typeof p.aspectRatio === 'string' ? p.aspectRatio : undefined,
      resolution: typeof p.resolution === 'string' ? p.resolution : undefined,
      count: typeof p.count === 'number' ? p.count : undefined,
      refImageUrls: refs.length > 0 ? refs : undefined,
      refImageHashes: refs.length > 0 ? refs.map(u => historyPersist.hashRef(u)) : undefined,
      outputType: undefined,
      createdAt: undefined,
    };
  }

  /** 从资产记录配方字段合成 AdoptMeta（R2 读侧：记录 = 持久化真相；无配方字段返回 undefined 走反查兜底） */
  recipeFromRecord(rec: ImageAssetRecord): AdoptMeta | undefined {
    const meta: AdoptMeta = {
      prompt: typeof rec.prompt === 'string' ? rec.prompt : undefined,
      model: typeof rec.model === 'string' ? rec.model : undefined,
      aspectRatio: typeof rec.aspectRatio === 'string' ? rec.aspectRatio : undefined,
      resolution: typeof rec.resolution === 'string' ? rec.resolution : undefined,
      count: typeof rec.count === 'number' ? rec.count : undefined,
      refImageUrls: Array.isArray(rec.refImageUrls) ? rec.refImageUrls.filter((u): u is string => typeof u === 'string') : undefined,
      refImageHashes: Array.isArray(rec.refImageHashes) ? rec.refImageHashes.filter((h): h is string => typeof h === 'string') : undefined,
      outputType: typeof rec.outputType === 'string' ? rec.outputType : undefined,
      createdAt: typeof rec.createdAt === 'number' ? rec.createdAt : undefined,
    };
    const hasAny = meta.prompt !== undefined
      || meta.model !== undefined
      || meta.aspectRatio !== undefined
      || meta.resolution !== undefined
      || meta.count !== undefined
      || (Array.isArray(meta.refImageUrls) && meta.refImageUrls.length > 0)
      || (Array.isArray(meta.refImageHashes) && meta.refImageHashes.length > 0)
      || meta.outputType !== undefined
      || meta.createdAt !== undefined;
    return hasAny ? meta : undefined;
  }

  // ───────────────────────── 查询（UI 判定一律走这里） ─────────────────────────

  isAddedByImageUrl(url: string): boolean {
    return !!this.getByImageUrl(url);
  }

  getByImageUrl(url: string): ImageAssetRecord | null {
    if (!url) return null;
    const key = this._keyOf(url);
    const rec = this.records.get(key);
    if (rec) this.urlByKey.set(key, url); // 读路径反哺内存缓存：旧记录无 imageUrl 时资产库仍可显示
    return rec ?? null;
  }

  /** 资产列表（按 updatedAt 倒序）；url 优先级 = record.imageUrl → urlByKey 缓存；
   *  thumbnailUrl = record.thumbnail || url（缩略图优先）；originalPath = 原图引用；
   *  meta = 会话缓存优先，未命中时由记录配方合成（R2：跨会话 meta 不空，记录 = 持久化真相） */
  getAssets(): AssetAsset[] {
    const list: AssetAsset[] = [];
    this.records.forEach(rec => {
      const url = rec.imageUrl || this.urlByKey.get(rec.key) || '';
      list.push({
        record: { ...rec, tags: [...rec.tags], projectName: [...(rec.projectName || [])] },
        url,
        thumbnailUrl: rec.thumbnail || rec.imageUrl || this.urlByKey.get(rec.key) || '',
        originalPath: typeof rec.originalPath === 'string' ? rec.originalPath : undefined,
        meta: this.metaByKey.get(rec.key) ?? this.recipeFromRecord(rec),
      });
    });
    list.sort((a, b) => b.record.updatedAt - a.record.updatedAt);
    return list;
  }

  /** 全量记录（持久化用；副本数组，改它不影响 store） */
  list(): ImageAssetRecord[] {
    return [...this.records.values()].map(r => ({
      ...r,
      tags: [...r.tags],
      projectName: [...(r.projectName || [])],
    }));
  }

  // ───────────────────────── 撤销接入（X3） ─────────────────────────

  captureSnapshot(): AssetSnapshot {
    return { records: this.list() };
  }

  /** 撤销/重做恢复：整体替换 records + notify + 立即落盘回退索引文件。 */
  applySnapshot(snap: AssetSnapshot): void {
    this.records.clear();
    this.urlByKey.clear();
    (snap.records || []).forEach(r => {
      if (r && typeof r.key === 'string') {
        const rec = this._normalize(r);
        if (r.added === false || r.adopted === false) return;
        this.records.set(rec.key, rec);
        if (rec.imageUrl) this.urlByKey.set(rec.key, rec.imageUrl);
      }
    });
    this.notify();
    void this.persistNow();
  }

  // ───────────────────────── 订阅 ─────────────────────────

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  notify(): void {
    this.listeners.forEach(fn => {
      try { fn(); } catch { /* 单个订阅者异常不影响整体 */ }
    });
  }

  // ───────────────────────── 持久化（X2） ─────────────────────────

  /** 立即落盘（项目保存成功路径幂等兜底 + 撤销回退） */
  persistNow(): Promise<void> {
    return this._persist();
  }

  private _getOrCreate(key: string, nodeId: string, imageUrl?: string, originalPath?: string): ImageAssetRecord {
    const existing = this.records.get(key);
    if (existing) {
      // nodeId 冗余：图当前所在节点可能已变化，随写更新
      if (nodeId) existing.nodeId = nodeId;
      // imageUrl 仅在添加时写入：旧记录缺失时补全，已有值不覆盖。
      if (imageUrl && !existing.imageUrl) existing.imageUrl = imageUrl;
      if (imageUrl) this.urlByKey.set(key, imageUrl);
      // 缩略图=展示图 URL；原图引用首写不覆盖（图片性能优化）
      if (imageUrl && !existing.thumbnail) existing.thumbnail = imageUrl;
      if (originalPath && !existing.originalPath) existing.originalPath = originalPath;
      return existing;
    }
    const rec: ImageAssetRecord = {
      key,
      nodeId: nodeId || '',
      imageUrl: imageUrl || '',
      thumbnail: imageUrl || '',
      originalPath: originalPath || '',
      projectName: [],
      added: true,
      tags: [],
      category: '成图', // B8 P2：分类预留，默认 '成图'，本期不渲染分类 UI
      updatedAt: Date.now(),
    };
    this.records.set(key, rec);
    if (imageUrl) this.urlByKey.set(key, imageUrl);
    return rec;
  }

  /** 从磁盘记录归一（兼容脏数据/旧格式：缺 imageUrl → ''、缺 projectName → []，共享知识 6；缩略图/原图引用缺省；
   *  R2 配方字段容错：缺失/坏类型 → undefined，不报错（旧 assets.json 无配方字段可正常加载） */
  private _normalize(r: ImageAssetRecord): ImageAssetRecord {
    return {
      key: typeof r.key === 'string' ? r.key : String(r.key || ''),
      nodeId: typeof r.nodeId === 'string' ? r.nodeId : '',
      imageUrl: typeof r.imageUrl === 'string' ? r.imageUrl : '',
      thumbnail: typeof r.thumbnail === 'string' ? r.thumbnail : '',
      originalPath: typeof r.originalPath === 'string' ? r.originalPath : '',
      projectName: Array.isArray(r.projectName) ? r.projectName.filter(n => typeof n === 'string') : [],
      added: true,
      tags: Array.isArray(r.tags) ? r.tags.filter(t => typeof t === 'string') : [],
      category: typeof r.category === 'string' && r.category ? r.category : '成图',
      updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : Date.now(),
      // R2 配方字段：字符串 → 非 string 置 undefined；数组 → Array.isArray 过滤 string；count/createdAt → number 校验
      prompt: typeof r.prompt === 'string' ? r.prompt : undefined,
      model: typeof r.model === 'string' ? r.model : undefined,
      aspectRatio: typeof r.aspectRatio === 'string' ? r.aspectRatio : undefined,
      resolution: typeof r.resolution === 'string' ? r.resolution : undefined,
      count: typeof r.count === 'number' ? r.count : undefined,
      refImageUrls: Array.isArray(r.refImageUrls) ? r.refImageUrls.filter((u): u is string => typeof u === 'string') : undefined,
      refImageHashes: Array.isArray(r.refImageHashes) ? r.refImageHashes.filter((h): h is string => typeof h === 'string') : undefined,
      outputType: typeof r.outputType === 'string' ? r.outputType : undefined,
      createdAt: typeof r.createdAt === 'number' ? r.createdAt : undefined,
    };
  }

  /** 把添加时元数据合并写入记录本体（仅覆盖非 undefined 字段；数组拷贝，不整体替换）。 */
  private _applyRecipe(rec: ImageAssetRecord, meta: AdoptMeta): void {
    if (typeof meta.prompt === 'string') rec.prompt = meta.prompt;
    if (typeof meta.model === 'string') rec.model = meta.model;
    if (typeof meta.aspectRatio === 'string') rec.aspectRatio = meta.aspectRatio;
    if (typeof meta.resolution === 'string') rec.resolution = meta.resolution;
    if (typeof meta.count === 'number') rec.count = meta.count;
    if (Array.isArray(meta.refImageUrls)) {
      rec.refImageUrls = meta.refImageUrls.filter((u): u is string => typeof u === 'string');
    }
    if (Array.isArray(meta.refImageHashes)) {
      rec.refImageHashes = meta.refImageHashes.filter((h): h is string => typeof h === 'string');
    }
    if (typeof meta.outputType === 'string') rec.outputType = meta.outputType;
    if (typeof meta.createdAt === 'number') rec.createdAt = meta.createdAt;
  }

  /** 添加时把当前项目名追加进 projectName（去重追加，不删除） */
  private _appendProjectName(rec: ImageAssetRecord): void {
    const name = flowState.projectName || '未命名项目';
    if (name && !rec.projectName.includes(name)) rec.projectName.push(name);
  }

  /** 变更后统一动作：置 dirty（X2）+ 双 notify + 防抖落盘 */
  private _afterChange(): void {
    // 资产库变更计入 dirty（顶栏「未保存」亮起）。
    flowState.dirty = true;
    flowState.updatedAt = Date.now();
    flowState.notify();
    this.notify();
    this._persistDebounced();
  }

  private _persistDebounced(): void {
    if (this.persistTimer !== null) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this._persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  private async _persist(): Promise<void> {
    try {
      const res = await Backend.saveAssets(this.list());
      if (res.status !== 'success') {
        showToast('资产索引保存失败', false);
      } else if (res.degraded) {
        // A2：未配置图片保存路径 → 数据已降级写入 APP_DIR，人话提示引导配置（不得静默失败、不得出现 no_path）
        showToast(res.message || TOAST_DEGRADED, false);
      }
    } catch {
      showToast('资产索引保存失败', false);
    }
  }

  private _keyOf(url: string): string {
    return historyPersist.hashRef(url);
  }
}

export const assetStore = new AssetStore();
