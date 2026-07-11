/**
 * 统一执行调度器
 * 替代散落在各处的"主动拉取"逻辑
 *
 * 职责：
 * 1. 拓扑排序 - 按依赖关系排序执行
 * 2. 循环检测 - 检测并处理循环依赖
 * 3. 批量调度 - 一次事件触发多个卡片更新
 * 4. 执行策略 - 根据卡片类型选择执行时机
 */
const PipelineEngine = {

    // 正在处理的卡片集合（防止重复）
    _processing: new Set(),

    /**
     * 触发数据管道
     * 由 DirtyQueue flush 后调用，或由 ConnectionRules 在数据变化时调用
     * @param {string} sourceCardId - 数据源卡片 ID
     * @param {string} dataType - 数据类型
     */
    trigger(sourceCardId, dataType) {
        if (this._processing.has(sourceCardId)) {
            console.debug(`[PipelineEngine] ${sourceCardId} 正在处理中，跳过`);
            return;
        }
        this._processing.add(sourceCardId);

        try {
            // 1. 找到所有下游卡片
            const downstreamCards = this._getDownstreamCards(sourceCardId, dataType);
            if (downstreamCards.length === 0) {
                console.debug(`[PipelineEngine] ${sourceCardId} 没有下游卡片`);
                return;
            }

            // 2. 拓扑排序
            const sorted = this._topoSort(downstreamCards);
            if (!sorted) {
                console.warn('[PipelineEngine] 检测到循环依赖，跳过执行');
                return;
            }

            // 3. 依次调用 onReceive
            for (const cardId of sorted) {
                this._dispatch(cardId, dataType);
            }

        } finally {
            this._processing.delete(sourceCardId);
        }
    },

    /**
     * 执行单个卡片的数据接收
     */
    _dispatch(cardId, dataType) {
        const card = CardFactory.getInstance(cardId);
        if (!card || !card.onReceive) return;

        // 获取上游数据
        const upstreamData = DataSource.getUpstreamData(cardId, dataType);
        if (!upstreamData || upstreamData.length === 0) return;

        // 检查 receivePolicy
        const contract = card.constructor.getContract?.();
        const inputs = contract?.inputs || [];
        const matchingInput = inputs.find(i => i.type === dataType);
        const policy = matchingInput?.receivePolicy || 'replace';

        if (policy === 'ignore') return;

        // 调用 onReceive
        if (dataType === 'text') {
            // 文本：取第一个（replace 策略）或合并（append 策略）
            if (policy === 'replace') {
                card.onReceive(dataType, upstreamData[0].data, {
                    source: 'upstream',
                    sourceCardId: upstreamData[0].sourceCardId,
                    connectionId: upstreamData[0].connectionId,
                    endPort: upstreamData[0].endPort
                });
            } else if (policy === 'append') {
                // append 策略：多次调用
                upstreamData.forEach(item => {
                    card.onReceive(dataType, item.data, {
                        source: 'upstream',
                        sourceCardId: item.sourceCardId,
                        connectionId: item.connectionId,
                        endPort: item.endPort
                    });
                });
            }
        } else if (dataType === 'image') {
            // 图片：多次调用（append 策略）
            upstreamData.forEach(item => {
                card.onReceive(dataType, item.data, {
                    source: 'upstream',
                    sourceCardId: item.sourceCardId,
                    connectionId: item.connectionId,
                    endPort: item.endPort
                });
            });
        }
    },

    /**
     * 获取指定卡片的所有下游卡片
     */
    _getDownstreamCards(sourceCardId, dataType) {
        const result = [];

        const connections = AppState.connections.list
            .filter(c => c.start === sourceCardId);

        for (const conn of connections) {
            const targetCard = CardFactory.getInstance(conn.end);
            if (!targetCard) continue;

            // 检查目标卡片是否接受这个类型
            const contract = targetCard.constructor.getContract?.();
            const inputs = contract?.inputs || [];
            const matchingInput = inputs.find(i => i.type === dataType);

            if (matchingInput) {
                result.push(conn.end);
            }
        }

        return result;
    },

    /**
     * 拓扑排序（Kahn 算法）
     * 返回排序后的卡片 ID 数组，如果存在循环返回 null
     */
    _topoSort(cardIds) {
        const idSet = new Set(cardIds);
        const connections = AppState.connections.list;

        // 构建入度表
        const inDegree = new Map();
        const adjList = new Map();

        cardIds.forEach(id => {
            inDegree.set(id, 0);
            adjList.set(id, []);
        });

        // 计算入度（只考虑 batch 内部的依赖）
        cardIds.forEach(id => {
            connections.forEach(conn => {
                if (conn.start === id && idSet.has(conn.end)) {
                    adjList.get(id).push(conn.end);
                    inDegree.set(conn.end, inDegree.get(conn.end) + 1);
                }
            });
        });

        // Kahn 算法
        const queue = [];
        for (const [id, deg] of inDegree) {
            if (deg === 0) queue.push(id);
        }

        const result = [];
        while (queue.length > 0) {
            const id = queue.shift();
            result.push(id);

            for (const neighbor of adjList.get(id) || []) {
                inDegree.set(neighbor, inDegree.get(neighbor) - 1);
                if (inDegree.get(neighbor) === 0) {
                    queue.push(neighbor);
                }
            }
        }

        // 如果有循环，部分节点不会被处理
        if (result.length !== cardIds.length) {
            return null;  // 存在循环依赖
        }

        return result;
    },

    /**
     * 获取卡片的执行依赖链（用于调试）
     */
    getDependencyChain(cardId) {
        const chain = [];
        const visited = new Set();

        const traverse = (id) => {
            if (visited.has(id)) return;
            visited.add(id);

            const connections = AppState.connections.list
                .filter(c => c.end === id);

            for (const conn of connections) {
                const upstream = CardFactory.getInstance(conn.start);
                if (upstream) {
                    chain.push({
                        from: conn.start,
                        to: id,
                        type: upstream.constructor.getDataType?.()
                    });
                    traverse(conn.start);
                }
            }
        };

        traverse(cardId);
        return chain;
    },

    /**
     * 检查是否存在循环依赖
     * @param {string} cardId - 起始卡片 ID
     * @returns {boolean} - 是否存在循环
     */
    hasCycle(cardId) {
        const visited = new Set();
        const recursionStack = new Set();

        const dfs = (id) => {
            visited.add(id);
            recursionStack.add(id);

            const connections = AppState.connections.list
                .filter(c => c.start === id);

            for (const conn of connections) {
                if (!visited.has(conn.end)) {
                    if (dfs(conn.end)) return true;
                } else if (recursionStack.has(conn.end)) {
                    return true;
                }
            }

            recursionStack.delete(id);
            return false;
        };

        return dfs(cardId);
    }
};

window.PipelineEngine = PipelineEngine;
