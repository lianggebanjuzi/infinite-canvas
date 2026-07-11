// src/cards/image-input-card.ts
// 图片输入卡片

import { BaseCard } from './base-card';
import { CardContract, CardOptions } from '../types/cards';
import { AppState } from '../state/app-state';

declare const CardFactory: { getInstance(id: string): { getType?(): string; removeRefImage?(id: string): void } | null };
declare const ConnectionManager: { updateCardConnections(id: string): void };
declare const CardEventBus: { EventTypes: { DATA_CHANGED: string }; emit(type: string, payload: unknown): void };
declare const CmdManager: { execute(cmd: unknown): void };
declare const ModifyContentCommand: any;
declare const API: { saveImageAs(data: unknown): Promise<{ status: string; path?: string; message?: string }>; loadLocalImage(path: string): Promise<{ status: string; data_url?: string; message?: string }> };
declare const Toast: { show(msg: string, dur?: number): void };

export class ImageInputCard extends BaseCard {
  content: string = '';
  maskData: string | null = null;
  protected _displayDataUrl?: string;

  constructor(options: CardOptions = {}) {
    super({ width: '240px', height: '200px', title: 'Image', ...options });
    this.content = options.content || '';
    this.maskData = ((options as unknown as Record<string, unknown>).maskData as string) || null;
  }

  getType(): string { return 'image'; }

  static override getContract(): CardContract {
    return {
      outputs: [{ name: 'default', type: 'image' }],
      inputs: []
    };
  }

  override getOutput(outputName = 'default'): unknown {
    if (outputName === 'default') {
      return this.content || this._displayDataUrl || null;
    }
    return null;
  }

  override renderContent(): string {
    if (this.content) {
      return `
        <div class="image-card-wrapper">
            <img src="${this.content}" class="image-content">
            ${this.maskData ? `
                <img src="${this.maskData}"
                     class="image-mask-overlay"
                     draggable="false">
            ` : ''}
            <div class="image-hover-toolbar">
                <button class="img-action-btn img-action-primary" title="下载图片" data-action="download">
                    <i class="fas fa-download"></i>
                    <span>下载</span>
                </button>
                <button class="img-action-btn img-action-danger" title="删除图片" data-action="delete">
                    <i class="fas fa-trash-alt"></i>
                    <span>删除</span>
                </button>
            </div>
        </div>
      `;
    }
    return `
      <div class="image-placeholder" data-action="upload">
          <i class="fas fa-image"></i>
          <span>点击选择图片</span>
      </div>
    `;
  }

  async setImage(src: string, keepMask = false): Promise<void> {
    const oldContent = this.content;

    this.content = src;
    if (!keepMask) {
      this.maskData = null;
    }

    const body = this.element?.querySelector('.card-body');
    if (body) body.innerHTML = this.renderContent();

    ConnectionManager.updateCardConnections(this.id);
    this.notifyDownstream();

    if (CmdManager && src !== oldContent) {
      CmdManager.execute(new ModifyContentCommand( this.id, src, oldContent));
    }
  }

  override onReceive(_type: 'text' | 'image', _data: unknown, _source = 'upstream'): void {}

  refreshMaskDisplay(): void {
    const body = this.element?.querySelector('.card-body') as HTMLElement | null;
    if (!body || !this.content) return;

    const wrapper = body.querySelector('.image-card-wrapper');
    if (!wrapper) return;

    let overlay = wrapper.querySelector('.image-mask-overlay');

    if (this.maskData) {
      if (overlay) {
        const imgOverlay = overlay as HTMLImageElement;
        imgOverlay.src = this.maskData;
      } else {
        const img = document.createElement('img');
        img.src = this.maskData;
        img.className = 'image-mask-overlay';
        img.draggable = false;
        const toolbar = wrapper.querySelector('.image-hover-toolbar');
        wrapper.insertBefore(img, toolbar!);
      }
    } else {
      overlay?.remove();
    }
  }

  override serialize() {
    const base = super.serialize();
    return {
      ...base,
      content: this.content || '',
      maskData: this.maskData || null
    };
  }

  override createElement(): HTMLElement {
    const el = super.createElement();
    el.classList.add('image-card');

    const body = el.querySelector('.card-body') as HTMLElement;
    body.style.cssText = 'padding:0; display:flex; flex-direction:column; overflow:hidden;';

    this._bindCardEvents(el);
    return el;
  }

  private _bindCardEvents(el: HTMLElement): void {
    const body = el.querySelector('.card-body') as HTMLElement;

    const placeholder = body?.querySelector('[data-action="upload"]') as HTMLElement | null;
    placeholder?.addEventListener('click', () => {
      const t = (window as unknown as { CardFactory: { triggerImageUpload(id: string): void } }).CardFactory;
      t?.triggerImageUpload(this.id);
    });

    const downloadBtn = body?.querySelector('[data-action="download"]') as HTMLElement | null;
    downloadBtn?.addEventListener('click', () => {
      ImageInputCard.downloadAs(this.id);
    });

    const deleteBtn = body?.querySelector('[data-action="delete"]') as HTMLElement | null;
    deleteBtn?.addEventListener('click', () => {
      ImageInputCard._deleteImage(this.id);
    });
  }

  static _deleteImage(cardId: string): void {
    const card = CardFactory.getInstance(cardId) as ImageInputCard | null;
    if (!card) return;

    const oldContent = card.content;
    const oldMaskData = card.maskData;

    card.content = '';
    card.maskData = null;

    const body = card.element?.querySelector('.card-body');
    if (body) body.innerHTML = card.renderContent();

    (AppState.connections.list as Array<{ start: string; end: string }>).forEach(c => {
      if (c.start === cardId || c.end === cardId) {
        const otherId = c.start === cardId ? c.end : c.start;
        const other = CardFactory.getInstance(otherId);
        if (other?.getType?.() === 'ai-image') {
          other.removeRefImage?.(cardId);
        }
      }
    });

    if (CardEventBus && CardEventBus.EventTypes) {
      CardEventBus.emit(CardEventBus.EventTypes.DATA_CHANGED, {
        cardId,
        type: 'image',
        data: null,
        source: 'manual'
      });
    }

    ConnectionManager.updateCardConnections(cardId);

    if (CmdManager && oldContent) {
      CmdManager.execute(new ModifyContentCommand( cardId, '', oldContent));
    }
  }

  static async downloadAs(cardId: string): Promise<void> {
    const card = CardFactory.getInstance(cardId) as ImageInputCard | null;
    if (!card || !card.content) {
      console.warn('[ImageInputCard] 无法下载：卡片或内容为空');
      return;
    }

    let imageData = card.content;

    try {
      const result = await API.saveImageAs(imageData);
      if (result.status === 'success') {
        Toast.show('图片已保存到: ' + result.path, 3000);
      } else if (result.status === 'cancelled') {
        // 用户取消
      } else {
        Toast.show('保存失败: ' + (result.message || '未知错误'), 3000);
      }
    } catch (e) {
      Toast.show('保存失败: ' + e, 3000);
    }
  }
}

