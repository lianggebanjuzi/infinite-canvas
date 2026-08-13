// src/state/ui-state.ts
// 框选、激光切割、撤销重做、AI 绘图、性能优化等 UI 状态

export const selectionState = {
    isBoxSelecting: false,
    selectionBox: null as HTMLElement | null,
    startX: 0,
    startY: 0
};

export const laserState = {
    isCutting: false,
    laserLine: null as SVGPathElement | null,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    justFinished: false
};

export const historyState = {
    undoStack: [] as unknown[],
    redoStack: [] as unknown[],
    maxSteps: 50
};

export const aiState = {
    generatingCards: new Map<string, unknown>(),
    pasteOffsetX: 0,
    pasteOffsetY: 0,
    pasteOffsetStep: 20,
    pasteOffsetMax: 200
};

export const performanceState = {
    connectionUpdateQueue: new Set<string>(),
    connectionUpdateTimer: null as ReturnType<typeof setTimeout> | null,
    minimapUpdateTimer: null as ReturnType<typeof setTimeout> | null
};
