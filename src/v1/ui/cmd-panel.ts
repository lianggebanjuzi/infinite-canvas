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
import { fetchImageModels, fetchChatModels, fetchVideoModels, fetchAudioModels } from '../api';
import { showToast } from './toast';
import { floatingPanels } from './floating-panels';
import { outpaintPanel } from './outpaint-panel';
import { promptLibraryStore } from './prompt-library';
import { assetStore } from '../asset-store';
import { historyDrawer } from './history-drawer';
import { uid } from '../../utils/uid';
import { getSupportedAspectRatios, getModelCapabilities } from '../nodes/model-config';
import { getVideoModelCapabilities, getAudioModelCapabilities } from '../nodes/model-config';

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
  private outpaintSettings: HTMLElement | null = null;
  private outpaintSettingsRatio: HTMLElement | null = null;
  private outpaintSettingsSummary: HTMLElement | null = null;
  private historyEl!: HTMLElement;
  private promptPreview: HTMLElement | null = null;
  /** 4.1-B @素材：token chip 条与资源选择器 */
  private mentionStrip: HTMLElement | null = null;
  private mentionPicker: HTMLElement | null = null;
  /** 打开选择器时记录的插入点（搜索框聚焦会移走 textarea 焦点，不能再读 selectionStart） */
  private mentionInsertPos = 0;
  private modelOptions: Array<{ id: string; name: string }> = [];
  private chatModelOptions: Array<{ id: string; name: string }> = [];
  private videoModelOptions: Array<{ id: string; name: string }> = [];
  private audioModelOptions: Array<{ id: string; name: string }> = [];
  /** 4.2-A：视频首帧/尾帧选择条（仅模型 capability supportsStartEndFrame 时显示） */
  private frameStrip: HTMLElement | null = null;
  /** 异步模型拉取序号：迟到的旧请求不得覆盖 pywebview 就绪后的新结果。 */
  private modelLoadSeq = 0;
  /** 动态参考图缩略元素（随 refImages/上游增删重建） */
  private _multiRefs: HTMLElement[] = [];
  /** 提示词库弹窗 */
  private libPopup: HTMLElement | null = null;
  /** 普通图片任务默认只露出提示词与参考；模型等高级设置按需展开。 */
  private advancedOpen = false;

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
    // 扩图摘要元素：HTML 缺 id 时置 null，渲染走 ?. 防御（Phase 1 遗留低危项修复）
    this.outpaintSettings = document.getElementById('outpaint-settings') as HTMLElement | null;
    this.outpaintSettingsRatio = document.getElementById('outpaint-settings-ratio') as HTMLElement | null;
    this.outpaintSettingsSummary = document.getElementById('outpaint-settings-summary') as HTMLElement | null;
    this.historyEl = document.getElementById('cmd-text-history') as HTMLElement;
    this.mentionStrip = document.getElementById('cmd-mentions') as HTMLElement | null;
    document.getElementById('cmd-advanced-toggle')?.addEventListener('click', () => {
      this.advancedOpen = !this.advancedOpen;
      this.sync();
    });
    const controls = this.el.querySelector('.cmd-controls');
    if (controls && !document.getElementById('chip-video-audio')) {
      controls.insertAdjacentHTML('beforeend', '<label id="chip-video-audio" class="cmd-video-audio" hidden><input type="checkbox"> 含音频</label>');
      const toggle = document.querySelector('#chip-video-audio input') as HTMLInputElement | null;
      toggle?.addEventListener('change', () => {
        const node = selection.single();
        if (node?.type === 'video-gen') flowState.updateNodeParams(node.id, { audio: toggle.checked });
      });
    }

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

    // 4.2-A：视频首帧/尾帧选择条（动态创建；仅 supportsStartEndFrame 时显示）
    if (this.el && !this.el.querySelector('#cmd-frame-strip')) {
      this.frameStrip = document.createElement('div');
      this.frameStrip.className = 'cmd-frame-strip';
      this.frameStrip.id = 'cmd-frame-strip';
      this.frameStrip.hidden = true;
      this.frameStrip.innerHTML = `
        <span class="cmd-frame-title">首尾帧</span>
        <button class="cmd-frame-pick" data-frame="start" title="选择首帧图片">首帧</button>
        <button class="cmd-frame-pick" data-frame="end" title="选择尾帧图片">尾帧</button>
        <button class="cmd-frame-clear" title="清除首尾帧">清除</button>
        <span class="cmd-frame-hint"></span>`;
      const refsEl = document.getElementById('cmd-refs');
      if (refsEl) refsEl.before(this.frameStrip);
      else this.el.appendChild(this.frameStrip);
      this.frameStrip.addEventListener('click', (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (target.classList.contains('cmd-frame-pick')) {
          this._pickFrame(target.dataset.frame === 'end' ? 'end' : 'start');
        } else if (target.classList.contains('cmd-frame-clear')) {
          this._clearFrames();
        }
      });
    } else {
      this.frameStrip = this.el?.querySelector('#cmd-frame-strip') as HTMLElement | null;
    }

    // 预取模型列表（绘图 + 对话，供 chip 菜单与默认模型回填）。主入口会在
    // pywebview 就绪后再次调用，避免启动竞态把空列表永久留在面板内。
    void this.refreshModels();

    this._bindEvents();
    flowState.subscribe(() => this.sync());
    canvasView.onViewChange(() => this.reposition());
  }

  /** 供「继续创作」等图片动作直接把用户带到下一句想法，避免还要再找输入框。 */
  focusInput(): void {
    window.requestAnimationFrame(() => {
      if (this.input && !this.input.disabled) this.input.focus();
    });
  }

  /** 读取当前输入框内容（提示词页签「收藏当前输入」用；未选中节点时为上次输入） */
  getCurrentPrompt(): string {
    return this.input ? this.input.value : '';
  }

  /** 提示词页签「插入」：把选中的提示词写入当前输入框并同步节点参数（无选中节点时仅填输入框） */
  insertPromptToCurrent(prompt: string): void {
    if (!this.input) return;
    this.input.value = prompt;
    this.input.dispatchEvent(new Event('input'));
    const node = selection.single();
    showToast(node && node.type !== 'text-split' ? '已插入当前节点提示词' : '已填入提示词输入框');
  }

  /** 在桥接就绪或供应商配置变更后刷新模型；完成后立即刷新当前卡片的显示名。 */
  async refreshModels(): Promise<void> {
    const seq = ++this.modelLoadSeq;
    const [imageModels, chatModels, videoModels, audioModels] = await Promise.all([
      fetchImageModels(),
      fetchChatModels(),
      fetchVideoModels(),
      fetchAudioModels(),
    ]);
    if (seq !== this.modelLoadSeq) return;
    this.modelOptions = imageModels.filter(model => Boolean(model.id));
    this.chatModelOptions = chatModels.filter(model => Boolean(model.id));
    this.videoModelOptions = videoModels.filter(model => Boolean(model.id));
    this.audioModelOptions = audioModels.filter(model => Boolean(model.id));
    this.sync();
  }

  private _bindEvents(): void {
    // 输入框聚焦即记一次快照：整段输入的 prompt/指令折叠为一步撤销（逐字记录会刷爆 50 步上限）
    this.input.addEventListener('focus', () => {
      if (selection.single()) flowHistory.record();
    });

    // 输入框：改自己 → 更新 params（不标 stale）；发送 → 运行
    this.input.addEventListener('input', () => {
      this._autoResizeInput();
      const node = selection.single();
      if (!node) return;
      if (node.type === 'text-gen') {
        flowState.updateNodeParams(node.id, { instruction: this.input.value });
      } else {
        flowState.updateNodeParams(node.id, { prompt: this.input.value });
        // 4.1-B：token 文本与结构化 mentions 保持同步（删除 token 即移除引用）
        this._syncMentionsFromText(node.id, this.input.value);
      }
    });

    // 4.1-B @素材：图片节点输入框内输入 @ 打开资源选择器
    this.input.addEventListener('keydown', (e: KeyboardEvent) => {
      const node = selection.single();
      if (!node || node.type !== 'image-gen') return;
      if ((node.params as unknown as StyleTransferParams).mode === 'outpaint') return;
      if (e.key !== '@') return;
      e.preventDefault();
      const text = this.input.value;
      const before = text.slice(0, this.input.selectionStart ?? text.length);
      const prevChar = before.length > 0 ? before[before.length - 1] : '';
      if (before.length > 0 && !/\s/.test(prevChar)) return; // 词中 @ 不触发
      this.mentionInsertPos = this.input.selectionStart ?? text.length;
      this._openMentionPicker();
    });

    this.send.addEventListener('click', () => this._onSend());

    document.getElementById('chip-model')?.addEventListener('click', (e: MouseEvent) => {
      const node = selection.single();
      if (!node) return;
      e.stopPropagation();
      if ((node.params as unknown as StyleTransferParams).mode === 'outpaint') {
        // 扩图只允许兼容的自动解析模型；从同一弹窗调整，避免选到普通绘图模型后运行失败。
        void outpaintPanel.open(node.id);
        return;
      }
      if (node.type === 'audio-gen') {
        void this._openModelMenu(e.currentTarget as HTMLElement);
        return;
      }
      if (node.type === 'video-gen') {
        const caps = getVideoModelCapabilities((node.params as unknown as VideoGenParams).model || '');
        this._showChipMenu(e.currentTarget as HTMLElement, caps.aspectRatios.map(id => ({ id, name: id })), 'aspectRatio');
        return;
      }
      void this._openModelMenu(e.currentTarget as HTMLElement);
    });
    document.getElementById('chip-ratio')?.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      const node = selection.single();
      if (node?.type === 'audio-gen') {
        // 音频：chip-ratio 复用为格式选择（mp3/wav/ogg）
        const caps = getAudioModelCapabilities((node.params as unknown as AudioGenParams).model || '');
        const formats = (caps.formats.length ? caps.formats : ['mp3']).map(id => ({ id, name: id.toUpperCase() }));
        this._showChipMenu(e.currentTarget as HTMLElement, formats, 'format');
        return;
      }
      if (node?.type === 'video-gen') {
        const caps = getVideoModelCapabilities((node.params as unknown as VideoGenParams).model || '');
        this._showChipMenu(e.currentTarget as HTMLElement, caps.resolutions.map(id => ({ id, name: id })), 'resolution');
        return;
      }
      if (!node) return;
      if ((node.params as unknown as StyleTransferParams).mode === 'outpaint') {
        // 常规模型能力表可能含 3:2 / Auto 等扩图画布尚未支持的比例。
        // 统一转到扩图画布，比例和原图摆放始终以同一个预览为准。
        void outpaintPanel.open(node.id);
        return;
      }
      // 根据模型ID获取支持的比例
      const modelId = (node.params as any).model; // 从 params 中获取 model ID
      const capabilities = getModelCapabilities(modelId || '');
      const filteredRatios = capabilities.aspectRatios.map(v => ({ id: v, name: v }));
      this._showChipMenu(e.currentTarget as HTMLElement, filteredRatios, 'aspectRatio');
    });
    document.getElementById('chip-res')?.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      const node = selection.single();
      if (node?.type === 'audio-gen') {
        // 音频：chip-res 复用为时长选择（仅 capability 声明 seconds 时显示）
        const caps = getAudioModelCapabilities((node.params as unknown as AudioGenParams).model || '');
        if (caps.seconds.length === 0) { showToast('当前音频模型未声明可选时长', false); return; }
        this._showChipMenu(e.currentTarget as HTMLElement, caps.seconds.map(id => ({ id: String(id), name: `${id} 秒` })), 'seconds');
        return;
      }
      if (node?.type === 'video-gen') {
        const caps = getVideoModelCapabilities((node.params as unknown as VideoGenParams).model || '');
        this._showChipMenu(e.currentTarget as HTMLElement, caps.seconds.map(id => ({ id: String(id), name: `${id} 秒` })), 'seconds');
        return;
      }
      if (node && (node.params as unknown as StyleTransferParams).mode === 'outpaint') {
        showToast('扩图固定生成 1 张 4K 图；请点击比例调整画布', false);
        return;
      }
      this._showChipMenu(e.currentTarget as HTMLElement, RES_OPTIONS.map(v => ({ id: v, name: v })), 'resolution');
    });
    document.getElementById('chip-count')?.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      const node = selection.single();
      if (node?.type === 'audio-gen') {
        showToast('音频生成每次生成一条音频，无需选择数量', false);
        return;
      }
      if (node && (node.params as unknown as StyleTransferParams).mode === 'outpaint') {
        showToast('扩图固定生成 1 张 4K 图；请点击比例调整画布', false);
        return;
      }
      if (node && flowState.getUpstreams(node.id).some(n => n.type === 'text-split')) {
        showToast('已按文本拆分段数生成，无需选择张数', false);
        return;
      }
      this._showChipMenu(e.currentTarget as HTMLElement, COUNT_OPTIONS.map(v => ({ id: String(v), name: `${v}张` })), 'count');
    });
    document.getElementById('outpaint-settings-adjust')?.addEventListener('click', () => {
      const node = selection.single();
      if (node && (node.params as unknown as StyleTransferParams).mode === 'outpaint') {
        void outpaintPanel.open(node.id);
      }
    });

    document.getElementById('cmd-ref-add')?.addEventListener('click', () => {
      const node = selection.single();
      if (!node) return;
      interactions.openFilePickerForRef(node.id);
    });

    // 提示词库按钮
    document.getElementById('cmd-lib-btn')?.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      void this._toggleLibPopup();
    });

    // 保存提示词按钮（数据源 = 共享 promptLibraryStore，与左侧资源抽屉提示词页签一致）
    document.getElementById('cmd-lib-save')?.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      void promptLibraryStore.savePrompt(this.input.value);
    });
  }

  /** 按内容增高而非过早出现内部滚动条；极长文本仍在 240px 后滚动，避免遮住画布。 */
  private _autoResizeInput(): void {
    const maxHeight = 240;
    this.input.style.height = 'auto';
    const height = Math.max(52, Math.min(this.input.scrollHeight, maxHeight));
    this.input.style.height = `${height}px`;
    this.input.style.overflowY = this.input.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }

  // ==================== 提示词库 ====================
  // 数据读写已收敛到共享 promptLibraryStore（prompt-library.ts）：
  // 指令面板的收藏按钮/弹窗与左侧资源抽屉「提示词」页签共用同一份数据，
  // 避免两处 localStorage/后端读写逻辑分叉。

  private async _toggleLibPopup(): Promise<void> {
    if (this.libPopup) {
      this.libPopup.remove();
      this.libPopup = null;
      return;
    }
    await promptLibraryStore.ready();
    this._showLibPopup();
  }

  private _showLibPopup(): void {
    if (!this.el) return;
    let library = promptLibraryStore.list();

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
      void promptLibraryStore.savePrompt(this.input.value).then(saved => {
        if (!saved) return;
        library = promptLibraryStore.list();
        renderList(searchInput.value);
      });
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

  // ───────────────────────── 4.1-B @素材引用 ─────────────────────────

  /** 读取节点结构化 mentions（缺失返回 []）。 */
  private _readMentions(nodeId: string): PromptMention[] {
    const node = flowState.getNode(nodeId);
    const mentions = (node?.params as Record<string, unknown> | undefined)?.mentions;
    return Array.isArray(mentions) ? mentions.filter((m): m is PromptMention => !!m && typeof m === 'object') : [];
  }

  /** 写入节点结构化 mentions。 */
  private _writeMentions(nodeId: string, mentions: PromptMention[]): void {
    flowState.updateNodeParams(nodeId, { mentions });
  }

  /** 资源是否已丢失：图片无任何可解析来源、文本无正文且无名称。 */
  private _isMentionMissing(m: PromptMention): boolean {
    if (m.kind === 'image') {
      if (m.sourceNodeId && flowState.getNode(m.sourceNodeId)) return false;
      return !m.imageUrl && !m.originalPath;
    }
    return !m.text && !m.label;
  }

  /**
   * 输入变化后同步 mentions：按文本中 `@label` 出现次数保留前 N 个同名 mention
   * （删除 token 文本即移除对应引用；同名素材各绑各的资源，不会互相引用错）。
   */
  private _syncMentionsFromText(nodeId: string, text: string): void {
    const mentions = this._readMentions(nodeId);
    if (mentions.length === 0) return;
    const used = new Map<string, number>();
    const kept: PromptMention[] = [];
    mentions.forEach(m => {
      const label = m.label || '';
      if (!label) return;
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`@${escaped}`, 'g');
      const total = (text.match(re) || []).length;
      const current = used.get(label) ?? 0;
      if (current < total) {
        used.set(label, current + 1);
        kept.push(m);
      }
    });
    if (kept.length !== mentions.length) this._writeMentions(nodeId, kept);
  }

  /** 渲染 token chip 条：显示名称 + 删除；资源丢失标红。 */
  private _renderMentions(): void {
    if (!this.mentionStrip) return;
    const node = selection.single();
    if (!node || node.type !== 'image-gen' || (node.params as unknown as StyleTransferParams).mode === 'outpaint') {
      this.mentionStrip.hidden = true;
      this.mentionStrip.innerHTML = '';
      return;
    }
    const mentions = this._readMentions(node.id);
    this.mentionStrip.hidden = mentions.length === 0;
    this.mentionStrip.innerHTML = '';
    mentions.forEach(m => {
      const chip = document.createElement('span');
      chip.className = 'cmd-mention-chip' + (this._isMentionMissing(m) ? ' missing' : '');
      chip.title = this._isMentionMissing(m) ? '引用资源已丢失：请移除或替换' : '点击 ✕ 移除该引用';
      const label = document.createElement('span');
      label.className = 'cmd-mention-label';
      label.textContent = `@${m.label || '未命名'}`;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'cmd-mention-del';
      del.textContent = '✕';
      del.title = '移除引用';
      del.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
        this._removeMention(node.id, m);
      });
      chip.append(label, del);
      this.mentionStrip!.appendChild(chip);
    });
  }

  /** 删除 chip：移除结构化引用 + 移除提示词中首个 `@label` 文本。 */
  private _removeMention(nodeId: string, mention: PromptMention): void {
    const node = flowState.getNode(nodeId);
    if (!node) return;
    const mentions = this._readMentions(nodeId).filter(m => m.id !== mention.id);
    this._writeMentions(nodeId, mentions);
    const label = mention.label || '';
    const p = node.params as unknown as StyleTransferParams;
    const text = typeof p.prompt === 'string' ? p.prompt : '';
    if (label) {
      const token = `@${label}`;
      const idx = text.indexOf(token);
      if (idx >= 0) {
        const next = text.slice(0, idx) + text.slice(idx + token.length);
        flowState.updateNodeParams(nodeId, { prompt: next });
        this.input.value = next;
        this._autoResizeInput();
      }
    }
    this._renderMentions();
  }

  /** 打开 @ 资源选择器（项目资产 / 历史图片 / 画布图片 / 文本片段）。 */
  private _openMentionPicker(): void {
    this.mentionPicker?.remove();
    const node = selection.single();
    if (!node) return;

    type Candidate = PromptMention & { group: string; thumb?: string };
    const candidates: Candidate[] = [];

    // 项目资产
    assetStore.getAssets().forEach(a => {
      const url = a.thumbnailUrl || a.url;
      if (!url) return;
      candidates.push({
        id: uid('ment-asset'), kind: 'image', label: this.assetLabel(a), group: '项目资产',
        imageUrl: url, originalPath: a.originalPath, thumb: a.thumbnailUrl || a.url,
      });
    });
    // 历史图片
    historyDrawer.listImages().forEach(h => {
      const url = h.thumbnail || h.src;
      if (!url) return;
      candidates.push({
        id: uid('ment-history'), kind: 'image', label: h.prompt ? h.prompt.slice(0, 24) : '历史图片', group: '历史图片',
        imageUrl: url, originalPath: h.originalPath, thumb: h.thumbnail || h.src, text: h.prompt,
      });
    });
    // 画布图片
    flowState.nodes.forEach(n => {
      if (!n.imageUrl) return;
      candidates.push({
        id: uid('ment-canvas'), kind: 'image', label: n.title || '画布图片', group: '画布图片',
        imageUrl: n.imageUrl, originalPath: n.imageOrigin?.path, sourceNodeId: n.id, thumb: n.imageUrl,
      });
    });
    // 文本片段
    flowState.nodes.forEach(n => {
      if (n.type !== 'text-gen' || !n.outputText?.trim()) return;
      candidates.push({
        id: uid('ment-text'), kind: 'text', label: (n.outputText || '').trim().slice(0, 24), group: '文本片段',
        text: n.outputText || '', sourceNodeId: n.id,
      });
    });

    const popup = document.createElement('div');
    popup.className = 'mention-picker';
    this.mentionPicker = popup;

    const head = document.createElement('div');
    head.className = 'mention-picker-head';
    head.innerHTML = '<strong>@ 引用素材</strong><button type="button" class="mention-picker-close" title="关闭">×</button>';
    popup.appendChild(head);

    const searchWrap = document.createElement('div');
    searchWrap.className = 'mention-picker-search';
    const search = document.createElement('input');
    search.type = 'text';
    search.placeholder = '搜索资产 / 历史 / 画布 / 文本…';
    searchWrap.appendChild(search);
    popup.appendChild(searchWrap);

    const list = document.createElement('div');
    list.className = 'mention-picker-list';
    popup.appendChild(list);

    const renderList = (filter = '') => {
      list.innerHTML = '';
      const q = filter.trim().toLowerCase();
      const groups = new Map<string, Candidate[]>();
      candidates.forEach(c => {
        if (q && !((c.label || '').toLowerCase().includes(q) || (c.text || '').toLowerCase().includes(q))) return;
        const arr = groups.get(c.group) || [];
        arr.push(c);
        groups.set(c.group, arr);
      });
      if (groups.size === 0) {
        const empty = document.createElement('div');
        empty.className = 'mention-picker-empty';
        empty.textContent = '没有匹配的素材';
        list.appendChild(empty);
        return;
      }
      groups.forEach((items, group) => {
        const g = document.createElement('div');
        g.className = 'mention-picker-group';
        g.textContent = group;
        list.appendChild(g);
        items.slice(0, 20).forEach(c => {
          const item = document.createElement('button');
          item.type = 'button';
          item.className = 'mention-picker-item';
          if (c.thumb) {
            const thumb = document.createElement('span');
            thumb.className = 'mention-picker-thumb';
            thumb.style.backgroundImage = `url('${c.thumb.replace(/'/g, "\\'")}')`;
            item.appendChild(thumb);
          } else {
            const icon = document.createElement('span');
            icon.className = 'mention-picker-thumb mention-picker-text-icon';
            icon.textContent = 'T';
            item.appendChild(icon);
          }
          const meta = document.createElement('span');
          meta.className = 'mention-picker-meta';
          meta.textContent = c.label;
          item.appendChild(meta);
          item.addEventListener('click', () => {
            this._insertMention(node.id, c);
            popup.remove();
            this.mentionPicker = null;
          });
          list.appendChild(item);
        });
      });
    };
    renderList();
    search.addEventListener('input', () => renderList(search.value));

    head.querySelector('.mention-picker-close')?.addEventListener('click', () => {
      popup.remove();
      this.mentionPicker = null;
    });
    const closeHandler = (e: MouseEvent) => {
      if (!popup.contains(e.target as Node)) {
        popup.remove();
        this.mentionPicker = null;
        document.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 0);

    popup.style.position = 'fixed';
    const rect = this.input.getBoundingClientRect();
    const width = Math.min(340, window.innerWidth - 32);
    popup.style.left = Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)) + 'px';
    popup.style.top = (rect.bottom + 6) + 'px';
    popup.style.width = width + 'px';
    document.body.appendChild(popup);
    search.focus();
  }

  /** 资产条目 → 可读名称（prompt 优先、模型次之、缺省「资产」）。 */
  private assetLabel(a: AssetAsset): string {
    const meta = a.meta;
    const prompt = (meta?.prompt || a.record.prompt || '').trim();
    if (prompt) return prompt.slice(0, 24);
    const model = (meta?.model || a.record.model || '').split(':').pop() || '';
    return model ? `资产 · ${model}` : '资产';
  }

  /** 在光标处插入 `@label` token 并把结构化 mention 写入节点。 */
  private _insertMention(nodeId: string, mention: PromptMention): void {
    const node = flowState.getNode(nodeId);
    if (!node) return;
    const mentions = [...this._readMentions(nodeId), mention];
    this._writeMentions(nodeId, mentions);
    const label = mention.label || '未命名';
    const token = `@${label}`;
    const start = Math.min(this.mentionInsertPos, this.input.value.length);
    const end = start;
    const before = this.input.value.slice(0, start);
    const after = this.input.value.slice(end);
    const sep = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
    const next = `${before}${sep}${token} `;
    this.input.value = next + after;
    this.input.dispatchEvent(new Event('input'));
    this._autoResizeInput();
    this.input.focus();
    const pos = next.length;
    this.input.setSelectionRange(pos, pos);
  }

  private _onSend(): void {
    const node = selection.single();
    if (!node) return;
    if (node.status === 'run') {
      runEngine.cancel(node.id);
      return;
    }
    // 4.1-B：@引用资源丢失时阻止提交，提示替换/移除（B3）
    if (node.type === 'image-gen') {
      const missing = this._readMentions(node.id).filter(m => this._isMentionMissing(m));
      if (missing.length > 0) {
        showToast(`有 ${missing.length} 个 @引用资源已丢失，请先移除或替换后再生成`, false);
        return;
      }
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
    } else if (node.type === 'video-gen') {
      this.videoModelOptions = (await fetchVideoModels()).filter(m => Boolean(m.id));
      this._showChipMenu(btn, this.videoModelOptions, 'model');
    } else if (node.type === 'audio-gen') {
      this.audioModelOptions = (await fetchAudioModels()).filter(m => Boolean(m.id));
      this._showChipMenu(btn, this.audioModelOptions, 'model');
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
      case 'seconds': return String((node.params as unknown as VideoGenParams).seconds ?? 5);
      case 'format': return String((node.params as unknown as AudioGenParams).format ?? 'mp3');
      default: return '';
    }
  }

  private _applyParam(nodeId: string, paramType: string, value: string): void {
    const node = flowState.getNode(nodeId);
    if (!node) return;
    flowHistory.record();
    if (paramType === 'model') {
      flowState.updateNodeParams(nodeId, { model: value });
      if (node.type === 'video-gen') {
        const old = node.params as unknown as VideoGenParams;
        const caps = getVideoModelCapabilities(value);
        const patch: Partial<VideoGenParams> = {
          seconds: caps.seconds.includes(Number(old.seconds)) ? Number(old.seconds) : (caps.seconds[0] || 5),
          aspectRatio: caps.aspectRatios.includes(old.aspectRatio) ? old.aspectRatio : (caps.aspectRatios[0] || '16:9'),
          resolution: caps.resolutions.includes(old.resolution) ? old.resolution : (caps.resolutions[0] || '720p'),
          audio: caps.supportsAudio ? !!old.audio : false,
        };
        // 4.2-A：切换模型时清理不兼容的首尾帧（仅当新模型不支持且已有值）
        if (!caps.supportsStartEndFrame && (old.startFrame || old.endFrame)) {
          patch.startFrame = undefined;
          patch.endFrame = undefined;
        }
        flowState.updateNodeParams(nodeId, patch as Record<string, unknown>);
        if (!caps.supportsAudio && old.audio) showToast('新模型不支持音频，已关闭音频参数', false);
        if (!caps.supportsStartEndFrame && (old.startFrame || old.endFrame)) showToast('新模型不支持首尾帧，已清除首尾帧', false);
      } else if (node.type === 'audio-gen') {
        const old = node.params as unknown as AudioGenParams;
        const caps = getAudioModelCapabilities(value);
        const patch: Partial<AudioGenParams> = {};
        if (caps.seconds.length > 0) {
          patch.seconds = caps.seconds.includes(Number(old.seconds)) ? Number(old.seconds) : caps.seconds[0];
        }
        if (caps.formats.length > 0) {
          patch.format = caps.formats.includes(old.format ?? 'mp3')
            ? (old.format ?? 'mp3')
            : caps.formats[0];
        }
        flowState.updateNodeParams(nodeId, patch as Record<string, unknown>);
      }
      if (value) {
        // 只记在当前项目：后续新建同类节点沿用用户最近选择，而不污染其它项目。
        flowState.setModelDefault(node.type === 'text-gen' ? 'chat' : (node.type === 'video-gen' ? 'video' : (node.type === 'audio-gen' ? 'audio' : 'drawing')), value);
      }
    } else if (paramType === 'aspectRatio') {
      flowState.updateNodeParams(nodeId, { aspectRatio: value });
    } else if (paramType === 'resolution') {
      flowState.updateNodeParams(nodeId, { resolution: value });
    } else if (paramType === 'count') {
      flowState.updateNodeParams(nodeId, { count: Number(value) || 1 });
    } else if (paramType === 'seconds') {
      flowState.updateNodeParams(nodeId, { seconds: Number(value) || 5 });
    } else if (paramType === 'format') {
      flowState.updateNodeParams(nodeId, { format: value });
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
      else if (node.type === 'video-gen') this._ensureVideoModel(node.id);
      else if (node.type === 'audio-gen') this._ensureAudioModel(node.id);
      else this._ensureModel(node.id);
    }

    // Tab 化：面板默认收起；仅当 Tab 呼出（floatingPanels.isVisible()）时才显示/定位。
    // 显示态下切换选中节点：仍会走下方逻辑刷新内容/位置（跟随新选中节点），不会误收起。
    if (!floatingPanels.isVisible()) {
      this.el.classList.remove('show', 'pos-above', 'textgen', 'reverse');
      return;
    }

    // text-gen 面板：隐藏绘图参数 chips（比例/分辨率/张数）与参考图区，模型 chip 切到文本模型；
    // image-gen 面板：绘图参数 chips 全显示（反推模式 UI 已删除，W2-2）
    const isTextGen = node.type === 'text-gen';
    const isVideo = node.type === 'video-gen';
    const isAudio = node.type === 'audio-gen';
    const isTextSplitDriven = !isTextGen && flowState.getUpstreams(node.id).some(n => n.type === 'text-split');
    const isOutpaint = node.type === 'image-gen' && (node.params as unknown as StyleTransferParams).mode === 'outpaint';
    // 扩图参数只在专用预览弹窗中调整。不要在画布下方重复展开一张大框：
    // 失败信息已直接显示在扩图步骤卡中，重试走上方「调整扩图」。
    if (isOutpaint) {
      this.el.classList.remove('show', 'pos-above', 'textgen', 'outpaint', 'reverse');
      return;
    }
    // 上下文标识优先说明正在做的任务，而不是暴露内部节点标题。
    this.ctxName.textContent = isTextGen ? '处理文本' : (isVideo ? '生成视频' : (isAudio ? '生成音频' : (isOutpaint ? '扩图' : (flowState.getReferenceImages(node.id).length > 0 ? '基于图片修改' : '创作图片'))));
    this.el.classList.toggle('textgen', isTextGen);
    this.el.classList.toggle('outpaint', isOutpaint);
    this.el.classList.toggle('textsplit-driven', isTextSplitDriven);
    this.el.classList.toggle('advanced-open', this.advancedOpen || isTextGen || isOutpaint);
    const advancedToggle = document.getElementById('cmd-advanced-toggle') as HTMLButtonElement | null;
    if (advancedToggle) {
      advancedToggle.hidden = isTextGen || isOutpaint;
      advancedToggle.setAttribute('aria-expanded', String(this.advancedOpen));
      advancedToggle.textContent = this.advancedOpen ? '收起设置 ▴' : '更多设置 ▾';
    }
    this.el.classList.remove('reverse');

    // chip/发送钮 title 文案随节点类型切换（文本处理 / 图片生成 / 视频 / 音频）
    this.chipModelBtn.title = isTextGen ? '选择文本模型' : (isVideo ? '选择视频模型' : (isAudio ? '选择音频模型' : (isOutpaint ? '扩图模型自动选择；点击调整扩图' : '选择绘图模型')));
    const ratioBtn = document.getElementById('chip-ratio');
    const resBtn = document.getElementById('chip-res');
    const countBtn = document.getElementById('chip-count');
    if (ratioBtn) {
      ratioBtn.title = isOutpaint ? '调整扩图比例和原图摆放' : (isAudio ? '音频格式' : '画面比例');
      ratioBtn.hidden = isTextGen;
    }
    if (resBtn) {
      resBtn.title = isOutpaint ? '扩图固定为 4K' : (isAudio ? '音频时长' : (isVideo ? '视频时长' : '分辨率'));
      resBtn.hidden = isTextGen;
    }
    if (countBtn) {
      countBtn.title = isOutpaint ? '扩图固定生成 1 张' : '生成张数';
      countBtn.hidden = isTextGen || isVideo || isAudio;
    }
    const isRunning = node.status === 'run';
    this.send.title = isRunning ? '暂停' : (isTextGen ? '处理文本' : (isVideo ? '生成视频' : (isAudio ? '生成音频' : (isOutpaint ? '开始扩图' : '生成'))));
    this.send.setAttribute('aria-label', this.send.title);
    this.send.innerHTML = isRunning ? PAUSE_SVG : SEND_SVG;

    this.send.disabled = false;
    // 4.2-B 能力门控：未配置音频模型时禁用发送钮并给明确提示（不出现可运行按钮）
    if (isAudio) {
      const audioCaps = getAudioModelCapabilities((node.params as unknown as AudioGenParams).model || '');
      const hasAudioModel = !!audioCaps.available;
      this.send.disabled = !hasAudioModel;
      if (!hasAudioModel) this.send.title = '未配置音频模型，请先在设置中配置';
    } else {
      this.send.disabled = false;
    }

    // 输入框占位提示跟随节点类型（切换选中节点时同步变化）
    if (isTextGen) {
      this.input.placeholder = TEXT_GEN_INPUT_PLACEHOLDER;
    } else if (isOutpaint) {
      this.input.placeholder = '可选：描述希望扩展出的画面，如：向右延展为明亮的客厅';
    } else if (isVideo) {
      this.input.placeholder = '描述镜头动作、节奏和氛围，例如：镜头缓慢推进，窗帘随风轻摆';
    } else if (isAudio) {
      this.input.placeholder = '描述想要的音乐/音效，例如：温暖的原声吉他旋律，舒缓放松';
    } else {
      this.input.placeholder = PROMPT_INPUT_PLACEHOLDER;
    }

    this.ctxHint.textContent =
      node.status === 'stale' ? '· 上游已改，待重跑' :
      node.status === 'done' ? '· 已完成' :
      node.status === 'run' ? this._runHint(node.id) :
      node.status === 'fail' ? (isTextGen ? '· 处理失败' : (isOutpaint ? '· 可重新调整' : '· 生成失败')) : '';

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
    this._autoResizeInput();
    if (this.outpaintSettings) this.outpaintSettings.hidden = !isOutpaint;
    if (isOutpaint) {
      const params = node.params as unknown as StyleTransferParams;
      const ratio = params.aspectRatio || '1:1';
      if (this.outpaintSettingsRatio) this.outpaintSettingsRatio.textContent = ratio;
      if (this.outpaintSettingsSummary) {
        this.outpaintSettingsSummary.textContent = this._outpaintSettingsSummary(ratio, params.outpaintPlacement);
      }
    }

    this._renderRefs();
    this._renderFrameStrip(node);
    this._renderChips(node);
    const audioToggle = document.getElementById('chip-video-audio') as HTMLElement | null;
    const audioInput = audioToggle?.querySelector('input') as HTMLInputElement | null;
    const audioCaps = isVideo ? getVideoModelCapabilities((node.params as unknown as VideoGenParams).model || '') : null;
    if (audioToggle) audioToggle.hidden = !isVideo || !audioCaps?.supportsAudio;
    if (audioInput && isVideo) audioInput.checked = !!(node.params as unknown as VideoGenParams).audio;
    this._renderTextHistory(node);
    this._renderPromptPreview(node);
    this._renderMentions();
    this._position(node);
  }

  /** run 状态提示：text-gen「处理中」；批次「生成中 done/total」；媒体任务细分（提交中/已提交/处理中/查询恢复中） */
  private _runHint(nodeId: string): string {
    const node = flowState.getNode(nodeId);
    if (node && node.type === 'text-gen') return '· 处理中';
    if (node) {
      const task = (node.params as Record<string, unknown> | undefined)?.videoTask as MediaTask | undefined
        ?? (node.params as Record<string, unknown> | undefined)?.audioTask as MediaTask | undefined;
      if (task) {
        switch (task.state) {
          case 'submitting': return '· 提交中';
          case 'accepted': return task.remoteTaskId ? '· 已提交（远端处理中）' : '· 已提交';
          case 'processing': return '· 处理中';
          case 'queued': return '· 排队中';
          default: return '· 生成中';
        }
      }
    }
    const p = runEngine.getBatchProgress(nodeId);
    if (p && p.total > 0) return `· 生成中 ${p.done}/${p.total}`;
    return '· 生成中';
  }

  /**
   * 扩图的摆放是任务参数的一部分。把像素偏移翻成人话，用户无需重开预览就能
   * 确认项目中保存、重跑时会使用的画布状态。
   */
  private _outpaintSettingsSummary(
    ratio: string,
    placement?: { posX: number; posY: number; scale: number },
  ): string {
    if (!placement) return `${ratio} · 原图居中、自动适配`;
    const horizontal = placement.posX > 120 ? '向右' : placement.posX < -120 ? '向左' : '';
    const vertical = placement.posY > 120 ? '向下' : placement.posY < -120 ? '向上' : '';
    const position = [horizontal, vertical].filter(Boolean).join('') || '居中';
    const scale = typeof placement.scale === 'number' && placement.scale > 0
      ? ` · 缩放 ${Math.round(placement.scale * 100)}%`
      : '';
    return `${ratio} · 原图${position}${scale}`;
  }

  private _modelFilling = new Set<string>();

  /** 生成节点未配置模型时：优先沿用当前项目的最近选择，否则取第一个可用模型。 */
  private _ensureModel(nodeId: string): void {
    if (this._modelFilling.has(nodeId)) return;
    this._modelFilling.add(nodeId);
    // 过滤掉 _getImageModels 无模型时返回的占位项 { id:'' }
    const valid = (): Array<{ id: string; name: string }> => this.modelOptions.filter(m => Boolean(m.id));
    const apply = () => {
      const node = flowState.getNode(nodeId);
      if (!node || (node.params.model as string | undefined)) return;
      const opts = valid();
      const saved = flowState.getModelDefault('drawing');
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

  /** text-gen 未配置模型时：优先沿用当前项目的最近选择，否则取第一个可用模型。 */
  private _ensureChatModel(nodeId: string): void {
    if (this._modelFilling.has(nodeId)) return;
    this._modelFilling.add(nodeId);
    const valid = (): Array<{ id: string; name: string }> => this.chatModelOptions.filter(m => Boolean(m.id));
    const apply = () => {
      const node = flowState.getNode(nodeId);
      if (!node || (node.params.model as string | undefined)) return;
      const opts = valid();
      const saved = flowState.getModelDefault('chat');
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

  private _ensureVideoModel(nodeId: string): void {
    if (this._modelFilling.has(nodeId)) return;
    this._modelFilling.add(nodeId);
    const apply = (models: Array<{ id: string }>) => {
      const node = flowState.getNode(nodeId);
      if (!node || (node.params.model as string | undefined)) return;
      const saved = flowState.getModelDefault('video');
      const target = saved && models.some(m => m.id === saved) ? saved : (models.find(m => m.id)?.id || '');
      if (target) flowState.updateNodeParams(nodeId, { model: target });
    };
    if (this.videoModelOptions.length) apply(this.videoModelOptions);
    else void fetchVideoModels().then(models => { this.videoModelOptions = models.filter(m => Boolean(m.id)); apply(this.videoModelOptions); });
  }

  /** audio-gen 未配置模型时：沿用最近选择，否则取第一个可用音频模型（无可用则保持空 → canRun 拒绝）。 */
  private _ensureAudioModel(nodeId: string): void {
    if (this._modelFilling.has(nodeId)) return;
    this._modelFilling.add(nodeId);
    const apply = (models: Array<{ id: string }>) => {
      const node = flowState.getNode(nodeId);
      if (!node || (node.params.model as string | undefined)) return;
      const saved = flowState.getModelDefault('audio');
      const target = saved && models.some(m => m.id === saved) ? saved : (models.find(m => m.id)?.id || '');
      if (target) flowState.updateNodeParams(nodeId, { model: target });
    };
    if (this.audioModelOptions.length) apply(this.audioModelOptions);
    else void fetchAudioModels().then(models => { this.audioModelOptions = models.filter(m => Boolean(m.id)); apply(this.audioModelOptions); });
  }

  // ───────────────────────── 4.2-A：视频首帧/尾帧 ─────────────────────────

  /** 选择首/尾帧图片：读取本地图片 → 压缩为 ≤768px 的 data URL → 写入 params（模型不支持时面板不显示入口）。 */
  private _pickFrame(frame: 'start' | 'end'): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const src = ev.target?.result as string;
        if (!src) return;
        const img = new Image();
        img.onload = () => {
          const maxSide = 768;
          const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
          const node = selection.single();
          if (!node) return;
          flowHistory.record();
          flowState.updateNodeParams(node.id, frame === 'start' ? { startFrame: dataUrl } : { endFrame: dataUrl });
          this.sync();
        };
        img.src = src;
      };
      reader.readAsDataURL(file);
    });
    input.click();
  }

  private _clearFrames(): void {
    const node = selection.single();
    if (!node) return;
    flowHistory.record();
    flowState.updateNodeParams(node.id, { startFrame: undefined, endFrame: undefined });
    showToast('已清除首尾帧');
    this.sync();
  }

  /** 视频首尾帧选择条渲染（仅 supportsStartEndFrame 且有模型时显示）。 */
  private _renderFrameStrip(node: FlowNode): void {
    if (!this.frameStrip) return;
    const isVideo = node.type === 'video-gen';
    const p = node.params as unknown as VideoGenParams;
    const caps = isVideo ? getVideoModelCapabilities(p.model || '') : null;
    const show = isVideo && !!caps?.available && caps.supportsStartEndFrame;
    this.frameStrip.hidden = !show;
    if (!show) return;
    const startBtn = this.frameStrip.querySelector('[data-frame="start"]') as HTMLElement | null;
    const endBtn = this.frameStrip.querySelector('[data-frame="end"]') as HTMLElement | null;
    const hint = this.frameStrip.querySelector('.cmd-frame-hint') as HTMLElement | null;
    if (startBtn) startBtn.textContent = p.startFrame ? '首帧 ✓' : '首帧';
    if (endBtn) endBtn.textContent = p.endFrame ? '尾帧 ✓' : '尾帧';
    if (hint) hint.textContent = (p.startFrame && p.endFrame) ? '首尾帧已设置' : (p.startFrame || p.endFrame ? '首尾帧需成对使用' : '可选：选择首尾帧图片');
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
      } else {
        // 上游参考图：明确标注来源，让「继续创作/连线加入的源图」在本次上下文里一眼可见。
        const badge = document.createElement('span');
        badge.className = 'cmd-ref-src';
        badge.textContent = '来自上游';
        t.appendChild(badge);
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
    // 模型 chip 名称按节点类型查对应模型列表（text-gen → chat；image-gen → 绘图；视频/音频 → 各自）
    let modelName: string;
    if (node.type === 'text-gen') {
      const model = this.chatModelOptions.find(m => m.id === p.model);
      modelName = model ? model.name : (p.model || '选择模型');
    } else if (node.type === 'video-gen') {
      const model = this.videoModelOptions.find(m => m.id === p.model);
      modelName = model ? model.name : (p.model || '选择视频模型');
    } else if (node.type === 'audio-gen') {
      const model = this.audioModelOptions.find(m => m.id === p.model);
      modelName = model ? model.name : (p.model || '选择音频模型');
    } else {
      const model = this.modelOptions.find(m => m.id === p.model);
      modelName = model ? model.name : (p.model || '选择模型');
    }
    this.chipModelLabel.textContent = modelName;
    if (node.type === 'audio-gen') {
      const ap = node.params as unknown as AudioGenParams;
      this.chipRatioLabel.textContent = (ap.format || 'mp3').toUpperCase();
      this.chipResLabel.textContent = typeof ap.seconds === 'number' ? `${ap.seconds} 秒` : '时长默认';
      this.chipCountLabel.textContent = '1条';
      return;
    }
    this.chipRatioLabel.textContent = p.aspectRatio || '4:3';
    this.chipResLabel.textContent = (p.resolution || '2k').toUpperCase();
    this.chipCountLabel.textContent = node.type === 'video-gen'
      ? `${(node.params as unknown as VideoGenParams).seconds ?? 5} 秒`
      : (flowState.getUpstreams(node.id).some(n => n.type === 'text-split') ? '按拆分段数' : `${p.count ?? 1}张`);
  }

  /** 智能避让定位（原型 syncBars 逻辑） */
  reposition(): void {
    const node = selection.single();
    if (!node || !floatingPanels.isVisible()) return;
    // 导入素材只作为画布输入，不应因视图平移的定位回调重新露出下方命令面板。
    const isOutpaint = node.type === 'image-gen' && (node.params as unknown as StyleTransferParams).mode === 'outpaint';
    if (flowState.isAssetNode(node) || node.type === 'text-split' || isOutpaint) {
      this.el?.classList.remove('show', 'pos-above', 'textgen', 'reverse');
      return;
    }
    this._position(node);
  }

  private _position(node: FlowNode): void {
    if (!this.el) return;
    const wrap = canvasView.wrap;
    if (!wrap) return;
    const wr = wrap.getBoundingClientRect();
    const { x: cx0, y: topY } = canvasView.worldToWrap(node.x + CARD_W / 2, node.y);
    const botY = canvasView.worldToWrap(0, node.y + (node.h ?? cardView.cardHeight(node))).y;

    const leftX = canvasView.worldToWrap(node.x, node.y).x;
    const rightX = canvasView.worldToWrap(node.x + (node.w ?? CARD_W), node.y).x;
    if (rightX < 0 || leftX > wr.width || botY < 0 || topY > wr.height) {
      this.el.classList.remove('show', 'pos-above');
      return;
    }

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
