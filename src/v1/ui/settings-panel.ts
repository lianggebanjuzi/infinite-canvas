// src/v1/ui/settings-panel.ts
// 设置/供应商面板（温馨园艺风，A7）
// 完整供应商管理：列表 / 添加 / 编辑（url·provider 字段 + Key 级模型组 + Key 列表）/ 默认绘图模型 / 自定义下拉与确认弹窗
// 模型可用性属于 Key。页面可以汇总展示，但绝不能把一把 Key 的模型复制给另一把 Key。
// Key 卡片仅凭据（名称/api_key/启停/删除/测试连接），Key 级改动即时持久化；「保存」按钮只管 provider 级字段

import { Backend } from '../api';
import { showToast } from './toast';
import { createSelect, type SelectHandle, type SelectOption } from './select';
import { confirmDialog } from './confirm';

const DEFAULT_MODEL_KEY = 'icv_default_model';

/** 添加供应商时的类型选项 */
const PROVIDER_TYPE_OPTIONS: SelectOption[] = [
  { value: 'openai', label: 'OpenAI 兼容' },
  { value: 'gemini', label: 'Gemini 原生' },
];

/** 手动添加模型时的类型选项 */
const MODEL_TYPE_OPTIONS: SelectOption[] = [
  { value: 'drawing', label: '图像' },
  { value: 'chat', label: '文本' },
  { value: 'video', label: '视频' },
];

/** 仅 FluxPort 的 Key 对应不同账号组；其它供应商保持共享模型组的简洁配置。 */
function isFluxPortProvider(provider: BackendProvider): boolean {
  const urls = [provider.api_url, provider.text_api_url]
    .filter((url): url is string => typeof url === 'string')
    .join(' ')
    .toLowerCase();
  return urls.includes('api.uselg.top') || urls.includes('api.ai-media.vip');
}

/** key 卡片回调上下文（由 _renderEditor 注入；key 卡片仅凭据：名称/api_key/启停/删除/测试连接） */
interface KeyCardCtx {
  /** 当前编辑中的对话 URL（文本对话 URL 实时值优先，空则图片/视频 URL 实时值） */
  getUrl(): string;
  /** keys 数组变更回调（更新本地副本 + this.providers + 顶部默认模型下拉） */
  onKeysChange(next: BackendProviderKey[]): void;
  /** 重新渲染 key 卡片列表（增删 key 后调用） */
  onRenderKeys(): void;
}

class SettingsPanel {
  private overlay: HTMLElement | null = null;
  private list: HTMLElement | null = null;
  private nameInput: HTMLInputElement | null = null;
  private shortInput: HTMLInputElement | null = null;
  private addBtn: HTMLButtonElement | null = null;
  private typeSelect: SelectHandle | null = null;
  private defaultSelect: SelectHandle | null = null;
  private providers: BackendProvider[] = [];
  private editingId: string | null = null;
  /** 当前图片保存路径（_refresh 时 loadSettings 回显，P5） */
  private imageSavePath = '';
  /** 图片保存路径输入框（_renderImagePathSection 动态创建；_saveImagePath 读取） */
  private imagePathInput: HTMLInputElement | null = null;

  init(): void {
    this.overlay = document.getElementById('settings-overlay');
    this.list = document.getElementById('settings-provider-list');
    this.nameInput = document.getElementById('settings-add-name') as HTMLInputElement | null;
    this.addBtn = document.getElementById('btn-add-provider') as HTMLButtonElement | null;

    this._ensureAddFields();

    document.getElementById('btn-close-settings')?.addEventListener('click', () => this.close());
    this.overlay?.addEventListener('click', (e: MouseEvent) => {
      if (e.target === this.overlay) this.close();
    });
    this.addBtn?.addEventListener('click', () => void this._addProvider());
    this.nameInput?.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') void this._addProvider();
    });
    this.shortInput?.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') void this._addProvider();
    });
  }

  /** 动态补齐添加区：简称输入 + 类型自定义下拉（index.html 只放了名称输入与添加按钮） */
  private _ensureAddFields(): void {
    const wrap = document.querySelector('.settings-add');
    if (!wrap || !this.addBtn) return;

    if (!this.shortInput) {
      this.shortInput = document.createElement('input');
      this.shortInput.className = 'settings-input';
      this.shortInput.id = 'settings-add-short';
      this.shortInput.placeholder = '简称，如：bltcy';
      this.shortInput.spellcheck = false;
      this.shortInput.style.flex = '0 0 96px';
      wrap.insertBefore(this.shortInput, this.addBtn);
    }

    if (!this.typeSelect) {
      this.typeSelect = createSelect({
        options: PROVIDER_TYPE_OPTIONS,
        value: 'openai',
        placeholder: '类型',
      });
      this.typeSelect.element.style.flex = '0 0 128px';
      this.typeSelect.element.style.minHeight = '35px';
      wrap.insertBefore(this.typeSelect.element, this.addBtn);
    }
  }

  async open(): Promise<void> {
    if (!this.overlay) return;
    this.overlay.classList.add('show');
    this.editingId = null;
    await this._refresh();
  }

  close(): void {
    this.overlay?.classList.remove('show');
    this.editingId = null;
    // 清理可能残留的自定义下拉菜单（固定定位在 body 上）
    document.querySelectorAll('.settings-select-menu').forEach(el => el.remove());
  }

  private async _refresh(): Promise<void> {
    if (!this.list) return;
    try {
      const res = await Backend.loadProviders();
      this.providers = res.providers || [];
      const settings = await Backend.loadSettings(); // P5：设置打开时回显图片保存路径
      this.imageSavePath = typeof settings.image_save_path === 'string' ? settings.image_save_path : '';
    } catch {
      this.providers = [];
      showToast('加载供应商失败', false);
    }
    this._render();
  }

  private _render(): void {
    if (!this.list) return;

    this.list.innerHTML = '';
    // P1：图片保存路径配置区置于供应商列表顶部（默认绘图模型上方）
    this.list.appendChild(this._renderImagePathSection());
    this.list.appendChild(this._renderDefaultModelSelect());

    if (this.providers.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'settings-empty';
      empty.textContent = '还没有配置供应商。添加后即可在绘图节点选择模型。';
      this.list.appendChild(empty);
      return;
    }

    const editing = this.editingId ? this.providers.find(p => p.id === this.editingId) : undefined;
    this.providers.forEach(p => {
      if (editing && p.id === editing.id) {
        this.list!.appendChild(this._renderEditor(p));
      } else {
        this.list!.appendChild(this._renderCard(p));
      }
    });
  }

  /**
   * 图片保存路径配置区（P1/P4/P5/P6）：输入框 + 选择文件夹 + 保存按钮 + hint。
   * 保存调 save_settings，后端做 strip+abspath 归一与目录校验（不存在创建/非目录/写探针）；
   * 失败 toast 人话 error；成功 toast「已保存」并回显归一后的绝对路径。
   */
  private _renderImagePathSection(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'settings-image-path';
    const label = document.createElement('span');
    label.className = 'settings-label';
    label.textContent = '图片保存路径';
    wrap.appendChild(label);

    const row = document.createElement('div');
    row.className = 'settings-path-row';
    const input = document.createElement('input');
    input.className = 'settings-input';
    input.id = 'settings-image-path-input';
    input.placeholder = '未设置';
    input.spellcheck = false;
    input.value = this.imageSavePath;
    this.imagePathInput = input;
    const pickBtn = document.createElement('button');
    pickBtn.className = 'mini-btn';
    pickBtn.textContent = '选择文件夹';
    pickBtn.title = '选择文件夹';
    row.appendChild(input);
    row.appendChild(pickBtn);
    wrap.appendChild(row);

    const saveRow = document.createElement('div');
    saveRow.className = 'settings-path-save';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn-secondary';
    saveBtn.textContent = '保存';
    saveBtn.style.padding = '6px 16px';
    saveBtn.style.fontSize = '12px';
    saveRow.appendChild(saveBtn);
    wrap.appendChild(saveRow);

    const hint = document.createElement('div');
    hint.className = 'settings-hint';
    hint.textContent = '生成图片与采纳的资产将保存到此目录。未设置时生成图仅临时可用、不落盘。';
    wrap.appendChild(hint);

    // 选择文件夹：调 select_folder() 后回填输入框（P1）
    pickBtn.addEventListener('click', () => {
      void (async () => {
        try {
          const res = await Backend.selectFolder();
          if (res.status === 'success' && res.path) input.value = res.path;
          else if (res.status === 'error') showToast(res.message || '选择文件夹失败', false);
        } catch (e) {
          showToast('选择文件夹失败：' + (e as Error).message, false);
        }
      })();
    });
    // 保存：后端归一 + 校验（P4/P6）
    saveBtn.addEventListener('click', () => void this._saveImagePath());
    return wrap;
  }

  /** 保存图片保存路径（合并当前 settings 后写入 image_save_path，P1） */
  private async _saveImagePath(): Promise<void> {
    const raw = this.imagePathInput?.value ?? '';
    try {
      const current = await Backend.loadSettings();
      const res = await Backend.saveSettings({ ...current, image_save_path: raw });
      if (res.status === 'success') {
        showToast('已保存'); // 共享知识 3 常量
        // 回显归一后的绝对路径（P5/P6）
        const after = await Backend.loadSettings();
        const normalized = typeof after.image_save_path === 'string' ? after.image_save_path : '';
        this.imageSavePath = normalized;
        if (this.imagePathInput) this.imagePathInput.value = normalized;
      } else {
        showToast(res.message || '保存失败', false); // 后端人话 error（目录校验失败等）
      }
    } catch (e) {
      showToast('保存失败：' + (e as Error).message, false);
    }
  }

  /** 顶部「默认绘图模型」自定义下拉：数据源 = 所有 enabled 供应商 × enabled key 的 drawing 模型（三段 id）；
   *  label 简化为「供应商短名 - 模型名」（去 key 名）+ 跨 key 重名去重（保留第一个 enabled key 条目） */
  private _renderDefaultModelSelect(): HTMLElement {
    this.defaultSelect?.destroy();

    const drawing: SelectOption[] = [];
    const seen = new Set<string>();
    this.providers.forEach(p => {
      if (!p.enabled) return;
      const displayName = p.short_name || p.name;
      (p.keys || []).forEach(k => {
        if (k.enabled === false) return;
        (k.models || []).forEach(m => {
          if (m.enabled === false || m.type !== 'drawing') return;
          const dedupeKey = `${p.id}:${m.id}`;
          if (seen.has(dedupeKey)) return; // 跨 key 重名去重：保留第一个 enabled key 条目
          seen.add(dedupeKey);
          // 三段式完整 id + label 去 key 名（前端不暴露 Key 概念）
          drawing.push({ value: `${p.id}:${k.id}:${m.id}`, label: `${displayName} - ${m.name}` });
        });
      });
    });

    // 宽容回显：旧两段 id（provider:model）也能在当前列表中找到同名模型并回显三段值
    const current = localStorage.getItem(DEFAULT_MODEL_KEY) || '';
    const currentValue = this._matchDefaultOption(drawing, current);
    this.defaultSelect = createSelect({
      options: drawing,
      value: currentValue,
      placeholder: '暂无可用绘图模型',
      onChange: (v) => {
        localStorage.setItem(DEFAULT_MODEL_KEY, v);
        showToast('默认绘图模型已更新');
      },
    });

    const wrap = document.createElement('div');
    wrap.className = 'settings-default-model';
    const label = document.createElement('span');
    label.className = 'settings-label';
    label.textContent = '默认绘图模型';
    wrap.appendChild(label);
    this.defaultSelect.element.style.flex = '1';
    wrap.appendChild(this.defaultSelect.element);
    return wrap;
  }

  /** 局部刷新顶部「默认绘图模型」下拉（不重建列表，保持编辑态不被打断） */
  private _refreshDefaultModelSelect(): void {
    if (!this.list) return;
    const newWrap = this._renderDefaultModelSelect();
    const first = this.list.firstElementChild;
    if (first && first.classList.contains('settings-default-model')) {
      this.list.replaceChild(newWrap, first);
    } else {
      this.list.insertBefore(newWrap, this.list.firstChild);
    }
  }

  /** 默认模型下拉宽容回显：旧两段 id 只在唯一匹配某把 Key 时转换，避免猜错账号组。 */
  private _matchDefaultOption(options: SelectOption[], saved: string): string {
    if (!saved) return '';
    if (options.some(o => o.value === saved)) return saved;
    const parts = saved.split(':');
    if (parts.length === 2) {
      const [pid, mid] = parts;
      const hits = options.filter(o => o.value.startsWith(`${pid}:`) && o.value.endsWith(`:${mid}`));
      if (hits.length === 1) return hits[0].value;
    }
    return '';
  }

  /** 紧凑卡片视图：名称 / 简称·类型 / 模型数量（跨 key 汇总）/ 启用开关 / 编辑 / 删除 */
  private _renderCard(p: BackendProvider): HTMLElement {
    const card = document.createElement('div');
    card.className = 'provider-card';

    // 模型计数跨 Key 汇总后按 id+type 去重；模型归属仍由各 Key 的 models[] 保留。
    const keys = p.keys || [];
    const allModels = keys.reduce((acc, k) => acc.concat(k.models || []), [] as BackendModel[]);
    const seenModels = new Set<string>();
    const uniqueModels = allModels.filter(m => {
      const dedupeKey = `${m.id}:${m.type || ''}`;
      if (seenModels.has(dedupeKey)) return false;
      seenModels.add(dedupeKey);
      return true;
    });
    const chatCount = uniqueModels.filter(m => (m.type || 'chat') === 'chat').length;
    const drawCount = uniqueModels.filter(m => m.type === 'drawing').length;
    const videoCount = uniqueModels.filter(m => m.type === 'video').length;

    card.innerHTML = `
      <div class="provider-card-head">
        <div class="provider-card-info">
          <div class="provider-name">${escapeHtml(p.name)}</div>
          <div class="provider-type">${escapeHtml(p.short_name || '')} · ${escapeHtml(typeLabel(p.type))}</div>
        </div>
        <div class="provider-actions">
          <span class="provider-counts">文本 ${chatCount} · 图像 ${drawCount} · 视频 ${videoCount}${keys.length ? ` · ${keys.length} Key` : ''}</span>
          <button class="switch ${p.enabled ? 'on' : ''}" data-id="${escapeHtml(p.id)}" title="启用/停用"></button>
          <button class="mini-btn" data-edit="${escapeHtml(p.id)}">编辑</button>
          <button class="mini-btn danger" data-del="${escapeHtml(p.id)}">删除</button>
        </div>
      </div>`;

    card.querySelector('.switch')?.addEventListener('click', () => {
      void this._toggleProvider(p.id, !p.enabled);
    });
    card.querySelector('[data-edit]')?.addEventListener('click', () => {
      this.editingId = p.id;
      this._render();
    });
    card.querySelector('[data-del]')?.addEventListener('click', () => {
      void this._deleteProvider(p.id);
    });
    return card;
  }

  /** 供应商编辑详情区（provider 级字段 + Key 级模型组 + 凭据列表；key 级改动即时持久化） */
  private _renderEditor(p: BackendProvider): HTMLElement {
    const card = document.createElement('div');
    card.className = 'provider-card provider-editor';

    // Key 本地副本（key 级改动即时持久化；「保存」按钮只管 provider 级字段）
    let keys: BackendProviderKey[] = (p.keys || []).map(k => ({ ...k, models: (k.models || []).map(m => ({ ...m })) }));
    // 汇总展示各 Key 的模型；keys[].models 才是请求路由的权威来源。
    // 编辑区展示所有启用密钥的并集；每个模型仍保留原本所属的 Key。
    const aggregateModels = (source: BackendProviderKey[] = keys): BackendModel[] => {
      const byId = new Map<string, BackendModel>();
      const activeKeys = source.filter(k => k.enabled !== false);
      const modelKeys = activeKeys.length ? activeKeys : source.slice(0, 1);
      modelKeys.forEach(k => {
        (k.models || []).forEach(m => {
          const id = `${m.type || 'chat'}:${m.id}`;
          if (!byId.has(id)) byId.set(id, { ...m });
        });
      });
      return [...byId.values()];
    };
    let providerModels: BackendModel[] = aggregateModels();
    const fluxPortMode = isFluxPortProvider(p);
    let proxyOn = p.use_proxy === true;
    const providerId = p.id;

    // ── 头部 ──
    const head = document.createElement('div');
    head.className = 'provider-editor-head';
    const titleEl = document.createElement('div');
    titleEl.className = 'provider-editor-title';
    titleEl.textContent = `编辑 · ${p.name}`;
    head.appendChild(titleEl);
    const backBtn = document.createElement('button');
    backBtn.className = 'mini-btn';
    backBtn.textContent = '返回列表';
    backBtn.addEventListener('click', () => { this.editingId = null; this._render(); });
    head.appendChild(backBtn);
    card.appendChild(head);

    // ── 简称（provider 级） ──
    const shortField = document.createElement('div');
    shortField.className = 'settings-field';
    shortField.innerHTML = '<span class="settings-label">简称</span>';
    const shortInput = document.createElement('input');
    shortInput.className = 'settings-input';
    shortInput.value = p.short_name || '';
    shortInput.spellcheck = false;
    shortField.appendChild(shortInput);
    card.appendChild(shortField);

    // ── API 地址（provider 级） ──
    const urlField = document.createElement('div');
    urlField.className = 'settings-field';
    urlField.innerHTML = '<span class="settings-label">API 地址</span>';
    const urlBody = document.createElement('div');
    urlBody.className = 'settings-field-body';
    const urlRow = document.createElement('div');
    urlRow.className = 'settings-field-row';
    const urlInput = document.createElement('input');
    urlInput.className = 'settings-input';
    urlInput.value = p.api_url || '';
    urlInput.placeholder = 'https://api.example.com/v1';
    urlInput.spellcheck = false;
    const copyBtn = document.createElement('button');
    copyBtn.className = 'mini-btn';
    copyBtn.textContent = '复制';
    copyBtn.title = '复制 API 地址';
    copyBtn.addEventListener('click', () => {
      const v = urlInput.value.trim();
      if (!v) { showToast('暂无内容可复制', false); return; }
      void copyText(v).then(ok => showToast(ok ? '已复制' : '复制失败', ok));
    });
    urlRow.appendChild(urlInput);
    urlRow.appendChild(copyBtn);
    const urlHint = document.createElement('div');
    urlHint.className = 'settings-hint';
    urlHint.textContent = '以 /v1 结尾会被自动识别，也可省略（如 https://api.bltcy.ai）';
    urlBody.appendChild(urlRow);
    urlBody.appendChild(urlHint);
    urlField.appendChild(urlBody);
    card.appendChild(urlField);

    // ── 文本对话 URL（provider 级，可选：文本模型走此 URL；留空共用上方图片/视频 URL） ──
    const textUrlField = document.createElement('div');
    textUrlField.className = 'settings-field';
    textUrlField.innerHTML = '<span class="settings-label">文本对话 URL（可选）</span>';
    const textUrlBody = document.createElement('div');
    textUrlBody.className = 'settings-field-body';
    const textUrlRow = document.createElement('div');
    textUrlRow.className = 'settings-field-row';
    const textApiUrlInput = document.createElement('input');
    textApiUrlInput.className = 'settings-input';
    textApiUrlInput.value = p.text_api_url || '';
    textApiUrlInput.placeholder = '留空则与图片/视频 URL 共用';
    textApiUrlInput.spellcheck = false;
    const textUrlCopyBtn = document.createElement('button');
    textUrlCopyBtn.className = 'mini-btn';
    textUrlCopyBtn.textContent = '复制';
    textUrlCopyBtn.title = '复制文本对话 URL';
    textUrlCopyBtn.addEventListener('click', () => {
      const v = textApiUrlInput.value.trim();
      if (!v) { showToast('暂无内容可复制', false); return; }
      void copyText(v).then(ok => showToast(ok ? '已复制' : '复制失败', ok));
    });
    textUrlRow.appendChild(textApiUrlInput);
    textUrlRow.appendChild(textUrlCopyBtn);
    const textUrlHint = document.createElement('div');
    textUrlHint.className = 'settings-hint';
    textUrlHint.textContent = '文本模型走此 URL（如 https://api.uselg.top/v1）；留空共用上方图片/视频 URL。';
    textUrlBody.appendChild(textUrlRow);
    textUrlBody.appendChild(textUrlHint);
    textUrlField.appendChild(textUrlBody);
    card.appendChild(textUrlField);

    // ── 使用代理（provider 级） ──
    const proxyField = document.createElement('div');
    proxyField.className = 'settings-field';
    proxyField.innerHTML = '<span class="settings-label">使用代理</span>';
    const proxyBody = document.createElement('div');
    proxyBody.className = 'settings-field-body inline';
    const proxySwitch = document.createElement('button');
    proxySwitch.className = 'switch' + (proxyOn ? ' on' : '');
    proxySwitch.title = '启用代理';
    proxySwitch.addEventListener('click', () => {
      proxyOn = !proxyOn;
      proxySwitch.classList.toggle('on', proxyOn);
    });
    const proxyHint = document.createElement('span');
    proxyHint.className = 'settings-hint';
    proxyHint.textContent = '关闭后直连 API，默认开启';
    proxyBody.appendChild(proxySwitch);
    proxyBody.appendChild(proxyHint);
    proxyField.appendChild(proxyBody);
    card.appendChild(proxyField);

    // ── 模型管理（FluxPort 按 Key 手动配置；其它供应商共享模型组） ──
    const modelSection = document.createElement('div');
    modelSection.className = 'model-section';
    const modelHead = document.createElement('div');
    modelHead.className = 'model-section-head';
    const modelLabel = document.createElement('span');
    modelLabel.className = 'settings-label';
    modelLabel.textContent = fluxPortMode ? '模型管理（FluxPort 分组 Key）' : '模型管理';
    modelHead.appendChild(modelLabel);
    if (!fluxPortMode) {
      const fetchBtn = document.createElement('button');
      fetchBtn.className = 'mini-btn';
      fetchBtn.textContent = '拉取模型';
      fetchBtn.addEventListener('click', () => void fetchModels());
      modelHead.appendChild(fetchBtn);
    }
    modelSection.appendChild(modelHead);

    const modelHint = document.createElement('div');
    modelHint.className = 'settings-hint';
    modelHint.textContent = fluxPortMode
      ? '请手动添加文本、图像或视频模型并指定所属密钥。文本模型走“文本对话 URL”；图像和视频模型走上方 API 地址。文本 URL 留空时自动共用上方地址。'
      : '模型组由供应商共享；可手动维护，或用“拉取模型”更新。文本 URL 留空时自动共用上方 API 地址。';
    modelSection.appendChild(modelHint);

    const modelList = document.createElement('div');
    modelList.className = 'model-list';
    modelSection.appendChild(modelList);

    // 手动添加行
    const addRow = document.createElement('div');
    addRow.className = 'model-add-row';
    const midInput = document.createElement('input');
    midInput.className = 'settings-input';
    midInput.placeholder = '模型 ID';
    midInput.spellcheck = false;
    const mnameInput = document.createElement('input');
    mnameInput.className = 'settings-input';
    mnameInput.placeholder = '显示名称';
    mnameInput.spellcheck = false;
    const modelTypeSelect = createSelect({
      options: MODEL_TYPE_OPTIONS,
      value: 'drawing',
      placeholder: '类型',
    });
    modelTypeSelect.element.style.flex = '0 0 88px';
    const modelKeySelect = createSelect({
      options: [],
      placeholder: '所属密钥',
    });
    modelKeySelect.element.style.flex = '0 0 126px';
    modelKeySelect.element.title = '选择要添加模型的密钥组';
    const maddBtn = document.createElement('button');
    maddBtn.className = 'mini-btn';
    maddBtn.textContent = '手动添加';
    maddBtn.addEventListener('click', () => void addModel());
    addRow.appendChild(midInput);
    addRow.appendChild(mnameInput);
    addRow.appendChild(modelTypeSelect.element);
    if (fluxPortMode) addRow.appendChild(modelKeySelect.element);
    addRow.appendChild(maddBtn);
    modelSection.appendChild(addRow);
    card.appendChild(modelSection);

    const refreshModelKeyOptions = (): void => {
      const selected = modelKeySelect.getValue();
      const enabledKeys = keys.filter(k => k.enabled !== false);
      if (enabledKeys.length === 0) {
        modelKeySelect.setOptions([]);
        modelKeySelect.setValue('');
        return;
      }
      modelKeySelect.setOptions(enabledKeys.map(k => ({
        value: k.id,
        label: k.name || 'key',
      })));
      modelKeySelect.setValue(enabledKeys.some(k => k.id === selected) ? selected : enabledKeys[0].id);
    };

    // ── Key 管理区（凭据-only：名称/密钥/启停/删除/测试连接） ──
    const keysSection = document.createElement('div');
    keysSection.className = 'keys-section';
    const keysHead = document.createElement('div');
    keysHead.className = 'keys-section-head';
    const keysLabel = document.createElement('span');
    keysLabel.className = 'settings-label';
    keysLabel.textContent = fluxPortMode ? '密钥管理（每个密钥组独立保存可用模型）' : '密钥管理（共用模型组）';
    const addKeyBtn = document.createElement('button');
    addKeyBtn.className = 'mini-btn';
    addKeyBtn.textContent = '添加密钥';
    addKeyBtn.addEventListener('click', () => void this._addKey(providerId, syncKeys, renderKeys));
    keysHead.appendChild(keysLabel);
    keysHead.appendChild(addKeyBtn);
    keysSection.appendChild(keysHead);

    const keysWrap = document.createElement('div');
    keysWrap.className = 'keys-list';
    keysSection.appendChild(keysWrap);
    card.appendChild(keysSection);

    // ── 底部操作（保存 = provider 级字段：简称/URL/文本对话 URL/代理） ──
    const actions = document.createElement('div');
    actions.className = 'provider-editor-actions';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn-secondary';
    saveBtn.textContent = '保存';
    saveBtn.addEventListener('click', () => void saveFields());
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-ghost';
    cancelBtn.textContent = '关闭';
    cancelBtn.addEventListener('click', () => { this.editingId = null; this._render(); });
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    card.appendChild(actions);

    // ── 内部函数 ──

    /** keys 数组变更：更新本地副本 + this.providers + 顶部默认模型下拉 */
    const syncKeys = (next: BackendProviderKey[]): void => {
      keys = next;
      const provider = this.providers.find(x => x.id === providerId);
      if (provider) provider.keys = next;
      this._refreshDefaultModelSelect();
      refreshModelKeyOptions();
    };

    /** 重渲染 key 卡片列表（增删 key 后调用，保留 provider 级字段输入） */
    const renderKeys = (): void => {
      keysWrap.innerHTML = '';
      if (keys.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'key-empty';
        empty.textContent = '暂无密钥，点击「添加密钥」创建';
        keysWrap.appendChild(empty);
        return;
      }
      keys.forEach(k => keysWrap.appendChild(this._renderKeyCard(p, k, {
        getUrl: () => textApiUrlInput.value.trim() || urlInput.value.trim(),
        onKeysChange: syncKeys,
        onRenderKeys: renderKeys,
      })));
    };

    const saveFields = async (): Promise<void> => {
      try {
        const res = await Backend.updateProvider(providerId, {
          short_name: shortInput.value.trim(),
          api_url: urlInput.value.trim(),
          text_api_url: textApiUrlInput.value.trim() || '',
          use_proxy: proxyOn,
        });
        if (res.status === 'success') showToast('已保存');
        else showToast(res.message || '保存失败', false);
      } catch (e) {
        showToast('保存失败：' + (e as Error).message, false);
      }
    };

    // ── Key 级模型组函数（页面只做汇总展示） ──

    const renderModelRows = (): void => {
      modelList.innerHTML = '';
      if (fluxPortMode) {
        const entries = keys
          .filter(k => k.enabled !== false)
          .flatMap(k => (k.models || []).map(model => ({ key: k, model })));
        if (entries.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'model-empty';
          empty.textContent = '暂无模型，请手动添加';
          modelList.appendChild(empty);
          return;
        }
        entries.forEach(({ key, model }) => modelList.appendChild(buildModelRow(model, key)));
        return;
      }
      if (providerModels.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'model-empty';
        empty.textContent = '暂无模型，可“拉取模型”或手动添加';
        modelList.appendChild(empty);
        return;
      }
      providerModels.forEach(model => modelList.appendChild(buildModelRow(model)));
    };

    const buildModelRow = (m: BackendModel, key?: BackendProviderKey): HTMLElement => {
      const row = document.createElement('div');
      row.className = 'model-row';

      const badge = document.createElement('span');
      const typeLabel = m.type === 'drawing' ? '图像' : (m.type === 'video' ? '视频' : '文本');
      badge.className = 'model-type-badge ' + (m.type === 'drawing' ? 'drawing' : 'chat');
      badge.textContent = typeLabel;

      const nameEl = document.createElement('span');
      nameEl.className = 'model-name';
      nameEl.textContent = m.name || m.id;
      nameEl.title = m.id;

      const idEl = document.createElement('span');
      idEl.className = 'model-id';
      if (key) {
        const owner = key.name || 'key';
        idEl.textContent = `${m.id} · ${owner}`;
        idEl.title = `所属密钥组：${owner}`;
      } else {
        idEl.textContent = m.id;
        idEl.title = m.id;
      }

      const sw = document.createElement('button');
      sw.className = 'switch ' + (m.enabled !== false ? 'on' : '');
      sw.title = '启用/停用';
      sw.addEventListener('click', () => {
        if (key) void toggleModel(key.id, m.id, m.enabled === false);
        else void toggleProviderModel(m.id, m.enabled === false);
      });

      const del = document.createElement('button');
      del.className = 'mini-btn danger';
      del.textContent = '删除';
      del.addEventListener('click', () => {
        if (key) void deleteModel(key.id, m.id);
        else void deleteProviderModel(m.id);
      });

      row.appendChild(badge);
      row.appendChild(nameEl);
      row.appendChild(idEl);
      row.appendChild(sw);
      row.appendChild(del);
      return row;
    };

    /** 只更新一个 Key 的模型列表；模型归属绝不跨 Key 复制。 */
    const updateKeyModels = async (
      keyId: string,
      transform: (models: BackendModel[]) => BackendModel[],
    ): Promise<boolean> => {
      const target = keys.find(k => k.id === keyId && k.enabled !== false);
      if (!target) return false;
      try {
        const res = await Backend.updateKey(providerId, target.id, { models: transform(target.models || []) });
        if (res.status !== 'success' || !res.keys) return false;
        syncKeys(res.keys);
      } catch {
        return false;
      }
      providerModels = aggregateModels();
      this._refreshDefaultModelSelect();
      renderModelRows();
      return true;
    };

    /** 普通供应商：模型组共享到每个启用 Key，维持原有简洁配置。 */
    const updateProviderModels = async (next: BackendModel[]): Promise<boolean> => {
      const targets = keys.filter(k => k.enabled !== false);
      if (targets.length === 0) return false;
      let allOk = true;
      for (const key of targets) {
        try {
          const res = await Backend.updateKey(providerId, key.id, { models: next.map(m => ({ ...m })) });
          if (res.status === 'success' && res.keys) syncKeys(res.keys);
          else allOk = false;
        } catch {
          allOk = false;
        }
      }
      providerModels = aggregateModels();
      this._refreshDefaultModelSelect();
      renderModelRows();
      return allOk;
    };

    const fetchModels = async (): Promise<void> => {
      const url = textApiUrlInput.value.trim() || urlInput.value.trim();
      const sourceKey = keys.find(k => k.enabled !== false && Boolean(k.api_key));
      if (!url) { showToast('请先填写 API 地址', false); return; }
      if (!sourceKey) { showToast('请先启用并填写至少一个 API 密钥', false); return; }
      try {
        const res = await Backend.fetchModels(url, sourceKey.api_key);
        if (res.status !== 'success' || !res.models) {
          showToast(res.message || '拉取模型失败', false);
          return;
        }
        const ok = await updateProviderModels(res.models.map(m => ({
          id: m.id,
          name: m.name || m.id,
          type: m.type === 'video' ? 'video' : (m.type === 'chat' ? 'chat' : 'drawing'),
          enabled: m.enabled !== false,
        })));
        showToast(ok ? '模型已更新' : '模型保存失败', ok);
      } catch (e) {
        showToast('拉取模型失败：' + (e as Error).message, false);
      }
    };

    const addModel = (): void => {
      const mid = midInput.value.trim();
      if (!mid) { showToast('请输入模型 ID', false); return; }
      const mtype = modelTypeSelect.getValue() || 'drawing';
      const newModel: BackendModel = {
        id: mid,
        name: mnameInput.value.trim() || mid,
        type: mtype,
        enabled: true,
      };
      void (async () => {
        if (!fluxPortMode) {
          if (providerModels.some(m => m.id === mid && m.type === mtype)) {
            showToast('该模型已存在', false);
            return;
          }
          const ok = await updateProviderModels([...providerModels, newModel]);
          showToast(ok ? '已添加' : '模型保存失败', ok);
          return;
        }
        const target = keys.find(k => k.id === modelKeySelect.getValue() && k.enabled !== false);
        if (!target) { showToast('请选择一个启用的密钥组', false); return; }
        if ((target.models || []).some(m => m.id === mid)) { showToast('该模型已存在于所选密钥组', false); return; }
        try {
          const res = await Backend.updateKey(providerId, target.id, { models: [...(target.models || []), newModel] });
          if (res.status === 'success' && res.keys) {
            syncKeys(res.keys);
            providerModels = aggregateModels();
            this._refreshDefaultModelSelect();
            renderModelRows();
            showToast('已添加');
          } else {
            showToast(res.message || '模型保存失败', false);
          }
        } catch (e) {
          showToast('模型保存失败：' + (e as Error).message, false);
        }
      })();
    };

    const toggleModel = (keyId: string, modelId: string, enabled: boolean): void => {
      void (async () => {
        const ok = await updateKeyModels(keyId, models => models.map(m => (
          m.id === modelId ? { ...m, enabled } : m
        )));
        showToast(ok ? '已保存' : '模型保存失败', ok);
      })();
    };

    const toggleProviderModel = (modelId: string, enabled: boolean): void => {
      void (async () => {
        const ok = await updateProviderModels(providerModels.map(m => (
          m.id === modelId ? { ...m, enabled } : m
        )));
        showToast(ok ? '已保存' : '模型保存失败', ok);
      })();
    };

    const deleteModel = async (keyId: string, modelId: string): Promise<void> => {
      const key = keys.find(k => k.id === keyId);
      const keyLabel = key ? (key.name || 'key') : keyId;
      const ok = await confirmDialog({
        title: '删除模型',
        message: `确定从密钥组「${keyLabel}」删除模型「${modelId}」？`,
        confirmText: '删除',
        cancelText: '取消',
        danger: true,
      });
      if (!ok) return;
      const ok2 = await updateKeyModels(keyId, models => models.filter(m => m.id !== modelId));
      showToast(ok2 ? '已删除' : '删除失败', ok2);
    };

    const deleteProviderModel = async (modelId: string): Promise<void> => {
      const ok = await confirmDialog({
        title: '删除模型',
        message: `确定删除模型「${modelId}」？将从该供应商所有启用密钥的共享模型组中移除。`,
        confirmText: '删除',
        cancelText: '取消',
        danger: true,
      });
      if (!ok) return;
      const ok2 = await updateProviderModels(providerModels.filter(m => m.id !== modelId));
      showToast(ok2 ? '已删除' : '删除失败', ok2);
    };

    refreshModelKeyOptions();
    renderKeys();
    renderModelRows();
    return card;
  }

  /** 单张 key 卡片（凭据-only：名称/密钥/启停/测试连接/删除；key 级改动即时持久化） */
  private _renderKeyCard(p: BackendProvider, k: BackendProviderKey, ctx: KeyCardCtx): HTMLElement {
    const card = document.createElement('div');
    card.className = 'key-card' + (k.enabled === false ? ' disabled' : '');
    const providerId = p.id;
    const keyId = k.id;
    let keyVisible = false;

    // ── 头部：key 名输入 + 启停 + 删除 ──
    const head = document.createElement('div');
    head.className = 'key-card-head';
    const nameInput = document.createElement('input');
    nameInput.className = 'key-name-input';
    nameInput.value = k.name || '';
    nameInput.placeholder = '密钥名称';
    nameInput.spellcheck = false;
    nameInput.addEventListener('change', () => {
      void persistKey({ name: nameInput.value.trim() || nameInput.value });
    });
    const keySwitch = document.createElement('button');
    keySwitch.className = 'switch' + (k.enabled !== false ? ' on' : '');
    keySwitch.title = '启用/停用密钥';
    keySwitch.addEventListener('click', () => {
      const nextEnabled = k.enabled === false;
      keySwitch.classList.toggle('on', nextEnabled);
      card.classList.toggle('disabled', !nextEnabled);
      void persistKey({ enabled: nextEnabled });
    });
    const delBtn = document.createElement('button');
    delBtn.className = 'mini-btn danger';
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', () => void deleteKey());
    head.appendChild(nameInput);
    head.appendChild(keySwitch);
    head.appendChild(delBtn);
    card.appendChild(head);

    // ── 密钥字段（key 级） ──
    const keyField = document.createElement('div');
    keyField.className = 'settings-field';
    keyField.innerHTML = '<span class="settings-label">API 密钥</span>';
    const keyBody = document.createElement('div');
    keyBody.className = 'settings-field-body inline';
    const keyInput = document.createElement('input');
    keyInput.className = 'settings-input';
    keyInput.type = 'password';
    keyInput.value = k.api_key || '';
    keyInput.placeholder = 'sk-...';
    keyInput.spellcheck = false;
    keyInput.addEventListener('change', () => {
      void persistKey({ api_key: keyInput.value });
    });
    const eyeBtn = document.createElement('button');
    eyeBtn.className = 'mini-btn';
    eyeBtn.textContent = '显示';
    eyeBtn.title = '显示/隐藏密钥';
    eyeBtn.addEventListener('click', () => {
      keyVisible = !keyVisible;
      keyInput.type = keyVisible ? 'text' : 'password';
      eyeBtn.textContent = keyVisible ? '隐藏' : '显示';
    });
    const testBtn = document.createElement('button');
    testBtn.className = 'mini-btn';
    testBtn.textContent = '测试连接';
    testBtn.addEventListener('click', () => void testConnection());
    keyBody.appendChild(keyInput);
    keyBody.appendChild(eyeBtn);
    keyBody.appendChild(testBtn);
    keyField.appendChild(keyBody);
    card.appendChild(keyField);

    // ── 内部函数 ──

    /** 即时持久化 key 字段（成功后同步本地/供应商副本 + 顶部默认模型下拉） */
    const persistKey = async (updates: Record<string, unknown>): Promise<void> => {
      try {
        const res = await Backend.updateKey(providerId, keyId, updates);
        if (res.status === 'success') {
          if (res.keys) ctx.onKeysChange(res.keys);
          showToast('已保存');
        } else {
          showToast(res.message || '保存失败', false);
        }
      } catch (e) {
        showToast('保存失败：' + (e as Error).message, false);
      }
    };

    const testConnection = async (): Promise<void> => {
      const url = ctx.getUrl();
      const key = keyInput.value;
      if (!url) { showToast('请先填写 API 地址', false); return; }
      if (!key) { showToast('请先填写 API 密钥', false); return; }
      try {
        const res = await Backend.testConnection(url, key);
        if (res.success) showToast(res.message || '连接成功');
        else showToast(res.message || '连接失败', false);
      } catch (e) {
        showToast('测试失败：' + (e as Error).message, false);
      }
    };

    const deleteKey = async (): Promise<void> => {
      const ok = await confirmDialog({
        title: '删除密钥',
        message: `确定删除密钥「${nameInput.value || keyId}」？删除后其出图/对话将不可用，已引用该密钥模型的节点需重新选择模型。`,
        confirmText: '删除',
        cancelText: '取消',
        danger: true,
      });
      if (!ok) return;
      try {
        const res = await Backend.deleteKey(providerId, keyId);
        if (res.status === 'success') {
          if (res.keys) ctx.onKeysChange(res.keys);
          ctx.onRenderKeys();
          showToast('已删除');
        } else {
          showToast(res.message || '删除失败', false);
        }
      } catch (e) {
        showToast('删除失败：' + (e as Error).message, false);
      }
    };

    return card;
  }

  /** 添加密钥（后端生成 key_${uuid} + 默认名 keyN）；新 Key 从空模型列表开始，由用户手动配置。 */
  private async _addKey(providerId: string, onKeysChange: (next: BackendProviderKey[]) => void, onRenderKeys: () => void): Promise<void> {
    try {
      const res = await Backend.addKey(providerId);
      if (res.status === 'success' && res.keys) {
        onKeysChange(res.keys);
        onRenderKeys();
        showToast('已添加密钥');
      } else {
        showToast(res.message || '添加失败', false);
      }
    } catch (e) {
      showToast('添加失败：' + (e as Error).message, false);
    }
  }

  private async _toggleProvider(id: string, enabled: boolean): Promise<void> {
    try {
      const res = await Backend.updateProvider(id, { enabled });
      if (res.status === 'success') {
        showToast(enabled ? '已启用' : '已停用');
        await this._refresh();
      } else {
        showToast('操作失败', false);
      }
    } catch (e) {
      showToast('操作失败：' + (e as Error).message, false);
    }
  }

  private async _deleteProvider(id: string): Promise<void> {
    const ok = await confirmDialog({
      title: '删除供应商',
      message: '确定删除该供应商？其下的模型配置将一并移除。',
      confirmText: '删除',
      cancelText: '取消',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await Backend.deleteProvider(id);
      if (res.status === 'success') {
        showToast('已删除');
        await this._refresh();
      } else {
        showToast('删除失败', false);
      }
    } catch (e) {
      showToast('删除失败：' + (e as Error).message, false);
    }
  }

  private async _addProvider(): Promise<void> {
    const name = this.nameInput?.value.trim() || '';
    if (!name) { showToast('请输入供应商名称', false); return; }
    const shortName = this.shortInput?.value.trim() || '';
    const type = this.typeSelect?.getValue() || 'openai';
    try {
      const res = await Backend.addProvider(name, type, shortName);
      const newId = res.provider_id || res.id || res.provider?.id || '';
      if (res.status === 'success' && newId) {
        showToast('供应商已添加');
        if (this.nameInput) this.nameInput.value = '';
        if (this.shortInput) this.shortInput.value = '';
        await this._refresh();
        this.editingId = newId;
        this._render();
      } else {
        showToast(res.message || '添加失败', false);
      }
    } catch (e) {
      showToast('添加失败：' + (e as Error).message, false);
    }
  }
}

function typeLabel(type: string): string {
  return type === 'gemini' ? 'Gemini 原生' : 'OpenAI 兼容';
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function fallbackCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text)
      .then(() => true)
      .catch(() => fallbackCopy(text));
  }
  return Promise.resolve(fallbackCopy(text));
}

export const settingsPanel = new SettingsPanel();
