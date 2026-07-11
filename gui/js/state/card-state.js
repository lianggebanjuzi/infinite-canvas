// js/state/card-state.js

/**
 * 卡片状态管理模块
 * 存储当前激活卡片、上传目标、多选列表等卡片相关状态
 */
window.AppState = window.AppState || {};
window.AppState.cards = {
    // 当前激活（聚焦）的卡片 ID
    activeCardId: null,
    // 等待上传图片的目标卡片 ID
    targetUploadCardId: null,
    // 框选多选的卡片列表（DOM 元素数组，非 ID 数组）
    multiSelected: []
};
