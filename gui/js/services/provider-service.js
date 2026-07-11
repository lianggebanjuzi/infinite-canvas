// js/services/provider-service.js
/**
 * 供应商服务层
 * 负责供应商的加载、添加、更新、删除、连接测试等业务逻辑
 * 不涉及任何 DOM 操作
 */

/**
 * 加载所有供应商列表，并同步到 AppState
 * @returns {Promise<Array>} 供应商列表
 */
async function loadProviders() {
    const result = await API.loadProviders();
    if (result && result.providers) {
        AppState.providers.list = result.providers;
    }
    return result;
}

/**
 * 添加新供应商
 * @param {string} name       - 供应商名称
 * @param {string} type      - 供应商类型（OpenAI/Anthropic/Gemini等）
 * @param {string} shortName - 简称
 * @returns {Promise<object>} 后端返回结果
 */
async function addProvider(name, type, shortName = '') {
    const result = await API.addProvider(name, type, shortName);
    if (result.status === 'success') {
        await loadProviders();
    }
    return result;
}

/**
 * 更新供应商信息，并同步本地状态
 * @param {string} providerId - 供应商 ID
 * @param {object} updates    - 更新的字段
 * @returns {Promise<object>} 后端返回结果
 */
async function updateProvider(providerId, updates) {
    const result = await API.updateProvider(providerId, updates);
    if (result && result.status === 'success') {
        const provider = AppState.providers.list.find(p => p.id === providerId);
        if (provider) {
            Object.assign(provider, updates);
        }
    }
    return result;
}

/**
 * 删除供应商
 * @param {string} providerId - 供应商 ID
 * @returns {Promise<object>} 后端返回结果
 */
async function deleteProvider(providerId) {
    const result = await API.deleteProvider(providerId);
    if (result && result.status === 'success') {
        AppState.providers.list = AppState.providers.list.filter(p => p.id !== providerId);
    }
    return result;
}

/**
 * 测试 API 连接
 * @param {string} apiUrl - API 地址
 * @param {string} apiKey - API 密钥
 * @returns {Promise<object>} { success: boolean, message: string }
 */
async function testConnection(apiUrl, apiKey) {
    return await API.testConnection(apiUrl, apiKey);
}

const ProviderService = {
    loadProviders,
    addProvider,
    updateProvider,
    deleteProvider,
    testConnection
};

window.ProviderService = ProviderService;
