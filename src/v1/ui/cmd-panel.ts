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
import { runEngine, applyTextToDownstream } from '../engine/run-engine';
import { Backend, fetchImageModels, fetchChatModels } from '../api';
import { DEFAULT_CHAT_MODEL_KEY } from '../nodes/text-gen';
import { showToast } from './toast';

const RATIO_OPTIONS = ['3:4', '2:3', '4:5', '9:16', '1:4', '1:8', '1:1', '4:3', '3:2', '5:4', '16:9', '21:9', '4:1', '8:1', 'Auto'];
const RES_OPTIONS = ['1k', '2k', '4k'];
const COUNT_OPTIONS = [1, 2, 3, 4];

const DEL_SVG = '<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

/** 指令输入框占位提示：text-gen 用命令示例，图片节点文本反推模式用反推命令示例，其余用通用编辑指令 */
const PROMPT_INPUT_PLACEHOLDER = '输入指令编辑这张图，如：把背景换成浅灰水泥墙，加一盆绿萝';
const TEXT_GEN_INPUT_PLACEHOLDER = '输入命令，如：改得更专业、翻译成英文';
const IMAGE_TEXT_REVERSE_PLACEHOLDER = '输入命令，如：反推这个图片';

class CmdPanel {
  private el: HTMLElement | null = null;
  private ctxThumb!: HTMLElement;
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
  private modelOptions: Array<{ id: string; name: string }> = [];
  private chatModelOptions: Array<{ id: string; name: string }> = [];
  /** 动态参考图缩略元素（随 refImages/上游增删重建） */
  private _multiRefs: HTMLElement[] = [];

  init(): void {
    this.el = document.getElementById('cmd-panel');
    if (!this.el) return;

    this.ctxThumb = document.getElementById('ctx-thumb') as HTMLElement;
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
      this._showChipMenu(e.currentTarget as HTMLElement, RATIO_OPTIONS.map(v => ({ id: v, name: v })), 'aspectRatio');
    });
    document.getElementById('chip-res')?.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      this._showChipMenu(e.currentTarget as HTMLElement, RES_OPTIONS.map(v => ({ id: v, name: v })), 'resolution');
    });
    document.getElementById('chip-count')?.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      this._showChipMenu(e.currentTarget as HTMLElement, COUNT_OPTIONS.map(v => ({ id: String(v), name: `${v}张` })), 'count');
    });

    document.getElementById('cmd-ref-add')?.addEventListener('click', () => {
      const node = selection.single();
      if (!node) return;
      interactions.openFilePickerForRef(node.id);
    });
  }

  private _onSend(): void {
    const node = selection.single();
    if (!node) return;
    if (node.type === 'text-gen') {
      // 命令是临时的：从输入框读命令执行；输入框被 sync 清空时退回节点已暂存的 command（params.instruction），
      // 避免「输命令→点模型 chip（sync 清空输入框）→点发送」丢命令。执行后仍清空命令框（卡片只显示结果）。
      const command = this.input.value.trim() || ((node.params as unknown as TextGenParams).instruction || '').trim();
      flowState.updateNodeParams(node.id, { instruction: command });
      void runEngine.run(node.id);
      this.input.value = '';
    } else {
      const prompt = this.input.value.trim();
      flowState.updateNodeParams(node.id, { prompt });
      void runEngine.run(node.id);
    }
  }

  /** 模型 chip：打开菜单前重新拉取模型（text-gen → chat 模型；image-gen → 绘图/文本模型类型切换），确保设置里新增/拉取的模型即时可见 */
  private async _openModelMenu(btn: HTMLElement): Promise<void> {
    const node = selection.single();
    if (!node) return;
    if (node.type === 'text-gen') {
      this.chatModelOptions = await fetchChatModels();
      this._showChipMenu(btn, this.chatModelOptions.map(m => ({ id: m.id, name: m.name })), 'model');
    } else {
      // image-gen：绘图模型（默认，生成图）/ 文本模型（反推）类型切换
      await this._openImageModelMenu(btn, node);
    }
  }

  /** image-gen 模型 chip：顶部「绘图模型 / 文本模型」两个 tab，切换类型并记住（写 params.modelType）；选中写对应 model 字段 */
  private async _openImageModelMenu(btn: HTMLElement, node: FlowNode): Promise<void> {
    const [imageModels, chatModels] = await Promise.all([fetchImageModels(), fetchChatModels()]);
    this.modelOptions = imageModels;
    this.chatModelOptions = chatModels;

    document.querySelector('.param-menu')?.remove();
    const rect = btn.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'param-menu';
    menu.style.left = rect.left + 'px';
    menu.style.top = (rect.bottom + 5) + 'px';
    const menuWidth = 200;
    if (rect.left + menuWidth > window.innerWidth - 12) {
      menu.style.left = (window.innerWidth - menuWidth - 12) + 'px';
    }

    const p = node.params as unknown as StyleTransferParams;
    let currentType: 'draw' | 'text' = p.modelType === 'text' ? 'text' : 'draw';

    const tabs = document.createElement('div');
    tabs.className = 'param-menu-tabs';
    const tabDraw = document.createElement('div');
    tabDraw.className = 'param-menu-tab' + (currentType === 'draw' ? ' active' : '');
    tabDraw.textContent = '绘图模型';
    const tabText = document.createElement('div');
    tabText.className = 'param-menu-tab' + (currentType === 'text' ? ' active' : '');
    tabText.textContent = '文本模型';
    tabs.appendChild(tabDraw);
    tabs.appendChild(tabText);
    menu.appendChild(tabs);

    const listBox = document.createElement('div');
    listBox.className = 'param-menu-list';
    menu.appendChild(listBox);

    const renderList = (type: 'draw' | 'text'): void => {
      listBox.innerHTML = '';
      const items = type === 'text' ? this.chatModelOptions : this.modelOptions;
      const current = type === 'text' ? (p.textModel || '') : (p.model || '');
      items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'param-menu-item' + (item.id === current ? ' selected' : '');
        div.textContent = item.name;
        div.addEventListener('click', (ev) => {
          ev.stopPropagation();
          flowHistory.record();
          if (type === 'text') {
            flowState.updateNodeParams(node.id, { modelType: 'text', textModel: item.id });
          } else {
            flowState.updateNodeParams(node.id, { modelType: 'draw', model: item.id });
            if (item.id) localStorage.setItem('icv_default_model', item.id);
          }
          menu.remove();
        });
        listBox.appendChild(div);
      });
    };

    const setTab = (type: 'draw' | 'text'): void => {
      currentType = type;
      flowHistory.record();
      flowState.updateNodeParams(node.id, { modelType: type });
      tabDraw.className = 'param-menu-tab' + (type === 'draw' ? ' active' : '');
      tabText.className = 'param-menu-tab' + (type === 'text' ? ' active' : '');
      renderList(type);
    };
    tabDraw.addEventListener('click', (ev) => { ev.stopPropagation(); setTab('draw'); });
    tabText.addEventListener('click', (ev) => { ev.stopPropagation(); setTab('text'); });

    renderList(currentType);

    document.body.appendChild(menu);
    setTimeout(() => {
      const close = () => { menu.remove(); document.removeEventListener('click', close); };
      document.addEventListener('click', close);
    }, 0);
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
      case 'aspectRatio': return p.aspectRatio || '3:4';
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

    // 上下文标识
    this.ctxName.textContent = node.title || '节点';
    this.ctxThumb.style.backgroundImage = node.imageUrl ? `url('${node.imageUrl.replace(/'/g, "\\'")}')` : 'none';

    // text-gen 面板：隐藏绘图参数 chips（比例/分辨率/张数）与参考图区，模型 chip 切到文本模型；
    // image-gen 文本反推模式：同样隐藏绘图参数 chips（无意义），但保留参考图区（反推依赖源图，可见可换）
    const isTextGen = node.type === 'text-gen';
    const isImageReverse = node.type === 'image-gen' && (node.params as unknown as StyleTransferParams).modelType === 'text';
    this.el.classList.toggle('textgen', isTextGen);
    this.el.classList.toggle('reverse', isImageReverse);

    // chip/发送钮 title 文案随节点类型/模式切换（文本处理/图片反推/图片生成语义不同）
    this.chipModelBtn.title = isTextGen || isImageReverse ? '选择文本模型' : '选择绘图模型';
    this.send.title = isTextGen ? '处理文本' : (isImageReverse ? '反推文本' : '生成');

    // 输入框占位提示跟随节点类型/模型类型（切换选中节点时同步变化）
    if (isTextGen) {
      this.input.placeholder = TEXT_GEN_INPUT_PLACEHOLDER;
    } else if (isImageReverse) {
      this.input.placeholder = IMAGE_TEXT_REVERSE_PLACEHOLDER;
    } else {
      this.input.placeholder = PROMPT_INPUT_PLACEHOLDER;
    }

    this.ctxHint.textContent =
      node.status === 'stale' ? '· 上游已改，待重跑' :
      node.status === 'done' ? '· 已完成' :
      node.status === 'run' ? this._runHint(node.id) :
      node.status === 'fail' ? (isTextGen ? '· 处理失败' : isImageReverse ? '· 反推失败' : '· 生成失败') : '';

    // 输入框（用户未聚焦时回填）：text-gen 命令是临时的，保持干净不回填；image-gen 回填 prompt（文本反推模式复用 prompt 作命令）
    if (document.activeElement !== this.input) {
      if (isTextGen) {
        this.input.value = '';
      } else {
        const p = node.params as unknown as StyleTransferParams;
        this.input.value = p.prompt || '';
      }
    }
    this.send.disabled = node.status === 'run';

    this._renderRefs();
    this._renderChips(node);
    if (!(node.params.model as string | undefined)) {
      if (isTextGen) this._ensureChatModel(node.id);
      else this._ensureModel(node.id);
    }
    this._renderTextHistory(node);
    this._position(node);
  }

  /** run 状态提示：text-gen「处理中」；图片节点文本反推「反推中」；批次「生成中 done/total」（无批次时退化为「生成中」） */
  private _runHint(nodeId: string): string {
    const node = flowState.getNode(nodeId);
    if (node && node.type === 'text-gen') return '· 处理中';
    if (node && node.type === 'image-gen' && (node.params as unknown as StyleTransferParams).modelType === 'text') return '· 反推中';
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

  /** 历史回填动作（与运行成功时的覆盖动作完全一致）：写 outputText + 覆盖直接 image-gen 下游 prompt + 标 stale */
  private _refillHistoryItem(nodeId: string, item: TextGenHistoryItem): void {
    flowHistory.record();
    flowState.updateNode(nodeId, { outputText: item.text });
    applyTextToDownstream(nodeId, item.text);
    showToast('已回填历史反推文本');
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
    // 模型 chip 名称按节点类型/模型类型查对应模型列表（text-gen → chat；image-gen 文本反推 → chat 的 textModel；其余 → 绘图）
    let modelName: string;
    if (node.type === 'text-gen') {
      const model = this.chatModelOptions.find(m => m.id === p.model);
      modelName = model ? model.name : (p.model || '选择模型');
    } else if (p.modelType === 'text') {
      const model = this.chatModelOptions.find(m => m.id === p.textModel);
      modelName = model ? model.name : (p.textModel || '选择文本模型');
    } else {
      const model = this.modelOptions.find(m => m.id === p.model);
      modelName = model ? model.name : (p.model || '选择模型');
    }
    this.chipModelLabel.textContent = modelName;
    this.chipRatioLabel.textContent = p.aspectRatio || '3:4';
    this.chipResLabel.textContent = (p.resolution || '2k').toUpperCase();
    this.chipCountLabel.textContent = `${p.count ?? 1}张`;
  }

  /** 智能避让定位（原型 syncBars 逻辑） */
  private _position(node: FlowNode): void {
    if (!this.el) return;
    const wrap = canvasView.wrap;
    if (!wrap) return;
    const wr = wrap.getBoundingClientRect();
    const { x: cx0, y: topY } = canvasView.worldToWrap(node.x + CARD_W / 2, node.y);
    const botY = canvasView.worldToWrap(0, node.y + cardView.cardHeight(node)).y;

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
