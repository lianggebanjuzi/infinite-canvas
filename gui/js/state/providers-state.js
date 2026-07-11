// js/state/providers-state.js

/**
 * 供应商状态管理模块
 * 存储供应商列表、当前编辑的供应商 ID、已拉取的模型数据
 */
window.AppState = window.AppState || {};
window.AppState.providers = {
    // 供应商列表：从后端加载的完整数据
    list: [],
    // 当前正在编辑的供应商 ID
    currentId: null,
    // 当前已拉取的模型数据（按分类分组）
    fetchedModels: null
};
