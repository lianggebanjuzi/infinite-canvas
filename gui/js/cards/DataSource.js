/**
 * 统一数据源管理器
 * 所有卡片通过此类获取上游数据，不再各自实现遍历逻辑
 *
 * 职责：
 * 1. 统一数据获取 - 所有卡片通过 DataSource 获取上游数据
 * 2. 按类型过滤 - 支持按 dataType 过滤上游卡片
 * 3. 按端口过滤 - 支持按 inputPort 过滤
 * 4. 缓存结果 - 避免重复计算（可选）
 */
const DataSource = {

    /**
     * 获取指定卡片的某个类型的所有上游数据
     * @param {string} cardId - 目标卡片 ID
     * @param {string} dataType - 数据类型：'text' | 'image'
     * @param {Object} options - 选项
     * @param {string} options.inputPort - 输入端口名称（可选）
     * @param {boolean} options.single - 是否只返回一个（默认 false）
     * @returns {Array} - 数据数组，每项包含 { data, sourceCardId, connectionId, endPort }
     */
    getUpstreamData(cardId, dataType, options = {}) {
        const { inputPort = null, single = false } = options;

        const connections = AppState.connections.list
            .filter(c => c.end === cardId);

        const results = [];

        connections.forEach(conn => {
            // 按端口过滤
            if (inputPort && conn.endPort !== inputPort) {
                return;
            }

            const upstreamCard = CardFactory.getInstance(conn.start);
            if (!upstreamCard) return;

            // 按类型过滤（通过 getDataType 方法）
            const upstreamType = upstreamCard.constructor.getDataType?.();
            if (upstreamType !== dataType) return;

            // 获取输出数据
            const data = upstreamCard.getOutput?.();
            if (!data) return;

            results.push({
                data: data,
                sourceCardId: conn.start,
                connectionId: conn.id,
                endPort: conn.endPort
            });
        });

        if (single) {
            return results.length > 0 ? results[0] : null;
        }

        return results;
    },

    /**
     * 获取上游文本数据
     * @param {string} cardId - 目标卡片 ID
     * @param {Object} options - 选项
     * @returns {Array} - 文本数据数组
     */
    getUpstreamText(cardId, options = {}) {
        return this.getUpstreamData(cardId, 'text', options);
    },

    /**
     * 获取上游图片数据
     * @param {string} cardId - 目标卡片 ID
     * @param {Object} options - 选项
     * @returns {Array} - 图片数据数组
     */
    getUpstreamImage(cardId, options = {}) {
        return this.getUpstreamData(cardId, 'image', options);
    },

    /**
     * 获取第一个匹配的上游数据
     * @param {string} cardId - 目标卡片 ID
     * @param {string} dataType - 数据类型
     * @returns {Object|null} - 第一个匹配的数据项
     */
    getFirstUpstream(cardId, dataType) {
        return this.getUpstreamData(cardId, dataType, { single: true });
    },

    /**
     * 获取上游数据并合并为字符串（用于 AI 输入）
     * @param {string} cardId - 目标卡片 ID
     * @returns {string} - 合并后的文本
     */
    getUpstreamTextMerged(cardId) {
        const texts = this.getUpstreamText(cardId);
        if (!texts || texts.length === 0) return '';
        return texts.map(t => t.data).join('\n\n');
    },

    /**
     * 获取上游图片 URL 列表
     * @param {string} cardId - 目标卡片 ID
     * @returns {Array} - 图片 URL 数组
     */
    getUpstreamImageList(cardId) {
        const images = this.getUpstreamImage(cardId);
        if (!images || images.length === 0) return [];
        return images.map(i => i.data);
    },

    /**
     * 检查是否有指定类型的上游
     * @param {string} cardId - 目标卡片 ID
     * @param {string} dataType - 数据类型
     * @returns {boolean}
     */
    hasUpstreamOfType(cardId, dataType) {
        const data = this.getUpstreamData(cardId, dataType, { single: true });
        return data !== null;
    },

    /**
     * 获取上游内容（文字 + 图片），兼容 AgentCard 的使用习惯
     * @param {string} cardId - 目标卡片 ID
     * @returns {Object} { texts: string[], images: string[] }
     */
    getUpstreamContent(cardId) {
        const textResults = this.getUpstreamText(cardId);
        const imageResults = this.getUpstreamImage(cardId);

        const texts = textResults
            .map(t => t.data)
            .filter(Boolean);

        const images = imageResults
            .map(i => i.data)
            .filter(src => {
                // AgentCard._isDisplayableImageSrc 的逻辑
                if (!src) return false;
                if (typeof src !== 'string') return false;
                return src.startsWith('data:') ||
                       src.startsWith('http') ||
                       src.startsWith('file://') ||
                       src.startsWith('blob:');
            });

        return { texts, images };
    },

    // ═══════════════════════════════════════════════════════════════════
    // 下游数据获取
    // ═══════════════════════════════════════════════════════════════════

    /**
     * 获取指定卡片的所有下游卡片实例
     * @param {string} cardId - 源卡片 ID
     * @param {Object} options - 选项
     * @param {string} options.dataType - 数据类型过滤：'text' | 'image'（可选）
     * @returns {Array} - 下游卡片实例数组
     */
    getDownstreamCards(cardId, options = {}) {
        const { dataType = null } = options;

        const connections = AppState.connections.list
            .filter(c => c.start === cardId);

        const results = [];

        connections.forEach(conn => {
            const downstreamCard = CardFactory.getInstance(conn.end);
            if (!downstreamCard) return;

            // 按数据类型过滤
            if (dataType) {
                const outputType = downstreamCard.constructor.getDataType?.();
                if (outputType !== dataType) return;
            }

            results.push(downstreamCard);
        });

        return results;
    },

    /**
     * 获取下游图片卡片实例（不含 PreviewCard）
     * @param {string} cardId - 源卡片 ID
     * @returns {Array} - 下游图片卡片实例数组
     */
    getDownstreamImageCards(cardId) {
        const allDownstream = this.getDownstreamCards(cardId, { dataType: 'image' });
        return allDownstream.filter(card => {
            // 排除 PreviewCard（它只是展示用，不应作为图片源）
            return card.getType && card.getType() !== 'preview';
        });
    },

    /**
     * 获取下游预览卡片实例
     * @param {string} cardId - 源卡片 ID
     * @returns {Array} - 下游 PreviewCard 实例数组
     */
    getDownstreamPreviews(cardId) {
        const allDownstream = this.getDownstreamCards(cardId, { dataType: 'image' });
        return allDownstream.filter(card => {
            return card.getType && card.getType() === 'preview';
        });
    },

    /**
     * 检查是否有指定类型的下游
     * @param {string} cardId - 源卡片 ID
     * @param {string} dataType - 数据类型
     * @returns {boolean}
     */
    hasDownstreamOfType(cardId, dataType) {
        const downstream = this.getDownstreamCards(cardId, { dataType });
        return downstream.length > 0;
    }
};

window.DataSource = DataSource;
