// src/v1/ui/settings-panel.ts
// 设置/供应商面板（温馨园艺风，A7）
// 完整供应商管理：列表 / 添加 / 编辑（url·provider 字段 + Key 级模型组 + Key 列表）/ 自定义下拉与确认弹窗
// 模型可用性属于 Key。页面可以汇总展示，但绝不能把一把 Key 的模型复制给另一把 Key。
// URL 保持供应商级配置；图像/文本/视频可配置全局 Key，模型也可单独覆盖 Key。

import { Backend } from '../api';
import { showToast } from './toast';
import { createSelect, type SelectHandle, type SelectOption } from './select';
import { confirmDialog } from './confirm';
import {
  type ModelCapabilitySpec,
  type CustomDeclarativeAdapter,
  type ModelKind,
  type RequestAdapterKind,
  getBuiltinCapabilityPreview,
  validateCapabilitySpecLocal,
  loadCapabilitySchemas,
  saveCapabilitySchema,
  deleteCapabilitySchema,
  testCustomAdapter,
  getUserCapabilitySchemas,
} from '../nodes/model-config';

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
  { value: 'audio', label: '音频' },
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
  /** 4.3-D：用户能力 schema 列表（_refresh 时 loadCapabilitySchemas 载入） */
  private schemas: ModelCapabilitySpec[] = [];
  /** 4.3-D：schema 编辑态（null=未编辑；'new'=新建；modelId=编辑已有） */
  private schemaEditing: { mode: 'new' } | { mode: 'edit'; modelId: string } | null = null;
  /** 4.3-D：schema 编辑草稿（编辑器重渲染时保留用户输入） */
  private schemaDraft: SchemaDraft | null = null;

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
    // 4.3-D：载入用户能力 schema（能力门控实时更新）
    await loadCapabilitySchemas();
    this.schemas = getUserCapabilitySchemas();
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
    } else {
      const editing = this.editingId ? this.providers.find(p => p.id === this.editingId) : undefined;
      this.providers.forEach(p => {
        if (editing && p.id === editing.id) {
          this.list!.appendChild(this._renderEditor(p));
        } else {
          this.list!.appendChild(this._renderCard(p));
        }
      });
    }

    // 4.3-D：模型能力 schema 区块（唯一用户入口；UI 不写关键字判断副本）
    this.list.appendChild(this._renderSchemaSection());
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
    const audioCount = uniqueModels.filter(m => m.type === 'audio').length;

    card.innerHTML = `
      <div class="provider-card-head">
        <div class="provider-card-info">
          <div class="provider-name">${escapeHtml(p.name)}</div>
          <div class="provider-type">${escapeHtml(p.short_name || '')} · ${escapeHtml(typeLabel(p.type))}</div>
        </div>
        <div class="provider-actions">
          <span class="provider-counts">文本 ${chatCount} · 图像 ${drawCount} · 视频 ${videoCount} · 音频 ${audioCount}${keys.length ? ` · ${keys.length} Key` : ''}</span>
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
    const globalKeys: Record<'chat' | 'drawing' | 'video' | 'audio', string> = {
      chat: p.global_keys?.chat || '',
      drawing: p.global_keys?.drawing || '',
      video: p.global_keys?.video || '',
      audio: p.global_keys?.audio || '',
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
    const globalLabels: Array<{ kind: 'chat' | 'drawing' | 'video' | 'audio'; label: string }> = [
      { kind: 'drawing', label: '图像全局 Key' },
      { kind: 'chat', label: '对话全局 Key' },
      { kind: 'video', label: '视频全局 Key' },
      { kind: 'audio', label: '音频全局 Key' },
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

    // 图像 / 文本 / 视频 / 音频模型各自独立成栏，便于快速浏览和管理大量模型。
    const modelGrid = document.createElement('div');
    modelGrid.className = 'model-type-grid';
    const modelLists = new Map<'drawing' | 'chat' | 'video' | 'audio', HTMLElement>();
    ([
      { type: 'drawing' as const, label: '图像模型' },
      { type: 'chat' as const, label: '文本模型' },
      { type: 'video' as const, label: '视频模型' },
      { type: 'audio' as const, label: '音频模型' },
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
      const kindOf = (model: BackendModel): 'drawing' | 'chat' | 'video' | 'audio' => (
        model.type === 'drawing' || model.type === 'video' || model.type === 'audio' ? model.type : 'chat'
      );
      const kindLabel = (kind: 'drawing' | 'chat' | 'video' | 'audio'): string => (
        kind === 'drawing' ? '图像' : kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '文本'
      );
      const appendEmpty = (kind: 'drawing' | 'chat' | 'video' | 'audio'): void => {
        const empty = document.createElement('div');
        empty.className = 'model-empty';
        empty.textContent = `暂无${kindLabel(kind)}模型`;
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
          appendEmpty('audio');
          return;
        }
        entries.forEach(({ key, model }) => modelLists.get(kindOf(model))?.appendChild(buildModelRow(model, key)));
        (['drawing', 'chat', 'video', 'audio'] as const).forEach(kind => {
          if (!modelLists.get(kind)?.children.length) appendEmpty(kind);
        });
        return;
      }
      if (providerModels.length === 0) {
        appendEmpty('drawing');
        appendEmpty('chat');
        appendEmpty('video');
        appendEmpty('audio');
        return;
      }
      providerModels.forEach(model => modelLists.get(kindOf(model))?.appendChild(buildModelRow(model)));
      (['drawing', 'chat', 'video', 'audio'] as const).forEach(kind => {
        if (!modelLists.get(kind)?.children.length) appendEmpty(kind);
      });
    };

    const buildModelRow = (m: BackendModel, key?: BackendProviderKey): HTMLElement => {
      const row = document.createElement('div');
      row.className = 'model-row';

      const badge = document.createElement('span');
      const typeLabel = m.type === 'drawing' ? '图像' : (m.type === 'video' ? '视频' : (m.type === 'audio' ? '音频' : '文本'));
      badge.className = 'model-type-badge ' + (m.type === 'drawing' ? 'drawing' : 'chat');
      badge.textContent = typeLabel;

      const nameEl = document.createElement('span');
      nameEl.className = 'model-name';
      nameEl.textContent = m.name || m.id;
      nameEl.title = m.id;

      const idEl = document.createElement('span');
      idEl.className = 'model-id';
      const kind = m.type === 'drawing' ? 'drawing' : (m.type === 'video' ? 'video' : (m.type === 'audio' ? 'audio' : 'chat'));
      const kindLabel = kind === 'drawing' ? '图像' : (kind === 'video' ? '视频' : (kind === 'audio' ? '音频' : '对话'));
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
        { url: urlInput.value.trim(), apiKey: globalKeys.audio },
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
          type: m.type === 'video' ? 'video' : (m.type === 'chat' ? 'chat' : (m.type === 'audio' ? 'audio' : 'drawing')),
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

  // ─────────────────────────────────────────
  // 4.3-D 模型能力 schema 区块
  // 唯一用户入口：UI 不写关键字判断副本；保存后 loadCapabilitySchemas 刷新能力门控。
  // ─────────────────────────────────────────

  private _renderSchemaSection(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'schema-section';

    const head = document.createElement('div');
    head.className = 'schema-section-head';
    const title = document.createElement('span');
    title.className = 'settings-label';
    title.textContent = '模型能力 Schema（高级）';
    head.appendChild(title);
    const hint = document.createElement('span');
    hint.className = 'settings-hint';
    hint.textContent = '为自定义/未知模型声明能力；内置规则保留，用户 schema 优先，能力门控实时更新。';
    head.appendChild(hint);
    const addBtn = document.createElement('button');
    addBtn.className = 'mini-btn';
    addBtn.textContent = '新建 schema';
    addBtn.addEventListener('click', () => {
      this.schemaEditing = { mode: 'new' };
      this.schemaDraft = schemaDraftFromSpec(null);
      this._render();
    });
    head.appendChild(addBtn);
    wrap.appendChild(head);

    if (this.schemaEditing) {
      const editing = this.schemaEditing;
      const editingSpec = editing.mode === 'edit'
        ? this.schemas.find(s => s.modelId === editing.modelId) ?? null
        : null;
      if (!this.schemaDraft) this.schemaDraft = schemaDraftFromSpec(editingSpec);
      wrap.appendChild(this._renderSchemaEditor());
      return wrap;
    }

    if (this.schemas.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'schema-empty';
      empty.textContent = '暂无用户 schema。内置规则覆盖已知模型；为未知模型保存 schema 后即可在对应节点显示正确参数。';
      wrap.appendChild(empty);
      return wrap;
    }

    this.schemas.forEach(spec => wrap.appendChild(this._renderSchemaRow(spec)));
    return wrap;
  }

  private _renderSchemaRow(spec: ModelCapabilitySpec): HTMLElement {
    const row = document.createElement('div');
    row.className = 'schema-row';

    const head = document.createElement('div');
    head.className = 'schema-row-head';

    const idEl = document.createElement('span');
    idEl.className = 'schema-model-id';
    idEl.textContent = spec.modelId;
    idEl.title = spec.modelId;
    head.appendChild(idEl);

    const kindsEl = document.createElement('span');
    kindsEl.className = 'schema-kinds';
    spec.kinds.forEach(kind => {
      const badge = document.createElement('span');
      badge.className = 'model-type-badge';
      badge.textContent = KIND_LABELS[kind] || kind;
      kindsEl.appendChild(badge);
    });
    head.appendChild(kindsEl);

    const adapterEl = document.createElement('span');
    adapterEl.className = 'schema-adapter';
    adapterEl.textContent = adapterLabel(spec.requestAdapter);
    head.appendChild(adapterEl);

    const actions = document.createElement('span');
    actions.className = 'schema-row-actions';

    const previewBtn = document.createElement('button');
    previewBtn.className = 'mini-btn';
    previewBtn.textContent = '预览请求';
    previewBtn.title = '预览请求结构（custom-declarative）';
    previewBtn.addEventListener('click', () => void this._previewSchema(spec));
    actions.appendChild(previewBtn);

    const testBtn = document.createElement('button');
    testBtn.className = 'mini-btn';
    testBtn.textContent = '测试连接';
    testBtn.title = '仅发送测试连接/模型列表请求，无媒体费用';
    testBtn.addEventListener('click', () => void this._testSchemaConnection(spec));
    actions.appendChild(testBtn);

    const genBtn = document.createElement('button');
    genBtn.className = 'mini-btn';
    genBtn.textContent = '生成测试';
    genBtn.title = spec.requestAdapter === 'custom-declarative'
      ? '自定义声明式适配器尚未接入实际生成'
      : '仅 custom-declarative adapter 支持生成测试';
    genBtn.disabled = true;
    actions.appendChild(genBtn);

    const editBtn = document.createElement('button');
    editBtn.className = 'mini-btn';
    editBtn.textContent = '编辑';
    editBtn.addEventListener('click', () => {
      this.schemaEditing = { mode: 'edit', modelId: spec.modelId };
      this.schemaDraft = schemaDraftFromSpec(spec);
      this._render();
    });
    actions.appendChild(editBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'mini-btn danger';
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', () => void this._deleteSchema(spec));
    actions.appendChild(delBtn);

    head.appendChild(actions);
    row.appendChild(head);

    const builtin = getBuiltinCapabilityPreview(spec.modelId);
    const fallback = document.createElement('div');
    fallback.className = 'schema-fallback';
    if (builtin) {
      fallback.textContent = `内置规则：${builtin.kinds.map(k => KIND_LABELS[k] || k).join(' / ')}；用户 schema 优先。`;
    } else {
      fallback.textContent = spec.requestAdapter === 'custom-declarative'
        ? '该声明式 Adapter 目前仅支持预览和连接测试，不能用于节点生成。'
        : '该模型无内置规则；保存 schema 后节点可用。';
    }
    row.appendChild(fallback);

    return row;
  }

  private _renderSchemaEditor(): HTMLElement {
    const card = document.createElement('div');
    card.className = 'provider-card schema-editor';
    const draft = this.schemaDraft ?? emptySchemaDraft();

    const head = document.createElement('div');
    head.className = 'provider-editor-head';
    const titleEl = document.createElement('div');
    titleEl.className = 'provider-editor-title';
    titleEl.textContent = this.schemaEditing?.mode === 'edit' ? `编辑 schema · ${draft.modelId || '未知模型'}` : '新建模型能力 schema';
    head.appendChild(titleEl);
    const backBtn = document.createElement('button');
    backBtn.className = 'mini-btn';
    backBtn.textContent = '返回列表';
    backBtn.addEventListener('click', () => {
      this.schemaEditing = null;
      this.schemaDraft = null;
      this._render();
    });
    head.appendChild(backBtn);
    card.appendChild(head);

    const form = document.createElement('div');
    form.className = 'schema-form';

    // ── 区块显隐 + 校验刷新 + 保存（先声明，供下方表单字段闭包引用） ──
    const refreshSections = (): void => {
      const hasDrawing = draft.kinds.includes('drawing');
      const hasVideo = draft.kinds.includes('video');
      const hasAudio = draft.kinds.includes('audio');
      const isCustom = draft.requestAdapter === 'custom-declarative';
      imageSection.style.display = hasDrawing ? '' : 'none';
      videoSection.style.display = hasVideo ? '' : 'none';
      audioSection.style.display = hasAudio ? '' : 'none';
      adapterSection.style.display = isCustom ? '' : 'none';
    };

    const refreshValidation = (): void => {
      const spec = schemaDraftToSpec(draft);
      const errors = validateCapabilitySpecLocal(spec);
      errorsEl.innerHTML = '';
      errors.forEach(err => {
        const div = document.createElement('div');
        div.className = 'schema-error';
        div.textContent = err;
        errorsEl.appendChild(div);
      });
      const modelId = draft.modelId.trim();
      saveBtn.disabled = errors.length > 0 || !modelId;
      errorsEl.style.display = errors.length ? '' : 'none';
    };

    const saveSchema = async (): Promise<void> => {
      const spec = schemaDraftToSpec(draft);
      const errors = validateCapabilitySpecLocal(spec);
      if (errors.length > 0) {
        showToast('schema 校验失败，无法保存', false);
        refreshValidation();
        return;
      }
      try {
        const res = await saveCapabilitySchema(spec);
        if (res.status === 'success') {
          this.schemas = getUserCapabilitySchemas();
          this.schemaEditing = null;
          this.schemaDraft = null;
          this._render();
          showToast('已保存');
        } else {
          showToast(res.message || '保存失败', false);
          refreshValidation();
        }
      } catch (e) {
        showToast('保存失败：' + (e as Error).message, false);
      }
    };

    // ── 模型 ID ──
    const idField = this._schemaField('模型 ID');
    const idInput = document.createElement('input');
    idInput.className = 'settings-input';
    idInput.value = draft.modelId;
    idInput.placeholder = '如 custom-video-pro / my-music-1';
    idInput.spellcheck = false;
    if (this.schemaEditing?.mode === 'edit') idInput.readOnly = true;
    idInput.addEventListener('input', () => {
      draft.modelId = idInput.value;
      refreshValidation();
    });
    idField.body.appendChild(idInput);
    form.appendChild(idField.wrap);

    // ── 能力类型（kinds） ──
    const kindsField = this._schemaField('能力类型');
    const kindsRow = document.createElement('div');
    kindsRow.className = 'schema-check-row';
    (['chat', 'drawing', 'video', 'audio'] as ModelKind[]).forEach(kind => {
      const label = document.createElement('label');
      label.className = 'schema-check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = draft.kinds.includes(kind);
      cb.addEventListener('change', () => {
        if (cb.checked) {
          if (!draft.kinds.includes(kind)) draft.kinds.push(kind);
        } else {
          draft.kinds = draft.kinds.filter(k => k !== kind);
        }
        refreshSections();
        refreshValidation();
      });
      const span = document.createElement('span');
      span.textContent = KIND_LABELS[kind] || kind;
      label.appendChild(cb);
      label.appendChild(span);
      kindsRow.appendChild(label);
    });
    kindsField.body.appendChild(kindsRow);
    form.appendChild(kindsField.wrap);

    // ── 请求适配器 ──
    const adapterField = this._schemaField('请求适配器');
    const adapterSelect = document.createElement('select');
    adapterSelect.className = 'settings-input';
    ADAPTER_OPTIONS.forEach(opt => {
      const option = document.createElement('option');
      option.value = opt.value;
      option.textContent = opt.label;
      adapterSelect.appendChild(option);
    });
    adapterSelect.value = draft.requestAdapter;
    adapterSelect.addEventListener('change', () => {
      draft.requestAdapter = adapterSelect.value as RequestAdapterKind;
      refreshSections();
      refreshValidation();
    });
    adapterField.body.appendChild(adapterSelect);
    form.appendChild(adapterField.wrap);

    // ── image 区块（drawing） ──
    const imageSection = this._renderSchemaImageSection(draft, refreshValidation);
    const videoSection = this._renderSchemaVideoSection(draft, refreshValidation);
    const audioSection = this._renderSchemaAudioSection(draft, refreshValidation);
    const adapterSection = this._renderSchemaAdapterSection(draft, refreshValidation);
    form.appendChild(imageSection);
    form.appendChild(videoSection);
    form.appendChild(audioSection);
    form.appendChild(adapterSection);

    // ── 回退内置规则 ──
    const fallbackRow = document.createElement('div');
    fallbackRow.className = 'schema-fallback-row';
    const fallbackBtn = document.createElement('button');
    fallbackBtn.className = 'mini-btn';
    fallbackBtn.textContent = '回退内置规则';
    fallbackBtn.title = '若该模型存在内置规则，用内置能力填充本表单';
    fallbackBtn.addEventListener('click', () => {
      const builtin = getBuiltinCapabilityPreview(draft.modelId);
      if (!builtin) {
        showToast('该模型没有内置规则；请手动填写能力', false);
        return;
      }
      this.schemaDraft = schemaDraftFromSpec(builtin);
      this._render();
      showToast('已用内置规则填充，可在此基础上修改');
    });
    const fallbackHint = document.createElement('span');
    fallbackHint.className = 'settings-hint';
    fallbackHint.textContent = '内置规则仅覆盖已知模型；填充后可修改后另存为用户 schema。';
    fallbackRow.appendChild(fallbackBtn);
    fallbackRow.appendChild(fallbackHint);
    form.appendChild(fallbackRow);

    // ── 校验错误列表 ──
    const errorsEl = document.createElement('div');
    errorsEl.className = 'schema-errors';
    form.appendChild(errorsEl);

    // ── 操作 ──
    const actions = document.createElement('div');
    actions.className = 'provider-editor-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-ghost';
    cancelBtn.textContent = '关闭';
    cancelBtn.addEventListener('click', () => {
      this.schemaEditing = null;
      this.schemaDraft = null;
      this._render();
    });
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn-secondary';
    saveBtn.textContent = '保存';
    saveBtn.addEventListener('click', () => void saveSchema());
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    form.appendChild(actions);
    card.appendChild(form);

    refreshSections();
    refreshValidation();
    return card;
  }

  private _schemaField(label: string): { wrap: HTMLElement; body: HTMLElement } {
    const wrap = document.createElement('div');
    wrap.className = 'settings-field schema-field';
    const labelEl = document.createElement('span');
    labelEl.className = 'settings-label';
    labelEl.textContent = label;
    const body = document.createElement('div');
    body.className = 'settings-field-body';
    wrap.appendChild(labelEl);
    wrap.appendChild(body);
    return { wrap, body };
  }

  private _schemaTextRow(body: HTMLElement, placeholder: string, value: string, onInput: (v: string) => void): HTMLInputElement {
    const input = document.createElement('input');
    input.className = 'settings-input';
    input.value = value;
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.addEventListener('input', () => onInput(input.value));
    body.appendChild(input);
    return input;
  }

  private _schemaCheck(body: HTMLElement, label: string, checked: boolean, onChange: (v: boolean) => void): void {
    const labelEl = document.createElement('label');
    labelEl.className = 'schema-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    cb.addEventListener('change', () => onChange(cb.checked));
    const span = document.createElement('span');
    span.textContent = label;
    labelEl.appendChild(cb);
    labelEl.appendChild(span);
    body.appendChild(labelEl);
  }

  private _renderSchemaImageSection(draft: SchemaDraft, refreshValidation: () => void): HTMLElement {
    const section = document.createElement('section');
    section.className = 'schema-section-block';
    const title = document.createElement('div');
    title.className = 'schema-block-title';
    title.textContent = '图像能力';
    section.appendChild(title);

    const refField = this._schemaField('参考图数');
    this._schemaTextRow(refField.body, '如 1（0 = 不支持参考图）', draft.referenceImages, v => {
      draft.referenceImages = v;
      refreshValidation();
    });
    section.appendChild(refField.wrap);

    const checkField = this._schemaField('编辑动作');
    const checkBody = document.createElement('div');
    checkBody.className = 'schema-check-row';
    this._schemaCheck(checkBody, '蒙版局改 maskEdit', draft.maskEdit, v => {
      draft.maskEdit = v;
      refreshValidation();
    });
    this._schemaCheck(checkBody, '多角度 angle', draft.angle, v => {
      draft.angle = v;
      refreshValidation();
    });
    checkField.body.appendChild(checkBody);
    section.appendChild(checkField.wrap);

    const ratioField = this._schemaField('比例');
    this._schemaTextRow(ratioField.body, '逗号分隔，如 1:1, 3:4, 16:9, Auto', draft.aspectRatios, v => {
      draft.aspectRatios = v;
      refreshValidation();
    });
    section.appendChild(ratioField.wrap);

    return section;
  }

  private _renderSchemaVideoSection(draft: SchemaDraft, refreshValidation: () => void): HTMLElement {
    const section = document.createElement('section');
    section.className = 'schema-section-block';
    const title = document.createElement('div');
    title.className = 'schema-block-title';
    title.textContent = '视频能力';
    section.appendChild(title);

    const checkField = this._schemaField('视频动作');
    const checkBody = document.createElement('div');
    checkBody.className = 'schema-check-row';
    this._schemaCheck(checkBody, '图片参考 imageReference', draft.imageReference, v => {
      draft.imageReference = v;
      refreshValidation();
    });
    this._schemaCheck(checkBody, '首帧/尾帧 startEndFrame', draft.startEndFrame, v => {
      draft.startEndFrame = v;
      refreshValidation();
    });
    this._schemaCheck(checkBody, '音频输入 audioInput', draft.audioInput, v => {
      draft.audioInput = v;
      refreshValidation();
    });
    checkField.body.appendChild(checkBody);
    section.appendChild(checkField.wrap);

    const secField = this._schemaField('可选时长(秒)');
    this._schemaTextRow(secField.body, '逗号分隔，如 5, 10', draft.seconds, v => {
      draft.seconds = v;
      refreshValidation();
    });
    section.appendChild(secField.wrap);

    return section;
  }

  private _renderSchemaAudioSection(draft: SchemaDraft, refreshValidation: () => void): HTMLElement {
    const section = document.createElement('section');
    section.className = 'schema-section-block';
    const title = document.createElement('div');
    title.className = 'schema-block-title';
    title.textContent = '音频能力';
    section.appendChild(title);

    const durField = this._schemaField('可选时长(秒)');
    this._schemaTextRow(durField.body, '逗号分隔，如 10, 30', draft.duration, v => {
      draft.duration = v;
      refreshValidation();
    });
    section.appendChild(durField.wrap);

    const fmtField = this._schemaField('输出格式');
    this._schemaTextRow(fmtField.body, '逗号分隔，如 mp3, wav, ogg', draft.formats, v => {
      draft.formats = v;
      refreshValidation();
    });
    section.appendChild(fmtField.wrap);

    return section;
  }

  private _renderSchemaAdapterSection(draft: SchemaDraft, refreshValidation: () => void): HTMLElement {
    const section = document.createElement('section');
    section.className = 'schema-section-block schema-adapter-block';
    const title = document.createElement('div');
    title.className = 'schema-block-title';
    title.textContent = '自定义声明式 Adapter（白名单）';
    section.appendChild(title);

    const warn = document.createElement('div');
    warn.className = 'schema-warning';
    warn.textContent = '仅允许描述 URL path / 字段映射 / 状态字段 / 结果字段白名单；禁止 eval、任意脚本、任意 Header 注入。当前版本仅支持预览和连接测试，尚未接入实际生成。';
    section.appendChild(warn);

    const urlField = this._schemaField('URL path');
    this._schemaTextRow(urlField.body, '相对 API base，如 /v1/video/generations', draft.urlPath, v => {
      draft.urlPath = v;
      refreshValidation();
    });
    section.appendChild(urlField.wrap);

    const mapField = this._schemaField('字段映射');
    const mapBody = document.createElement('div');
    mapBody.className = 'schema-map-grid';
    FIELD_MAPPING_LABELS.forEach(item => {
      const cell = document.createElement('div');
      cell.className = 'schema-map-cell';
      const keyEl = document.createElement('span');
      keyEl.className = 'schema-map-key';
      keyEl.textContent = item.label;
      const input = document.createElement('input');
      input.className = 'settings-input';
      input.value = draft.fieldMapping[item.key] || '';
      input.placeholder = '供应商字段名';
      input.spellcheck = false;
      input.addEventListener('input', () => {
        draft.fieldMapping[item.key] = input.value;
        refreshValidation();
      });
      cell.appendChild(keyEl);
      cell.appendChild(input);
      mapBody.appendChild(cell);
    });
    mapField.body.appendChild(mapBody);
    section.appendChild(mapField.wrap);

    const taskTitle = document.createElement('div');
    taskTitle.className = 'schema-block-subtitle';
    taskTitle.textContent = '异步任务协议（同步生成可留空）';
    section.appendChild(taskTitle);

    const t1 = this._schemaField('任务 id 字段');
    this._schemaTextRow(t1.body, '如 task_id / id', draft.taskIdField, v => { draft.taskIdField = v; refreshValidation(); });
    section.appendChild(t1.wrap);
    const t2 = this._schemaField('轮询 URL 字段');
    this._schemaTextRow(t2.body, '如 status_url / poll_url / result_url', draft.pollUrlField, v => { draft.pollUrlField = v; refreshValidation(); });
    section.appendChild(t2.wrap);
    const t3 = this._schemaField('状态字段');
    this._schemaTextRow(t3.body, '如 status', draft.statusField, v => { draft.statusField = v; refreshValidation(); });
    section.appendChild(t3.wrap);
    const t4 = this._schemaField('完成状态值');
    this._schemaTextRow(t4.body, '逗号分隔，如 completed, succeeded', draft.completedValues, v => { draft.completedValues = v; refreshValidation(); });
    section.appendChild(t4.wrap);
    const t5 = this._schemaField('失败状态值');
    this._schemaTextRow(t5.body, '逗号分隔，如 failed, canceled', draft.failedValues, v => { draft.failedValues = v; refreshValidation(); });
    section.appendChild(t5.wrap);
    const t6 = this._schemaField('结果 URL 字段');
    this._schemaTextRow(t6.body, '点路径白名单，如 output.video_url, video_url', draft.resultUrlFields, v => { draft.resultUrlFields = v; refreshValidation(); });
    section.appendChild(t6.wrap);
    const t7 = this._schemaField('轮询间隔(ms)');
    this._schemaTextRow(t7.body, '如 2000', draft.pollIntervalMs, v => { draft.pollIntervalMs = v; refreshValidation(); });
    section.appendChild(t7.wrap);

    const t8 = this._schemaField('同步结果 URL 字段');
    this._schemaTextRow(t8.body, '同步生成时直接返回结果 URL 的字段，逗号分隔', draft.syncResultUrlFields, v => { draft.syncResultUrlFields = v; refreshValidation(); });
    section.appendChild(t8.wrap);

    return section;
  }

  private async _previewSchema(spec: ModelCapabilitySpec): Promise<void> {
    try {
      const res = await testCustomAdapter(spec.modelId, { mode: 'preview' });
      if (res.status !== 'success' || !res.preview) {
        showToast((res.message as string) || '预览失败', false);
        return;
      }
      this._showSchemaPreviewModal(res.preview as Record<string, unknown>);
    } catch (e) {
      showToast('预览失败：' + (e as Error).message, false);
    }
  }

  private _showSchemaPreviewModal(preview: Record<string, unknown>): void {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog schema-preview-dialog';
    const titleEl = document.createElement('div');
    titleEl.className = 'confirm-title';
    titleEl.textContent = '请求结构预览（custom-declarative）';
    const pre = document.createElement('pre');
    pre.className = 'schema-preview-json';
    pre.textContent = JSON.stringify(preview, null, 2);
    const actions = document.createElement('div');
    actions.className = 'confirm-actions';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'confirm-btn primary';
    closeBtn.textContent = '关闭';
    actions.appendChild(closeBtn);
    dialog.appendChild(titleEl);
    dialog.appendChild(pre);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    const finish = (): void => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(); }
    };
    closeBtn.addEventListener('click', finish);
    overlay.addEventListener('click', (e: MouseEvent) => { if (e.target === overlay) finish(); });
    document.addEventListener('keydown', onKey);
    closeBtn.focus();
  }

  private async _testSchemaConnection(spec: ModelCapabilitySpec): Promise<void> {
    try {
      const res = await testCustomAdapter(spec.modelId, { mode: 'connection' });
      showToast((res.message as string) || (res.status === 'success' ? '连接成功' : '连接失败'), res.status === 'success');
    } catch (e) {
      showToast('连接测试失败：' + (e as Error).message, false);
    }
  }

  private async _testSchemaGenerate(spec: ModelCapabilitySpec): Promise<void> {
    const ok = await confirmDialog({
      title: '生成测试（可能产生媒体费用）',
      message: '「生成测试」将向自定义 adapter 发起真实媒体生成并可能产生费用。是否确认继续？\n\n确认后仅校验 schema 可运行性并返回请求结构预览，不会自动触发真实生成。',
      confirmText: '确认并测试',
      cancelText: '取消',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await testCustomAdapter(spec.modelId, { mode: 'generate', confirm_cost: true });
      if (res.status === 'success' && res.preview) {
        this._showSchemaPreviewModal(res.preview as Record<string, unknown>);
        showToast((res.message as string) || '已确认费用', true);
      } else {
        showToast((res.message as string) || '测试失败', false);
      }
    } catch (e) {
      showToast('生成测试失败：' + (e as Error).message, false);
    }
  }

  private async _deleteSchema(spec: ModelCapabilitySpec): Promise<void> {
    const ok = await confirmDialog({
      title: '删除用户 schema',
      message: `确定删除模型「${spec.modelId}」的用户能力 schema？删除后回退内置规则（若无内置规则则该模型不可运行）。`,
      confirmText: '删除',
      cancelText: '取消',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await deleteCapabilitySchema(spec.modelId);
      if (res.status === 'success') {
        this.schemas = getUserCapabilitySchemas();
        this._render();
        showToast('已删除');
      } else {
        showToast(res.message || '删除失败', false);
      }
    } catch (e) {
      showToast('删除失败：' + (e as Error).message, false);
    }
  }
}

function typeLabel(type: string): string {
  return type === 'gemini' ? 'Gemini 原生' : 'OpenAI 兼容';
}

// ─────────────────────────────────────────
// 4.3-D schema 编辑辅助（模块级纯函数）
// ─────────────────────────────────────────

const KIND_LABELS: Record<ModelKind, string> = {
  chat: '文本',
  drawing: '图像',
  video: '视频',
  audio: '音频',
};

const ADAPTER_OPTIONS: Array<{ value: RequestAdapterKind; label: string }> = [
  { value: 'openai-image', label: 'OpenAI 图像' },
  { value: 'gemini-native', label: 'Gemini 原生' },
  { value: 'fluxport-video', label: 'FluxPort 视频（异步任务）' },
  { value: 'custom-declarative', label: '自定义声明式（仅预览，暂不可执行）' },
];

const FIELD_MAPPING_LABELS: Array<{ key: string; label: string }> = [
  { key: 'prompt', label: 'prompt' },
  { key: 'model', label: 'model' },
  { key: 'seconds', label: 'seconds' },
  { key: 'format', label: 'format' },
  { key: 'aspectRatio', label: 'aspectRatio' },
  { key: 'resolution', label: 'resolution' },
  { key: 'referenceImages', label: 'referenceImages' },
  { key: 'startFrame', label: 'startFrame' },
  { key: 'endFrame', label: 'endFrame' },
  { key: 'audio', label: 'audio' },
];

/** schema 编辑草稿（表单字符串态；保存时经 schemaDraftToSpec 转为 ModelCapabilitySpec） */
interface SchemaDraft {
  modelId: string;
  kinds: ModelKind[];
  requestAdapter: RequestAdapterKind;
  referenceImages: string;
  maskEdit: boolean;
  angle: boolean;
  aspectRatios: string;
  imageReference: boolean;
  startEndFrame: boolean;
  audioInput: boolean;
  seconds: string;
  duration: string;
  formats: string;
  urlPath: string;
  fieldMapping: Record<string, string>;
  taskIdField: string;
  pollUrlField: string;
  statusField: string;
  completedValues: string;
  failedValues: string;
  resultUrlFields: string;
  pollIntervalMs: string;
  syncResultUrlFields: string;
}

function emptySchemaDraft(): SchemaDraft {
  return {
    modelId: '', kinds: [], requestAdapter: 'openai-image',
    referenceImages: '', maskEdit: false, angle: false, aspectRatios: '',
    imageReference: false, startEndFrame: false, audioInput: false, seconds: '',
    duration: '', formats: '',
    urlPath: '', fieldMapping: {},
    taskIdField: '', pollUrlField: '', statusField: 'status',
    completedValues: 'completed', failedValues: 'failed', resultUrlFields: '',
    pollIntervalMs: '2000', syncResultUrlFields: '',
  };
}

function schemaDraftFromSpec(spec: ModelCapabilitySpec | null): SchemaDraft {
  const d = emptySchemaDraft();
  if (!spec) return d;
  d.modelId = spec.modelId || '';
  d.kinds = [...spec.kinds];
  d.requestAdapter = spec.requestAdapter;
  d.referenceImages = spec.image?.referenceImages !== undefined ? String(spec.image.referenceImages) : '';
  d.maskEdit = spec.image?.maskEdit === true;
  d.angle = spec.image?.angle === true;
  d.aspectRatios = (spec.image?.aspectRatios || []).join(', ');
  d.imageReference = spec.video?.imageReference === true;
  d.startEndFrame = spec.video?.startEndFrame === true;
  d.audioInput = spec.video?.audioInput === true;
  d.seconds = (spec.video?.seconds || []).join(', ');
  d.duration = (spec.audio?.duration || []).join(', ');
  d.formats = (spec.audio?.formats || []).join(', ');
  const a = spec.adapter;
  if (a) {
    d.urlPath = a.urlPath || '';
    d.fieldMapping = { ...(a.fieldMapping || {}) };
    d.taskIdField = a.task?.taskIdField || '';
    d.pollUrlField = a.task?.pollUrlField || '';
    d.statusField = a.task?.statusField || 'status';
    d.completedValues = (a.task?.completedValues || []).join(', ');
    d.failedValues = (a.task?.failedValues || []).join(', ');
    d.resultUrlFields = (a.task?.resultUrlFields || []).join(', ');
    d.pollIntervalMs = a.task?.pollIntervalMs !== undefined ? String(a.task.pollIntervalMs) : '2000';
    d.syncResultUrlFields = (a.syncResultUrlFields || []).join(', ');
  }
  return d;
}

function splitCommaList(text: string): string[] {
  return text.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
}

function schemaDraftToSpec(d: SchemaDraft): ModelCapabilitySpec {
  const kinds = [...new Set(d.kinds)];
  const spec: ModelCapabilitySpec = {
    modelId: d.modelId.trim(),
    kinds,
    requestAdapter: d.requestAdapter,
  };
  if (kinds.includes('drawing')) {
    const img: ModelCapabilitySpec['image'] = {};
    const ref = parseInt(d.referenceImages, 10);
    if (Number.isFinite(ref) && ref >= 0) img.referenceImages = ref;
    img.maskEdit = d.maskEdit;
    img.angle = d.angle;
    const ratios = splitCommaList(d.aspectRatios);
    if (ratios.length) img.aspectRatios = ratios;
    spec.image = img;
  }
  if (kinds.includes('video')) {
    const v: ModelCapabilitySpec['video'] = {};
    v.imageReference = d.imageReference;
    v.startEndFrame = d.startEndFrame;
    v.audioInput = d.audioInput;
    const seconds = splitCommaList(d.seconds).map(Number).filter(n => Number.isFinite(n));
    if (seconds.length) v.seconds = seconds;
    spec.video = v;
  }
  if (kinds.includes('audio')) {
    const a: ModelCapabilitySpec['audio'] = {};
    const duration = splitCommaList(d.duration).map(Number).filter(n => Number.isFinite(n));
    if (duration.length) a.duration = duration;
    const formats = splitCommaList(d.formats);
    if (formats.length) a.formats = formats;
    spec.audio = a;
  }
  if (d.requestAdapter === 'custom-declarative') {
    spec.adapter = adapterFromDraft(d);
  }
  return spec;
}

function adapterFromDraft(d: SchemaDraft): CustomDeclarativeAdapter {
  const fieldMapping: CustomDeclarativeAdapter['fieldMapping'] = {};
  for (const key of Object.keys(d.fieldMapping)) {
    const value = d.fieldMapping[key];
    if (value && value.trim()) {
      fieldMapping[key as keyof CustomDeclarativeAdapter['fieldMapping']] = value.trim();
    }
  }
  const task: CustomDeclarativeAdapter['task'] = {};
  if (d.taskIdField.trim()) task.taskIdField = d.taskIdField.trim();
  if (d.pollUrlField.trim()) task.pollUrlField = d.pollUrlField.trim();
  if (d.statusField.trim()) task.statusField = d.statusField.trim();
  const completed = splitCommaList(d.completedValues);
  if (completed.length) task.completedValues = completed;
  const failed = splitCommaList(d.failedValues);
  if (failed.length) task.failedValues = failed;
  const resultUrls = splitCommaList(d.resultUrlFields);
  if (resultUrls.length) task.resultUrlFields = resultUrls;
  const interval = parseInt(d.pollIntervalMs, 10);
  if (Number.isFinite(interval) && interval >= 100) task.pollIntervalMs = interval;
  const syncFields = splitCommaList(d.syncResultUrlFields);
  const adapter: CustomDeclarativeAdapter = { urlPath: d.urlPath.trim(), fieldMapping };
  if (Object.keys(task).length) adapter.task = task;
  if (syncFields.length) adapter.syncResultUrlFields = syncFields;
  return adapter;
}

function adapterLabel(adapter: RequestAdapterKind): string {
  return ADAPTER_OPTIONS.find(opt => opt.value === adapter)?.label || adapter;
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
