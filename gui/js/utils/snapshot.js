/**
 * 快照工具函数
 * 统一管理快照收集和恢复时的 base64 数据处理
 */
const SnapshotUtils = {

    /**
     * 收集快照时：将 base64 图片替换为占位符
     * @param {string} content - 卡片内容
     * @returns {string} 处理后的内容
     */
    sanitizeContent(content) {
        if (content?.startsWith('data:image')) {
            return '__base64_pending__';
        }
        return content;
    },

    /**
     * 恢复快照时：将占位符还原为空字符串
     * @param {string} content - 卡片内容
     * @returns {string} 处理后的内容
     */
    restoreContent(content) {
        if (content === '__base64_pending__') {
            return '';
        }
        return content || '';
    }
};

window.SnapshotUtils = SnapshotUtils;
