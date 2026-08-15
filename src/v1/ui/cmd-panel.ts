// src/v1/ui/cmd-panel.ts
// 指令面板：单面板 = 参考图区 + 提示词 + 模型/比例/分辨率/张数 chip + 圆形发送钮
// 仅单选出现，贴卡片下沿，空间不足智能翻到上方（原型行为）

import { flowState } from '../state/flow-state';
import { selection } from '../state/selection';
import { dirty } from '../state/dirty';
import { canvasView, CARD_W } from '../canvas/canvas-view';
import { cardView } from '../canvas/card-view';
import { interactions } from '../canvas/interactions';
import { runEngine } from '../engine/run-engine';
import { fetchImageModels, fetchChatModels } from '../api';
import { DEFAULT_CHAT_MODEL_KEY, DEFAULT_INSTRUCTION } from '../nodes/text-gen';
import { showToast } from './toast';

const RATIO_OPTIONS = ['3:4', '2:3', '4:5', '9:16', '1:4', '1:8', '1:1', '4:3', '3:2', '5:4', '16:9', '21:9', '4:1', '8:1', 'Auto'];
const RES_OPTIONS = ['1k', '2k', '4k'];
const COUNT_OPTIONS = [1, 2, 3, 4];

const DEL_SVG = '<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

/** 指令输入框占位提示：text-gen 用反推指令示例（DEFAULT_INSTRUCTION 仅作文案，不预填节点），其余用通用编辑指令 */
const PROMPT_INPUT_PLACEHOLDER = '输入指令编辑这张图，如：把背景换成浅灰水泥墙，加一盆绿萝';
const TEXT_GEN_INPUT_PLACEHOLDER = `输入反推指令，如：${DEFAULT_INSTRUCTION}`;

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
      const instruction = this.input.value.trim();
      flowState.updateNodeParams(node.id, { instruction });
    } else {
      const prompt = this.input.value.trim();
      flowState.updateNodeParams(node.id, { prompt });
    }
    void runEngine.run(node.id);
  }

  /** 模型 chip：打开菜单前重新拉取模型（text-gen → chat 模型，其余 → 绘图模型），确保设置里新增/拉取的模型即时可见 */
  private async _openModelMenu(btn: HTMLElement): Promise<void> {
    const node = selection.single();
    if (!node) return;
    if (node.type === 'text-gen') {
      this.chatModelOptions = await fetchChatModels();
      this._showChipMenu(btn, this.chatModelOptions.map(m => ({ id: m.id, name: m.name })), 'model');
    } else {
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
      case 'aspectRatio': return p.aspectRatio || '3:4';
      case 'resolution': return p.resolution || '2k';
      case 'count': return String(p.count ?? 1);
      default: return '';
    }
  }

  private _applyParam(nodeId: string, paramType: string, value: string): void {
    const node = flowState.getNode(nodeId);
    if (!node) return;
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
      this.el.classList.remove('show', 'pos-above', 'readonly', 'textgen');
      return;
    }

    // 上下文标识
    this.ctxName.textContent = node.title || '节点';
    this.ctxThumb.style.backgroundImage = node.imageUrl ? `url('${node.imageUrl.replace(/'/g, "\\'")}')` : 'none';

    // 结果卡只读模式：隐藏输入/chips/发送钮/参考图区，仅提示「结果卡（只读）」
    if (node.type === 'image-result') {
      this.el.classList.add('readonly');
      this.ctxHint.textContent = '· 结果卡（只读）';
      this._renderTextHistory(node); // 结果卡无历史，隐藏
      this._position(node);
      return;
    }
    this.el.classList.remove('readonly');

    // text-gen 面板：隐藏绘图参数 chips（比例/分辨率/张数），模型 chip 切到对话模型
    const isTextGen = node.type === 'text-gen';
    this.el.classList.toggle('textgen', isTextGen);

    // 输入框占位提示跟随节点类型：text-gen 反推指令示例，其余通用编辑指令（切换选中节点时同步变化）
    this.input.placeholder = isTextGen ? TEXT_GEN_INPUT_PLACEHOLDER : PROMPT_INPUT_PLACEHOLDER;

    this.ctxHint.textContent =
      node.status === 'stale' ? '· 上游已改，待重跑' :
      node.status === 'done' ? (isTextGen ? '· 已完成反推' : '· 已完成') :
      node.status === 'run' ? this._runHint(node.id) :
      node.status === 'fail' ? (isTextGen ? '· 反推失败' : '· 生成失败') : '';

    // 输入框（用户未聚焦时回填）：text-gen 绑定 instruction，其余绑定 prompt
    if (document.activeElement !== this.input) {
      if (isTextGen) {
        const tp = node.params as unknown as TextGenParams;
        this.input.value = tp.instruction || '';
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

  /** run 状态提示：text-gen「反推中」；批次「生成中 done/total」（无批次时退化为「生成中」） */
  private _runHint(nodeId: string): string {
    const node = flowState.getNode(nodeId);
    if (node && node.type === 'text-gen') return '· 反推中';
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
    flowState.updateNode(nodeId, { outputText: item.text });
    flowState.getDownstreams(nodeId)
      .filter(d => d.type === 'image-gen')
      .forEach(d => flowState.updateNodeParams(d.id, { prompt: item.text }));
    dirty.markUpstreamChanged(nodeId);
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
    // 模型 chip 名称按节点类型查对应模型列表（text-gen → chat 模型）
    const options = node.type === 'text-gen' ? this.chatModelOptions : this.modelOptions;
    const model = options.find(m => m.id === p.model);
    this.chipModelLabel.textContent = model ? model.name : (p.model || '选择模型');
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
