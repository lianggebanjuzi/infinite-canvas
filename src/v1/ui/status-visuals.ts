// src/v1/ui/status-visuals.ts
// 状态点/扫描光/流光 class 切换 helper
// 视觉完全由 CSS 基于 data-status 属性驱动（见 app.css）

/** 刷新卡片状态视觉（红点 hover 显示原因通过 title 透出） */
export function applyCardStatus(el: HTMLElement, status: NodeStatus): void {
  el.dataset.status = status;
}

/** 开关连线流光动画 */
export function applyLinkFlowing(path: SVGPathElement | null, on: boolean): void {
  if (!path) return;
  path.classList.toggle('flowing', on);
}
