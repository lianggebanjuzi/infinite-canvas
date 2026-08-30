// 4.1-C 画布资源包导入（.icbundle）。
// 冲突策略：
//   - 新建项目（默认）：后端把资源落到图片保存目录并把项目写为新的 .icproj；
//   - 插入当前画布（仅选中节点包可用）：后端返回解析后的项目数据，前端合并进当前画布。
// 导入失败由后端原子回滚，当前数据不被改写；前端在插入前记录撤销快照，可一次撤销回退。

import { flowState } from '../state/flow-state';
import { flowHistory } from '../state/history';
import { persistence } from '../persistence';
import { closeGuard } from '../close-guard';
import { Backend } from '../api';
import { showToast } from './toast';

const IMPORT_OFFSET = 96;

class ImportBundle {
  private overlay: HTMLElement | null = null;
  private importedProjectPath = '';

  init(): void {
    // 懒创建 overlay
  }

  open(): void {
    this.close();
    this.importedProjectPath = '';
    const overlay = document.createElement('div');
    overlay.className = 'overlay bundle-overlay';
    overlay.innerHTML = `
      <section class="bundle-panel" role="dialog" aria-modal="true" aria-label="导入画布资源包">
        <header class="bundle-head">
          <div><h2>导入画布资源包</h2><p>从 .icbundle 恢复项目或选中节点。资源包不含 API Key。</p></div>
          <button data-bi="close" title="关闭">×</button>
        </header>
        <div class="bundle-body">
          <div class="bundle-strategy">
            <button type="button" data-bi-strategy="new_project" class="active">新建项目（默认）</button>
            <button type="button" data-bi-strategy="insert_canvas">插入当前画布（仅选中节点包）</button>
          </div>
          <div class="bundle-hint" id="bi-hint">新建项目：导入为独立的 .icproj，不改变当前画布。</div>
          <div class="bundle-result" id="bi-result"></div>
        </div>
        <footer class="bundle-foot">
          <button class="btn-ghost" data-bi="cancel">取消</button>
          <button class="btn-primary" data-bi="confirm">选择资源包并导入</button>
        </footer>
      </section>`;
    document.body.appendChild(overlay);
    this.overlay = overlay;
    overlay.addEventListener('click', e => this.onClick(e as MouseEvent));
    overlay.querySelectorAll<HTMLElement>('[data-bi-strategy]').forEach(btn => {
      btn.addEventListener('click', () => {
        overlay.querySelectorAll<HTMLElement>('[data-bi-strategy]').forEach(b => b.classList.toggle('active', b === btn));
        const strategy = btn.dataset.biStrategy || 'new_project';
        const hint = overlay.querySelector('#bi-hint');
        if (hint) {
          hint.textContent = strategy === 'insert_canvas'
            ? '插入当前画布：仅「选中节点」资源包可用，导入后自动选中新节点。'
            : '新建项目：导入为独立的 .icproj，不改变当前画布。';
        }
      });
    });
  }

  close(): void {
    this.overlay?.remove();
    this.overlay = null;
  }

  private onClick(e: MouseEvent): void {
    const target = (e.target as Element).closest('[data-bi]') as HTMLElement | null;
    if (!target) { if (e.target === this.overlay) this.close(); return; }
    const action = target.dataset.bi;
    if (action === 'close' || action === 'cancel') { this.close(); return; }
    if (action === 'confirm') { void this.doImport(); }
  }

  private currentStrategy(): 'new_project' | 'insert_canvas' {
    const active = this.overlay?.querySelector('[data-bi-strategy].active') as HTMLElement | null;
    return active?.dataset.biStrategy === 'insert_canvas' ? 'insert_canvas' : 'new_project';
  }

  private async doImport(): Promise<void> {
    const confirmBtn = this.overlay?.querySelector('[data-bi="confirm"]') as HTMLButtonElement | null;
    const resultEl = this.overlay?.querySelector('#bi-result') as HTMLElement | null;
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = '导入中…'; }
    try {
      const strategy = this.currentStrategy();
      const result = await Backend.importBundle({ strategy });
      if (result.status === 'cancelled') return;
      if (result.status !== 'success') {
        showToast(result.message || '导入失败', false);
        if (resultEl) resultEl.textContent = result.message || '导入失败；当前数据未被改写';
        return;
      }
      if (strategy === 'insert_canvas') {
        const data = result.data as FlowProject | undefined;
        if (!data || !Array.isArray(data.nodes)) {
          showToast('资源包数据无效，无法插入', false);
          return;
        }
        const inserted = mergeBundleIntoCanvas(data);
        showToast(`已插入 ${inserted} 个节点到当前画布`);
        this.close();
      } else {
        const path = result.projectPath || '';
        this.importedProjectPath = path;
        if (resultEl) {
          resultEl.innerHTML = `已导入为新建项目：<span class="bi-path">${escapeHtml(path)}</span>`;
        }
        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'btn-ghost';
        openBtn.textContent = '打开导入的项目';
        openBtn.addEventListener('click', () => {
          void closeGuard.guardOpen(async () => {
            if (await persistence.openPath(path)) this.close();
          });
        });
        resultEl?.appendChild(openBtn);
        showToast('资源包导入成功');
      }
    } catch {
      showToast('导入失败', false);
    } finally {
      if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = '选择资源包并导入'; }
    }
  }
}

/**
 * 把导入的选中节点包合并进当前画布：
 * - id 冲突重映射（避免覆盖现有节点）；
 * - 整体向右下偏移避免与现有节点重叠；
 * - 记录一次撤销快照，可一次撤销回退。
 * 返回新插入的节点数。
 */
function mergeBundleIntoCanvas(project: FlowProject): number {
  const idMap = new Map<string, string>();
  const used = new Set(flowState.nodes.map(n => n.id));
  const newNodeIds: string[] = [];
  const remap = (id: string): string => {
    if (idMap.has(id)) return idMap.get(id)!;
    let candidate = id;
    let index = 2;
    while (used.has(candidate)) {
      candidate = `${id}_import_${index}`;
      index += 1;
    }
    used.add(candidate);
    idMap.set(id, candidate);
    return candidate;
  };

  flowHistory.record();
  const baseX = Math.min(...flowState.nodes.map(n => n.x), 0);
  const baseY = Math.min(...flowState.nodes.map(n => n.y), 0);
  const importedMinX = Math.min(...project.nodes.map(n => n.x), 0);
  const importedMinY = Math.min(...project.nodes.map(n => n.y), 0);
  const offsetX = baseX - importedMinX + IMPORT_OFFSET;
  const offsetY = baseY - importedMinY + IMPORT_OFFSET;

  project.nodes.forEach(node => {
    const newId = remap(node.id);
    newNodeIds.push(newId);
    // 仅当父节点也在导入包内时才重映射 parentId，否则置 null（避免产生悬空归属）
    const parentInBundle = node.parentId ? project.nodes.some(n => n.id === node.parentId) : false;
    flowState.addNode(node.type, node.x + offsetX, node.y + offsetY, {
      ...node,
      id: newId,
      params: { ...(node.params || {}) },
      imageUrl: node.imageUrl ?? null,
      refImages: [...(node.refImages || [])],
      textHistory: [...(node.textHistory || [])],
      generatedImages: Array.isArray(node.generatedImages) ? node.generatedImages.map(item => ({ ...item, origin: item.origin ? { ...item.origin } : item.origin })) : [],
      status: 'idle',
      error: null,
      lastRunAt: null,
      parentId: parentInBundle && node.parentId ? remap(node.parentId) : null,
      trace: node.trace ? { ...node.trace, refImageHashes: [...(node.trace.refImageHashes || [])] } : null,
    });
  });
  project.edges.forEach(edge => {
    const from = idMap.get(edge.from);
    const to = idMap.get(edge.to);
    if (from && to) flowState.addEdge(from, to, { suppressStale: true });
  });
  if (newNodeIds.length > 0) {
    flowState.updatedAt = Date.now();
    flowState.dirty = true;
    flowState.notify();
  }
  return newNodeIds.length;
}

function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const importBundle = new ImportBundle();
