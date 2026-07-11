// gui/js/state/group-state.js

/**
 * 组状态管理模块
 * 存储所有组实例、当前激活的组、框选状态等
 */
window.AppState = window.AppState || {};
window.AppState.groups = {
    // 所有组实例列表
    list: [],

    // 当前激活的组 ID（用于双击进入组内编辑模式）
    activeGroupId: null,

    // 是否正在框选创建组
    isSelecting: false,

    // 框选过程中的临时区域
    tempBounds: null
};
