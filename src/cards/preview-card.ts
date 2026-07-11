// src/cards/preview-card.ts
// 预览卡片 — 展示生成的图片

import { BaseCard } from './base-card';
import { CardContract, CardOptions } from '../types/cards';

declare const CardEventBus: { EventTypes: { RUN_COMPLETED: string; DATA_CHANGED: string }; emit(type: string, payload: unknown): void };
declare const ImageModal: { open(src: string): void };
declare const LazyLoader: { observe(img: HTMLImageElement): void };
declare const API: {
  loadLocalImage(path: string): Promise<{ status: string; data_url?: string; message?: string }>;
  saveImageAs(data: unknown): Promise<{ status: string; path?: string; message?: string }>;
};
declare const Toast: { show(msg: string, dur?: number): void };
declare const CardFactory: { getInstance(id: string): unknown };

export class PreviewCard extends BaseCard {
  content: string = '';
  thumbnail: string = '';
  imageMeta: Record<string, unknown> | null = null;
  fullLoaded: boolean = false;
  protected _displayDataUrl: string = '';
  protected _pendingSrc: string = '';
  protected _isRendering: boolean = false;

  constructor(options: CardOptions = {}) {
    super({ width: '400px', height: '300px', title: 'Preview', ...options });
    this.content = options.content || '';
    this.thumbnail = String(options.thumbnail || '');
    this.imageMeta = (options.imageMeta as Record<string, unknown>) || null;
  }

  getType(): string { return 'preview'; }

  static override getContract(): CardContract {
    return {
      outputs: [{ name: 'default', type: 'image' }],
      inputs: [{ name: 'default', type: 'image' }]
    };
  }

  override getOutput(outputName = 'default'): unknown {
    if (outputName === 'default') {
      return this.content || this._displayDataUrl || null;
    }
    return null;
  }

  override onReceive(type: 'text' | 'image', data: unknown, _source = 'upstream'): void {
    if (type === 'image' && data) {
      this.setImage(String(data));
    }
  }

  override renderContent(): string {
    if (this.content) {
      const imgSrc = this.thumbnail || this.content;
      return `
        <div class="preview-image-wrap">
            <img src="${imgSrc}"
                 class="image-content lazy-image"
                 data-full="${this.content}"
                 style="object-fit: contain; cursor: pointer;">
            ${this._renderHoverToolbar()}
            ${this._renderMeta()}
        </div>
      `;
    }
    return `
      <div class="preview-placeholder">
          <i class="fas fa-eye" style="font-size:48px; margin-bottom:10px;"></i>
          <div>等待 AI 绘图卡片生成图片</div>
      </div>
    `;
  }

  override createElement(): HTMLElement {
    const el = super.createElement();

    if (this.content && this._isLocalFile(this.content)) {
      this._loadFromLocalPath(this.content);
    }

    const wrap = el.querySelector('.preview-image-wrap');
    if (wrap && this.content) {
      wrap.addEventListener('dblclick', e => {
        e.stopPropagation();
        this._showFullImage();
      });
    }

    const img = el.querySelector('.image-content') as HTMLImageElement | null;
    if (img && (window as unknown as { LazyLoader?: { observe(img: HTMLImageElement): void } }).LazyLoader) {
      (window as unknown as { LazyLoader: { observe(img: HTMLImageElement): void } }).LazyLoader.observe(img);
    }

    this._bindHoverToolbar(el);
    return el;
  }

  private _bindHoverToolbar(el: HTMLElement): void {
    const btn = el.querySelector('[data-action="download"]') as HTMLElement | null;
    btn?.addEventListener('click', () => {
      PreviewCard.downloadAs(this.id);
    });
  }

  setImage(src: string, meta: Record<string, unknown> | null = null): void {
    if (meta) this.imageMeta = meta;

    this._displayDataUrl = '';
    this._pendingSrc = src;
    this.content = src;

    this._renderImage(src, this.imageMeta);

    requestAnimationFrame(() => {
      this._processImageAsync(src);
    });

    this.notifyDownstream();
  }

  private async _processImageAsync(_originalSrc: string): Promise<void> {
    // 保存由后端 UnifiedAPIRouter 负责，此处仅处理渲染后逻辑
  }

  private async _loadFromLocalPath(filePath: string): Promise<void> {
    try {
      const result = await API.loadLocalImage(filePath);
      if (result.status === 'success' && result.data_url) {
        this._displayDataUrl = result.data_url;
        this.setImage(result.data_url);
      } else {
        console.warn('[PreviewCard] 加载本地图片失败:', result.message);
        this._renderError();
      }
    } catch (e) {
      console.warn('[PreviewCard] 加载本地图片异常:', e);
      this._renderError();
    }
  }

  _renderImage(src: string, meta: Record<string, unknown> | null = null): void {
    if (this._isRendering) return;
    this._isRendering = true;

    try {
      const body = this.element?.querySelector('.card-body') as HTMLElement | null;
      if (!body) return;

      const displaySrc = src || '';
      const dataFull = (this.content || src || '').replace(/"/g, '&quot;');
      body.innerHTML = `
        <div class="preview-image-wrap" data-has-content="${this.content ? '1' : '0'}">
            <img class="image-content lazy-image"
                 data-full="${dataFull}"
                 style="object-fit: contain; cursor: pointer;">
            ${this._renderHoverToolbar()}
            ${this._renderMeta(meta)}
        </div>
      `;

      const img = body.querySelector('.image-content') as HTMLImageElement | null;
      if (img) {
        img.setAttribute('src', displaySrc);
        const ll = (window as unknown as { LazyLoader?: { observe(img: HTMLImageElement): void } }).LazyLoader;
        if (ll) ll.observe(img);
      }

      const wrap = body.querySelector('.preview-image-wrap') as HTMLElement | null;
      if (wrap && this.content) {
        wrap.addEventListener('dblclick', e => {
          e.stopPropagation();
          this._showFullImage();
        });
      }
    } finally {
      this._isRendering = false;
    }
  }

  _renderMeta(meta?: Record<string, unknown> | null): string {
    const m = meta || this.imageMeta;
    if (!m) return '';

    const res = m.resolution ? String(m.resolution).toUpperCase() : '';
    const ar = (m.aspectRatio && m.aspectRatio !== 'Auto') ? String(m.aspectRatio) : '';
    let time = '';
    if (m.generatedAt) {
      try {
        time = new Date(Number(m.generatedAt)).toLocaleTimeString('zh-CN', {
          hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
      } catch {}
    }

    const parts = [res, ar, time].filter(Boolean);
    if (!parts.length) return '';

    return `
      <div class="preview-meta-bar">
          ${res ? `<span class="preview-meta-res">${res}</span>` : ''}
          ${ar ? `<span class="preview-meta-ar">${ar}</span>` : ''}
          ${time ? `<span class="preview-meta-time">${time}</span>` : ''}
      </div>
    `;
  }

  _renderError(): void {
    const body = this.element?.querySelector('.card-body') as HTMLElement | null;
    if (!body) return;
    body.innerHTML = `
      <div class="preview-placeholder">
          <i class="fas fa-exclamation-triangle" style="font-size:48px; margin-bottom:10px; color:#f59e0b;"></i>
          <div>图片文件已丢失</div>
      </div>
    `;
  }

  _showFullImage(): void {
    if (!this.content) {
      console.warn('[PreviewCard] 无法显示大图：content 为空');
      return;
    }

    const im = (window as unknown as { ImageModal?: { open(src: string): void } }).ImageModal;
    if (im) {
      if (this._isLocalFile(this.content) && this._displayDataUrl) {
        im.open(this._displayDataUrl);
        return;
      }
      if (!this._isLocalFile(this.content)) {
        im.open(this.content);
        return;
      }
      this._showFullImageFromFile(this.content);
      return;
    }

    // Fallback
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.9);z-index:10000;display:flex;align-items:center;justify-content:center;cursor:pointer;';
    const img = document.createElement('img');
    img.src = this.content;
    img.style.cssText = 'max-width:90%;max-height:90%;object-fit:contain;';
    modal.appendChild(img);
    modal.addEventListener('click', () => modal.remove());
    document.body.appendChild(modal);
  }

  private async _showFullImageFromFile(filePath: string): Promise<void> {
    try {
      const result = await API.loadLocalImage(filePath);
      if (result.status === 'success' && result.data_url) {
        this._displayDataUrl = result.data_url;
        (window as unknown as { ImageModal: { open(src: string): void } }).ImageModal.open(result.data_url);
      } else {
        console.warn('[PreviewCard] 加载本地图片失败:', result.message);
      }
    } catch (e) {
      console.error('[PreviewCard] 加载大图失败:', e);
    }
  }

  _renderHoverToolbar(): string {
    return `
      <div class="preview-hover-toolbar">
          <button class="preview-action-btn" title="另存为到其他文件夹" data-action="download">
              <i class="fas fa-download"></i>
              <span>下载</span>
          </button>
      </div>
    `;
  }

  static async downloadAs(cardId: string): Promise<void> {
    const card = CardFactory.getInstance(cardId) as PreviewCard | null;
    if (!card || !card.content) {
      console.warn('[PreviewCard] 无法下载：卡片或内容为空');
      return;
    }

    let imageData = card._displayDataUrl || card.content;

    if (card._isLocalFile(card.content) && !card._displayDataUrl) {
      try {
        const result = await API.loadLocalImage(card.content);
        if (result.status === 'success' && result.data_url) {
          imageData = result.data_url;
        } else {
          Toast.show('图片加载失败，尝试直接保存', 2000);
        }
      } catch {
        Toast.show('图片加载失败，尝试直接保存', 2000);
      }
    }

    try {
      const result = await API.saveImageAs(imageData);
      if (result.status === 'success') {
        Toast.show('图片已保存到: ' + result.path, 3000);
      } else if (result.status !== 'cancelled') {
        Toast.show('保存失败: ' + (result.message || '未知错误'), 3000);
      }
    } catch (e) {
      Toast.show('保存失败: ' + e, 3000);
    }
  }

  override serialize() {
    const base = super.serialize();
    return {
      ...base,
      content: this.content || '',
      thumbnail: this.thumbnail || '',
      imageMeta: this.imageMeta || null
    };
  }

  private _isLocalFile(path: string): boolean {
    if (!path) return false;
    return (
      path.startsWith('file://') ||
      path.startsWith('file:///') ||
      path.startsWith('/') ||
      /^[A-Za-z]:/.test(path)
    );
  }
}
