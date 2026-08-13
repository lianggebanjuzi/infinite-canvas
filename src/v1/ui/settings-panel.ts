// src/v1/ui/settings-panel.ts
// 设置/供应商面板（温馨园艺风，A7）
// 完整供应商管理：列表 / 添加 / 编辑（url·key·模型）/ 默认绘图模型 / 自定义下拉与确认弹窗

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
    } catch {
      this.providers = [];
      showToast('加载供应商失败', false);
    }
    this._render();
  }

  private _render(): void {
    if (!this.list) return;

    this.list.innerHTML = '';
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

  /** 顶部「默认绘图模型」自定义下拉，数据源 = 所有 enabled 供应商的 drawing 模型 */
  private _renderDefaultModelSelect(): HTMLElement {
    this.defaultSelect?.destroy();

    const drawing: SelectOption[] = [];
    this.providers.forEach(p => {
      if (!p.enabled) return;
      (p.models || []).forEach(m => {
        if (m.enabled === false || m.type !== 'drawing') return;
        drawing.push({ value: `${p.id}:${m.id}`, label: `${p.short_name || p.name} - ${m.name}` });
      });
    });

    const current = localStorage.getItem(DEFAULT_MODEL_KEY) || '';
    this.defaultSelect = createSelect({
      options: drawing,
      value: current,
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

  /** 紧凑卡片视图：名称 / 简称·类型 / 模型数量 / 启用开关 / 编辑 / 删除 */
  private _renderCard(p: BackendProvider): HTMLElement {
    const card = document.createElement('div');
    card.className = 'provider-card';

    const models = p.models || [];
    const chatCount = models.filter(m => (m.type || 'chat') === 'chat').length;
    const drawCount = models.filter(m => m.type === 'drawing').length;

    card.innerHTML = `
      <div class="provider-card-head">
        <div class="provider-card-info">
          <div class="provider-name">${escapeHtml(p.name)}</div>
          <div class="provider-type">${escapeHtml(p.short_name || '')} · ${escapeHtml(typeLabel(p.type))}</div>
        </div>
        <div class="provider-actions">
          <span class="provider-counts">对话 ${chatCount} · 绘图 ${drawCount}</span>
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

  /** 供应商编辑详情区（列表内展开） */
  private _renderEditor(p: BackendProvider): HTMLElement {
    const card = document.createElement('div');
    card.className = 'provider-card provider-editor';

    // 模型本地副本（模型改动即时保存；字段改动由「保存」统一持久化）
    let models: BackendModel[] = (p.models || []).map(m => ({ ...m }));
    let proxyOn = p.use_proxy !== false;
    let keyVisible = false;
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

    // ── 简称 ──
    const shortField = document.createElement('div');
    shortField.className = 'settings-field';
    shortField.innerHTML = '<span class="settings-label">简称</span>';
    const shortInput = document.createElement('input');
    shortInput.className = 'settings-input';
    shortInput.value = p.short_name || '';
    shortInput.spellcheck = false;
    shortField.appendChild(shortInput);
    card.appendChild(shortField);

    // ── API 地址 ──
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

    // ── API 密钥 ──
    const keyField = document.createElement('div');
    keyField.className = 'settings-field';
    keyField.innerHTML = '<span class="settings-label">API 密钥</span>';
    const keyBody = document.createElement('div');
    keyBody.className = 'settings-field-body inline';
    const keyInput = document.createElement('input');
    keyInput.className = 'settings-input';
    keyInput.type = 'password';
    keyInput.value = p.api_key || '';
    keyInput.placeholder = 'sk-...';
    keyInput.spellcheck = false;
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

    // ── 使用代理 ──
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

    // ── 模型管理 ──
    const modelSection = document.createElement('div');
    modelSection.className = 'model-section';
    const modelHead = document.createElement('div');
    modelHead.className = 'model-section-head';
    const modelLabel = document.createElement('span');
    modelLabel.className = 'settings-label';
    modelLabel.textContent = '模型管理';
    const fetchBtn = document.createElement('button');
    fetchBtn.className = 'mini-btn';
    fetchBtn.textContent = '拉取模型';
    fetchBtn.addEventListener('click', () => void fetchModels());
    modelHead.appendChild(modelLabel);
    modelHead.appendChild(fetchBtn);
    modelSection.appendChild(modelHead);

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

    // ── 底部操作 ──
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

    const renderModelRows = (): void => {
      modelList.innerHTML = '';
      if (models.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'model-empty';
        empty.textContent = '暂无模型，可「拉取模型」或「手动添加」';
        modelList.appendChild(empty);
        return;
      }
      models.forEach(m => modelList.appendChild(buildModelRow(m)));
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

    const syncProviderModels = (next: BackendModel[]): void => {
      const provider = this.providers.find(x => x.id === providerId);
      if (provider) provider.models = next;
      this._refreshDefaultModelSelect();
    };

    const persistModels = async (next: BackendModel[]): Promise<void> => {
      try {
        const res = await Backend.updateProvider(providerId, { models: next });
        if (res.status === 'success') {
          models = next;
          syncProviderModels(next);
          renderModelRows();
          showToast('已保存');
        } else {
          showToast('保存失败', false);
        }
      } catch (e) {
        showToast('保存失败：' + (e as Error).message, false);
      }
    };

    const saveFields = async (): Promise<void> => {
      try {
        const res = await Backend.updateProvider(providerId, {
          short_name: shortInput.value.trim(),
          api_url: urlInput.value.trim(),
          api_key: keyInput.value,
          use_proxy: proxyOn,
        });
        if (res.status === 'success') showToast('已保存');
        else showToast('保存失败', false);
      } catch (e) {
        showToast('保存失败：' + (e as Error).message, false);
      }
    };

    const testConnection = async (): Promise<void> => {
      const url = urlInput.value.trim();
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

    const fetchModels = async (): Promise<void> => {
      const url = urlInput.value.trim();
      const key = keyInput.value;
      if (!url || !key) { showToast('请先填写 API 地址与密钥', false); return; }
      try {
        // 先保存当前 url/key（复用 fetchDrawingModels 的姿势）
        await Backend.updateProvider(providerId, {
          short_name: shortInput.value.trim(),
          api_url: url,
          api_key: key,
          use_proxy: proxyOn,
        });
        const res = await Backend.fetchModels(url, key);
        if (res.status !== 'success' || !res.models) {
          showToast(res.message || '拉取模型失败', false);
          return;
        }
        // 合并逻辑：保留手动添加的 chat 模型，用拉取的 drawing 模型替换旧的 drawing
        const existingMap: Record<string, BackendModel> = {};
        models.forEach(m => { existingMap[m.id] = m; });
        const chatModels = models.filter(m => m.type === 'chat');
        const mergedDrawing: BackendModel[] = (res.models || []).map(m => ({
          id: m.id,
          name: m.name || m.id,
          type: 'drawing',
          enabled: existingMap[m.id]?.enabled ?? true,
        }));
        const merged: BackendModel[] = [...chatModels, ...mergedDrawing];
        const upd = await Backend.updateProvider(providerId, { models: merged });
        if (upd.status === 'success') {
          models = merged;
          syncProviderModels(merged);
          renderModelRows();
          showToast(`已拉取 ${mergedDrawing.length} 个绘图模型`);
        } else {
          showToast('模型保存失败', false);
        }
      } catch (e) {
        showToast('拉取失败：' + (e as Error).message, false);
      }
    };

    const addModel = (): void => {
      const mid = midInput.value.trim();
      if (!mid) { showToast('请输入模型 ID', false); return; }
      if (models.some(m => m.id === mid)) { showToast('该模型已存在', false); return; }
      const mtype = modelTypeSelect.getValue() || 'drawing';
      const newModel: BackendModel = {
        id: mid,
        name: mnameInput.value.trim() || mid,
        type: mtype,
        enabled: true,
      };
      void persistModels([...models, newModel]);
    };

    const toggleModel = (modelId: string, enabled: boolean): void => {
      const next = models.map(m => (m.id === modelId ? { ...m, enabled } : m));
      void persistModels(next);
    };

    const deleteModel = async (modelId: string): Promise<void> => {
      const ok = await confirmDialog({
        title: '删除模型',
        message: `确定删除模型「${modelId}」？`,
        confirmText: '删除',
        cancelText: '取消',
        danger: true,
      });
      if (!ok) return;
      try {
        const res = await Backend.removeModel(providerId, modelId);
        if (res.status === 'success') {
          models = models.filter(m => m.id !== modelId);
          syncProviderModels(models);
          renderModelRows();
          showToast('已删除');
        } else {
          showToast(res.message || '删除失败', false);
        }
      } catch (e) {
        showToast('删除失败：' + (e as Error).message, false);
      }
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
