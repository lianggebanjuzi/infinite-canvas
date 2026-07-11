/**
 * 卡片连接规则引擎
 * 基于契约的通用规则系统，替代原有的硬编码规则注册表
 *
 * 核心原则：
 * 1. 按类型匹配（text→text, image→image），不按卡片类型逐对注册
 * 2. 特殊效果用生命周期钩子写在卡片自身，不写在全局表
 * 3. 所有连接建立/断开/数据变化都通过 CardEventBus 统一处理
 *
 * 保留向后兼容：
 * - register() 方法保留，已有的规则继续生效
 * - 新增通用规则优先匹配，已有规则作为特殊覆盖
 * - PipelineEngine 作为可选功能，默认关闭
 */
const ConnectionRules = (() => {

    // ─────────────────────────────────────────────────────────
    // Feature Flag: 是否启用 PipelineEngine 模式
    // true = 使用 PipelineEngine 统一调度（新增行为）
    // false = 使用现有契约规则（向后兼容）
    // ─────────────────────────────────────────────────────────
    const _usePipelineEngine = true;

    // ─────────────────────────────────────────────────────────
    // 生命周期钩子注册表（特殊效果）
    // key 格式: 'sourceType→targetType' 或 'sourceType+targetType'（compare 用）
    // ─────────────────────────────────────────────────────────
    const _lifecycleHooks = {};

    // ─────────────────────────────────────────────────────────
    // 注册生命周期钩子
    // ─────────────────────────────────────────────────────────
    function register(key, handler) {
        _lifecycleHooks[key] = handler;
    }

    // ─────────────────────────────────────────────────────────
    // 获取规则 key
    // ─────────────────────────────────────────────────────────
    function _getKey(sourceCard, targetCard) {
        const sourceType = sourceCard.getType();
        const targetType = targetCard.getType();
        if (targetType === 'compare') {
            return `${sourceType}+compare`;
        }
        return `${sourceType}→${targetType}`;
    }

    // ─────────────────────────────────────────────────────────
    // 执行生命周期钩子
    // ─────────────────────────────────────────────────────────
    function _applyHook(key, sourceCard, targetCard, endPort = null, isDisconnect = false) {
        const hookKey = isDisconnect ? `${key}:disconnect` : key;
        const hook = _lifecycleHooks[hookKey];
        if (hook) {
            const t0 = performance.now();
            try {
                hook(sourceCard, targetCard, endPort);
            } catch (e) {
                console.error(`[ConnectionRules] Hook error (${hookKey}):`, e);
            }
            const t1 = performance.now();
            if (t1 - t0 > 16) {
                console.warn(`[ConnectionRules] ⚠️ 钩子 "${hookKey}" 耗时 ${(t1-t0).toFixed(1)}ms`);
            }
        }
    }

    // ─────────────────────────────────────────────────────────
    // 通用契约匹配：按类型自动处理数据流转
    //
    // 职责说明（重要）：
    //   这个函数负责在连接建立时，把上游卡片的数据"推"给下游卡片。
    //   它会根据目标卡片的输入契约，找到匹配的端口类型，
    //   然后调用目标卡片的 onReceive() 方法完成数据传递。
    //
    //   onReceive() 方法里面会做什么，由目标卡片自己决定——
    //   比如 AIDrawCard 会加缩略图，AgentCard 会刷新预览区。
    //
    //   所以连接时只需要走这一条路就够了，不需要钩子再调一次 addRefImage，
    //   否则同一张图片会被加两次缩略图。
    // ─────────────────────────────────────────────────────────
    function _applyContractRules(sourceCard, targetCard, endPort = null) {
        const t0 = performance.now();
        if (!sourceCard || !targetCard) return;

        const sourceDataType = sourceCard.constructor.getDataType?.() || null;
        if (!sourceDataType) return;

        // 根据 targetCard 的输入契约决定如何处理
        const contract = targetCard.constructor.getContract?.() || {};
        const inputs = contract.inputs || [];

        // 优先按 endPort 精确查找端口（CompareCard 有 A/B 两个同名 type 的端口）
        let matchingInput = null;
        if (endPort) {
            matchingInput = inputs.find(input => input.name === endPort);
        }

        // 没有 endPort 或按端口名没找到，按类型匹配
        if (!matchingInput) {
            matchingInput = inputs.find(input =>
                input.type === sourceDataType ||
                (input.multiple && input.type === sourceDataType)
            );
        }

        if (!matchingInput) return;

        // 根据 receivePolicy 处理数据
        const policy = matchingInput.receivePolicy || 'replace';

        if (policy === 'ignore') return;

        // 获取上游数据
        const upstreamData = sourceCard.getOutput ? sourceCard.getOutput() : null;
        if (!upstreamData) return;

        const t1 = performance.now();

        // 调用目标卡片的 onReceive() 方法，传递数据（带 endPort 信息）
        if (targetCard.onReceive) {
            targetCard.onReceive(sourceDataType, upstreamData, sourceCard.id, endPort);
        }

        const t2 = performance.now();
        if (t2 - t0 > 16) {
            console.warn(`[ConnectionRules] ⚠️ _applyContractRules 总耗时 ${(t2-t0).toFixed(1)}ms | 查找端口:${(t1-t0).toFixed(1)}ms onReceive:${(t2-t1).toFixed(1)}ms dataSize:${upstreamData.length}`);
        }
    }

    // ─────────────────────────────────────────────────────────
    // 连接建立时调用
    //
    // 执行顺序（重要！不要打乱）：
    //   1. 钩子：处理特殊效果（禁用输入框、更新提示文字等纯 UI 效果）
    //   2. 通用契约规则：传递数据，触发 onReceive()
    //   3. 更新端口显示
    //
    // 注意：钩子和契约规则各自做各自的事，不会重复。
    //       钩子只做"不需要数据的 UI 更新"（如禁用输入框），
    //       契约规则负责"需要把数据送过去"（如加缩略图）。
    // ─────────────────────────────────────────────────────────
    function applyOnConnect(sourceCard, targetCard, endPort = null) {
        const t0 = performance.now();
        if (!sourceCard || !targetCard) return;

        const key = _getKey(sourceCard, targetCard);

        // 1. 执行生命周期钩子（只做 UI 效果，不传数据）
        _applyHook(key, sourceCard, targetCard, endPort, false);

        const t1 = performance.now();

        // 2. 执行数据传递（PipelineEngine 或契约规则）
        if (_usePipelineEngine && typeof PipelineEngine !== 'undefined') {
            // PipelineEngine 模式：统一调度
            const dataType = sourceCard.constructor.getDataType?.();
            if (dataType) {
                PipelineEngine.trigger(sourceCard.id, dataType);
            }
        } else {
            // 传统模式：契约规则直接传递数据
            _applyContractRules(sourceCard, targetCard, endPort);
        }

        const t2 = performance.now();

        // 3. 更新端口显示
        sourceCard._updatePortsVisibility?.();
        targetCard._updatePortsVisibility?.();

        const t3 = performance.now();
        if (t3 - t0 > 16) {
            console.warn(`[ConnectionRules] ⚠️ applyOnConnect 总耗时 ${(t3-t0).toFixed(1)}ms | hook:${(t1-t0).toFixed(1)}ms contract:${(t2-t1).toFixed(1)}ms ports:${(t3-t2).toFixed(1)}ms`);
        }
        if (t3 - t0 > 50) {
            console.error(`[ConnectionRules] 🔴 严重卡顿 applyOnConnect=${(t3-t0).toFixed(1)}ms hook=${(t1-t0).toFixed(1)}ms contract=${(t2-t1).toFixed(1)}ms`);
        }
    }

    // ─────────────────────────────────────────────────────────
    // 连接断开时调用
    //
    // 执行顺序：
    //   1. 钩子：处理断开时的特殊效果（恢复输入框等）
    //   2. 刷新目标卡片：让它重新读取当前的连线状态，更新界面
    //      比如 AIDrawCard 会根据当前连线重新渲染参考图列表，
    //      AgentCard 会重新计算上游内容并更新预览区。
    //      这样断开后界面会自动变成"断开后的正确状态"。
    //   3. 更新端口显示
    // ─────────────────────────────────────────────────────────
    function applyOnDisconnect(sourceCard, targetCard) {
        if (!sourceCard || !targetCard) return;

        const key = _getKey(sourceCard, targetCard);

        // 1. 执行生命周期钩子（纯 UI 效果，如恢复输入框）
        _applyHook(key, sourceCard, targetCard, null, true);

        // 2. 通知目标卡片刷新：根据当前连线状态重新渲染
        //    这是关键！有了这个，即使没有专门写 disconnect 钩子，
        //    卡片也能在断开后自动更新到正确状态。
        //    AgentCard 之前就是缺少这个方法导致预览不消失。
        if (targetCard.refreshUpstream) {
            targetCard.refreshUpstream();
        }

        // 3. 更新端口显示
        sourceCard._updatePortsVisibility?.();
        targetCard._updatePortsVisibility?.();
    }

    // ─────────────────────────────────────────────────────────
    // 数据变化时调用（由 CardEventBus 触发）
    // 当上游卡片的数据变了（如重新生成图片），通知所有下游
    // ─────────────────────────────────────────────────────────
    function applyOnDataChanged(sourceCard, dataType, data) {
        if (!sourceCard) return;

        if (_usePipelineEngine && typeof PipelineEngine !== 'undefined') {
            // PipelineEngine 模式：统一调度
            PipelineEngine.trigger(sourceCard.id, dataType);
        } else {
            // 传统模式：遍历所有下游
            const connections = AppState.connections.list
                .filter(c => c.start === sourceCard.id);

            connections.forEach(c => {
                const targetCard = CardFactory.getInstance(c.end);
                if (!targetCard) return;

                // 检查 targetCard 是否接受这个类型
                const contract = targetCard.constructor.getContract?.() || {};
                const inputs = contract.inputs || [];

                // 优先按 endPort 精确查找端口
                let matchingInput = null;
                if (c.endPort) {
                    matchingInput = inputs.find(input => input.name === c.endPort);
                }

                if (!matchingInput) {
                    matchingInput = inputs.find(input =>
                        input.type === dataType ||
                        (input.multiple && input.type === dataType)
                    );
                }

                if (matchingInput && targetCard.onReceive) {
                    const policy = matchingInput.receivePolicy || 'replace';
                    if (policy !== 'ignore') {
                        // 把 sourceCard.id 和 endPort 传过去，让目标卡片知道数据来自哪个上游
                        targetCard.onReceive(dataType, data, sourceCard.id, c.endPort);
                    }
                }
            });
        }
    }

    // ─────────────────────────────────────────────────────────
    // 运行完成时调用（由 CardEventBus 触发）
    // 当卡片运行完成后，把输出数据推给下游
    // ─────────────────────────────────────────────────────────
    function applyOnRunCompleted(card, dataType, data) {
        if (!card) return;

        if (_usePipelineEngine && typeof PipelineEngine !== 'undefined') {
            // PipelineEngine 模式：统一调度
            PipelineEngine.trigger(card.id, dataType);
        } else {
            // 传统模式：遍历所有下游
            const connections = AppState.connections.list
                .filter(c => c.start === card.id);

            connections.forEach(c => {
                const targetCard = CardFactory.getInstance(c.end);
                if (!targetCard) return;

                // 推送数据到下游
                if (targetCard.onReceive) {
                    // 把 card.id 传过去，让目标卡片知道数据来自哪个上游
                    targetCard.onReceive(dataType, data, card.id);
                }
            });
        }
    }

    // ─────────────────────────────────────────────────────────
    // 向后兼容：保留原有的 register/execute 接口
    // ─────────────────────────────────────────────────────────
    function execute(sourceCard, targetCard, endPort) {
        // 兼容旧代码中直接调用 execute 的场景
        applyOnConnect(sourceCard, targetCard, endPort);
    }

    return {
        register,
        applyOnConnect,
        applyOnDisconnect,
        applyOnDataChanged,
        applyOnRunCompleted,
        execute,       // 向后兼容
    };
})();

// ═══════════════════════════════════════════════════════════════════════════
// 生命周期钩子注册表
//
// 原则：只写"不需要传数据"的纯 UI 效果。
//       所有需要传递数据的操作（如加缩略图），都由通用契约引擎的 onReceive 统一处理。
//       这样保证"连一次只触发一次"，不会出现重复添加的问题。
// ═══════════════════════════════════════════════════════════════════════════

// text → AIDrawCard：禁用输入框（断开时由 applyOnDisconnect 中的 refreshUpstream 自动处理）
ConnectionRules.register('text→ai-image', (sourceCard, targetCard) => {
    targetCard.updateUpstreamTextHint?.();
});

// agent → AIDrawCard：禁用输入框（断开时由 applyOnDisconnect 自动处理）
ConnectionRules.register('agent→ai-image', (sourceCard, targetCard) => {
    targetCard.updateUpstreamTextHint?.();
});

// image/agent/preview → compare：设置 A/B 槽位（合并为一个钩子）
['image+compare', 'preview+compare', 'agent+compare'].forEach(key => {
    ConnectionRules.register(key, (sourceCard, targetCard, endPort) => {
        const src = sourceCard.getOutput?.();
        if (!src) return;

        // endPort 是连线建立时记录的 'A' 或 'B'，是唯一可靠的事实来源
        if (endPort === 'A') {
            // 明确连到 A 端口 → 放 A
            targetCard.setImageA?.(src);
        } else if (endPort === 'B') {
            // 明确连到 B 端口 → 放 B
            targetCard.setImageB?.(src);
        } else {
            // endPort 为 null（从旧数据恢复或边缘情况）→ 按槽位优先分配
            if (!targetCard.imageA) {
                targetCard.setImageA?.(src);
            } else if (!targetCard.imageB) {
                targetCard.setImageB?.(src);
            } else {
                targetCard.setImageA?.(src);
            }
        }

        // 注意：这里不调用 refreshUpstream，因为数据已经由 setImageA/setImageB 设置了
        // setImageA/setImageB 内部已经调用了 _refreshContent()
        // refreshUpstream 的职责是"重新读取连线状态"，而不是"设置数据"
    });
});

// agent → Agent：更新下游提示
ConnectionRules.register('agent→agent', (sourceCard, targetCard) => {
    targetCard.updateUpstreamHint?.();
});

window.ConnectionRules = ConnectionRules;
