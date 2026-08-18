// src/v1/ui/settings-panel.ts
// 设置/供应商面板（温馨园艺风，A7）
// 完整供应商管理：列表 / 添加 / 编辑（url·provider 字段 + 供应商级模型组 + 凭据-only Key 列表）/ 默认绘图模型 / 自定义下拉与确认弹窗
// 供应商级模型组：一个供应商（同一 api_url）配置一份模型组，全部 enabled key 共享；
//                模型组编辑（增删/启停/拉取）后同步复制到全部 enabled key 的 models[]（禁用 key 不复制）；
//                新增 key 的 models 初始化为当前模型组副本；已有每 key 独立配置在首次编辑模型组前保持原样。
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
  { value: 'drawing', label: '绘图' },
  { value: 'chat', label: '对话' },
];

/** key 卡片回调上下文（由 _renderEditor 注入；key 卡片仅凭据：名称/api_key/启停/删除/测试连接） */
interface KeyCardCtx {
  /** 当前编辑中的 API 地址（provider 级输入框实时值） */
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

  /** 默认模型下拉宽容回显：三段命中；旧两段 id 在 options 中找同名模型并返回三段 id；未命中返回 '' */
  private _matchDefaultOption(options: SelectOption[], saved: string): string {
    if (!saved) return '';
    if (options.some(o => o.value === saved)) return saved;
    const parts = saved.split(':');
    if (parts.length === 2) {
      const [pid, mid] = parts;
      const hit = options.find(o => o.value.startsWith(`${pid}:`) && o.value.endsWith(`:${mid}`));
      if (hit) return hit.value;
    }
    return '';
  }

  /** 紧凑卡片视图：名称 / 简称·类型 / 模型数量（跨 key 汇总）/ 启用开关 / 编辑 / 删除 */
  private _renderCard(p: BackendProvider): HTMLElement {
    const card = document.createElement('div');
    card.className = 'provider-card';

    // 模型计数跨 key 汇总后按 id+type 去重（模型组供应商级共享：enabled key 各自持有一份副本，
    // 直接相加会重复计数；去重后展示供应商实际拥有的模型集合）
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

    card.innerHTML = `
      <div class="provider-card-head">
        <div class="provider-card-info">
          <div class="provider-name">${escapeHtml(p.name)}</div>
          <div class="provider-type">${escapeHtml(p.short_name || '')} · ${escapeHtml(typeLabel(p.type))}</div>
        </div>
        <div class="provider-actions">
          <span class="provider-counts">对话 ${chatCount} · 绘图 ${drawCount}${keys.length ? ` · ${keys.length} Key` : ''}</span>
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

  /** 供应商编辑详情区（provider 级字段 + 供应商级模型组 + 凭据-only Key 列表；key 级改动即时持久化） */
  private _renderEditor(p: BackendProvider): HTMLElement {
    const card = document.createElement('div');
    card.className = 'provider-card provider-editor';

    // Key 本地副本（key 级改动即时持久化；「保存」按钮只管 provider 级字段）
    let keys: BackendProviderKey[] = (p.keys || []).map(k => ({ ...k, models: (k.models || []).map(m => ({ ...m })) }));
    // 供应商级模型组（一个供应商一份，全部 enabled key 共享；编辑后同步复制到全部 enabled key 的 models[]）。
    // 初始化取第一个 enabled key 的 models（无 enabled key 取第一个 key；无 key 为空数组）。
    // 已有每 key 独立配置的供应商在首次编辑模型组前保持原样不动（不主动清空/覆盖）。
    const firstEnabledKey = keys.find(k => k.enabled !== false) || keys[0];
    let providerModels: BackendModel[] = (firstEnabledKey?.models || []).map(m => ({ ...m }));
    let proxyOn = p.use_proxy !== false;
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

    // ── 模型组管理（供应商级：一份模型组，全部 enabled key 共享） ──
    const modelSection = document.createElement('div');
    modelSection.className = 'model-section';
    const modelHead = document.createElement('div');
    modelHead.className = 'model-section-head';
    const modelLabel = document.createElement('span');
    modelLabel.className = 'settings-label';
    modelLabel.textContent = '模型组管理（全部密钥共享）';
    const fetchBtn = document.createElement('button');
    fetchBtn.className = 'mini-btn';
    fetchBtn.textContent = '拉取模型';
    fetchBtn.addEventListener('click', () => void fetchModels());
    modelHead.appendChild(modelLabel);
    modelHead.appendChild(fetchBtn);
    modelSection.appendChild(modelHead);

    const modelHint = document.createElement('div');
    modelHint.className = 'settings-hint';
    modelHint.textContent = '同一供应商下的全部密钥共享此模型组；增删/启停/拉取后自动同步到所有启用的密钥。';
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
    const maddBtn = document.createElement('button');
    maddBtn.className = 'mini-btn';
    maddBtn.textContent = '手动添加';
    maddBtn.addEventListener('click', () => void addModel());
    addRow.appendChild(midInput);
    addRow.appendChild(mnameInput);
    addRow.appendChild(modelTypeSelect.element);
    addRow.appendChild(maddBtn);
    modelSection.appendChild(addRow);
    card.appendChild(modelSection);

    // ── Key 管理区（凭据-only：名称/密钥/启停/删除/测试连接） ──
    const keysSection = document.createElement('div');
    keysSection.className = 'keys-section';
    const keysHead = document.createElement('div');
    keysHead.className = 'keys-section-head';
    const keysLabel = document.createElement('span');
    keysLabel.className = 'settings-label';
    keysLabel.textContent = '密钥管理（仅凭据；共用上方模型组）';
    const addKeyBtn = document.createElement('button');
    addKeyBtn.className = 'mini-btn';
    addKeyBtn.textContent = '添加密钥';
    addKeyBtn.addEventListener('click', () => void this._addKey(providerId, providerModels, syncKeys, renderKeys));
    keysHead.appendChild(keysLabel);
    keysHead.appendChild(addKeyBtn);
    keysSection.appendChild(keysHead);

    const keysWrap = document.createElement('div');
    keysWrap.className = 'keys-list';
    keysSection.appendChild(keysWrap);
    card.appendChild(keysSection);

    // ── 底部操作（保存 = provider 级字段：简称/URL/代理） ──
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
        getUrl: () => urlInput.value.trim(),
        onKeysChange: syncKeys,
        onRenderKeys: renderKeys,
      })));
    };

    const saveFields = async (): Promise<void> => {
      try {
        const res = await Backend.updateProvider(providerId, {
          short_name: shortInput.value.trim(),
          api_url: urlInput.value.trim(),
          use_proxy: proxyOn,
        });
        if (res.status === 'success') showToast('已保存');
        else showToast(res.message || '保存失败', false);
      } catch (e) {
        showToast('保存失败：' + (e as Error).message, false);
      }
    };

    // ── 供应商级模型组函数 ──

    const renderModelRows = (): void => {
      modelList.innerHTML = '';
      if (providerModels.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'model-empty';
        empty.textContent = '暂无模型，可「拉取模型」或「手动添加」';
        modelList.appendChild(empty);
        return;
      }
      providerModels.forEach(m => modelList.appendChild(buildModelRow(m)));
    };

    const buildModelRow = (m: BackendModel): HTMLElement => {
      const row = document.createElement('div');
      row.className = 'model-row';

      const badge = document.createElement('span');
      const isDrawing = m.type === 'drawing';
      badge.className = 'model-type-badge ' + (isDrawing ? 'drawing' : 'chat');
      badge.textContent = isDrawing ? '绘图' : '对话';

      const nameEl = document.createElement('span');
      nameEl.className = 'model-name';
      nameEl.textContent = m.name || m.id;
      nameEl.title = m.id;

      const idEl = document.createElement('span');
      idEl.className = 'model-id';
      idEl.textContent = m.id;

      const sw = document.createElement('button');
      sw.className = 'switch ' + (m.enabled !== false ? 'on' : '');
      sw.title = '启用/停用';
      sw.addEventListener('click', () => void toggleModel(m.id, m.enabled === false));

      const del = document.createElement('button');
      del.className = 'mini-btn danger';
      del.textContent = '删除';
      del.addEventListener('click', () => void deleteModel(m.id));

      row.appendChild(badge);
      row.appendChild(nameEl);
      row.appendChild(idEl);
      row.appendChild(sw);
      row.appendChild(del);
      return row;
    };

    /**
     * 模型组变化：更新本地 providerModels + this.providers 的 enabled key 副本，
     * 再逐个 updateKey 把新模型组写入全部 enabled key 的 models[]（禁用 key 不复制）。
     * 返回是否全部写成功（单 key 失败不中断，继续写其余 key）。
     */
    const persistProviderModels = async (next: BackendModel[]): Promise<boolean> => {
      providerModels = next.map(m => ({ ...m }));
      const provider = this.providers.find(x => x.id === providerId);
      if (provider) {
        (provider.keys || []).forEach(k => {
          if (k.enabled !== false) k.models = next.map(m => ({ ...m }));
        });
      }
      let allOk = true;
      const enabledKeys = keys.filter(k => k.enabled !== false);
      for (const k of enabledKeys) {
        try {
          const res = await Backend.updateKey(providerId, k.id, { models: next.map(m => ({ ...m })) });
          if (res.status === 'success') {
            if (res.keys) syncKeys(res.keys);
          } else {
            allOk = false;
          }
        } catch (e) {
          allOk = false;
        }
      }
      this._refreshDefaultModelSelect();
      renderModelRows();
      return allOk;
    };

    const fetchModels = async (): Promise<void> => {
      const url = urlInput.value.trim();
      const keyCred = (keys.find(k => k.enabled !== false) || keys[0])?.api_key || '';
      if (!url) { showToast('请先填写 API 地址', false); return; }
      if (!keyCred) { showToast('请先填写 API 密钥', false); return; }
      try {
        const res = await Backend.fetchModels(url, keyCred);
        if (res.status !== 'success' || !res.models) {
          showToast(res.message || '拉取模型失败', false);
          return;
        }
        // 合并逻辑：按后端返回的 type 字段分类合并（chat 归 chat、drawing 归 drawing），
        // 同 ID 保留旧 enabled 状态；旧列表里拉回未出现的模型保留（含手动添加）。
        const existingMap: Record<string, BackendModel> = {};
        providerModels.forEach(m => { existingMap[m.id] = m; });

        const chatById: Record<string, BackendModel> = {};
        const drawingById: Record<string, BackendModel> = {};
        providerModels.forEach(m => {
          if (m.type === 'chat') chatById[m.id] = m;
          else drawingById[m.id] = m;
        });

        (res.models || []).forEach(m => {
          const isChat = m.type === 'chat';
          const entry: BackendModel = {
            id: m.id,
            name: m.name || m.id,
            type: isChat ? 'chat' : 'drawing',
            enabled: existingMap[m.id]?.enabled ?? true,
          };
          if (isChat) chatById[m.id] = entry;
          else drawingById[m.id] = entry;
        });

        const merged: BackendModel[] = [...Object.values(chatById), ...Object.values(drawingById)];
        const ok = await persistProviderModels(merged);
        showToast(
          ok
            ? `已拉取 ${Object.keys(chatById).length} 个对话模型、${Object.keys(drawingById).length} 个绘图模型`
            : '模型已拉取但部分密钥同步失败',
          ok,
        );
      } catch (e) {
        showToast('拉取失败：' + (e as Error).message, false);
      }
    };

    const addModel = (): void => {
      const mid = midInput.value.trim();
      if (!mid) { showToast('请输入模型 ID', false); return; }
      if (providerModels.some(m => m.id === mid)) { showToast('该模型已存在', false); return; }
      const mtype = modelTypeSelect.getValue() || 'drawing';
      const newModel: BackendModel = {
        id: mid,
        name: mnameInput.value.trim() || mid,
        type: mtype,
        enabled: true,
      };
      void (async () => {
        const ok = await persistProviderModels([...providerModels, newModel]);
        showToast(ok ? '已添加' : '模型保存失败', ok);
      })();
    };

    const toggleModel = (modelId: string, enabled: boolean): void => {
      const next = providerModels.map(m => (m.id === modelId ? { ...m, enabled } : m));
      void (async () => {
        const ok = await persistProviderModels(next);
        showToast(ok ? '已保存' : '模型保存失败', ok);
      })();
    };

    const deleteModel = async (modelId: string): Promise<void> => {
      const ok = await confirmDialog({
        title: '删除模型',
        message: `确定删除模型「${modelId}」？将从该供应商全部密钥的模型组中移除。`,
        confirmText: '删除',
        cancelText: '取消',
        danger: true,
      });
      if (!ok) return;
      const ok2 = await persistProviderModels(providerModels.filter(m => m.id !== modelId));
      showToast(ok2 ? '已删除' : '删除失败', ok2);
    };

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

  /** 添加密钥（后端生成 key_${uuid} + 默认名 keyN）；新 key 的 models 初始化为当前供应商级模型组副本（非空时写一次） */
  private async _addKey(providerId: string, providerModels: BackendModel[], onKeysChange: (next: BackendProviderKey[]) => void, onRenderKeys: () => void): Promise<void> {
    try {
      const res = await Backend.addKey(providerId);
      if (res.status === 'success' && res.keys) {
        onKeysChange(res.keys);
        // 新 key 的 models 初始化为当前模型组副本（模型组为空则保持后端默认 []）
        const newKey = res.key;
        if (newKey && providerModels.length > 0) {
          const upd = await Backend.updateKey(providerId, newKey.id, { models: providerModels.map(m => ({ ...m })) });
          if (upd.status === 'success') {
            if (upd.keys) onKeysChange(upd.keys);
          } else {
            showToast(upd.message || '模型初始化失败', false);
          }
        }
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
