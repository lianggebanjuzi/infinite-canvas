// src/v1/ui/empty-state.ts
// 空态引导（A6）：无节点时画布中央居中引导卡 + 「创建默认模板」/「打开项目」

import { flowState } from '../state/flow-state';
import { createDefaultProject } from '../templates';
import { persistence } from '../persistence';
import { resolveDefaultModel } from '../api';

class EmptyState {
  private el: HTMLElement | null = null;

  init(): void {
    this.el = document.getElementById('empty-state');
    if (!this.el) return;

    document.getElementById('btn-create-template')?.addEventListener('click', () => {
      flowState.replaceAll(createDefaultProject());
      persistence.syncProjectNameInput();
      void this._fillModels();
    });

    document.getElementById('btn-empty-open')?.addEventListener('click', () => void persistence.open());

    flowState.subscribe(() => this._sync());
    this._sync();
  }

  private async _fillModels(): Promise<void> {
    const model = await resolveDefaultModel();
    if (!model) return;
    flowState.nodes
      .filter(n => n.type === 'style-transfer' && !(n.params.model as string | undefined))
      .forEach(n => flowState.updateNodeParams(n.id, { model }));
  }

  private _sync(): void {
    if (!this.el) return;
    this.el.classList.toggle('show', flowState.nodes.length === 0);
  }
}

export const emptyState = new EmptyState();
