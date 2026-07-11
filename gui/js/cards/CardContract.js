// gui/js/cards/CardContract.js
// 卡片契约系统 - 基于声明式的数据流转

/**
 * 契约类型定义
 * @typedef {Object} OutputPort
 * @property {string} name - 端口名称
 * @property {string} type - 数据类型：'text' | 'image'
 */

/**
 * @typedef {Object} InputPort
 * @property {string} name - 端口名称
 * @property {string} type - 数据类型：'text' | 'image'
 * @property {boolean} [multiple] - 是否支持多个输入
 */

/**
 * @typedef {Object} CardContract
 * @property {OutputPort[]} outputs - 输出端口列表
 * @property {InputPort[]} inputs - 输入端口列表
 */

const CardContract = {

    // ─────────────────────────────────────────────────────────
    // 现有方法
    // ─────────────────────────────────────────────────────────

    /**
     * 获取卡片类型的契约
     * @param {BaseCard|string} cardOrType - 卡片实例或类型名字符串
     * @returns {CardContract|null}
     */
    get(cardOrType) {
        let CardClass;

        if (typeof cardOrType === 'string') {
            // 通过类型名查找卡片类
            const typeMap = {
                'text': TextCard,
                'image': ImageInputCard,
                'ai-image': AIDrawCard,
                'drawing-board': DrawingBoardCard,
                'preview': PreviewCard,
                'agent': AgentCard,
                'compare': CompareCard
            };
            CardClass = typeMap[cardOrType];
        } else {
            CardClass = cardOrType.constructor;
        }

        if (!CardClass || typeof CardClass.getContract !== 'function') {
            console.warn(`[CardContract] ${cardOrType} 没有声明契约`);
            return null;
        }

        return CardClass.getContract();
    },

    /**
     * 检查源卡片能否连接到目标卡片
     * @param {BaseCard} sourceCard - 源卡片
     * @param {BaseCard} targetCard - 目标卡片
     * @param {string} [endPort] - 目标端口名（如 'A', 'B'）
     * @returns {Object} { compatible: boolean, reason?: string }
     */
    checkCompatibility(sourceCard, targetCard, endPort = null) {
        const sourceContract = this.get(sourceCard);
        const targetContract = this.get(targetCard);

        if (!sourceContract || !targetContract) {
            return { compatible: false, reason: '缺少契约声明' };
        }

        // 目标卡片没有输入端口
        if (!targetContract.inputs || targetContract.inputs.length === 0) {
            return { compatible: false, reason: '目标卡片不接受输入' };
        }

        // 检查是否有匹配的输出类型
        const sourceOutputs = sourceContract.outputs || [];
        const targetInputs = targetContract.inputs || [];

        // 确定目标端口
        let targetInput = null;
        if (endPort && targetContract.inputs.length > 1) {
            targetInput = targetInputs.find(i => i.name === endPort);
        } else {
            // 只有一个输入口，默认用第一个
            targetInput = targetInputs[0];
        }

        if (!targetInput) {
            return { compatible: false, reason: '未找到目标输入端口' };
        }

        // 检查类型是否匹配
        const hasMatch = sourceOutputs.some(output =>
            output.type === targetInput.type ||
            (output.type === 'image' && targetInput.type === 'image')
        );

        if (!hasMatch) {
            return {
                compatible: false,
                reason: `类型不匹配: 输出 ${sourceOutputs.map(o => o.type).join('/')} → 输入 ${targetInput.type}`
            };
        }

        return { compatible: true };
    },

    // ─────────────────────────────────────────────────────────
    // receivePolicy 增强方法
    // ─────────────────────────────────────────────────────────

    /**
     * 获取卡片的接收策略
     * @param {BaseCard} card - 卡片实例
     * @param {string} inputType - 输入类型
     * @returns {Object} { policy: 'replace'|'append'|'ignore', input: {...} }
     */
    getReceivePolicy(card, inputType) {
        const contract = card.constructor.getContract?.();
        if (!contract) return { policy: 'replace', input: null };

        const input = contract.inputs?.find(i => i.type === inputType);
        if (!input) return { policy: 'ignore', input: null };

        return {
            policy: input.receivePolicy || 'replace',
            input: input
        };
    },

    /**
     * 检查是否应该接收数据
     * @param {BaseCard} card - 卡片实例
     * @param {string} inputType - 输入类型
     * @returns {boolean}
     */
    shouldReceive(card, inputType) {
        const { policy } = this.getReceivePolicy(card, inputType);
        return policy !== 'ignore';
    }
};

window.CardContract = CardContract;
