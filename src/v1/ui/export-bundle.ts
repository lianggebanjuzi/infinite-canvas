// 4.1-C 画布资源包导出（.icbundle）。
// 两种模式：
//   - 导出当前项目：打包当前画布全部节点与引用资源；
//   - 导出选中节点：只打包所选节点 + 向上游追溯的直接依赖（图片/文本输入）与它们之间的连线。
// 资源包不含 API Key（后端 _without_secrets 防御 + 按扩展名白名单只收媒体文件）。

import { flowState } from '../state/flow-state';
import { persistence } from '../persistence';
import { Backend } from '../api';
import { showToast } from './toast';

class ExportBundle {
  private overlay: HTMLElement | null = null;
  private mode: 'project' | 'selection' = 'project';
  private nodeIds: string[] = [];

  init(): void {
    // 懒创建 overlay
  }

  /** 导出当前项目（操作条「更多」/ 主页入口）。 */
  openProject(): void {
    this.mode = 'project';
    this.nodeIds = [];
    this.show();
  }

  /** 导出选中节点（操作条「更多」/ 右键菜单）；未传 id 时取当前选中集。 */
  openSelection(ids?: string[]): void {
    const nodeIds = ids && ids.length > 0 ? ids : [...flowState.selectedIds];
    if (nodeIds.length === 0) { showToast('请先选中要导出的节点', false); return; }
    this.mode = 'selection';
    this.nodeIds = nodeIds;
    this.show();
  }

  close(): void {
    this.overlay?.remove();
    this.overlay = null;
  }

  private show(): void {
    this.close();
    const overlay = document.createElement('div');
    overlay.className = 'overlay bundle-overlay';
    const isSelection = this.mode === 'selection';
    overlay.innerHTML = `
      <section class="bundle-panel" role="dialog" aria-modal="true" aria-label="导出画布资源包">
        <header class="bundle-head">
          <div><h2>${isSelection ? '导出选中节点包' : '导出当前项目包'}</h2>
          <p>${isSelection ? `将打包 ${this.nodeIds.length} 个选中节点及其向上游追溯的直接依赖与连线。` : '将打包当前画布全部节点、连线和引用资源。'}资源包不含 API Key。</p></div>
          <button data-be="close" title="关闭">×</button>
        </header>
        <div class="bundle-body">
          <div class="bundle-summary" id="be-summary">正在统计…</div>
        </div>
        <footer class="bundle-foot">
          <button class="btn-ghost" data-be="cancel">取消</button>
          <button class="btn-primary" data-be="confirm">${isSelection ? '导出选中节点包' : '导出当前项目包'}</button>
        </footer>
      </section>`;
    document.body.appendChild(overlay);
    this.overlay = overlay;
    overlay.addEventListener('click', e => this.onClick(e as MouseEvent));
    this.renderSummary();
  }

  private renderSummary(): void {
    const summary = this.overlay?.querySelector('#be-summary');
    if (!summary) return;
    const project = this.collectProject();
    const nodes = project.nodes || [];
    const edges = project.edges || [];
    const mediaCount = this.countMediaPaths(project);
    summary.textContent = `节点 ${nodes.length} 个 · 连线 ${edges.length} 条 · 本地媒体约 ${mediaCount} 个`;
  }

  /** 收集待导出项目数据（选中模式 = 选中节点 + 直接上游依赖 + 内部连线）。 */
  private collectProject(): FlowProject {
    if (this.mode === 'project') return persistence.collect();
    return collectSelectionProject(this.nodeIds);
  }

  private countMediaPaths(project: FlowProject): number {
    let count = 0;
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          if (['path', 'originalpath', 'coverpath', 'localpath'].includes(key.toLowerCase()) && typeof child === 'string' && child.length > 0) count += 1;
          visit(child);
        }
      }
    };
    visit(project);
    return count;
  }

  private onClick(e: MouseEvent): void {
    const target = (e.target as Element).closest('[data-be]') as HTMLElement | null;
    if (!target) { if (e.target === this.overlay) this.close(); return; }
    const action = target.dataset.be;
    if (action === 'close' || action === 'cancel') { this.close(); return; }
    if (action === 'confirm') { void this.doExport(); }
  }

  private async doExport(): Promise<void> {
    const confirmBtn = this.overlay?.querySelector('[data-be="confirm"]') as HTMLButtonElement | null;
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = '导出中…'; }
    try {
      const projectData = this.collectProject();
      const result = await Backend.exportBundle({
        mode: this.mode,
        projectData,
        exportedNodeIds: this.mode === 'selection' ? this.nodeIds : [],
        projectName: flowState.projectName || '未命名项目',
      });
      if (result.status === 'cancelled') return;
      if (result.status !== 'success') {
        showToast(result.message || '导出失败', false);
        return;
      }
      const m = (result.manifest || {}) as { assets?: number; nodeCount?: number };
      showToast(`已导出资源包：${result.path || ''}（${m.assets || 0} 个资源）`);
      this.close();
    } catch {
      showToast('导出失败', false);
    } finally {
      if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = this.mode === 'selection' ? '导出选中节点包' : '导出当前项目包'; }
    }
  }
}

/**
 * 选中节点子集收集：选中节点 + 直接上游（一层，提供图片/文本输入）+ 两端都在集合内的连线。
 * 「向上游追溯直接依赖」按直接依赖处理，避免把整条链全部打包（规范 C1）。
 */
export function collectSelectionProject(nodeIds: string[]): FlowProject {
  const full = persistence.collect();
  const include = new Set<string>();
  nodeIds.forEach(id => {
    if (!full.nodes.some(n => n.id === id)) return;
    include.add(id);
    // 直接上游：图片/文本输入依赖（getUpstreams 一层）
    const upstreamIds = full.edges
      .filter(e => e.to === id && full.nodes.some(n => n.id === e.from))
      .map(e => e.from);
    upstreamIds.forEach(uid => include.add(uid));
  });
  const nodes = full.nodes.filter(n => include.has(n.id));
  const nodeIdsSet = new Set(nodes.map(n => n.id));
  const edges = full.edges.filter(e => nodeIdsSet.has(e.from) && nodeIdsSet.has(e.to));
  return {
    ...full,
    nodes,
    edges,
    updatedAt: Date.now(),
  };
}

export const exportBundle = new ExportBundle();
