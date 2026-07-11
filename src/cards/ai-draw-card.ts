// src/cards/ai-draw-card.ts
// AI 绘图片

import { BaseCard } from './base-card';
import { CardContract, CardOptions } from '../types/cards';
import { AppState } from '../state/app-state';
import * as api from './ai-draw-api';
import * as status from './ai-draw-status';
import * as bindings from './ai-draw-bindings';

declare const CmdManager: { execute(cmd: unknown): void };
declare const PropertyChangeCommand: any;
declare const CardEventBus: { EventTypes: { RUN_COMPLETED: string; DATA_CHANGED: string }; emit(type: string, payload: unknown): void };
declare const PromptLibrary: { open(event: unknown, category: string, cb: (item: { content: string }) => void): void };
declare const HistorySidebar: { addImage(url: string, meta?: unknown): void };
declare const ConnectionManager: { updateCardConnections(id: string): void; create(startId: string, endId: string, saveHistory: boolean): unknown };
declare const DataSource: {
  getUpstreamText(cardId: string): Array<{ data: unknown; sourceCardId: string }>;
  getUpstreamImage(cardId: string): Array<{ data: unknown; sourceCardId: string }>;
  hasUpstreamOfType(cardId: string, type: string): boolean;
  getUpstreamTextMerged(cardId: string): string;
  getDownstreamPreviews(cardId: string): Array<{ id: string }>;
  getDownstreamImageCards(cardId: string): Array<{ id: string; setImage?(url: string): void }>;
};
declare const API: {
  loadProviders(): Promise<{ providers: ProviderList }>;
  generateImageV2(prompt: string, options?: Record<string, unknown>): Promise<{ task_id: string }>;
  getTaskResult(taskId: string): Promise<{ status: string; result?: { success?: boolean; image_url?: string; error?: string } }>;
};
interface ProviderList extends Array<ProviderItem> {}
interface ProviderItem { id: string; short_name?: string; name: string; enabled?: boolean; models?: ModelList }
interface ModelList extends Array<ModelItem> {}
interface ModelItem { id: string; name: string; type: string; enabled?: boolean }
declare const Toast: { show(msg: string, dur?: number): void };
declare const CardFactory: { create(type: string, options: unknown, saveHistory: boolean): { id: string }; getInstance(id: string): unknown };

export interface AIDrawConfig {
  model: string;
  aspectRatio: string;
  resolution: string;
  count: number;
  topP: number;
  referenceImages?: string[];
  generatedImages?: string[];
}

export class AIDrawCard extends BaseCard {
  prompt: string = '';
  config: AIDrawConfig = {
    model: '',
    aspectRatio: 'Auto',
    resolution: '1k',
    count: 1,
    topP: 0.95
  };

  protected _maskStore = new Map<string, string>();

  private _onProvidersUpdated = () => {
    if (!this.config.model) {
      AIDrawCard._getImageModels().then(models => {
        if (models.length > 0) {
          this.config.model = models[0].id;
          localStorage.setItem('ai_draw_last_model', this.config.model);
          this._updateParamDisplay('model', models[0].id, models[0].name);
        }
      });
    }
    this._restoreModelLabel();
  };

  constructor(options: CardOptions = {}) {
    super({ width: '500px', height: '480px', title: 'AI Image', ...options });

    if (options.content) {
      try {
        const parsed = JSON.parse(options.content as string);
        this.prompt = parsed.prompt || '';
        if (parsed.config) {
          const cfg = typeof parsed.config === 'string' ? JSON.parse(parsed.config) : parsed.config;
          this.config = { ...this.config, ...cfg };
        }
      } catch {}
    }

    if (options.aiConfig) {
      const aiCfg = options.aiConfig as Record<string, unknown>;
      if (aiCfg) this.config = { ...this.config, ...aiCfg } as AIDrawConfig;
    }

    if (options.maskStore) {
      Object.entries(options.maskStore as Record<string, string>).forEach(([k, v]) => {
        if (k && v) this._maskStore.set(k, v);
      });
    }

    if (!this.config.model) {
      this.config.model = localStorage.getItem('ai_draw_last_model') || '';
    }

    if (!this.config.model) {
      AIDrawCard._getImageModels().then(models => {
        if (models.length > 0) {
          this.config.model = models[0].id;
          localStorage.setItem('ai_draw_last_model', this.config.model);
          this._updateParamDisplay('model', models[0].id, models[0].name);
        }
      });
    }
  }

  getType(): string { return 'ai-image'; }

  static override getContract(): CardContract {
    return {
      outputs: [{ name: 'default', type: 'image', notifyOn: 'onRun' }],
      inputs: [
        { name: 'prompt', type: 'text', receivePolicy: 'replace' },
        { name: 'reference', type: 'image', multiple: true, receivePolicy: 'append' }
      ]
    };
  }

  override renderContent(): string {
    return `
      <div class="ai-image-prompt-area">
          <div class="ai-ref-images"></div>
          <div class="ai-image-prompt-wrap">
              <textarea class="ai-image-prompt"
                        placeholder="输入提示..."
                        spellcheck="false">${this._escapeHtml(this.prompt)}</textarea>
          </div>
      </div>
      <div class="ai-image-controls">
          <div class="ai-image-params">
              <button class="ai-image-param-btn"
                      data-param="model"
                      data-label="${this._getModelDisplayName(this.config.model)}">
                  ${this._getModelDisplayName(this.config.model)}
              </button>
              <button class="ai-image-param-btn" data-param="aspectRatio">
                  ${this.config.aspectRatio}
              </button>
              <button class="ai-image-param-btn" data-param="resolution">
                  ${this.config.resolution}
              </button>
              <button class="ai-image-param-btn" data-param="count">
                  ${this.config.count}
              </button>
              <input type="number" class="ai-image-topp-input"
                     data-param="topP"
                     value="${this.config.topP}"
                     min="0" max="1" step="0.05"
                     placeholder="topP"
                     title="topP (0.0~1.0)">
              <button class="ai-image-param-btn ai-prompt-lib-btn"
                      title="提示库"
                      data-action="promptLib">
                  <i class="fas fa-book-open" style="font-size:11px;"></i>
              </button>
          </div>
          <button class="ai-image-generate-btn" data-action="generate">
              生成
          </button>
      </div>
    `;
  }

  override createElement(): HTMLElement {
    const el = super.createElement();
    el.classList.add('ai-image-card');
    (el.querySelector('.card-body') as HTMLElement).style.cssText =
      'padding:0; display:flex; flex-direction:column;';

    this._bindPromptInput(el);
    this._bindParamButtons(el);
    this._bindTopPInput(el);
    this._bindGenerateButton(el);

    setTimeout(() => this._restoreModelLabel(), 0);
    window.addEventListener('providers:updated', this._onProvidersUpdated);

    return el;
  }

  override destroy(): void {
    window.removeEventListener('providers:updated', this._onProvidersUpdated);
    super.destroy();
  }

  // 4 个事件绑定 helper 已搬至 ./ai-draw-bindings.ts（与 this 解耦，纯函数）
  // 类内仍保留同名方法供子类 / 测试用，内部委托给 bindings 模块
  private _bindPromptInput(el: HTMLElement): void {
    bindings.bindPromptInput(el, (val) => { this.prompt = val; });
  }

  private _bindParamButtons(el: HTMLElement): void {
    bindings.bindParamButtons(el, this.id, (val) => { this.prompt = val; });
  }

  private _bindTopPInput(el: HTMLElement): void {
    bindings.bindTopPInput(el, () => this.config.topP, (val) => { this.config.topP = val; });
  }

  private _bindGenerateButton(el: HTMLElement): void {
    bindings.bindGenerateButton(el, this.id);
  }

  override getOutput(outputName = 'default'): unknown {
    if (outputName === 'default') {
      const imgs = this.element?.querySelectorAll('.preview-image-wrap img');
      if (imgs && imgs.length > 0) {
        return (imgs[0] as HTMLImageElement).src;
      }
      return this.config.generatedImages?.[0] || null;
    }
    return null;
  }

  getInput(inputName: string): unknown {
    if (inputName === 'prompt') {
      return DataSource.getUpstreamTextMerged(this.id);
    }
    if (inputName === 'reference') {
      return DataSource.getUpstreamImage(this.id).map(i => i.data).filter(Boolean);
    }
    return null;
  }

  updateUpstreamTextHint(): void {
    const textarea = this.element?.querySelector('.ai-image-prompt') as HTMLTextAreaElement | null;
    if (!textarea) return;

    const hasUpstreamText = DataSource.hasUpstreamOfType(this.id, 'text');

    if (hasUpstreamText) {
      textarea.disabled = true;
      textarea.placeholder = '提示由上游文本卡片提供';
      const upstreamTexts = DataSource.getUpstreamText(this.id).map(t => t.data).filter(Boolean);
      if (upstreamTexts.length > 0) {
        textarea.value = upstreamTexts.join(', ');
        this.prompt = textarea.value;
      }
    } else {
      textarea.disabled = false;
      textarea.placeholder = '输入提示...';
    }
  }

  addRefImage(src: string, sourceCardId: string): void {
    const container = this.element?.querySelector('.ai-ref-images') as HTMLElement | null;
    if (!container) return;

    this.removeRefImage(sourceCardId);

    const wrappers = container.querySelectorAll('.ai-ref-image-wrapper');
    if (wrappers.length >= 10) {
      Toast.show('最多能添加 10 张参考图');
      return;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'ai-ref-image-wrapper';

    const img = document.createElement('img');
    img.className = 'ai-ref-image';
    img.src = src;
    img.dataset.cardId = sourceCardId;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'ai-ref-image-remove';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      wrapper.remove();
      this._maskStore.delete(sourceCardId);
    });

    wrapper.appendChild(img);
    wrapper.appendChild(removeBtn);
    container.appendChild(wrapper);
  }

  removeRefImage(sourceCardId: string): void {
    const el = this.element?.querySelector(`.ai-ref-image[data-card-id="${sourceCardId}"]`)?.closest('.ai-ref-image-wrapper');
    el?.remove();
    this._maskStore.delete(sourceCardId);
  }

  refreshUpstream(): void {
    const container = this.element?.querySelector('.ai-ref-images') as HTMLElement | null;
    if (!container) return;
    container.innerHTML = '';

    DataSource.getUpstreamImage(this.id).forEach(item => {
      if (item.data) this.addRefImage(item.data as string, item.sourceCardId);
    });
  }

  updateRefMask(sourceCardId: string, maskBase64: string | null): void {
    if (maskBase64) this._maskStore.set(sourceCardId, maskBase64);
    else this._maskStore.delete(sourceCardId);
  }

  override onReceive(type: 'text' | 'image', data: unknown, _source = 'upstream'): void {
    if (!data) return;

    if (type === 'text') {
      this.prompt = String(data);
      const textarea = this.element?.querySelector('.ai-image-prompt') as HTMLTextAreaElement | null;
      if (textarea) {
        textarea.value = String(data);
        textarea.disabled = true;
        textarea.placeholder = '提示由上游文本卡片提供';
      }
    } else if (type === 'image') {
      const sourceCardId = String(_source);
      this.addRefImage(String(data), sourceCardId);
    }
  }

  updateParam(paramType: string, value: string | number, displayText?: string): void {
    if (paramType === 'count') {
      this.config.count = parseInt(String(value));
    } else {
      (this.config as unknown as Record<string, unknown>)[paramType] = value;
    }

    this._updateParamDisplay(paramType, value, displayText);

    if (paramType === 'model' && value) {
      localStorage.setItem('ai_draw_last_model', String(value));
    }

    if (CmdManager) {
      CmdManager.execute(new PropertyChangeCommand(
        this.id, 'config', { ...this.config } as Record<string, unknown>, null, '修改AI参数'
      ));
    }
  }

  _updateParamDisplay(paramType: string, value: string | number, displayText?: string): void {
    const btn = this.element?.querySelector(`[data-param="${paramType}"]`) as HTMLElement | null;
    if (!btn) return;

    if (paramType === 'model') {
      btn.textContent = displayText || String(value);
      (btn as HTMLElement & { dataset: Record<string, string> }).dataset.label = displayText || String(value);
    } else if (paramType === 'count') {
      btn.textContent = `${value}张`;
    } else {
      btn.textContent = displayText || String(value);
    }
  }

  async _restoreModelLabel(): Promise<void> {
    const btn = this.element?.querySelector('[data-param="model"]') as HTMLElement | null;
    if (!btn) return;

    try {
      const models = await AIDrawCard._getImageModels();

      if (!this.config.model && models.length > 0) {
        this.config.model = models[0].id;
        localStorage.setItem('ai_draw_last_model', this.config.model);
        btn.textContent = models[0].name;
        (btn as HTMLElement & { dataset: Record<string, string> }).dataset.label = models[0].name;
        return;
      }

      const match = models.find((m: { id: string }) => m.id === this.config.model);
      if (match) {
        btn.textContent = match.name;
        (btn as HTMLElement & { dataset: Record<string, string> }).dataset.label = match.name;
      } else {
        const name = this._getModelDisplayName(this.config.model);
        btn.textContent = name;
        (btn as HTMLElement & { dataset: Record<string, string> }).dataset.label = name;
      }
    } catch {
      const name = this._getModelDisplayName(this.config.model);
      btn.textContent = name || '选择模型';
      (btn as HTMLElement & { dataset: Record<string, string> }).dataset.label = name || '选择模型';
    }
  }

  override serialize() {
    const base = super.serialize();
    const textarea = this.element?.querySelector('.ai-image-prompt') as HTMLTextAreaElement | null;
    const currentPrompt = textarea?.value ?? this.prompt ?? '';

    const maskStoreObj: Record<string, string> = {};
    this._maskStore.forEach((v, k) => { maskStoreObj[k] = v; });

    return {
      ...base,
      content: JSON.stringify({ prompt: currentPrompt, config: this.config }),
      maskStore: this._maskStore.size > 0 ? maskStoreObj : undefined
    };
  }

  _getModelDisplayName(modelStr: string): string {
    if (!modelStr) return '选择模型';
    if (modelStr.includes(':')) {
      return modelStr.split(':').slice(1).join(':');
    }
    return modelStr;
  }

  _escapeHtml(str: string): string {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  _getRefImages(): Array<{ src: string; cardId: string }> {
    const wrappers = this.element?.querySelectorAll('.ai-ref-image-wrapper') || [];
    const result: Array<{ src: string; cardId: string }> = [];
    wrappers.forEach(wrapper => {
      const img = (wrapper as HTMLElement).querySelector('.ai-ref-image') as HTMLImageElement | null;
      if (img?.src) {
        result.push({ src: img.src, cardId: img.dataset.cardId || '' });
      }
    });
    return result;
  }

  _hasUpstreamText(): boolean {
    return DataSource.hasUpstreamOfType(this.id, 'text');
  }

  // 4 个状态 UI helper 已搬至 ./ai-draw-status.ts（与 this 解耦，纯函数）
  // 类内仍保留同名方法供子类 / 测试用，内部委托给 status 模块
  _showGeneratingStatus(count: number): HTMLElement | null {
    return this.element ? status.showGeneratingStatus(this.element, count) : null;
  }

  _updateGeneratingStatus(completed: number, total: number): void {
    if (this.element) status.updateGeneratingStatus(this.element, completed, total);
  }

  _clearGeneratingStatus(): void {
    if (this.element) status.clearGeneratingStatus(this.element);
  }

  _updateGenerateButton(isGenerating: boolean): void {
    if (this.element) status.updateGenerateButton(this.element, isGenerating);
  }

  // 8 个纯静态函数已搬至 ./ai-draw-api.ts（与 this 解耦，纯函数）
  // 通过 static 字段重新导出，保持向后兼容（GroupExecutor.ts 等调用方无需改）
  static _mergeImageAndMask = api._mergeImageAndMask;
  static _toBase64 = api._toBase64;
  static _generateErrorImage = api._generateErrorImage;
  static _showParamMenu = api._showParamMenu;
  static _getImageModels = api._getImageModels;
  static _getConnectedPreviews = api._getConnectedPreviews;
  static _getConnectedImageInputCards = api._getConnectedImageInputCards;
  static generate = api.generate;
}

