// src/v1/ui/action-bar.ts
// 卡片上方操作条：仅单选出现，贴卡上沿，智能避让翻转（原型行为）
// 首版动作按钮：风格调节聚焦指令面板；其余为后续版本能力，点击提示

import { flowState } from '../state/flow-state';
import { selection } from '../state/selection';
import { canvasView, CARD_W } from '../canvas/canvas-view';
import { cardView } from '../canvas/card-view';
import { showToast } from './toast';
import { cmdPanel } from './cmd-panel';

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

    if (action === 'style-adjust') {
      // 聚焦指令面板输入框
      const input = document.getElementById('cmd-input') as HTMLTextAreaElement | null;
      if (input) { input.focus(); input.scrollIntoView({ block: 'nearest' }); }
      return;
    }
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
    // 扩图/多角度/打光/高清放大：第二版能力
    showToast('该能力将在后续版本开放', false);
  }

  sync(): void {
    if (!this.el) return;
    const node = selection.single();
    // 结果卡只读：隐藏操作条
    if (!node || node.type === 'image-result') {
      this.el.classList.remove('show', 'pos-below');
      return;
    }

    const wrap = canvasView.wrap;
    if (!wrap) return;
    const wr = wrap.getBoundingClientRect();
    const { x: cx0, y: topY } = canvasView.worldToWrap(node.x + CARD_W / 2, node.y);
    const botY = canvasView.worldToWrap(0, node.y + cardView.cardHeight(node)).y;

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
