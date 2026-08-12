// src/v1/ui/cmd-panel.ts
// 指令面板：参考/标记/风格 tab + 参考图缩略 + 输入框 + 模型/比例/分辨率/张数 chip + 圆形发送钮
// 仅单选出现，贴卡片下沿，空间不足智能翻到上方（原型行为）

import { flowState } from '../state/flow-state';
import { selection } from '../state/selection';
import { canvasView, CARD_W } from '../canvas/canvas-view';
import { cardView } from '../canvas/card-view';
import { runEngine } from '../engine/run-engine';
import { fetchImageModels } from '../api';
import { showToast } from './toast';

const RATIO_OPTIONS = ['3:4', '1:1', '16:9', 'Auto'];
const RES_OPTIONS = ['1k', '2k', '4k'];
const COUNT_OPTIONS = [1, 2, 3, 4];

class CmdPanel {
  private el: HTMLElement | null = null;
  private ctxThumb!: HTMLElement;
  private ctxName!: HTMLElement;
  private ctxHint!: HTMLElement;
  private tabs!: NodeListOf<HTMLElement>;
  private refs!: HTMLElement;
  private refMain!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private send!: HTMLButtonElement;
  private chipModelLabel!: HTMLElement;
  private chipRatioLabel!: HTMLElement;
  private chipResLabel!: HTMLElement;
  private chipCountLabel!: HTMLElement;
  private activeTab = 'style';
  private modelOptions: Array<{ id: string; name: string }> = [];

  init(): void {
    this.el = document.getElementById('cmd-panel');
    if (!this.el) return;

    this.ctxThumb = document.getElementById('ctx-thumb') as HTMLElement;
    this.ctxName = document.getElementById('ctx-name') as HTMLElement;
    this.ctxHint = document.getElementById('ctx-hint') as HTMLElement;
    this.tabs = this.el.querySelectorAll('.cmd-tab') as unknown as NodeListOf<HTMLElement>;
    this.refs = document.getElementById('cmd-refs') as HTMLElement;
    this.refMain = document.getElementById('cmd-ref-main') as HTMLElement;
    this.input = document.getElementById('cmd-input') as HTMLTextAreaElement;
    this.send = document.getElementById('cmd-send') as HTMLButtonElement;
    this.chipModelLabel = document.getElementById('chip-model-label') as HTMLElement;
    this.chipRatioLabel = document.getElementById('chip-ratio-label') as HTMLElement;
    this.chipResLabel = document.getElementById('chip-res-label') as HTMLElement;
    this.chipCountLabel = document.getElementById('chip-count-label') as HTMLElement;

    // 预取模型列表（用于 chip 菜单与默认模型回填）
    void fetchImageModels().then(models => { this.modelOptions = models; });

    this._bindEvents();
    flowState.subscribe(() => this.sync());
  }

  private _bindEvents(): void {
    this.tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        this.tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.activeTab = tab.dataset.tab || 'style';
        this._renderRefs();
      });
    });

    // 输入框：改自己 → 更新 params（不标 stale）；发送 → 运行
    this.input.addEventListener('input', () => {
      const node = selection.single();
      if (!node) return;
      flowState.updateNodeParams(node.id, { prompt: this.input.value });
    });

    this.send.addEventListener('click', () => this._onSend());

    document.getElementById('chip-model')?.addEventListener('click', (e: MouseEvent) => {
      const node = selection.single();
      if (!node) return;
      this._showChipMenu(e, this.modelOptions.map(m => ({ id: m.id, name: m.name })), 'model');
    });
    document.getElementById('chip-ratio')?.addEventListener('click', (e: MouseEvent) => {
      this._showChipMenu(e, RATIO_OPTIONS.map(v => ({ id: v, name: v })), 'aspectRatio');
    });
    document.getElementById('chip-res')?.addEventListener('click', (e: MouseEvent) => {
      this._showChipMenu(e, RES_OPTIONS.map(v => ({ id: v, name: v })), 'resolution');
    });
    document.getElementById('chip-count')?.addEventListener('click', (e: MouseEvent) => {
      this._showChipMenu(e, COUNT_OPTIONS.map(v => ({ id: String(v), name: `${v}张` })), 'count');
    });

    document.getElementById('cmd-ref-add')?.addEventListener('click', () => {
      showToast('首版参考图由上游自动带入', false);
    });
  }

  private _onSend(): void {
    const node = selection.single();
    if (!node) return;
    const prompt = this.input.value.trim();
    flowState.updateNodeParams(node.id, { prompt });
    void runEngine.run(node.id);
  }

  private _showChipMenu(e: MouseEvent, items: Array<{ id: string; name: string }>, paramType: string): void {
    e.stopPropagation();
    document.querySelector('.param-menu')?.remove();
    const node = selection.single();
    if (!node) return;

    const btn = e.currentTarget as HTMLElement;
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
      if (value) localStorage.setItem('icv_default_model', value);
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
      this.el.classList.remove('show', 'pos-above');
      return;
    }

    // 上下文标识
    this.ctxName.textContent = node.title || '节点';
    this.ctxThumb.style.backgroundImage = node.imageUrl ? `url('${node.imageUrl.replace(/'/g, "\\'")}')` : 'none';
    this.ctxHint.textContent =
      node.status === 'stale' ? '· 上游已改，待重跑' :
      node.status === 'done' ? '· 已完成' :
      node.status === 'run' ? '· 生成中' :
      node.status === 'fail' ? '· 生成失败' : '';

    // 输入框（用户未聚焦时回填）
    if (document.activeElement !== this.input) {
      const p = node.params as unknown as StyleTransferParams;
      this.input.value = p.prompt || '';
    }
    this.send.disabled = node.status === 'run';

    // 默认 tab：换风格节点 → 风格
    if (node.type === 'style-transfer' && this.activeTab !== 'style') {
      this.activeTab = 'style';
      this.tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === 'style'));
    }
    if (node.type === 'product-image' && this.activeTab !== 'ref') {
      this.activeTab = 'ref';
      this.tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === 'ref'));
    }

    this._renderRefs();
    this._renderChips(node);
    if (node.type === 'style-transfer' && !(node.params.model as string | undefined)) {
      this._ensureModel(node.id);
    }
    this._position(node);
  }

  private _modelFilling = new Set<string>();

  /** 换风格节点未配置模型时：自动回填默认模型（localStorage 或第一个可用模型） */
  private _ensureModel(nodeId: string): void {
    if (this._modelFilling.has(nodeId)) return;
    this._modelFilling.add(nodeId);
    const apply = () => {
      const node = flowState.getNode(nodeId);
      if (!node || (node.params.model as string | undefined)) return;
      const saved = localStorage.getItem('icv_default_model');
      const target = saved && this.modelOptions.some(m => m.id === saved)
        ? saved
        : (this.modelOptions[0]?.id || '');
      if (target) flowState.updateNodeParams(nodeId, { model: target });
    };
    if (this.modelOptions.length > 0) { apply(); return; }
    void fetchImageModels().then(models => {
      this.modelOptions = models;
      apply();
    });
  }

  private _renderRefs(): void {
    const node = selection.single();
    if (!node) { this.refs.style.display = 'flex'; return; }
    if (this.activeTab !== 'ref' || node.type !== 'style-transfer') {
      // 非参考 tab：隐藏参考行（保持面板紧凑）
      this.refs.style.display = 'none';
      return;
    }
    this.refs.style.display = 'flex';
    const upstream = flowState.getUpstreams(node.id).filter(u => u.imageUrl);
    if (upstream.length > 0) {
      this.refMain.style.backgroundImage = `url('${upstream[0].imageUrl!.replace(/'/g, "\\'")}')`;
      this.refMain.style.display = 'block';
    } else {
      this.refMain.style.backgroundImage = 'none';
      this.refMain.style.display = 'block';
    }
  }

  private _renderChips(node: FlowNode): void {
    const p = node.params as unknown as StyleTransferParams;
    const model = this.modelOptions.find(m => m.id === p.model);
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

export const cmdPanel = new CmdPanel();
