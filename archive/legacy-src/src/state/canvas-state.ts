// src/state/canvas-state.ts
// 画布变换状态（缩放、平移等）
export const canvasState = {
    scale: 1,
    panX: 0,
    panY: 0,
    isPanning: false,
    startPanX: 0,
    startPanY: 0,
    contextClickPos: { x: 0, y: 0 }
};
