// src/v1/save-coordinator.ts
// 保存编排器（单例）：手动保存 / 自动保存 / 关闭前保存三条路径的唯一入口。
// 职责：单飞互斥（同一时刻仅一个在途保存）、串行合并（在途期间的新请求标记 pending，完成后补一次最新状态）、
//       60s 定时器 + 窗口失焦触发自动保存、顶栏三态（已保存 / 未保存 / 保存中…）。
// 底层落盘统一走 persistence.save()（后端 atomic_write_json），本模块不直接调 Backend。

import { flowState } from './state/flow-state';
import { persistence } from './persistence';

/** 自动保存间隔（设计 R2.6 可配置属 P2，暂硬编码常量） */
const AUTOSAVE_INTERVAL_MS = 60000;

/** 保存状态三态（顶栏 #save-status 文本 + data-status 驱动样式） */
type SaveStatus = 'saved' | 'dirty' | 'saving';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class SaveCoordinator {
  private saving = false;
  private pending = false;
  private status: SaveStatus = 'saved';
  private timerId: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs = AUTOSAVE_INTERVAL_MS;
  private statusEl: HTMLElement | null = null;
  private dotEl: HTMLElement | null = null;
  private inited = false;

  /** 启动：启动 60s 定时器 + 失焦触发 + 订阅 flowState 同步三态 */
  init(): void {
    if (this.inited) return;
    this.inited = true;
    this.statusEl = document.getElementById('save-status');
    this.dotEl = document.getElementById('save-dot');
    this.timerId = window.setInterval(() => { void this.save(true); }, this.intervalMs);
    window.addEventListener('blur', () => { void this.save(true); });
    flowState.subscribe(() => this.setStatus());
    this.setStatus();
  }

  /** 是否已有保存路径（lastPath 非空） */
  hasPath(): boolean {
    return persistence.hasPath();
  }

  /**
   * 保存统一入口。silent=true（自动保存）时：无改动或无路径 → 静默跳过（不弹窗、保持 dirty）。
   * 单飞：在途期间新请求标记 pending，当前保存完成后串行补一次最新状态（等价合并）。
   */
  async save(silent = false): Promise<boolean> {
    if (silent && (!flowState.dirty || !persistence.hasPath())) return true;
    if (this.saving) {
      this.pending = true;
      return true;
    }
    return this._run(silent);
  }

  /** 关闭前保存：等待在途保存结束（罕见并发），再强制做一次非静默保存。无路径时由 persistence 弹另存为。 */
  async saveForClose(): Promise<boolean> {
    const deadline = Date.now() + 10000;
    while (this.saving && Date.now() < deadline) {
      await delay(30);
    }
    if (this.saving) return false;
    return this._run(false);
  }

  /** 同步顶栏三态：保存中… / 未保存 ● / 已保存 */
  setStatus(): void {
    const next: SaveStatus = this.saving ? 'saving' : (flowState.dirty ? 'dirty' : 'saved');
    this.status = next;
    if (this.statusEl) {
      this.statusEl.dataset.status = next;
      this.statusEl.textContent = next === 'saving' ? '保存中…' : (next === 'dirty' ? '未保存' : '已保存');
    }
    if (this.dotEl) this.dotEl.classList.toggle('show', flowState.dirty);
  }

  /** 单飞执行的底层保存：置 saving → persistence.save → 处理 pending 合并 */
  private async _run(silent: boolean): Promise<boolean> {
    this.saving = true;
    this.setStatus();
    let ok = false;
    try {
      ok = await persistence.save(silent);
      return ok;
    } finally {
      this.saving = false;
      if (this.pending) {
        this.pending = false;
        this.setStatus();
        void this.save(true); // 补一次最新状态（静默；dirty 已 false 时会自然跳过）
      } else {
        this.setStatus();
      }
    }
  }
}

export const saveCoordinator = new SaveCoordinator();
