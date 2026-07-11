// js/services/model-service.js
/**
 * 模型服务层
 * 负责拉取模型列表、添加对话模型、删除模型、保存模型配置等业务逻辑
 * 不涉及任何 DOM 操作
 */

/**
 * 拉取供应商的绘图模型列表，并与本地对话模型合并
 * @param {string} providerId - 供应商 ID
 * @returns {Promise<object>} 后端返回结果，含合并后的 models
 */
async function fetchDrawingModels(providerId) {
    const provider = AppState.providers.list.find(p => p.id === providerId);
    if (!provider) {
        return { status: 'error', message: '供应商不存在' };
    }
    if (!provider.api_url || !provider.api_key) {
        return { status: 'error', message: '请先填写 API 地址和密钥' };
    }

    // 先保存当前供应商的修改
    await ProviderService.updateProvider(providerId, {
        short_name: provider.short_name || '',
        api_key:    provider.api_key    || '',
        api_url:    provider.api_url    || '',
        enabled:    provider.enabled     || false,
        use_proxy:  provider.use_proxy   !== false
    });

    const result = await API.fetchModels(provider.api_url, provider.api_key);

    if (result.status !== 'success') {
        return result;
    }

    const fetched     = result.models || [];
    const existing    = provider.models || [];
    const existingMap = {};
    existing.forEach(m => { existingMap[m.id] = m; });

    // 拉取回来的全部是绘图模型，手动添加的对话模型保留不覆盖
    const manualChatModels = existing.filter(m => m.type === 'chat');

    const mergedDrawing = fetched.map(m => ({
        id:      m.id,
        name:    m.name || m.id,
        type:    'drawing',
        enabled: existingMap[m.id]?.enabled ?? true
    }));

    // 对话模型在前，绘图模型在后，方便查看
    const merged = [...manualChatModels, ...mergedDrawing];

    provider.models                  = merged;
    AppState.providers.fetchedModels = merged;

    await API.updateProvider(providerId, { models: merged });

    return {
        status:   'success',
        models:   merged,
        chatCount:   manualChatModels.length,
        drawCount:   mergedDrawing.length
    };
}

/**
 * 添加对话模型到指定供应商
 * @param {string} providerId - 供应商 ID
 * @param {string} modelId   - 模型 ID
 * @param {string} modelName - 显示名称
 * @returns {Promise<object>} 后端返回结果
 */
async function addChatModel(providerId, modelId, modelName) {
    const provider = AppState.providers.list.find(p => p.id === providerId);
    if (!provider) {
        return { status: 'error', message: '供应商不存在' };
    }

    // 调用后端添加
    const result = await API.addChatModel(providerId, modelId, modelName);

    if (result.status === 'success') {
        // 同步本地状态
        if (!provider.models) provider.models = [];
        provider.models.unshift({
            id:      modelId,
            name:    modelName || modelId,
            type:    'chat',
            enabled: true
        });
    }

    return result;
}

/**
 * 删除指定供应商下的模型
 * @param {string} providerId - 供应商 ID
 * @param {string} modelId   - 模型 ID
 * @returns {Promise<object>} 后端返回结果
 */
async function removeModel(providerId, modelId) {
    const provider = AppState.providers.list.find(p => p.id === providerId);
    if (!provider) {
        return { status: 'error', message: '供应商不存在' };
    }

    const result = await API.removeModel(providerId, modelId);

    if (result && result.status === 'success') {
        provider.models = provider.models.filter(m => m.id !== modelId);
    }

    return result;
}

/**
 * 更新单个模型的启用状态
 * @param {string} providerId - 供应商 ID
 * @param {string} modelId   - 模型 ID
 * @param {boolean} enabled  - 是否启用
 * @returns {Promise<object>} 后端返回结果
 */
async function updateModelEnabled(providerId, modelId, enabled) {
    const provider = AppState.providers.list.find(p => p.id === providerId);
    if (!provider || !provider.models) {
        return { status: 'error', message: '供应商不存在' };
    }

    const model = provider.models.find(m => m.id === modelId);
    if (!model) {
        return { status: 'error', message: '模型不存在' };
    }

    model.enabled = enabled;
    return await API.updateProvider(providerId, { models: provider.models });
}

const ModelService = {
    fetchDrawingModels,
    addChatModel,
    removeModel,
    updateModelEnabled
};

window.ModelService = ModelService;
