// js/state/ui-state.js

/**
 * UI 状态管理模块
 * 存储框选、激光切割、撤销重做、AI 绘图、性能优化等 UI 相关状态
 */

// ── 框选状态 ──
window.AppState.selection = {
    isBoxSelecting: false,
    // 框选 DOM 元素
    selectionBox: null,
    startX: 0,
    startY: 0
};

// ── 激光切割状态 ──
window.AppState.laser = {
    isCutting: false,
    // 激光线 SVG path 元素
    laserLine: null,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    // 标记刚结束切割，防止触发右键菜单
    justFinished: false
};

// ── 历史记录（撤销/重做）──
window.AppState.history = {
    undoStack: [],
    redoStack: [],
    maxSteps: 50
};

// ── AI 绘图状态 ──
window.AppState.ai = {
    // 注意：generatingCards 是 Map 而非 Set，用于支持 abort 标记
    generatingCards: new Map(),
    // 粘贴偏移量（避免多次粘贴重叠）
    pasteOffsetX: 0,
    pasteOffsetY: 0,
    pasteOffsetStep: 20,
    pasteOffsetMax: 200
};

// ── 性能优化 ──
window.AppState.performance = {
    // 待更新连线的卡片 ID 集合（节流用）
    connectionUpdateQueue: new Set(),
    connectionUpdateTimer: null,
    // 小地图更新定时器
    minimapUpdateTimer: null
};
