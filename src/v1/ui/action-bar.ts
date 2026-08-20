// src/v1/ui/action-bar.ts
// 卡片上方操作条：仅单选出现，贴卡上沿，智能避让翻转（原型行为）
// 首版动作按钮：扩图/复现已接入；其余为后续版本能力，点击提示

import { flowState } from '../state/flow-state';
import { selection } from '../state/selection';
import { canvasView, CARD_W } from '../canvas/canvas-view';
import { cardView } from '../canvas/card-view';
import { showToast } from './toast';
import { cmdPanel } from './cmd-panel';
import { outpaintPanel } from './outpaint-panel';
import { reproduceService } from '../reproduce';
import { floatingPanels } from './floating-panels';

class ActionBar {
  private el: HTMLElement | null = null;

  init(): void {
    this.el = document.getElementById('action-bar');
    if (!this.el) return;

    this.el.querySelectorAll('.act-btn').forEach(btn => {
      (btn as HTMLElement).addEventListener('click', (e: MouseEvent) => {
        const action = ((e.currentTarget as HTMLElement).dataset.action) || '';
        this._handleAction(action);
      });
    });

    flowState.subscribe(() => this.sync());
  }

  private _handleAction(action: string): void {
    const node = selection.single();
    if (!node) return;

    if (action === 'download') {
      if (node.imageUrl) {
        const a = document.createElement('a');
        a.href = node.imageUrl;
        a.download = (node.title || 'image') + '.png';
        a.click();
      } else {
        showToast('该节点还没有可下载的图片', false);
      }
      return;
    }
    if (action === 'expand') {
      // 扩图：打开弹层（选目标比例 + 原图拖放/缩放 → canvas 合成 → banana 系列模型带图补全 → 新建产出节点连右侧）
      void outpaintPanel.open(node.id);
      return;
    }
    if (action === 'reproduce') {
      // 复现（A1-A5）：带 trace 节点一键回填参数并重跑（新建独立节点，不破坏原图）；无 trace 节点按钮不可见
      if (!node.trace) { showToast('该节点没有生成档案，无法复现', false); return; }
      void reproduceService.reproduceFromNode(node.id);
      return;
    }
    // 多角度/打光/高清放大：第二版能力
    showToast('该能力将在后续版本开放', false);
  }

  sync(): void {
    if (!this.el) return;
    // Tab 化：面板默认收起；仅当 Tab 呼出（floatingPanels.isVisible()）时才显示/定位
    // 显示态下切换选中节点：仍走下方逻辑刷新内容/位置（跟随新选中节点），不会误收起
    if (!floatingPanels.isVisible()) {
      this.el.classList.remove('show', 'pos-below');
      return;
    }
    const node = selection.single();
    // 文本节点 / 素材节点：隐藏操作条（素材仅展示图，无扩图/复现/下载等生成入口，判分支 #16+）
    if (!node || node.type === 'text-gen' || node.type === 'text-split' || flowState.isAssetNode(node)) {
      this.el.classList.remove('show', 'pos-below');
      return;
    }

    const wrap = canvasView.wrap;
    if (!wrap) return;
    const wr = wrap.getBoundingClientRect();
    const { x: cx0, y: topY } = canvasView.worldToWrap(node.x + CARD_W / 2, node.y);
    const botY = canvasView.worldToWrap(0, node.y + (node.h ?? cardView.cardHeight(node))).y;

    // 复现按钮显隐：仅带 trace 的节点显示（A1：无 trace 节点不出现；text 反推产物 trace=null 天然隐藏）
    const reproduceBtn = this.el.querySelector('[data-action="reproduce"]') as HTMLElement | null;
    if (reproduceBtn) reproduceBtn.classList.toggle('act-hidden', !node.trace);

    // 与指令面板同侧翻转：面板在上 → 操作条在下
    const cpH = (document.getElementById('cmd-panel') as HTMLElement)?.offsetHeight || 240;
    const flip = (wr.height - botY) < cpH + 24 && topY > cpH + 70;
    this.el.classList.toggle('pos-below', flip);

    const abCx = Math.min(Math.max(cx0, 200), wr.width - 200);
    this.el.style.left = abCx + 'px';
    this.el.style.top = (flip ? botY : topY) + 'px';
    this.el.classList.add('show');
  }
}

export const actionBar = new ActionBar();
