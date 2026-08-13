// src/cards/agent-card.ts
// Agent 卡片

import { BaseCard } from './base-card';
import { CardContract, CardOptions } from '../types/cards';
import * as api from './agent-api';
import * as bindings from './agent-bindings';

declare const CardFactory: {
  getInstance(cardId: string): AgentCard | null;
  create(type: string, options: unknown, saveHistory: boolean): { id: string };
};
declare const ModifyContentCommand: { new(id: string, content: string, old: unknown): unknown };
declare const CmdManager: { execute(cmd: unknown): void };
declare const PromptLibrary: { open(event: unknown, category: string, cb: (item: { content: string }) => void): void };
declare const CardEventBus: { EventTypes: { RUN_COMPLETED: string; DATA_CHANGED: string }; emit(type: string, payload: unknown): void };
declare const Toast: { show(msg: string, dur?: number): void };
declare const API: {
  loadProviders(): Promise<{ providers: ProviderList }>;
  loadLocalImage(src: string): Promise<{ data_url?: string }>;
  agentChatV2(input: string, options: Record<string, unknown>): Promise<{ success: boolean; text?: string; error?: string }>;
};
interface ProviderList extends Array<ProviderItem> {}
interface ProviderItem { id: string; short_name?: string; name: string; enabled?: boolean; models?: ModelList }
interface ModelList extends Array<ModelItem> {}
interface ModelItem { id: string; name: string; type: string; enabled?: boolean }
declare const DataSource: { getUpstreamContent(cardId: string): { texts: string[]; images: string[] } };
declare const Dom: { create(tag: string, attrs?: Record<string, string>, text?: string): HTMLElement };

export interface AgentConfig {
  model: string;
  metaPrompt: string;
  userInput: string;
  output: string;
}

export class AgentCard extends BaseCard {
  agentConfig: AgentConfig = {
    model: '',
    metaPrompt: '',
    userInput: '',
    output: ''
  };

  protected _running = false;
  protected _chatModels: Array<{ id: string; name: string; providerName: string }> = [];
  private _providersSub = () => { this._populateModelSelect(); };

  constructor(options: CardOptions = {}) {
    super({ width: '460px', height: '520px', minWidth: 360, minHeight: 420, title: 'Agent', ...options });

    const w = parseFloat(String(this.width));
    const h = parseFloat(String(this.height));
    if (!isNaN(w) && w < this.minWidth) this.width = this.minWidth + 'px';
    if (!isNaN(h) && h < this.minHeight) this.height = this.minHeight + 'px';

    this.agentConfig = {
      model: '',
      metaPrompt: '',
      userInput: '',
      output: '',
      ...(options.agentConfig as Partial<AgentConfig> || {})
    };

    if (options.content) {
      try {
        const parsed = JSON.parse(options.content as string);
        this.agentConfig = { ...this.agentConfig, ...parsed };
      } catch {}
    }

    if (!this.agentConfig.model) {
      this.agentConfig.model = localStorage.getItem('agent_last_model') || '';
    }
  }

  getType(): string { return 'agent'; }

  static override getContract(): CardContract {
    return {
      outputs: [{ name: 'default', type: 'text', notifyOn: 'onRun' }],
      inputs: [
        { name: 'prompt', type: 'text', multiple: true, receivePolicy: 'append' },
        { name: 'reference', type: 'image', multiple: true, receivePolicy: 'append' }
      ]
    };
  }

  override getOutput(outputName = 'default'): unknown {
    if (outputName === 'default') return this.agentConfig.output || '';
    return null;
  }

  getInput(inputName: string): unknown {
    if (inputName === 'prompt') {
      return DataSource.getUpstreamContent(this.id).texts.filter(Boolean);
    }
    if (inputName === 'reference') {
      return DataSource.getUpstreamContent(this.id).images.filter(Boolean);
    }
    return null;
  }

  override renderContent(): string {
    const cfg = this.agentConfig;
    return `
      <div class="agent-section">
        <div class="agent-section-header">
          <span class="agent-section-label">Meta Prompt</span>
          <div class="agent-model-select-wrap">
            <button class="agent-model-btn" data-action="model">选择模型</button>
          </div>
        </div>
        <div class="agent-meta-prompt-wrap">
          <textarea class="agent-meta-prompt"
                    placeholder="输入元提示词...（设定身份、风格等）"
                    spellcheck="false">${this._escapeHtml(cfg.metaPrompt || '')}</textarea>
          <div class="agent-meta-actions">
            <button class="agent-lib-btn" data-action="libCommon">
              <i class="fas fa-book-open" style="font-size:10px;margin-right:3px;"></i> 常用提示词库
            </button>
            <button class="agent-lib-btn" data-action="libSkill">
              <i class="fas fa-bolt" style="font-size:10px;margin-right:3px;"></i> Skill 库
            </button>
          </div>
        </div>
      </div>
      <div class="agent-section">
        <div class="agent-section-header">
          <span class="agent-section-label">用户需求</span>
        </div>
        <div class="agent-user-input-wrap">
          <textarea class="agent-user-input"
                    placeholder="输入文字内容..."
                    spellcheck="false">${this._escapeHtml(cfg.userInput || '')}</textarea>
          <div class="agent-upstream-hint" id="agent-upstream-hint-${this.id}">
            <i class="fas fa-link"></i>
            <span id="agent-upstream-hint-text-${this.id}">已连接上游内容，执行时将自动拼接</span>
          </div>
          <div class="agent-upstream-preview" id="agent-upstream-preview-${this.id}"></div>
        </div>
      </div>
      <div class="agent-output-section">
        <div class="agent-section-header">
          <span class="agent-section-label">输出内容</span>
        </div>
        <div class="agent-output-wrap" id="agent-output-wrap-${this.id}">
          ${cfg.output
            ? `<div class="agent-output-text">${this._escapeHtml(cfg.output)}</div>`
            : `<div class="agent-output-placeholder">
                 # 输出执行后的文字内容，<br>
                 # 每次执行后新结果覆盖旧的结果
               </div>`
          }
        </div>
      </div>
      <div class="agent-footer">
        <button class="agent-run-btn" data-action="run"><i class="fas fa-play"></i> 运行</button>
        <button class="agent-copy-btn" data-action="copy" title="复制输出内容"><i class="fas fa-copy"></i></button>
      </div>
    `;
  }

  override createElement(): HTMLElement {
    const el = super.createElement();
    el.classList.add('agent-card');
    (el.querySelector('.card-body') as HTMLElement).style.cssText =
      'padding:0; display:flex; flex-direction:column; overflow:hidden;';

    this._bindModelButton(el);
    this._bindMetaPrompt(el);
    this._bindLibButtons(el);
    this._bindUserInput(el);
    this._bindFooterButtons(el);

    setTimeout(() => this._populateModelSelect(), 0);
    setTimeout(() => this.updateUpstreamHint(), 0);
    window.addEventListener('providers:updated', this._providersSub);

    return el;
  }

  override destroy(): void {
    window.removeEventListener('providers:updated', this._providersSub);
    super.destroy();
  }

  // 5 个事件绑定 helper 已搬至 ./agent-bindings.ts（与 this 解耦，纯函数）
  private _bindModelButton(el: HTMLElement): void {
    bindings.bindModelButton(el, this.id);
  }

  private _bindMetaPrompt(el: HTMLElement): void {
    bindings.bindMetaPrompt(el, (val) => { this.agentConfig.metaPrompt = val; });
  }

  private _bindLibButtons(el: HTMLElement): void {
    bindings.bindLibButtons(el, this.id);
  }

  private _bindUserInput(el: HTMLElement): void {
    bindings.bindUserInput(el, (val) => { this.agentConfig.userInput = val; });
  }

  private _bindFooterButtons(el: HTMLElement): void {
    bindings.bindFooterButtons(el, this.id);
  }

  async _populateModelSelect(): Promise<void> {
    if (!this.element) return;
    return bindings.populateModelSelect(
      this.element,
      this.agentConfig.model,
      this._chatModels,
      (id) => this._getModelDisplayName(id),
      (models) => { this._chatModels = models; }
    );
  }

  _getModelDisplayName(modelStr: string): string {
    if (!modelStr) return '选择模型';
    if (modelStr.includes(':')) return modelStr.split(':').slice(1).join(':');
    return modelStr;
  }

  _setModel(modelId: string, displayText?: string): void {
    this.agentConfig.model = modelId;
    const btn = this.element?.querySelector('[data-action="model"]');
    if (btn) btn.textContent = displayText || this._getModelDisplayName(modelId);
    if (modelId) localStorage.setItem('agent_last_model', modelId);

    if ((window as unknown as { CmdManager?: typeof CmdManager }).CmdManager) {
      CmdManager.execute(new ModifyContentCommand(this.id, this._getPromptContent(), null));
    }
  }

  _getPromptContent(): string {
    return JSON.stringify({
      ...this.agentConfig,
      metaPrompt: (this.element?.querySelector('.agent-meta-prompt') as HTMLTextAreaElement | null)?.value ?? this.agentConfig.metaPrompt,
      userInput: (this.element?.querySelector('.agent-user-input') as HTMLTextAreaElement | null)?.value ?? this.agentConfig.userInput
    });
  }

  updateUpstreamHint(): void {
    const hint = this.element?.querySelector(`#agent-upstream-hint-${this.id}`);
    const hintText = this.element?.querySelector(`#agent-upstream-hint-text-${this.id}`);
    if (!hint) return;

    const content = this._getUpstreamContent();
    const hasText = content.texts.length > 0;
    const hasImages = content.images.length > 0;

    hint.classList.toggle('visible', hasText || hasImages);

    if (hintText) {
      if (hasImages && hasText) {
        hintText.textContent = `已连接 ${content.images.length} 张图片和文字内容`;
      } else if (hasImages) {
        hintText.textContent = `已连接 ${content.images.length} 张图片`;
      } else {
        hintText.textContent = '已连接上游内容，执行时将自动拼接';
      }
    }

    const previewEl = this.element?.querySelector(`#agent-upstream-preview-${this.id}`);
    if (previewEl) {
      if (content.images.length === 0) {
        previewEl.innerHTML = '';
        previewEl.classList.remove('visible');
      } else {
        previewEl.classList.add('visible');
        previewEl.innerHTML = content.images.map(src => {
          const safe = String(src).replace(/"/g, '&quot;');
          return `<img class="agent-upstream-thumb" src="${safe}" alt="">`;
        }).join('');
      }
    }
  }

  refreshUpstream(): void { this.updateUpstreamHint(); }

  _getUpstreamContent(): { texts: string[]; images: string[] } {
    return DataSource.getUpstreamContent(this.id);
  }

  override onReceive(type: 'text' | 'image', _data: unknown, _source = 'upstream'): void {
    this.updateUpstreamHint?.();
  }

  override serialize() {
    return { ...super.serialize(), content: this._getPromptContent() };
  }

  _escapeHtml(str: string): string {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  _setOutput(text: string): void {
    this.agentConfig.output = text;
    const wrap = this.element?.querySelector(`#agent-output-wrap-${this.id}`);
    if (!wrap) return;

    if (text) {
      wrap.innerHTML = `<div class="agent-output-text">${this._escapeHtml(text)}</div>`;
    } else {
      wrap.innerHTML = `<div class="agent-output-placeholder">
                           # 输出执行后的文字内容，<br>
                           # 每次执行后新结果覆盖旧的结果
                         </div>`;
    }

    this.notifyDownstream();

    if ((window as unknown as { CardEventBus?: typeof CardEventBus }).CardEventBus && CardEventBus.EventTypes) {
      CardEventBus.emit(CardEventBus.EventTypes.RUN_COMPLETED, {
        cardId: this.id, type: 'text', data: text
      });
    }
  }

  _setLoading(loading: boolean): void {
    this._running = loading;
    const btn = this.element?.querySelector('[data-action="run"]');
    const wrap = this.element?.querySelector(`#agent-output-wrap-${this.id}`);
    if (!btn) return;

    if (loading) {
      btn.classList.add('running');
      btn.innerHTML = '<i class="fas fa-stop"></i> 停止';
      if (wrap) {
        wrap.innerHTML = `<div class="agent-output-loading">
                            <div class="agent-spinner"></div>
                            <span>正在思考中...</span>
                          </div>`;
      }
    } else {
      btn.classList.remove('running');
      btn.innerHTML = '<i class="fas fa-play"></i> 运行';
    }
  }

  // 7 个纯静态函数已搬至 ./agent-api.ts（与 this 解耦，纯函数）
  // 通过 static 字段重新导出，保持向后兼容（外部调用方无需改）
  static _isDisplayableImageSrc = api._isDisplayableImageSrc;
  static _compressImage = api._compressImage;
  static _getChatModels = api._getChatModels;
  static _showModelMenu = api._showModelMenu;
  static _openLib = api._openLib;
  static _run = api._run;
  static _copyOutput = api._copyOutput;
}
