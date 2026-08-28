// src/v1/ui/left-capsule.ts
// 左侧统一资源入口（Phase 2）：单个胶囊按钮 + 单个抽屉外壳。
// 抽屉内部为「资源 / 历史 / 提示词」三个页签，页签内容委托原组件渲染：
//   资源 → assetDrawer；历史 → historyDrawer；提示词 → promptTab。
// 本模块是抽屉开合与页签切换的唯一编排者：
//   - 胶囊按钮 / 抽屉把手只在这里绑定；
//   - 各页签组件通过 setTabOpenRequest 请求「打开抽屉并切到我的页签」（如生成新图后自动切到历史）；
//   - 关闭抽屉保留页签状态，重新打开回到上次页签；
//   - 页签各自保留查询关键字（三个搜索框是独立 DOM，天然互不干扰）。

import { assetDrawer } from './asset-drawer';
import { historyDrawer } from './history-drawer';
import { promptTab } from './prompt-tab';

export type ResourceTab = 'assets' | 'history' | 'prompts';

class LeftCapsule {
  private btn: HTMLElement | null = null;
  private drawerEl: HTMLElement | null = null;
  private handle: HTMLElement | null = null;
  private tabs: HTMLElement[] = [];
  private panels: HTMLElement[] = [];
  private activeTab: ResourceTab = 'assets';
  private observer: MutationObserver | null = null;
  private inited = false;

  init(): void {
    if (this.inited) return;
    this.inited = true;
    this.btn = document.getElementById('capsule-resources');
    this.drawerEl = document.getElementById('left-drawer');
    this.handle = document.getElementById('drawer-handle');
    this.tabs = Array.from(document.querySelectorAll<HTMLElement>('.resource-tab'));
    this.panels = Array.from(document.querySelectorAll<HTMLElement>('.resource-panel'));

    this.btn?.addEventListener('click', () => this.toggle());
    // 抽屉把手仅在抽屉展开时可见（CSS 门控），点击即收起。
    this.handle?.addEventListener('click', () => this.close());
    this.tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.tab as ResourceTab | undefined;
        if (!target) return;
        this.open();
        this.showTab(target);
      });
    });

    // 监听抽屉 open class 变化（其它来源如生成图自动打开）→ 同步胶囊按钮 active。
    this.observer = new MutationObserver(() => this.syncBtnActive());
    if (this.drawerEl) {
      this.observer.observe(this.drawerEl, { attributes: true, attributeFilter: ['class'] });
    }
    this.syncBtnActive();
    this.showTab(this.activeTab);
  }

  isOpen(): boolean {
    return !!this.drawerEl?.classList.contains('open');
  }

  toggle(): void {
    if (this.isOpen()) this.close();
    else this.open();
  }

  open(): void {
    this.drawerEl?.classList.add('open');
  }

  close(): void {
    this.drawerEl?.classList.remove('open');
  }

  /** 打开抽屉并切到指定页签（生成图自动切历史等场景）。 */
  openTo(tab: ResourceTab): void {
    this.open();
    this.showTab(tab);
  }

  getActiveTab(): ResourceTab {
    return this.activeTab;
  }

  /** 页签切换：仅改可见性与委托刷新，不重建搜索/列表状态。 */
  showTab(tab: ResourceTab): void {
    this.activeTab = tab;
    this.tabs.forEach(el => {
      const on = el.dataset.tab === tab;
      el.classList.toggle('active', on);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    this.panels.forEach(el => {
      el.classList.toggle('active', el.dataset.panel === tab);
    });
    if (tab === 'assets') assetDrawer.refresh();
    else if (tab === 'history') historyDrawer.refresh();
    else promptTab.refresh();
    this.syncCounts();
  }

  /** 页签计数（资源/历史/提示词；每次切页签时刷新） */
  private syncCounts(): void {
    const assetsEl = document.getElementById('resource-count-assets');
    const historyEl = document.getElementById('resource-count-history');
    const promptsEl = document.getElementById('resource-count-prompts');
    if (assetsEl) assetsEl.textContent = assetDrawer.count() > 0 ? ` ${assetDrawer.count()}` : '';
    if (historyEl) historyEl.textContent = historyDrawer.count() > 0 ? ` ${historyDrawer.count()}` : '';
    if (promptsEl) promptsEl.textContent = promptTab.count() > 0 ? ` ${promptTab.count()}` : '';
  }

  private syncBtnActive(): void {
    this.btn?.classList.toggle('active', this.isOpen());
  }
}

export const leftCapsule = new LeftCapsule();
