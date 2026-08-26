// 全局工作流库：工作流是可复用的画布骨架，不是带成图和历史的项目副本。

import { Backend } from '../api';
import { persistence } from '../persistence';
import { closeGuard } from '../close-guard';
import { confirmDialog } from './confirm';
import { showToast } from './toast';

function workflowId(): string {
  return `workflow_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function isWorkflow(value: unknown): value is WorkflowTemplate {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<WorkflowTemplate>;
  return item.version === 1
    && typeof item.id === 'string'
    && typeof item.title === 'string'
    && Array.isArray(item.nodes)
    && Array.isArray(item.edges)
    && !!item.canvas;
}

class WorkflowLibrary {
  private overlay: HTMLElement | null = null;
  private list: HTMLElement | null = null;
  private nameInput: HTMLInputElement | null = null;
  private workflows: WorkflowTemplate[] = [];
  private inited = false;

  init(): void {
    if (this.inited) return;
    this.inited = true;
    this.overlay = document.getElementById('workflow-overlay');
    this.list = document.getElementById('workflow-list');
    this.nameInput = document.getElementById('workflow-name') as HTMLInputElement | null;

    document.getElementById('btn-workflows')?.addEventListener('click', () => void this.open());
    document.getElementById('workflow-close')?.addEventListener('click', () => this.close());
    document.getElementById('workflow-save')?.addEventListener('click', () => void this.saveCurrent());
    this.nameInput?.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      void this.saveCurrent();
    });
    this.overlay?.addEventListener('click', event => {
      if (event.target === this.overlay) this.close();
    });
  }

  isOpen(): boolean {
    return !!this.overlay?.classList.contains('show');
  }

  async open(): Promise<void> {
    this.overlay?.classList.add('show');
    await this.load();
    this.nameInput?.focus();
  }

  close(): void {
    this.overlay?.classList.remove('show');
  }

  private async load(): Promise<void> {
    const result = await Backend.loadWorkflows();
    this.workflows = Array.isArray(result.workflows)
      ? result.workflows.filter(isWorkflow).sort((a, b) => b.updatedAt - a.updatedAt)
      : [];
    if (result.status === 'error') showToast('工作流库读取失败: ' + (result.message || ''), false);
    this.render();
  }

  private async persist(): Promise<boolean> {
    const result = await Backend.saveWorkflows(this.workflows);
    if (result.status === 'success') return true;
    showToast('工作流库保存失败: ' + (result.message || ''), false);
    return false;
  }

  private async saveCurrent(): Promise<void> {
    const title = (this.nameInput?.value || '').trim();
    if (!title) {
      this.nameInput?.focus();
      showToast('请先为工作流命名', false);
      return;
    }
    const template = persistence.collectWorkflow(workflowId(), title);
    this.workflows.unshift(template);
    if (!await this.persist()) {
      this.workflows.shift();
      return;
    }
    if (this.nameInput) this.nameInput.value = '';
    this.render();
    showToast('工作流已保存');
  }

  private async use(workflow: WorkflowTemplate): Promise<void> {
    await closeGuard.guardOpen(async () => {
      if (!persistence.restoreWorkflow(workflow)) return;
      this.close();
      showToast(`已从「${workflow.title}」创建新画布`);
    });
  }

  private async remove(workflow: WorkflowTemplate): Promise<void> {
    const approved = await confirmDialog({
      title: '删除工作流？',
      message: `「${workflow.title}」将从工作流库移除，现有项目不会受影响。`,
      confirmText: '删除',
      danger: true,
    });
    if (!approved) return;
    const index = this.workflows.findIndex(item => item.id === workflow.id);
    if (index < 0) return;
    const [removed] = this.workflows.splice(index, 1);
    if (!await this.persist()) {
      this.workflows.splice(index, 0, removed);
      return;
    }
    this.render();
    showToast('工作流已删除');
  }

  private render(): void {
    if (!this.list) return;
    this.list.replaceChildren();
    if (this.workflows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'workflow-empty';
      empty.textContent = '还没有工作流。把当前画布保存下来，下一次即可从它开始创作。';
      this.list.appendChild(empty);
      return;
    }

    this.workflows.forEach(workflow => {
      const item = document.createElement('article');
      item.className = 'workflow-item';
      const main = document.createElement('div');
      main.className = 'workflow-item-main';
      const title = document.createElement('div');
      title.className = 'workflow-item-title';
      title.textContent = workflow.title;
      const meta = document.createElement('div');
      meta.className = 'workflow-item-meta';
      meta.textContent = `${workflow.nodes.length} 个节点 · ${workflow.edges.length} 条连线 · ${new Date(workflow.updatedAt).toLocaleDateString()}`;
      main.append(title, meta);

      const actions = document.createElement('div');
      actions.className = 'workflow-item-actions';
      const useBtn = document.createElement('button');
      useBtn.className = 'workflow-item-btn';
      useBtn.textContent = '使用';
      useBtn.addEventListener('click', () => void this.use(workflow));
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'workflow-item-btn danger';
      deleteBtn.textContent = '删除';
      deleteBtn.addEventListener('click', () => void this.remove(workflow));
      actions.append(useBtn, deleteBtn);
      item.append(main, actions);
      this.list!.appendChild(item);
    });
  }
}

export const workflowLibrary = new WorkflowLibrary();
