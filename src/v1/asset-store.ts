// src/v1/asset-store.ts
// 采纳/锁定单一数据源（X1）：ImageAssetRecord 管理 + 订阅通知 + 持久化 + 撤销快照。
// 任何 UI（画布角标/图库/对比面板/资产库）只读写这一个 store，四处同步天然成立（X1）。
// 索引键 = 图指纹 hashRef(imageUrl)（唯一定位「一张图」而非「一个节点」）；nodeId 冗余供保护逻辑回溯。
// 持久化：主索引 <图片保存目录>/assets.json（未配置降级 APP_DIR/assets.json，原子写；incremental-3 起）。
// 写路径：adopt/unadopt/setLocked/addTags → 置 dirty（X2）+ notify + 防抖 300ms 落盘；撤销 applySnapshot 后立即落盘回退（X3）。
// 内存缓存：urlByKey（图 URL，资产库渲染用）/ metaByKey（采纳时刻元数据，复现 S9 用；不持久化）。

import { flowState } from './state/flow-state';
import { historyPersist } from './history-persist';
import { Backend } from './api';
import { showToast } from './ui/toast';

/** 落盘防抖间隔（ms）：采纳/锁定是高频小变更，合并写避免逐次 IO */
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

  /** 打开项目后恢复采纳/锁定（顺序：restore → clear → loadHistory → loadAssets → notify）；失败静默回退空索引 */
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
            this.records.set(rec.key, rec);
            if (rec.imageUrl) this.urlByKey.set(rec.key, rec.imageUrl);
          }
        });
        this.notify();
      } else {
        // empty / error：迁移策略 = 无索引 → 空（全未采纳/未锁定）
        this.notify();
      }
    } catch {
      this.records.clear();
      this.urlByKey.clear();
    }
  }

  // ───────────────────────── 写入口（唯一写路径） ─────────────────────────

  /** 采纳（认可 + 自动置锁定，B2）。imageUrl 采纳时写入（资产库显示用）；meta 内存缓存（复现 S9 用） */
  adopt(key: string, nodeId: string, imageUrl?: string, meta?: AdoptMeta): void {
    const rec = this._getOrCreate(key, nodeId, imageUrl);
    if (imageUrl) this.urlByKey.set(key, imageUrl);
    if (meta) this.metaByKey.set(key, meta);
    if (rec.adopted) return;
    rec.adopted = true;
    rec.locked = true; // 采纳 = 认可 + 保护
    rec.updatedAt = Date.now();
    this._appendProjectName(rec); // A5：记录采纳时所在项目名（跨项目溯源）
    this._afterChange();
  }

  /** 取消采纳（仅撤 adopted；锁定状态保留——用户可单独锁定未采纳的图） */
  unadopt(key: string): void {
    const rec = this.records.get(key);
    if (!rec || !rec.adopted) return;
    rec.adopted = false;
    rec.updatedAt = Date.now();
    this._afterChange();
  }

  /** 锁定/解锁（未采纳的图也可单独锁定，B3）。对无记录图解锁时直接返回，不产生无意义空记录（QA O3）。 */
  setLocked(key: string, nodeId: string, locked: boolean, imageUrl?: string): void {
    let rec = this.records.get(key);
    if (!rec) {
      if (!locked) return; // 无记录且要解锁：无事可做，不建空记录
      rec = this._getOrCreate(key, nodeId, imageUrl);
    } else if (nodeId) {
      // nodeId 冗余：图当前所在节点可能已变化，随写更新（与 _getOrCreate 一致，空串不覆盖防误清）
      rec.nodeId = nodeId;
    }
    if (imageUrl) this.urlByKey.set(key, imageUrl);
    if (rec.locked === locked) return;
    rec.locked = locked;
    rec.updatedAt = Date.now();
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

  /** 按图 URL 采纳（内部转 key + 写 imageUrl，S3 资产库缩略图数据源） */
  adoptByUrl(url: string, nodeId: string, meta?: AdoptMeta): void {
    if (!url) return;
    this.adopt(this._keyOf(url), nodeId, url, meta);
  }

  /** 按图 URL 取消采纳 */
  unadoptByUrl(url: string): void {
    if (!url) return;
    const rec = this.getByImageUrl(url);
    if (rec) this.unadopt(rec.key);
  }

  /** 按图 URL 锁定/解锁 */
  setLockedByUrl(url: string, nodeId: string, locked: boolean): void {
    if (!url) return;
    this.setLocked(this._keyOf(url), nodeId, locked, url);
  }

  /** 按图 URL 追加标签 */
  addTagsByUrl(url: string, tags: string[]): void {
    if (!url) return;
    const rec = this.getByImageUrl(url);
    if (rec) this.addTags(rec.key, tags);
  }

  // ───────────────────────── 查询（UI 判定一律走这里） ─────────────────────────

  isAdoptedByImageUrl(url: string): boolean {
    const rec = this.getByImageUrl(url);
    return !!rec && rec.adopted;
  }

  isLockedByImageUrl(url: string): boolean {
    const rec = this.getByImageUrl(url);
    return !!rec && rec.locked;
  }

  /** 冗余回溯：按 nodeId 查锁定（保护逻辑里节点可能已被遍历但 imageUrl 变更/清空） */
  isLockedNode(nodeId: string): boolean {
    if (!nodeId) return false;
    for (const rec of this.records.values()) {
      if (rec.nodeId === nodeId && rec.locked) return true;
    }
    return false;
  }

  getByImageUrl(url: string): ImageAssetRecord | null {
    if (!url) return null;
    const key = this._keyOf(url);
    const rec = this.records.get(key);
    if (rec) this.urlByKey.set(key, url); // 读路径反哺内存缓存：旧记录无 imageUrl 时资产库仍可显示
    return rec ?? null;
  }

  /** 已采纳资产列表（S3：adopted=true，按 updatedAt 倒序）；url 优先级 = record.imageUrl → urlByKey 缓存 */
  getAdoptedAssets(): AssetAsset[] {
    const list: AssetAsset[] = [];
    this.records.forEach(rec => {
      if (!rec.adopted) return;
      list.push({
        record: { ...rec, tags: [...rec.tags], projectName: [...(rec.projectName || [])] },
        url: rec.imageUrl || this.urlByKey.get(rec.key) || '',
        meta: this.metaByKey.get(rec.key),
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

  /** 撤销/重做恢复：整体替换 records + notify + 立即落盘回退索引文件（X3 验收「撤销采纳后索引文件回退」） */
  applySnapshot(snap: AssetSnapshot): void {
    this.records.clear();
    this.urlByKey.clear();
    (snap.records || []).forEach(r => {
      if (r && typeof r.key === 'string') {
        const rec = this._normalize(r);
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

  private _getOrCreate(key: string, nodeId: string, imageUrl?: string): ImageAssetRecord {
    const existing = this.records.get(key);
    if (existing) {
      // nodeId 冗余：图当前所在节点可能已变化，随写更新
      if (nodeId) existing.nodeId = nodeId;
      // imageUrl 只在采纳/锁定时写入：旧记录缺失时补全，已有值不覆盖（共享知识 6）
      if (imageUrl && !existing.imageUrl) existing.imageUrl = imageUrl;
      if (imageUrl) this.urlByKey.set(key, imageUrl);
      return existing;
    }
    const rec: ImageAssetRecord = {
      key,
      nodeId: nodeId || '',
      imageUrl: imageUrl || '',
      projectName: [],
      adopted: false,
      locked: false,
      tags: [],
      category: '成图', // B8 P2：分类预留，默认 '成图'，本期不渲染分类 UI
      updatedAt: Date.now(),
    };
    this.records.set(key, rec);
    if (imageUrl) this.urlByKey.set(key, imageUrl);
    return rec;
  }

  /** 从磁盘记录归一（兼容脏数据/旧格式：缺 imageUrl → ''、缺 projectName → []，共享知识 6） */
  private _normalize(r: ImageAssetRecord): ImageAssetRecord {
    return {
      key: typeof r.key === 'string' ? r.key : String(r.key || ''),
      nodeId: typeof r.nodeId === 'string' ? r.nodeId : '',
      imageUrl: typeof r.imageUrl === 'string' ? r.imageUrl : '',
      projectName: Array.isArray(r.projectName) ? r.projectName.filter(n => typeof n === 'string') : [],
      adopted: !!r.adopted,
      locked: !!r.locked,
      tags: Array.isArray(r.tags) ? r.tags.filter(t => typeof t === 'string') : [],
      category: typeof r.category === 'string' && r.category ? r.category : '成图',
      updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : Date.now(),
    };
  }

  /** A5：采纳时把当前项目名追加进 projectName（去重追加，不删除） */
  private _appendProjectName(rec: ImageAssetRecord): void {
    const name = flowState.projectName || '未命名项目';
    if (name && !rec.projectName.includes(name)) rec.projectName.push(name);
  }

  /** 变更后统一动作：置 dirty（X2）+ 双 notify + 防抖落盘 */
  private _afterChange(): void {
    // X2：采纳/锁定变更计入 dirty（顶栏「未保存」亮起）；dirty 复位仅发生在保存成功或 replaceAll（沿用信任层约定）
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
