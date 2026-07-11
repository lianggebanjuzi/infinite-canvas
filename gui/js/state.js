// js/state.js
/**
 * 状态聚合导出模块
 * 各子状态分别定义在 state/ 目录下：
 *   - canvas-state.js      画布变换
 *   - card-state.js        卡片状态
 *   - providers-state.js   供应商状态
 *   - connection-state.js  连线状态
 *   - ui-state.js          UI 交互状态（框选、激光、历史、AI、性能）
 *
 * 统一通过 window.AppState 访问
 * 本文件在所有子状态文件之后加载，确保 AppState 已完成初始化
 */
window.AppState = window.AppState || {};
