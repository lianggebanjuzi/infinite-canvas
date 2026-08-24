// src/v1/ui/settings-panel.ts
// 设置/供应商面板（温馨园艺风，A7）
// 完整供应商管理：列表 / 添加 / 编辑（url·provider 字段 + Key 级模型组 + Key 列表）/ 自定义下拉与确认弹窗
// 模型可用性属于 Key。页面可以汇总展示，但绝不能把一把 Key 的模型复制给另一把 Key。
// URL 保持供应商级配置；图像/文本/视频可配置全局 Key，模型也可单独覆盖 Key。

import { Backend } from '../api';
import { showToast } from './toast';
import { createSelect, type SelectHandle, type SelectOption } from './select';
import { confirmDialog } from './confirm';

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

class SettingsPanel {
  private overlay: HTMLElement | null = null;
  private list: HTMLElement | null = null;
  private nameInput: HTMLInputElement | null = null;
  private shortInput: HTMLInputElement | null = null;
  private addBtn: HTMLButtonElement | null = null;
  private typeSelect: SelectHandle | null = null;
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
    // P1：图片保存路径配置区置于供应商列表顶部。
    this.list.appendChild(this._renderImagePathSection());
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
    hint.textContent = '生成图片与资产库素材将保存到此目录。未设置时生成图仅临时可用、不落盘。';
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

  /** 供应商编辑详情区（URL、全局 Key 与 Key 级模型组）。 */
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
    const globalKeys: Record<'chat' | 'drawing' | 'video', string> = {
      chat: p.global_keys?.chat || '',
      drawing: p.global_keys?.drawing || '',
      video: p.global_keys?.video || '',
    };

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

    // 基础连接在上、模型分栏在下：避免把连通性配置与模型操作拆到左右两侧。
    const workspace = document.createElement('div');
    workspace.className = 'provider-editor-workspace';
    const connectionColumn = document.createElement('section');
    connectionColumn.className = 'provider-editor-column provider-connection-column';
    const connectionTitle = document.createElement('div');
    connectionTitle.className = 'provider-editor-column-title';
    connectionTitle.textContent = '基础连接';
    connectionColumn.appendChild(connectionTitle);
    const modelColumn = document.createElement('section');
    modelColumn.className = 'provider-editor-column provider-model-column';
    const modelTitle = document.createElement('div');
    modelTitle.className = 'provider-editor-column-title';
    modelTitle.textContent = '模型管理';
    modelColumn.appendChild(modelTitle);
    workspace.appendChild(connectionColumn);
    workspace.appendChild(modelColumn);
    card.appendChild(workspace);

    // ── 简称（provider 级） ──
    const shortField = document.createElement('div');
    shortField.className = 'settings-field';
    shortField.innerHTML = '<span class="settings-label">简称</span>';
    const shortInput = document.createElement('input');
    shortInput.className = 'settings-input';
    shortInput.value = p.short_name || '';
    shortInput.spellcheck = false;
    shortField.appendChild(shortInput);
    connectionColumn.appendChild(shortField);

    // ── URL（保持原有供应商级配置） ──
    const makeUrlField = (label: string, value: string, placeholder: string): HTMLInputElement => {
      const field = document.createElement('div');
      field.className = 'settings-field';
      field.innerHTML = `<span class="settings-label">${label}</span>`;
      const input = document.createElement('input');
      input.className = 'settings-input';
      input.value = value;
      input.placeholder = placeholder;
      input.spellcheck = false;
      field.appendChild(input);
      connectionColumn.appendChild(field);
      return input;
    };
    const urlInput = makeUrlField('API 地址', p.api_url || '', 'https://api.example.com/v1');
    const textApiUrlInput = makeUrlField('文本对话 URL', p.text_api_url || '', '留空则与 API 地址共用');

    // ── 分类型全局 Key（模型未填写单独 Key 时使用） ──
    const globalLabels: Array<{ kind: 'chat' | 'drawing' | 'video'; label: string }> = [
      { kind: 'drawing', label: '图像全局 Key' },
      { kind: 'chat', label: '对话全局 Key' },
      { kind: 'video', label: '视频全局 Key' },
    ];
    globalLabels.forEach(({ kind, label }) => {
      const field = document.createElement('div');
      field.className = 'settings-field';
      field.innerHTML = `<span class="settings-label">${label}</span>`;
      const body = document.createElement('div');
      body.className = 'settings-field-body inline';
      const input = document.createElement('input');
      input.className = 'settings-input';
      input.type = 'password';
      input.value = globalKeys[kind];
      input.placeholder = '留空时该类型模型需填写专用 Key';
      input.spellcheck = false;
      input.addEventListener('change', () => {
        globalKeys[kind] = input.value;
        void persistGlobalKeys();
      });
      let visible = false;
      const eye = document.createElement('button');
      eye.className = 'mini-btn';
      eye.textContent = '显示';
      eye.addEventListener('click', () => {
        visible = !visible;
        input.type = visible ? 'text' : 'password';
        eye.textContent = visible ? '隐藏' : '显示';
      });
      body.appendChild(input);
      body.appendChild(eye);
      field.appendChild(body);
      connectionColumn.appendChild(field);
    });

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
    connectionColumn.appendChild(proxyField);

    // ── 模型管理（FluxPort 按 Key 手动配置；其它供应商共享模型组） ──
    const modelSection = document.createElement('div');
    modelSection.className = 'model-section';
    const modelHead = document.createElement('div');
    modelHead.className = 'model-section-head';
    const modelLabel = document.createElement('span');
    modelLabel.className = 'settings-label';
    modelLabel.textContent = fluxPortMode ? '模型管理（对话 / 图像独立配置）' : '模型管理';
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
      ? '图像、对话、视频 Key 严格分开；模型专用 Key 优先于同类型全局 Key。'
      : '模型可手动添加。未填写模型单独 Key 时，按图像、对话、视频使用上方对应全局 Key。';
    modelSection.appendChild(modelHint);

    // 图像 / 文本 / 视频模型各自独立成栏，便于快速浏览和管理大量模型。
    const modelGrid = document.createElement('div');
    modelGrid.className = 'model-type-grid';
    const modelLists = new Map<'drawing' | 'chat' | 'video', HTMLElement>();
    ([
      { type: 'drawing' as const, label: '图像模型' },
      { type: 'chat' as const, label: '文本模型' },
      { type: 'video' as const, label: '视频模型' },
    ]).forEach(({ type, label }) => {
      const column = document.createElement('section');
      column.className = `model-type-column ${type}`;
      const heading = document.createElement('div');
      heading.className = 'model-type-column-title';
      heading.textContent = label;
      const list = document.createElement('div');
      list.className = 'model-list';
      column.appendChild(heading);
      column.appendChild(list);
      modelGrid.appendChild(column);
      modelLists.set(type, list);
    });
    modelSection.appendChild(modelGrid);

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
    modelColumn.appendChild(modelSection);

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

    /** keys 数组变更：更新本地副本与当前供应商缓存。 */
    const syncKeys = (next: BackendProviderKey[]): void => {
      keys = next;
      const provider = this.providers.find(x => x.id === providerId);
      if (provider) provider.keys = next;
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

    const persistGlobalKeys = async (): Promise<void> => {
      try {
        const res = await Backend.updateProvider(providerId, { global_keys: globalKeys });
        showToast(res.status === 'success' ? '已保存' : (res.message || '保存失败'), res.status === 'success');
      } catch (e) {
        showToast('保存失败：' + (e as Error).message, false);
      }
    };

    // ── Key 级模型组函数（页面只做汇总展示） ──

    const renderModelRows = (): void => {
      modelLists.forEach(list => { list.innerHTML = ''; });
      const kindOf = (model: BackendModel): 'drawing' | 'chat' | 'video' => (
        model.type === 'drawing' || model.type === 'video' ? model.type : 'chat'
      );
      const appendEmpty = (kind: 'drawing' | 'chat' | 'video'): void => {
        const empty = document.createElement('div');
        empty.className = 'model-empty';
        empty.textContent = `暂无${kind === 'drawing' ? '图像' : kind === 'video' ? '视频' : '文本'}模型`;
        modelLists.get(kind)?.appendChild(empty);
      };
      if (fluxPortMode) {
        const entries = keys
          .filter(k => k.enabled !== false)
          .flatMap(k => (k.models || [])
            .map(model => ({ key: k, model })));
        if (entries.length === 0) {
          appendEmpty('drawing');
          appendEmpty('chat');
          appendEmpty('video');
          return;
        }
        entries.forEach(({ key, model }) => modelLists.get(kindOf(model))?.appendChild(buildModelRow(model, key)));
        (['drawing', 'chat', 'video'] as const).forEach(kind => {
          if (!modelLists.get(kind)?.children.length) appendEmpty(kind);
        });
        return;
      }
      if (providerModels.length === 0) {
        appendEmpty('drawing');
        appendEmpty('chat');
        appendEmpty('video');
        return;
      }
      providerModels.forEach(model => modelLists.get(kindOf(model))?.appendChild(buildModelRow(model)));
      (['drawing', 'chat', 'video'] as const).forEach(kind => {
        if (!modelLists.get(kind)?.children.length) appendEmpty(kind);
      });
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
      const kind = m.type === 'drawing' ? 'drawing' : (m.type === 'video' ? 'video' : 'chat');
      const kindLabel = kind === 'drawing' ? '图像' : (kind === 'video' ? '视频' : '对话');
      const channelKey = key?.channels?.[kind]?.api_key;
      const keySource = m.api_key
        ? `${kindLabel}专用 Key`
        : (globalKeys[kind] ? `${kindLabel}全局 Key` : (channelKey ? `${kindLabel}账户 Key` : `未配置${kindLabel} Key`));
      // 密钥组名称是账户备注，不是模型类型或协议；不再把诸如“gpt-对话”拼到图像模型 ID 后。
      idEl.textContent = `${m.id} · ${keySource}`;
      idEl.title = key ? `配置账户：${key.name || '未命名'}；实际使用：${keySource}` : `实际使用：${keySource}`;

      const modelKeyInput = document.createElement('input');
      modelKeyInput.className = 'settings-input model-key-input';
      modelKeyInput.type = 'password';
      modelKeyInput.value = m.api_key || '';
      modelKeyInput.placeholder = `${kindLabel}专用 Key（可选）`;
      modelKeyInput.title = `仅供该${kindLabel}模型使用，优先于${kindLabel}全局 Key`;
      modelKeyInput.spellcheck = false;
      modelKeyInput.addEventListener('change', () => {
        const update = (models: BackendModel[]) => models.map(item => (
          item.id === m.id && item.type === m.type ? { ...item, api_key: modelKeyInput.value } : item
        ));
        void (async () => {
          const ok = key ? await updateKeyModels(key.id, update) : await updateProviderModels(update(providerModels));
          showToast(ok ? '已保存' : '保存失败', ok);
        })();
      });

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
      row.appendChild(modelKeyInput);
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
      renderModelRows();
      return allOk;
    };

    const fetchModels = async (): Promise<void> => {
      const sources = [
        { url: textApiUrlInput.value.trim() || urlInput.value.trim(), apiKey: globalKeys.chat },
        { url: urlInput.value.trim(), apiKey: globalKeys.drawing },
        { url: urlInput.value.trim(), apiKey: globalKeys.video },
      ];
      const legacyKey = keys.find(k => k.enabled !== false && Boolean(k.api_key))?.api_key || '';
      const source = sources.find(item => Boolean(item.url && item.apiKey)) ||
        (urlInput.value.trim() && legacyKey ? { url: urlInput.value.trim(), apiKey: legacyKey } : undefined);
      if (!source) { showToast('请先填写 API 地址和任一类型的全局 Key', false); return; }
      try {
        const res = await Backend.fetchModels(source.url, source.apiKey);
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
        const target = keys.find(k => k.enabled !== false);
        if (!target) { showToast('模型配置不可用，请重新打开设置', false); return; }
        if ((target.models || []).some(m => m.id === mid)) { showToast('该模型已存在于所选密钥组', false); return; }
        try {
          const res = await Backend.updateKey(providerId, target.id, { models: [...(target.models || []), newModel] });
          if (res.status === 'success' && res.keys) {
            syncKeys(res.keys);
            providerModels = aggregateModels();
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

    renderModelRows();
    return card;
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
