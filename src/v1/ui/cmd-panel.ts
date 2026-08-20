// src/v1/ui/cmd-panel.ts
// 指令面板：单面板 = 参考图区 + 提示词 + 模型/比例/分辨率/张数 chip + 圆形发送钮
// 仅单选出现，贴卡片下沿，空间不足智能翻到上方（原型行为）

import { flowState } from '../state/flow-state';
import { selection } from '../state/selection';
import { dirty } from '../state/dirty';
import { flowHistory } from '../state/history';
import { canvasView, CARD_W } from '../canvas/canvas-view';
import { cardView } from '../canvas/card-view';
import { interactions } from '../canvas/interactions';
import { runEngine } from '../engine/run-engine';
import { Backend, fetchImageModels, fetchChatModels } from '../api';
import { DEFAULT_CHAT_MODEL_KEY } from '../nodes/text-gen';
import { showToast } from './toast';
import { floatingPanels } from './floating-panels';
import { getSupportedAspectRatios, getModelCapabilities } from '../nodes/model-config';

const DEFAULT_RATIO_OPTIONS = ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9', '2:3', '3:2', '4:5', '5:4', 'Auto'];

/**
 * 根据当前选中的模型ID动态计算支持的比例选项
 * @param modelId 当前选中的模型ID
 * @returns 支持的比例列表
 */
function getDynamicRatioOptions(modelId?: string): string[] {
  if (!modelId) return DEFAULT_RATIO_OPTIONS;

  try {
    const capabilities = getModelCapabilities(modelId);
    return capabilities.aspectRatios;
  } catch (e) {
    console.error('获取模型能力失败:', e);
    return DEFAULT_RATIO_OPTIONS;
  }
}

const RATIO_OPTIONS = DEFAULT_RATIO_OPTIONS;
const RES_OPTIONS = ['1k', '2k', '4k'];
const COUNT_OPTIONS = [1, 2, 3, 4];

const DEL_SVG = '<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const SEND_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
const PAUSE_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h3v14H7zM14 5h3v14h-3z"/></svg>';

/** 指令输入框占位提示：text-gen 用命令示例，图片节点用绘图指令（反推模式 UI 已删除，W2-2） */
const PROMPT_INPUT_PLACEHOLDER = '输入指令编辑这张图，如：把背景换成浅灰水泥墙，加一盆绿萝';
const TEXT_GEN_INPUT_PLACEHOLDER = '输入命令，如：改得更专业、翻译成英文、反推这张图';

class CmdPanel {
  private el: HTMLElement | null = null;
  private ctxName!: HTMLElement;
  private ctxHint!: HTMLElement;
  private refs!: HTMLElement;
  private refMain!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private send!: HTMLButtonElement;
  private chipModelLabel!: HTMLElement;
  private chipModelBtn!: HTMLElement;
  private chipRatioLabel!: HTMLElement;
  private chipResLabel!: HTMLElement;
  private chipCountLabel!: HTMLElement;
  private historyEl!: HTMLElement;
  private promptPreview: HTMLElement | null = null;
  private modelOptions: Array<{ id: string; name: string }> = [];
  private chatModelOptions: Array<{ id: string; name: string }> = [];
  /** 动态参考图缩略元素（随 refImages/上游增删重建） */
  private _multiRefs: HTMLElement[] = [];
  /** 提示词库弹窗 */
  private libPopup: HTMLElement | null = null;

  init(): void {
    this.el = document.getElementById('cmd-panel');
    if (!this.el) return;
    // 保持贴卡直接编辑：提示词、模型、参数与参考图均由当前节点的悬浮面板直接操作。

    this.ctxName = document.getElementById('ctx-name') as HTMLElement;
    this.ctxHint = document.getElementById('ctx-hint') as HTMLElement;
    this.refs = document.getElementById('cmd-refs') as HTMLElement;
    this.refMain = document.getElementById('cmd-ref-main') as HTMLElement;
    this.input = document.getElementById('cmd-input') as HTMLTextAreaElement;
    this.send = document.getElementById('cmd-send') as HTMLButtonElement;
    this.chipModelLabel = document.getElementById('chip-model-label') as HTMLElement;
    this.chipModelBtn = document.getElementById('chip-model') as HTMLElement;
    this.chipRatioLabel = document.getElementById('chip-ratio-label') as HTMLElement;
    this.chipResLabel = document.getElementById('chip-res-label') as HTMLElement;
    this.chipCountLabel = document.getElementById('chip-count-label') as HTMLElement;
    this.historyEl = document.getElementById('cmd-text-history') as HTMLElement;

    // P1（W3-4）：最终 prompt 预览行——动态创建（image-gen 选中时展示 composeImagePrompt 只读结果）
    this.promptPreview = document.getElementById('cmd-prompt-preview') as HTMLElement | null;
    if (!this.promptPreview && this.el) {
      this.promptPreview = document.createElement('div');
      this.promptPreview.className = 'cmd-prompt-preview';
      this.promptPreview.id = 'cmd-prompt-preview';
      this.promptPreview.hidden = true;
      const controls = this.el.querySelector('.cmd-controls');
      if (controls) controls.before(this.promptPreview);
      else this.el.appendChild(this.promptPreview);
    }

    // 预取模型列表（绘图 + 对话，供 chip 菜单与默认模型回填）
    void fetchImageModels().then(models => { this.modelOptions = models; });
    void fetchChatModels().then(models => { this.chatModelOptions = models; });

    this._bindEvents();
    flowState.subscribe(() => this.sync());
  }

  private _bindEvents(): void {
    // 输入框聚焦即记一次快照：整段输入的 prompt/指令折叠为一步撤销（逐字记录会刷爆 50 步上限）
    this.input.addEventListener('focus', () => {
      if (selection.single()) flowHistory.record();
    });

    // 输入框：改自己 → 更新 params（不标 stale）；发送 → 运行
    this.input.addEventListener('input', () => {
      const node = selection.single();
      if (!node) return;
      if (node.type === 'text-gen') {
        flowState.updateNodeParams(node.id, { instruction: this.input.value });
      } else {
        flowState.updateNodeParams(node.id, { prompt: this.input.value });
      }
    });

    this.send.addEventListener('click', () => this._onSend());

    document.getElementById('chip-model')?.addEventListener('click', (e: MouseEvent) => {
      const node = selection.single();
      if (!node) return;
      e.stopPropagation();
      void this._openModelMenu(e.currentTarget as HTMLElement);
    });
    document.getElementById('chip-ratio')?.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      const node = selection.single();
      if (!node) return;
      // 根据模型ID获取支持的比例
      const modelId = (node.params as any).model; // 从 params 中获取 model ID
      const capabilities = getModelCapabilities(modelId || '');
      const filteredRatios = capabilities.aspectRatios.map(v => ({ id: v, name: v }));
      this._showChipMenu(e.currentTarget as HTMLElement, filteredRatios, 'aspectRatio');
    });
    document.getElementById('chip-res')?.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      this._showChipMenu(e.currentTarget as HTMLElement, RES_OPTIONS.map(v => ({ id: v, name: v })), 'resolution');
    });
    document.getElementById('chip-count')?.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      const node = selection.single();
      if (node && flowState.getUpstreams(node.id).some(n => n.type === 'text-split')) {
        showToast('已按文本拆分段数生成，无需选择张数', false);
        return;
      }
      this._showChipMenu(e.currentTarget as HTMLElement, COUNT_OPTIONS.map(v => ({ id: String(v), name: `${v}张` })), 'count');
    });

    document.getElementById('cmd-ref-add')?.addEventListener('click', () => {
      const node = selection.single();
      if (!node) return;
      interactions.openFilePickerForRef(node.id);
    });

    // 提示词库按钮
    document.getElementById('cmd-lib-btn')?.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      this._toggleLibPopup();
    });

    // 保存提示词按钮
    document.getElementById('cmd-lib-save')?.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      this._saveCurrentPromptToLibrary();
    });
  }

  // ==================== 提示词库 ====================

  private static readonly LIB_KEY = 'icv_prompt_library';

  private _getLibrary(): string[] {
    try {
      const raw = localStorage.getItem(CmdPanel.LIB_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return [];
  }

  private _saveCurrentPromptToLibrary(): boolean {
    const text = this.input.value.trim();
    if (!text) {
      showToast('先输入提示词，再收藏到库中', false);
      return false;
    }
    const lib = this._getLibrary();
    if (lib.includes(text)) {
      showToast('这条提示词已在库中', false);
      return false;
    }
    lib.unshift(text);
    this._saveLibrary(lib);
    showToast('已收藏到提示词库');
    return true;
  }

  private _saveLibrary(list: string[]): void {
    localStorage.setItem(CmdPanel.LIB_KEY, JSON.stringify(list));
  }

  private _toggleLibPopup(): void {
    if (this.libPopup) {
      this.libPopup.remove();
      this.libPopup = null;
      return;
    }
    this._showLibPopup();
  }

  private _showLibPopup(): void {
    if (!this.el) return;
    let library = this._getLibrary();

    const popup = document.createElement('div');
    popup.className = 'prompt-lib-popup';
    this.libPopup = popup;

    const head = document.createElement('div');
    head.className = 'prompt-lib-head';
    head.innerHTML = `
      <div><span class="prompt-lib-kicker">创作素材</span><strong>提示词库</strong><span class="prompt-lib-count"></span></div>
      <button type="button" class="prompt-lib-close" title="关闭提示词库" aria-label="关闭提示词库">×</button>`;
    popup.appendChild(head);

    // 搜索框
    const searchWrap = document.createElement('div');
    searchWrap.className = 'prompt-lib-search';
    searchWrap.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6"/><path d="m20 20-4-4"/></svg>';
    const searchInput = document.createElement('input');
    searchInput.placeholder = '搜索已收藏的提示词';
    searchInput.type = 'text';
    searchWrap.appendChild(searchInput);
    popup.appendChild(searchWrap);

    const saveWrap = document.createElement('div');
    saveWrap.className = 'prompt-lib-save-wrap';
    const saveCurrent = document.createElement('button');
    saveCurrent.type = 'button';
    saveCurrent.className = 'prompt-lib-save-current';
    saveCurrent.innerHTML = '<span>＋</span> 收藏当前提示词';
    saveWrap.appendChild(saveCurrent);
    popup.appendChild(saveWrap);

    // 列表
    const list = document.createElement('div');
    list.className = 'prompt-lib-list';
    popup.appendChild(list);

    const renderList = (filter = '') => {
      list.innerHTML = '';
      const items = filter ? library.filter(p => p.toLowerCase().includes(filter.toLowerCase())) : library;
      const count = head.querySelector('.prompt-lib-count') as HTMLElement;
      count.textContent = library.length ? `${library.length} 条` : '空';
      saveCurrent.disabled = !this.input.value.trim() || library.includes(this.input.value.trim());
      if (items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'prompt-lib-empty';
        empty.innerHTML = filter ? '没有找到匹配的提示词' : '还没有收藏提示词<br><span>把常用创作描述留在这里，随时复用。</span>';
        list.appendChild(empty);
        return;
      }
      items.forEach(prompt => {
        const item = document.createElement('div');
        item.className = 'prompt-lib-item';
        item.innerHTML = `<span class="prompt-lib-item-index">${library.indexOf(prompt) + 1}</span><span class="prompt-lib-item-text">${escapeHtml(prompt)}</span>`;
        item.title = prompt;
        item.addEventListener('click', () => {
          this.input.value = prompt;
          this.input.dispatchEvent(new Event('input'));
          this.libPopup?.remove();
          this.libPopup = null;
        });
        list.appendChild(item);
      });
    };

    renderList();
    searchInput.addEventListener('input', () => renderList(searchInput.value));
    saveCurrent.addEventListener('click', () => {
      if (this._saveCurrentPromptToLibrary()) {
        library = this._getLibrary();
        renderList(searchInput.value);
      }
    });
    head.querySelector('.prompt-lib-close')?.addEventListener('click', () => {
      popup.remove();
      this.libPopup = null;
    });

    // 关闭处理
    const closeHandler = (e: MouseEvent) => {
      if (!popup.contains(e.target as Node) && !(e.target as HTMLElement)?.closest('#cmd-lib-btn')) {
        popup.remove();
        this.libPopup = null;
        document.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 0);

    // 使用 fixed 定位，避免父容器 overflow:hidden 裁剪
    popup.style.position = 'fixed';
    const btn = document.getElementById('cmd-lib-btn');
    if (btn) {
      const rect = btn.getBoundingClientRect();
      const width = Math.min(360, window.innerWidth - 32);
      popup.style.left = Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)) + 'px';
      popup.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
      popup.style.width = width + 'px';
    } else {
      popup.style.left = '50%';
      popup.style.bottom = '100px';
      popup.style.transform = 'translateX(-50%)';
    }

    document.body.appendChild(popup);
    searchInput.focus();
  }

  private _onSend(): void {
    const node = selection.single();
    if (!node) return;
    if (node.status === 'run') {
      runEngine.cancel(node.id);
      return;
    }
    if (node.type === 'text-gen') {
      // 命令始终暂存在节点参数中，失焦、成功或失败均不清空，方便修改后重试。
      const command = this.input.value.trim() || ((node.params as unknown as TextGenParams).instruction || '').trim();
      flowState.updateNodeParams(node.id, { instruction: command });
      void runEngine.run(node.id);
    } else {
      // 输入框已下线（编辑职责在属性编辑器）：发送时回退节点 params.prompt，避免误清空
      const p = node.params as unknown as StyleTransferParams;
      const prompt = this.input.value.trim() || (typeof p.prompt === 'string' ? p.prompt : '');
      flowState.updateNodeParams(node.id, { prompt });
      void runEngine.run(node.id);
    }
  }

  /** 模型 chip：打开菜单前重新拉取模型（text-gen → chat 模型；image-gen → 绘图模型），确保设置里新增/拉取的模型即时可见 */
  private async _openModelMenu(btn: HTMLElement): Promise<void> {
    const node = selection.single();
    if (!node) return;
    if (node.type === 'text-gen') {
      this.chatModelOptions = await fetchChatModels();
      this._showChipMenu(btn, this.chatModelOptions.map(m => ({ id: m.id, name: m.name })), 'model');
    } else {
      // image-gen：仅绘图模型列表（文本模型 tab / 反推模式 UI 已删除，W2-2；modelType 运行时忽略 Q7）
      this.modelOptions = await fetchImageModels();
      this._showChipMenu(btn, this.modelOptions.map(m => ({ id: m.id, name: m.name })), 'model');
    }
  }

  private _showChipMenu(btn: HTMLElement, items: Array<{ id: string; name: string }>, paramType: string): void {
    document.querySelector('.param-menu')?.remove();
    const node = selection.single();
    if (!node) return;

    const rect = btn.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'param-menu';
    menu.style.left = rect.left + 'px';
    menu.style.top = (rect.bottom + 5) + 'px';

    const menuWidth = 180;
    if (rect.left + menuWidth > window.innerWidth - 12) {
      menu.style.left = (window.innerWidth - menuWidth - 12) + 'px';
    }

    const current = this._currentParam(node, paramType);
    items.forEach(item => {
      const div = document.createElement('div');
      div.className = 'param-menu-item' + (item.id === current ? ' selected' : '');
      div.textContent = item.name;
      div.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._applyParam(node.id, paramType, item.id);
        menu.remove();
      });
      menu.appendChild(div);
    });

    document.body.appendChild(menu);
    setTimeout(() => {
      const close = () => { menu.remove(); document.removeEventListener('click', close); };
      document.addEventListener('click', close);
    }, 0);
  }

  private _currentParam(node: FlowNode, paramType: string): string {
    const p = node.params as unknown as StyleTransferParams;
    switch (paramType) {
      case 'model': return p.model || '';
      case 'aspectRatio': return p.aspectRatio || '4:3';
      case 'resolution': return p.resolution || '2k';
      case 'count': return String(p.count ?? 1);
      default: return '';
    }
  }

  private _applyParam(nodeId: string, paramType: string, value: string): void {
    const node = flowState.getNode(nodeId);
    if (!node) return;
    flowHistory.record();
    if (paramType === 'model') {
      flowState.updateNodeParams(nodeId, { model: value });
      if (value) {
        // text-gen 记 chat 默认模型（与绘图默认模型互不污染）
        localStorage.setItem(node.type === 'text-gen' ? DEFAULT_CHAT_MODEL_KEY : 'icv_default_model', value);
      }
    } else if (paramType === 'aspectRatio') {
      flowState.updateNodeParams(nodeId, { aspectRatio: value });
    } else if (paramType === 'resolution') {
      flowState.updateNodeParams(nodeId, { resolution: value });
    } else if (paramType === 'count') {
      flowState.updateNodeParams(nodeId, { count: Number(value) || 1 });
    }
  }

  /** 状态/选中变更 → 刷新面板 */
  sync(): void {
    if (!this.el) return;
    const node = selection.single();
    if (!node) {
      this.el.classList.remove('show', 'pos-above', 'textgen', 'reverse');
      return;
    }

    // 素材节点：仅展示图、不可输入指令——隐藏面板（含默认模型回填跳过，W5-2）
    if (flowState.isAssetNode(node) || node.type === 'text-split') {
      this.el.classList.remove('show', 'pos-above', 'textgen', 'reverse');
      return;
    }

    // 默认模型回填：数据行为，与面板显隐解耦——选中节点即回填（不受下方 Tab 门控影响），
    // 保证「新建节点/连线插入节点 → 运行选中」在面板收起态也能拿到默认模型（QA 回归 P1）。
    // text-gen 回填对话模型；其余（image-gen）回填绘图模型。
    if (!(node.params.model as string | undefined)) {
      if (node.type === 'text-gen') this._ensureChatModel(node.id);
      else this._ensureModel(node.id);
    }

    // Tab 化：面板默认收起；仅当 Tab 呼出（floatingPanels.isVisible()）时才显示/定位。
    // 显示态下切换选中节点：仍会走下方逻辑刷新内容/位置（跟随新选中节点），不会误收起。
    if (!floatingPanels.isVisible()) {
      this.el.classList.remove('show', 'pos-above', 'textgen', 'reverse');
      return;
    }

    // 上下文标识
    this.ctxName.textContent = node.title || '节点';

    // text-gen 面板：隐藏绘图参数 chips（比例/分辨率/张数）与参考图区，模型 chip 切到文本模型；
    // image-gen 面板：绘图参数 chips 全显示（反推模式 UI 已删除，W2-2）
    const isTextGen = node.type === 'text-gen';
    const isTextSplitDriven = !isTextGen && flowState.getUpstreams(node.id).some(n => n.type === 'text-split');
    this.el.classList.toggle('textgen', isTextGen);
    this.el.classList.toggle('textsplit-driven', isTextSplitDriven);
    this.el.classList.remove('reverse');

    // chip/发送钮 title 文案随节点类型切换（文本处理 / 图片生成）
    this.chipModelBtn.title = isTextGen ? '选择文本模型' : '选择绘图模型';
    const isRunning = node.status === 'run';
    this.send.title = isRunning ? '暂停' : (isTextGen ? '处理文本' : '生成');
    this.send.setAttribute('aria-label', this.send.title);
    this.send.innerHTML = isRunning ? PAUSE_SVG : SEND_SVG;

    // 输入框占位提示跟随节点类型（切换选中节点时同步变化）
    if (isTextGen) {
      this.input.placeholder = TEXT_GEN_INPUT_PLACEHOLDER;
    } else {
      this.input.placeholder = PROMPT_INPUT_PLACEHOLDER;
    }

    this.ctxHint.textContent =
      node.status === 'stale' ? '· 上游已改，待重跑' :
      node.status === 'done' ? '· 已完成' :
      node.status === 'run' ? this._runHint(node.id) :
      node.status === 'fail' ? (isTextGen ? '· 处理失败' : '· 生成失败') : '';

    // 输入框（用户未聚焦时回填）：文本命令与图片提示词均从节点参数恢复，避免点出输入框后内容消失。
    this.input.disabled = isTextSplitDriven;
    if (isTextSplitDriven) {
      this.input.value = '';
      this.input.placeholder = '提示词由上游文本拆分节点提供';
    } else if (document.activeElement !== this.input) {
      if (isTextGen) {
        const p = node.params as unknown as TextGenParams;
        this.input.value = p.instruction || '';
      } else {
        const p = node.params as unknown as StyleTransferParams;
        this.input.value = p.prompt || '';
      }
    }
    this.send.disabled = false;

    this._renderRefs();
    this._renderChips(node);
    this._renderTextHistory(node);
    this._renderPromptPreview(node);
    this._position(node);
  }

  /** run 状态提示：text-gen「处理中」；批次「生成中 done/total」（无批次时退化为「生成中」） */
  private _runHint(nodeId: string): string {
    const node = flowState.getNode(nodeId);
    if (node && node.type === 'text-gen') return '· 处理中';
    const p = runEngine.getBatchProgress(nodeId);
    if (p && p.total > 0) return `· 生成中 ${p.done}/${p.total}`;
    return '· 生成中';
  }

  private _modelFilling = new Set<string>();

  /** 生成节点未配置模型时：自动回填默认模型（localStorage 或第一个可用模型） */
  private _ensureModel(nodeId: string): void {
    if (this._modelFilling.has(nodeId)) return;
    this._modelFilling.add(nodeId);
    // 过滤掉 _getImageModels 无模型时返回的占位项 { id:'' }
    const valid = (): Array<{ id: string; name: string }> => this.modelOptions.filter(m => Boolean(m.id));
    const apply = () => {
      const node = flowState.getNode(nodeId);
      if (!node || (node.params.model as string | undefined)) return;
      const opts = valid();
      const saved = localStorage.getItem('icv_default_model');
      const target = saved && opts.some(m => m.id === saved)
        ? saved
        : (opts[0]?.id || '');
      if (target) flowState.updateNodeParams(nodeId, { model: target });
    };
    if (valid().length > 0) { apply(); return; }
    void fetchImageModels().then(models => {
      this.modelOptions = models.filter(m => Boolean(m.id));
      apply();
    });
  }

  /** text-gen 未配置模型时：自动回填默认对话模型（localStorage icv_default_chat_model 或第一个可用 chat 模型） */
  private _ensureChatModel(nodeId: string): void {
    if (this._modelFilling.has(nodeId)) return;
    this._modelFilling.add(nodeId);
    const valid = (): Array<{ id: string; name: string }> => this.chatModelOptions.filter(m => Boolean(m.id));
    const apply = () => {
      const node = flowState.getNode(nodeId);
      if (!node || (node.params.model as string | undefined)) return;
      const opts = valid();
      const saved = localStorage.getItem(DEFAULT_CHAT_MODEL_KEY);
      const target = saved && opts.some(m => m.id === saved)
        ? saved
        : (opts[0]?.id || '');
      if (target) flowState.updateNodeParams(nodeId, { model: target });
    };
    if (valid().length > 0) { apply(); return; }
    void fetchChatModels().then(models => {
      this.chatModelOptions = models.filter(m => Boolean(m.id));
      apply();
    });
  }

  /** 历史反推结果列表：最新在前、单行截断 + 时间；点击回填（=恢复该历史输出，联动覆盖下游 prompt + 标 stale） */
  private _renderTextHistory(node: FlowNode): void {
    if (!this.historyEl) return;
    const history = flowState.getTextHistory(node.id);
    if (history.length === 0) {
      this.historyEl.classList.remove('show');
      this.historyEl.innerHTML = '';
      return;
    }
    this.historyEl.classList.add('show');
    this.historyEl.innerHTML = '<div class="cmd-text-history-title">历史反推结果</div>';
    history.forEach(item => {
      const div = document.createElement('div');
      div.className = 'cmd-text-history-item';
      div.title = item.text;
      const time = new Date(item.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      div.innerHTML = `<span class="cmd-text-history-time">${time}</span><span class="cmd-text-history-summary">${escapeHtml(item.text)}</span>`;
      div.addEventListener('click', () => this._refillHistoryItem(node.id, item));
      this.historyEl!.appendChild(div);
    });
  }

  /** 历史回填动作（与运行成功/就地编辑三处口径一致，W4-3）：写 outputText + 标下游 stale；旁路已删除，不覆盖下游 prompt */
  private _refillHistoryItem(nodeId: string, item: TextGenHistoryItem): void {
    flowHistory.record();
    flowState.updateNode(nodeId, { outputText: item.text });
    dirty.markUpstreamChanged(nodeId);
    showToast('已回填历史反推文本');
  }

  /** P1（W3-4）：最终 prompt 预览——已禁用，不再显示最终 prompt 预览 */
  private _renderPromptPreview(node: FlowNode): void {
    if (!this.promptPreview) return;
    // 用户不需要最终 prompt 预览，直接隐藏
    this.promptPreview.hidden = true;
  }

  /** 参考图区：展示 getReferenceImages(id)（本节点 refImages + 上游可作参考图的图），本节点 refImages 支持删除 */
  private _renderRefs(): void {
    const node = selection.single();
    if (!node) { this.refs.style.display = 'none'; return; }
    this.refs.style.display = 'flex';
    this._clearMultiRefs();
    this.refMain.style.display = 'none';

    const refs = flowState.getReferenceImages(node.id);
    if (refs.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'cmd-ref-hint';
      hint.textContent = '拖入图片或连接上游节点添加参考图';
      this.refs.insertBefore(hint, this.refMain);
      this._multiRefs.push(hint);
      return;
    }

    refs.forEach(url => {
      const isOwn = (node.refImages || []).includes(url);
      const t = document.createElement('div');
      t.className = 'cmd-ref';
      t.style.backgroundImage = `url('${url.replace(/'/g, "\\'")}')`;
      t.title = isOwn ? '参考图（可删除）' : '上游参考图';
      if (isOwn) {
        const del = document.createElement('button');
        del.className = 'cmd-ref-del';
        del.innerHTML = DEL_SVG;
        del.title = '删除参考图';
        del.addEventListener('click', (e: MouseEvent) => {
          e.stopPropagation();
          flowHistory.record();
          flowState.removeRefImage(node.id, url);
          dirty.markStale(node.id);
        });
        t.appendChild(del);
      }
      this.refs.insertBefore(t, this.refMain);
      this._multiRefs.push(t);
    });
  }

  private _clearMultiRefs(): void {
    this._multiRefs.forEach(t => t.remove());
    this._multiRefs = [];
  }

  private _renderChips(node: FlowNode): void {
    const p = node.params as unknown as StyleTransferParams;
    // 模型 chip 名称按节点类型查对应模型列表（text-gen → chat；image-gen → 绘图；反推模式已删除）
    let modelName: string;
    if (node.type === 'text-gen') {
      const model = this.chatModelOptions.find(m => m.id === p.model);
      modelName = model ? model.name : (p.model || '选择模型');
    } else {
      const model = this.modelOptions.find(m => m.id === p.model);
      modelName = model ? model.name : (p.model || '选择模型');
    }
    this.chipModelLabel.textContent = modelName;
    this.chipRatioLabel.textContent = p.aspectRatio || '4:3';
    this.chipResLabel.textContent = (p.resolution || '2k').toUpperCase();
    this.chipCountLabel.textContent = flowState.getUpstreams(node.id).some(n => n.type === 'text-split') ? '按拆分段数' : `${p.count ?? 1}张`;
  }

  /** 智能避让定位（原型 syncBars 逻辑） */
  private _position(node: FlowNode): void {
    if (!this.el) return;
    const wrap = canvasView.wrap;
    if (!wrap) return;
    const wr = wrap.getBoundingClientRect();
    const { x: cx0, y: topY } = canvasView.worldToWrap(node.x + CARD_W / 2, node.y);
    const botY = canvasView.worldToWrap(0, node.y + (node.h ?? cardView.cardHeight(node))).y;

    const cpH = this.el.offsetHeight || 240;
    const roomBelow = wr.height - botY;
    const flip = roomBelow < cpH + 24 && topY > cpH + 70;
    this.el.classList.toggle('pos-above', flip);

    const cpW = this.el.offsetWidth || 640;
    const cpCx = Math.min(Math.max(cx0, cpW / 2 + 12), wr.width - cpW / 2 - 12);

    this.el.style.left = cpCx + 'px';
    this.el.style.top = (flip ? topY : botY) + 'px';
    this.el.classList.add('show');
  }
}

/** HTML 转义（历史列表展示反推文本用，防注入） */
function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const cmdPanel = new CmdPanel();
