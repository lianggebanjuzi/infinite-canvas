// js/services/prompt-service.js
/**
 * 提示词库服务层
 * 负责提示词数据的加载、保存、增删等业务逻辑
 * 不涉及任何 DOM 操作或 UI 渲染
 */

const PromptService = {

    // 内存缓存
    _data: null,

    /**
     * 加载提示词库数据（带内存缓存）
     * @returns {Promise<object>} { common: [], skill: [], draw: [] }
     */
    async load() {
        if (this._data) return this._data;
        try {
            const result = await API.loadPromptsLibrary();
            if (result.status === 'success') {
                this._data = result.data;
            } else {
                this._data = { common: [], skill: [], draw: [] };
            }
        } catch (e) {
            console.error('[PromptService] 加载失败:', e);
            this._data = { common: [], skill: [], draw: [] };
        }
        return this._data;
    },

    /**
     * 保存提示词库数据到后端
     * @returns {Promise<void>}
     */
    async save() {
        if (!this._data) return;
        try {
            await API.savePromptsLibrary(this._data);
        } catch (e) {
            console.error('[PromptService] 保存失败:', e);
            Toast.show('提示词库保存失败');
        }
    },

    /**
     * 添加一条提示词
     * @param {string} category - 'common' | 'skill' | 'draw'
     * @param {string} name     - 名称
     * @param {string} content - 提示词内容
     * @returns {Promise<string>} 新增条目的 ID
     */
    async addItem(category, name, content) {
        const data = await this.load();
        if (!data[category]) data[category] = [];

        const id = `${category[0]}${Date.now()}`;
        data[category].push({ id, name, content });
        await this.save();
        return id;
    },

    /**
     * 删除一条提示词
     * @param {string} category - 'common' | 'skill' | 'draw'
     * @param {string} id       - 条目 ID
     * @returns {Promise<void>}
     */
    async removeItem(category, id) {
        const data = await this.load();
        if (!data[category]) return;
        data[category] = data[category].filter(item => item.id !== id);
        await this.save();
    },

    /**
     * 获取指定分类的提示词列表
     * @param {string} category - 'common' | 'skill' | 'draw'
     * @returns {Promise<Array>} 提示词条目列表
     */
    async getItems(category) {
        const data = await this.load();
        return data[category] || [];
    }
};

window.PromptService = PromptService;
