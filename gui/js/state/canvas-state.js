// js/state/canvas-state.js

/**
 * 画布状态管理模块
 * 存储画布的缩放、平移等变换状态
 */
window.AppState = window.AppState || {};
window.AppState.canvas = {
    scale: 1,
    panX: 0,
    panY: 0,
    isPanning: false,
    startPanX: 0,
    startPanY: 0,
    // 右键点击时记录的画布坐标，用于在此位置创建卡片
    contextClickPos: { x: 0, y: 0 }
};
