// src/cards/compare-card.ts
// 对比片 左滑对比两张图片

import { BaseCard } from './base-card';
import { CardContract } from '../types/cards';
import { AppState } from '../state/app-state';
import { getUpstreamImage } from './data-source';

declare const CmdManager: { execute(cmd: unknown): void };
declare const PropertyChangeCommand: any;
declare const API: {
  loadLocalImage(path: string): Promise<{ status: string; data_url?: string; message?: string }>;
};

export class CompareCard extends BaseCard {
  imageA: string = '';
  imageB: string = '';
  sliderPos: number = 50;
  private _currentPos: number = 50;
  private _sliderCleanup?: () => void;

  constructor(options: { imageA?: string; imageB?: string; sliderPos?: number } = {}) {
    super({ width: '400px', height: '280px', minWidth: 300, minHeight: 200, title: 'Compare', ...options });
    this.imageA = options.imageA || '';
    this.imageB = options.imageB || '';
    this.sliderPos = options.sliderPos ?? 50;
    this._currentPos = this.sliderPos;
  }

  getType(): string { return 'compare'; }

  static override getContract(): CardContract {
    return {
      outputs: [],
      inputs: [
        { name: 'A', type: 'image', receivePolicy: 'replace' },
        { name: 'B', type: 'image', receivePolicy: 'replace' }
      ]
    };
  }

  override createElement(): HTMLElement {
    const el = super.createElement();
    el.classList.add('compare');

    const body = el.querySelector('.card-body') as HTMLElement;
    body.style.cssText = 'padding:0; display:flex; flex-direction:column;';

    body.innerHTML = this.renderContent();
    this._bindSliderDrag(body);

    this._updateSliderPosition();

    const portLeft = el.querySelector('.port-left') as HTMLElement;
    if (portLeft) {
      portLeft.classList.add('port-input-a');
      portLeft.dataset.inputName = 'A';
      portLeft.title = '输入 A（左侧图片）';
    }

    const portRight = el.querySelector('.port-right') as HTMLElement;
    if (portRight) portRight.remove();

    const portB = this._createPort('port-left port-input-b', 'input');
    portB.dataset.inputName = 'B';
    portB.title = '输入 B（右侧图片）';
    el.appendChild(portB);
    this._bindPortDrag(portB, 'input');

    this._portLeft = portLeft;
    this._portRight = portB;
    this._updatePortsVisibility();

    return el;
  }

  override _updatePortsVisibility(): void {
    const cardId = this.element?.id;
    if (!cardId) return;

    const connections = AppState.connections.list;
    const hasInputA = connections.some(c => c.end === cardId && (c as Record<string, unknown>).endPort === 'A');
    const hasInputB = connections.some(c => c.end === cardId && (c as Record<string, unknown>).endPort === 'B');

    if (this._portLeft) {
      this._portLeft.style.display = '';
      this._portLeft.classList.toggle('port--linked', hasInputA);
    }
    if (this._portRight) {
      this._portRight.style.display = '';
      this._portRight.classList.toggle('port--linked', hasInputB);
    }
  }

  override renderContent(): string {
    return `
      <div class="compare-container">
          <div class="compare-image-a">
              ${this.imageA ? `<img src="${this.imageA}" alt="A">` : '<div class="compare-placeholder"></div>'}
          </div>
          <div class="compare-image-b">
              ${this.imageB ? `<img src="${this.imageB}" alt="B">` : '<div class="compare-placeholder"></div>'}
          </div>
          <div class="compare-slider">
              <div class="compare-slider-line"></div>
              <div class="compare-slider-handle">
                  <span class="compare-slider-arrow left">◀</span>
                  <span class="compare-slider-arrow right">▶</span>
              </div>
          </div>
      </div>
    `;
  }

  private _bindSliderDrag(body: HTMLElement): void {
    const slider = body.querySelector('.compare-slider') as HTMLElement | null;
    if (!slider) return;

    let isDragging = false;
    let startX = 0;
    let startPos = 0;
    let rafId: number | null = null;
    const container = body.querySelector('.compare-container') as HTMLElement;

    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const scale = AppState.canvas.scale || 1;
      const dx = (e.clientX - startX) / scale;
      const containerWidth = container.offsetWidth;
      let newPos = startPos + (dx / containerWidth) * 100;
      newPos = Math.max(0, Math.min(100, newPos));
      this.sliderPos = newPos;
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        this._updateSliderPosition();
      });
    };

    const onMouseUp = () => {
      if (isDragging) {
        isDragging = false;
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
          this._updateSliderPosition();
        }
        if (CmdManager) {
          CmdManager.execute(new PropertyChangeCommand(
            this.id, 'sliderPos', this._currentPos || 50, null, '调整对比'
          ));
        }
      }
    };

    slider.addEventListener('mousedown', (e: MouseEvent) => {
      if ((e as MouseEvent).button !== 0) return;
      e.preventDefault();
      isDragging = true;
      startX = (e as MouseEvent).clientX;
      startPos = this.sliderPos;
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    });

    this._sliderCleanup = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }

  _updateSliderPosition(): void {
    const body = this.element?.querySelector('.card-body') as HTMLElement | null;
    if (!body) return;

    const slider = body.querySelector('.compare-slider') as HTMLElement | null;
    const imageA = body.querySelector('.compare-image-a') as HTMLElement | null;
    const imageB = body.querySelector('.compare-image-b') as HTMLElement | null;

    if (slider) slider.style.left = this.sliderPos + '%';
    if (imageA) imageA.style.clipPath = `inset(0 ${100 - this.sliderPos}% 0 0)`;
    if (imageB) imageB.style.clipPath = `inset(0 0 0 ${this.sliderPos}%)`;
  }

  setImageA(src: string): void {
    this.imageA = src;
    this._refreshContent();
  }

  setImageB(src: string): void {
    this.imageB = src;
    this._refreshContent();
  }

  private _refreshContent(): void {
    const body = this.element?.querySelector('.card-body') as HTMLElement | null;
    if (!body) return;
    body.innerHTML = this.renderContent();
    this._bindSliderDrag(body);
    this._updateSliderPosition();
  }

  static _getImageFromCard(card: unknown): string {
    const c = card as { _displayDataUrl?: string; getOutput?(): unknown };
    if (!c) return '';

    if (c._displayDataUrl) return c._displayDataUrl;
    if (c.getOutput) {
      const output = c.getOutput();
      if (output) return String(output);
    }

    const el = document.getElementById((card as { id: string }).id);
    const img = el?.querySelector('img') as HTMLImageElement | null;
    return img?.src || '';
  }

  getUpstreamImages(): { imageA: string; imageB: string } {
    const imageAData = getUpstreamImage(this.id, { inputPort: 'A' });
    const imageBData = getUpstreamImage(this.id, { inputPort: 'B' });
    return {
      imageA: (imageAData[0]?.data as string) || '',
      imageB: (imageBData[0]?.data as string) || ''
    };
  }

  refreshUpstream(): void {
    const { imageA, imageB } = this.getUpstreamImages();

    const needLoad = (url: string) =>
      url && (url.startsWith('file:///') || url.startsWith('file://'));

    const hasFile = needLoad(imageA) || needLoad(imageB);

    if (!hasFile) {
      this._applyUpstreamImages(imageA, imageB);
      return;
    }

    const loadOne = (url: string): Promise<string> => {
      if (!url || !needLoad(url)) return Promise.resolve(url);
      return (API as { loadLocalImage(path: string): Promise<{ status: string; data_url?: string }> })
        .loadLocalImage(url)
        .then(r => (r && r.status === 'success' && r.data_url) ? r.data_url : url)
        .catch(() => url);
    };

    Promise.all([loadOne(imageA), loadOne(imageB)])
      .then(([a, b]) => this._applyUpstreamImages(a, b))
      .catch(() => this._applyUpstreamImages(imageA, imageB));
  }

  private _applyUpstreamImages(imageA: string, imageB: string): void {
    let changed = false;
    if (this.imageA !== imageA) {
      this.imageA = imageA;
      changed = true;
    }
    if (this.imageB !== imageB) {
      this.imageB = imageB;
      changed = true;
    }
    if (changed) {
      this._refreshContent();
    }
  }

  override onReceive(type: 'text' | 'image', data: unknown, _source = 'upstream'): void {
    if (type !== 'image' || !data) return;

    if (!this.imageA) {
      this.setImageA(String(data));
    } else if (!this.imageB) {
      this.setImageB(String(data));
    } else {
      this.setImageA(String(data));
    }
  }

  override serialize() {
    const base = super.serialize();
    return {
      ...base,
      imageA: this.imageA || '',
      imageB: this.imageB || '',
      sliderPos: this.sliderPos
    };
  }

  override destroy(): void {
    this._sliderCleanup?.();
    super.destroy();
  }
}

