// 本地项目入口：只编排新建/打开/返回画布，不引入浏览器项目存储或第二套项目数据。
import { closeGuard } from '../close-guard';
import { persistence } from '../persistence';
import { Backend } from '../api';
import { showToast } from './toast';
import { copyText } from './clipboard';
import { applyWorkspaceTheme, normalizeWorkspaceTheme } from './bottom-bar';
import { exportBundle } from './export-bundle';
import { importBundle } from './import-bundle';

class ProjectHome {
  private el: HTMLElement | null = null;
  private recentList: HTMLElement | null = null;
  private recentEmpty: HTMLElement | null = null;
  private recents: RecentProject[] = [];

  init(): void {
    this.el = document.getElementById('project-home');
    if (!this.el) return;
    this.recentList = document.getElementById('project-home-recent-list');
    this.recentEmpty = document.getElementById('project-home-recent-empty');
    document.getElementById('btn-project-home')?.addEventListener('click', () => this.show());
    document.getElementById('project-home-resume')?.addEventListener('click', () => this.hide());
    document.getElementById('project-home-new')?.addEventListener('click', () => {
      void closeGuard.guardOpen(() => { persistence.createNewProject(); this.hide(); });
    });
    document.getElementById('project-home-open')?.addEventListener('click', () => {
      void closeGuard.guardOpen(async () => { await persistence.open(); await this.refreshRecents(); });
    });
    document.getElementById('project-home-backup-export')?.addEventListener('click', () => void this.exportBackup());
    document.getElementById('project-home-backup-import')?.addEventListener('click', () => void this.importBackup());
    document.getElementById('project-home-bundle-export')?.addEventListener('click', () => { exportBundle.openProject(); });
    document.getElementById('project-home-bundle-import')?.addEventListener('click', () => { importBundle.open(); });
    document.getElementById('project-home-clear-missing')?.addEventListener('click', () => void this.clearMissing());
    document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]').forEach(button => button.addEventListener('click', () => void this.chooseTheme(button.dataset.themeChoice || 'light')));
  }

  show(): void {
    if (!this.el) return;
    this.el.hidden = false;
    this.el.classList.add('show');
    this.syncThemeSelection();
    void this.refreshRecents();
  }

  private async refreshRecents(): Promise<void> {
    try {
      const result = await Backend.loadRecentProjects();
      this.recents = result.status === 'success' && Array.isArray(result.projects) ? result.projects : [];
    } catch {
      // 桌面桥接尚未就绪或短暂失联时，入口仍应可用并呈现空态。
      this.recents = [];
    }
    await this.renderRecents();
  }

  private async renderRecents(): Promise<void> {
    if (!this.recentList) return;
    // P2-1：后端逐条做真实路径存在性检查（Promise.all 预取，渲染不串行等待）；
    // 后端不可用/查询异常时按存在处理（保持旧行为，不误标红，openPath 兜底不变）。
    const existsMap = new Map<string, boolean>();
    await Promise.all(this.recents.map(async record => {
      try {
        const result = await Backend.checkRecentProjectPath(record.path);
        existsMap.set(record.path, result.status === 'success' ? result.exists !== false : true);
      } catch {
        existsMap.set(record.path, true);
      }
    }));
    this.recentList.replaceChildren();
    if (this.recentEmpty) this.recentEmpty.hidden = this.recents.length > 0;
    this.recents.forEach(record => {
      const available = existsMap.get(record.path) ?? true;
      const item = document.createElement('article'); item.className = `project-home-recent-item${available ? '' : ' is-missing'}`;
      const main = document.createElement('button'); main.type = 'button'; main.className = 'project-home-recent-main';
      const name = document.createElement('strong'); name.textContent = record.name;
      const path = document.createElement('span'); path.textContent = available ? record.path : `文件不可用：${record.path}`;
      const when = document.createElement('small'); when.textContent = this.formatTime(record.lastOpenedAt);
      main.append(name, path, when); main.disabled = !available;
      main.addEventListener('click', () => void closeGuard.guardOpen(async () => { if (await persistence.openPath(record.path)) this.hide(); else await this.refreshRecents(); }));
      const actions = document.createElement('div'); actions.className = 'project-home-recent-actions';
      actions.append(this.action('显示名', () => void this.rename(record)), this.action('文件夹', () => void this.reveal(record)), this.action('复制路径', () => void this.copyPath(record)), this.action('移除记录', () => void this.remove(record)));
      item.append(main, actions); this.recentList!.appendChild(item);
    });
  }

  private action(label: string, fn: () => void): HTMLButtonElement { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.addEventListener('click', fn); return button; }
  /** P2-1：真实路径存在性检查（后端 os.path.exists）；异常回退 true（不误标红）。 */
  private async existsPath(path: string): Promise<boolean> {
    try {
      const result = await Backend.checkRecentProjectPath(path);
      return result.status === 'success' ? result.exists !== false : true;
    } catch {
      return true;
    }
  }
  private async rename(record: RecentProject): Promise<void> { const name = window.prompt('仅修改首页显示名称，不会重命名文件', record.name); if (!name?.trim()) return; const result = await Backend.renameRecentProject(record.path, name.trim()); if (result.status !== 'success') showToast(result.message || '修改显示名失败', false); await this.refreshRecents(); }
  private async reveal(record: RecentProject): Promise<void> { const result = await Backend.revealProjectInFolder(record.path); showToast(result.status === 'success' ? '已打开项目所在文件夹' : (result.message || '无法打开文件夹'), result.status === 'success'); }
  private async copyPath(record: RecentProject): Promise<void> { showToast(await copyText(record.path) ? '项目路径已复制' : '复制失败', true); }
  private async remove(record: RecentProject): Promise<void> { if (!window.confirm(`移除“${record.name}”的最近记录？不会删除项目文件。`)) return; const result = await Backend.removeRecentProject(record.path); showToast(result.status === 'success' ? '已移除最近记录' : (result.message || '移除失败'), result.status === 'success'); await this.refreshRecents(); }
  private async clearMissing(): Promise<void> {
    const existsMap = new Map<string, boolean>();
    await Promise.all(this.recents.map(async record => {
      existsMap.set(record.path, await this.existsPath(record.path));
    }));
    const missing = this.recents.filter(record => existsMap.get(record.path) === false);
    await Promise.all(missing.map(record => Backend.removeRecentProject(record.path)));
    await this.refreshRecents();
    if (missing.length) showToast(`已清理 ${missing.length} 条失效记录`);
  }
  private syncThemeSelection(): void {
    const theme = normalizeWorkspaceTheme(document.documentElement.getAttribute('data-theme'));
    document.querySelectorAll<HTMLElement>('[data-theme-choice]').forEach(button => button.classList.toggle('active', button.dataset.themeChoice === theme));
  }
  private async chooseTheme(value: string): Promise<void> { const theme = await applyWorkspaceTheme(value); this.syncThemeSelection(); showToast(`已切换为${({ light: '亮色', dark: '暗色' } as Record<string, string>)[theme]}主题`); }
  private formatTime(value: number): string { return value > 0 ? new Date(value).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }) : '未记录打开时间'; }

  hide(): void {
    if (!this.el) return;
    this.el.classList.remove('show');
    this.el.hidden = true;
  }

  private async exportBackup(): Promise<void> {
    const preview = await Backend.previewBackup();
    if (preview.status !== 'success') { showToast(preview.message || '无法估算备份内容', false); return; }
    let includeMedia = true;
    if (preview.requires_media_choice) {
      includeMedia = window.confirm(`备份约 ${(preview.estimated_bytes || 0) / 1024 / 1024 | 0} MB，包含 ${preview.assets || 0} 个本地媒体。\n确定：包含媒体；取消：仅备份元数据。`);
    }
    const result = await Backend.exportBackup({ include_media: includeMedia });
    showToast(result.status === 'success' ? `备份已导出：${result.path || ''}` : (result.message || '导出备份失败'), result.status === 'success');
  }

  private async importBackup(): Promise<void> {
    const choice = window.prompt('恢复冲突策略：新增副本 / 合并 / 跳过', '新增副本');
    if (choice === null) return;
    const normalized = choice.includes('合并') ? 'merge' : choice.includes('跳过') ? 'skip' : 'copy';
    const result = await Backend.importBackup({ conflict: normalized });
    showToast(result.status === 'success' ? '备份已恢复；请重新配置 API 渠道和密钥' : (result.message || '恢复备份失败'), result.status === 'success');
  }
}

export const projectHome = new ProjectHome();
