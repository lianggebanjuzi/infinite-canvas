// js/state/connection-state.js

/**
 * 连线状态管理模块
 * 存储连线列表、拖拽状态等连接相关状态
 */
window.AppState = window.AppState || {};
window.AppState.connections = {
    // 所有连线数据：[{ id, start, end, element }]
    list: [],
    // 是否正在拖拽连线
    isConnecting: false,
    // 临时连线的 SVG path 元素
    tempLine: null,
    // 连线起点信息：{ cardId, portRole, x, y }
    startPort: null,
    // 未连接到卡片时，待创建的卡片信息和起点信息
    pendingConnection: null
};
