// src/v1/ui/left-capsule.ts
// 左侧胶囊调（改版）：竖排胶囊条，内置「历史图库 / 资产库」两个图标入口。
// 点击图标 → 对应抽屉 toggle（互斥仍由 main.ts 编排，见 historyDrawer/assetDrawer.setMutex）；
// 通过 MutationObserver 监听两个抽屉容器的 open class，同步图标 active 高亮，
// 覆盖所有开合路径：图标点击 / 抽屉把手 / Escape / 点画布空白 / 生成图自动打开等。
// 不修改两个抽屉的内部逻辑，仅新增入口形态与布局。

import { historyDrawer } from './history-drawer';
import { assetDrawer } from './asset-drawer';

class LeftCapsule {
  private historyBtn: HTMLElement | null = null;
  private assetBtn: HTMLElement | null = null;
  private historyDrawerEl: HTMLElement | null = null;
  private assetDrawerEl: HTMLElement | null = null;
  private observer: MutationObserver | null = null;
  private inited = false;

  init(): void {
    if (this.inited) return;
    this.inited = true;
    this.historyBtn = document.getElementById('capsule-history');
    this.assetBtn = document.getElementById('capsule-assets');
    this.historyDrawerEl = document.getElementById('left-drawer');
    this.assetDrawerEl = document.getElementById('asset-drawer');

    this.historyBtn?.addEventListener('click', () => historyDrawer.toggle());
    this.assetBtn?.addEventListener('click', () => assetDrawer.toggle());

    // 监听抽屉 open class 变化 → 同步图标 active（与抽屉实际开合状态强一致）
    this.observer = new MutationObserver(() => this.syncActive());
    if (this.historyDrawerEl) {
      this.observer.observe(this.historyDrawerEl, { attributes: true, attributeFilter: ['class'] });
    }
    if (this.assetDrawerEl) {
      this.observer.observe(this.assetDrawerEl, { attributes: true, attributeFilter: ['class'] });
    }
    this.syncActive();
  }

  /** 图标 active 态：对应抽屉打开时高亮 */
  private syncActive(): void {
    if (this.historyBtn) {
      this.historyBtn.classList.toggle('active', !!this.historyDrawerEl?.classList.contains('open'));
    }
    if (this.assetBtn) {
      this.assetBtn.classList.toggle('active', !!this.assetDrawerEl?.classList.contains('open'));
    }
  }
}

export const leftCapsule = new LeftCapsule();
