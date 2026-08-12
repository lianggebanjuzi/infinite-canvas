// src/v1/ui/settings-panel.ts
// 设置/供应商面板（温馨园艺风，A7）
// 首版保留：查看 / 启用 / 默认模型 / 添加 / 删除；改 = 启用开关 + 默认模型

import { Backend } from '../api';
import { showToast } from './toast';

const DEFAULT_MODEL_KEY = 'icv_default_model';

class SettingsPanel {
  private overlay: HTMLElement | null = null;
  private list: HTMLElement | null = null;
  private nameInput: HTMLInputElement | null = null;
  private typeSelect: HTMLSelectElement | null = null;
  private providers: BackendProvider[] = [];

  init(): void {
    this.overlay = document.getElementById('settings-overlay');
    this.list = document.getElementById('settings-provider-list');
    this.nameInput = document.getElementById('settings-add-name') as HTMLInputElement | null;
    this.typeSelect = this._ensureTypeSelect();

    document.getElementById('btn-close-settings')?.addEventListener('click', () => this.close());
    this.overlay?.addEventListener('click', (e: MouseEvent) => {
      if (e.target === this.overlay) this.close();
    });
    document.getElementById('btn-add-provider')?.addEventListener('click', () => void this._addProvider());
    this.nameInput?.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') void this._addProvider();
    });
  }

  private _ensureTypeSelect(): HTMLSelectElement | null {
    let select = document.getElementById('settings-add-type') as HTMLSelectElement | null;
    if (select) return select;
    const wrap = document.querySelector('.settings-add');
    if (!wrap) return null;
    select = document.createElement('select');
    select.id = 'settings-add-type';
    select.className = 'settings-input';
    select.style.flex = '0 0 110px';
    select.innerHTML = `<option value="openai">OpenAI 兼容</option><option value="gemini">Gemini 原生</option>`;
    wrap.insertBefore(select, wrap.firstChild);
    return select;
  }

  async open(): Promise<void> {
    if (!this.overlay) return;
    this.overlay.classList.add('show');
    await this._refresh();
  }

  close(): void {
    this.overlay?.classList.remove('show');
  }

  private async _refresh(): Promise<void> {
    if (!this.list) return;
    try {
      const res = await Backend.loadProviders();
      this.providers = res.providers || [];
    } catch {
      this.providers = [];
    }
    this._render();
  }

  private _render(): void {
    if (!this.list) return;
    if (this.providers.length === 0) {
      this.list.innerHTML = '<div class="settings-empty">还没有配置供应商。<br>添加后即可在换风格节点选择绘图模型。</div>';
      return;
    }
    const defaultModel = localStorage.getItem(DEFAULT_MODEL_KEY) || '';

    this.list.innerHTML = '';
    this.providers.forEach(p => {
      const card = document.createElement('div');
      card.className = 'provider-card';

      const drawingModels = (p.models || []).filter(m => m.type === 'drawing' || (!m.type && !this._isChatLike(m.id)));
      const head = document.createElement('div');
      head.className = 'provider-card-head';
      head.innerHTML = `
        <div>
          <div class="provider-name">${escapeHtml(p.name)}</div>
          <div class="provider-type">${escapeHtml(p.short_name || '')} · ${p.models?.length ?? 0} 个模型</div>
        </div>
        <div class="provider-actions">
          <button class="switch ${p.enabled ? 'on' : ''}" data-id="${p.id}" title="启用/停用"></button>
          <button class="mini-btn danger" data-del="${p.id}">删除</button>
        </div>`;
      card.appendChild(head);

      const meta = document.createElement('div');
      meta.className = 'provider-meta';
      meta.innerHTML = '<span class="meta-chip hl">默认模型</span>';
      const select = document.createElement('select');
      select.className = 'settings-input';
      select.style.flex = '1';
      select.style.minWidth = '180px';
      if (drawingModels.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '该供应商暂无绘图模型';
        select.appendChild(opt);
      } else {
        drawingModels.forEach(m => {
          const opt = document.createElement('option');
          opt.value = `${p.id}:${m.id}`;
          opt.textContent = `${p.short_name || p.name} - ${m.name}`;
          opt.selected = (`${p.id}:${m.id}`) === defaultModel;
          select.appendChild(opt);
        });
        if (!drawingModels.some(m => `${p.id}:${m.id}` === defaultModel)) {
          select.selectedIndex = 0;
        }
      }
      select.addEventListener('change', () => {
        if (select.value) localStorage.setItem(DEFAULT_MODEL_KEY, select.value);
        showToast('默认模型已更新');
      });
      meta.appendChild(select);
      card.appendChild(meta);

      this.list!.appendChild(card);
    });

    // 启用/停用
    this.list.querySelectorAll('.switch').forEach(sw => {
      sw.addEventListener('click', () => {
        const id = (sw as HTMLElement).dataset.id || '';
        const provider = this.providers.find(x => x.id === id);
        if (!provider) return;
        void this._toggleProvider(id, !provider.enabled);
      });
    });

    // 删除
    this.list.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = (btn as HTMLElement).dataset.del || '';
        void this._deleteProvider(id);
      });
    });
  }

  private _isChatLike(modelId: string): boolean {
    const lower = modelId.toLowerCase();
    return /gpt-|claude-|deepseek|qwen|glm-|llama|mistral|moonshot|gemini-2/.test(lower);
  }

  private async _toggleProvider(id: string, enabled: boolean): Promise<void> {
    const res = await Backend.updateProvider(id, { enabled });
    if (res.status === 'success') {
      showToast(enabled ? '已启用' : '已停用');
      await this._refresh();
    } else {
      showToast('操作失败', false);
    }
  }

  private async _deleteProvider(id: string): Promise<void> {
    if (!confirm('确定删除该供应商？')) return;
    const res = await Backend.deleteProvider(id);
    if (res.status === 'success') {
      showToast('已删除');
      await this._refresh();
    } else {
      showToast('删除失败', false);
    }
  }

  private async _addProvider(): Promise<void> {
    const name = this.nameInput?.value.trim() || '';
    if (!name) { showToast('请输入供应商名称', false); return; }
    const type = this.typeSelect?.value || 'openai';
    const res = await Backend.addProvider(name, type);
    if (res.status === 'success' || res.id) {
      showToast('供应商已添加，可在 providers_data.json 中补充 API 地址与密钥');
      if (this.nameInput) this.nameInput.value = '';
      await this._refresh();
    } else {
      showToast('添加失败', false);
    }
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export const settingsPanel = new SettingsPanel();
