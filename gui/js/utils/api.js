// gui/js/utils/api.js
// 封装所有对 Python 后端的接口调用
// 只负责调用和返回结果，不写任何业务逻辑和 DOM 操作

/**
 * 后端错误码到前端提示信息的映射表
 * 用途：在 API 调用失败时，显示用户友好的错误信息
 */
const ERROR_MESSAGES = {
    401: 'API 密钥无效或已过期，请检查设置',
    402: '额度不足，请检查账户余额',
    422: '当前模型不支持此操作',
    429: '请求过于频繁，请稍后再试',
    500: '发生了未知错误，请重试',
    502: 'AI 服务返回了无效响应，请稍后重试',
    503: 'AI 服务暂时不可用，请稍后重试',
    504: 'AI 服务响应超时，请检查网络后重试'
};

/**
 * 统一处理 API 请求的错误
 * 负责显示 Toast 提示，并将响应对象转换为干净的结果（让调用方无需重复处理）
 * @param {object} response - pywebview API 返回的响应对象
 * @param {string} fallbackMsg - 当响应格式异常时的兜底提示
 * @returns {any} - 成功时返回 response.result，失败时返回 response（让调用方自行判断）
 */
function handleAPIError(response, fallbackMsg = '操作失败，请重试') {
    if (response && response.success === false) {
        const msg = ERROR_MESSAGES[response.error_code] || response.message || response.error || fallbackMsg;
        Toast.show(msg, 3000);
        return response;
    }
    return response && response.result !== undefined ? response.result : response;
}

const API = {
    handleAPIError,
    ERROR_MESSAGES,

    // ─────────────────────────────────────────
    // 供应商管理
    // ─────────────────────────────────────────

    /** 加载所有供应商列表 */
    async loadProviders() {
        return await pywebview.api.load_providers();
    },

    /** 添加新供应商 */
    async addProvider(name, type, shortName = '') {
        return await pywebview.api.add_provider(name, type, shortName);
    },

    /** 更新供应商信息 */
    async updateProvider(providerId, updates) {
        return await pywebview.api.update_provider(providerId, updates);
    },

    /** 删除供应商 */
    async deleteProvider(providerId) {
        return await pywebview.api.delete_provider(providerId);
    },

    /** 测试供应商 API 连接 */
    async testConnection(apiUrl, apiKey) {
        return await pywebview.api.test_api_connection(apiUrl, apiKey);
    },

    /** 拉取供应商的绘图模型列表 */
    async fetchModels(apiUrl, apiKey) {
        return await pywebview.api.fetch_models(apiUrl, apiKey);
    },

    // ─────────────────────────────────────────
    // 对话模型管理
    // ─────────────────────────────────────────

    async addChatModel(providerId, modelId, modelName) {
        return await pywebview.api.add_chat_model(providerId, modelId, modelName);
    },

    async removeModel(providerId, modelId) {
        return await pywebview.api.remove_model(providerId, modelId);
    },

    // ─────────────────────────────────────────
    // AI 图片生成
    // ─────────────────────────────────────────

    /** 统一异步图片生成（推荐） */
    async generateImageV2(prompt, options) {
        return await pywebview.api.unified_generate_image(prompt, options);
    },

    /** 统一同步图片生成（阻塞等待结果） */
    async generateImageV2Sync(prompt, options) {
        return await pywebview.api.unified_generate_image_sync(prompt, options);
    },

    /** 查询异步任务结果 */
    async getTaskResult(taskId) {
        return await pywebview.api.get_task_result(taskId);
    },

    // ─────────────────────────────────────────
    // Agent 对话（统一走 UnifiedAPIRouter）
    // ─────────────────────────────────────────

    async agentChatV2(userInput, options) {
        return await pywebview.api.unified_chat_v2(userInput, options);
    },

    /** 统一对话接口（数组格式 messages） */
    async unifiedChat(messages, options) {
        return await pywebview.api.unified_chat(messages, options);
    },

    // ─────────────────────────────────────────
    // 提示词库
    // ─────────────────────────────────────────

    async loadPromptsLibrary() {
        return await pywebview.api.load_prompts_library();
    },

    async savePromptsLibrary(data) {
        return await pywebview.api.save_prompts_library(data);
    },

    // ─────────────────────────────────────────
    // 图片处理
    // ─────────────────────────────────────────

    async saveImageToLocal(imgUrl) {
        return await pywebview.api.save_image_to_local(imgUrl);
    },

    async saveImageAs(imageData, filename) {
        return await pywebview.api.save_image_as(imageData, filename);
    },

    async loadLocalImage(filePath) {
        return await pywebview.api.load_local_image(filePath);
    },

    async outpaint(imageBase64, direction, ratio, prompt, providerId, modelId, resolution, maskData = null) {
        return await pywebview.api.outpaint(
            imageBase64, direction, ratio, prompt, providerId, modelId, resolution, maskData
        );
    },

    // ─────────────────────────────────────────
    // 剪贴板
    // ─────────────────────────────────────────

    async copyToClipboard(data) {
        return await pywebview.api.copy_to_clipboard(data);
    },

    async pasteFromClipboard() {
        return await pywebview.api.paste_from_clipboard();
    },

    // ─────────────────────────────────────────
    // 项目文件管理
    // ─────────────────────────────────────────

    async saveProject(data) {
        return await pywebview.api.save_project(data);
    },

    async saveProjectAs(data) {
        return await pywebview.api.save_project_as(data);
    },

    async openProject() {
        return await pywebview.api.open_project_dialog();
    },

    // ─────────────────────────────────────────
    // 设置
    // ─────────────────────────────────────────

    async loadSettings() {
        return await pywebview.api.load_settings();
    },

    async saveSettings(settings) {
        return await pywebview.api.save_settings(settings);
    },

    async selectFolder() {
        return await pywebview.api.select_folder();
    },

    // ─────────────────────────────────────────
    // 统一 API 路由层（UnifiedAPIRouter）
    // ─────────────────────────────────────────

    /** 统一对话接口（简化版，自动组装 messages） */
    async unifiedChatV2(userInput, options) {
        return await pywebview.api.unified_chat_v2(userInput, options);
    },

    /** 统一图片生成（异步，立即返回 task_id） */
    async unifiedGenerateImage(prompt, options) {
        return await pywebview.api.unified_generate_image(prompt, options);
    },

    /** 统一图片生成（同步，阻塞等待结果） */
    async unifiedGenerateImageSync(prompt, options) {
        return await pywebview.api.unified_generate_image_sync(prompt, options);
    },

    /** 查询异步任务结果 */
    async unifiedGetTaskResult(taskId) {
        return await pywebview.api.unified_get_task_result(taskId);
    }

};

window.API = API;
