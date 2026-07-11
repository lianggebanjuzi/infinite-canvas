/**
 * 事件总线订阅初始化
 * 所有卡片的事件总线订阅集中在此处注册，避免散落在各卡片文件末尾，
 * 减少加载顺序依赖，确保 CardEventBus 已完全初始化后再执行订阅。
 *
 * 加载顺序要求：此文件必须在所有卡片 JS 之后加载。
 *
 * PipelineEngine 模式说明：
 * - ConnectionRules 中的 _usePipelineEngine 标志控制是否启用
 * - 启用后，数据传递由 PipelineEngine 统一调度
 * - 当前默认为 false，保持向后兼容
 */

(function () {
    'use strict';

    // 等待 CardEventBus、CardFactory、ConnectionRules 和 PipelineEngine 初始化
    function waitAndSubscribe(timeout) {
        if (typeof CardEventBus === 'undefined' ||
            typeof CardFactory === 'undefined' ||
            typeof ConnectionRules === 'undefined' ||
            typeof PipelineEngine === 'undefined' ||
            typeof DataSource === 'undefined') {
            if (timeout > 0) {
                setTimeout(() => waitAndSubscribe(timeout - 100), 100);
            }
            return;
        }
        _doSubscribe();
    }

    function _doSubscribe() {

        // ─────────────────────────────────────────────────────────
        // TextCard 订阅：文本数据变化时通知所有下游
        // ─────────────────────────────────────────────────────────
        CardEventBus.subscribe(CardEventBus.EventTypes.DATA_CHANGED,
            (event) => {
                if (event.type !== 'text') return;
                ConnectionRules.applyOnDataChanged(
                    CardFactory.getInstance(event.cardId),
                    event.type,
                    event.data
                );
            },
            CardEventBus.byType('text')
        );

        // ─────────────────────────────────────────────────────────
        // ImageInputCard 订阅：图片数据变化时通知下游
        // ─────────────────────────────────────────────────────────
        CardEventBus.subscribe(CardEventBus.EventTypes.DATA_CHANGED,
            (event) => {
                if (event.type !== 'image') return;
                ConnectionRules.applyOnDataChanged(
                    CardFactory.getInstance(event.cardId),
                    event.type,
                    event.data
                );
            },
            CardEventBus.byType('image')
        );

        // ─────────────────────────────────────────────────────────
        // PreviewCard 订阅：预览图片变化时通知下游
        // ─────────────────────────────────────────────────────────
        CardEventBus.subscribe(CardEventBus.EventTypes.DATA_CHANGED,
            (event) => {
                if (event.type !== 'image') return;
                ConnectionRules.applyOnDataChanged(
                    CardFactory.getInstance(event.cardId),
                    event.type,
                    event.data
                );
            },
            CardEventBus.byType('image')
        );

        // ─────────────────────────────────────────────────────────
        // CompareCard 订阅：已移除（2026-03-25）
        //
        // CompareCard 不需要单独的 DATA_CHANGED 订阅，原因：
        // 1. ConnectionRules.applyOnDataChanged 已经通过 onReceive 处理了数据流转
        // 2. CompareCard 的 refreshUpstream 只在"连接建立/断开"时由 ConnectionRules 显式调用
        // 3. 如果在此订阅中调用 refreshUpstream，会与 onReceive 竞争，导致重复刷新
        //    表现：图片数据变化时，onReceive 先设置值，refreshUpstream 又设置一遍，
        //    可能覆盖或重复刷新。
        // ─────────────────────────────────────────────────────────

        // ─────────────────────────────────────────────────────────
        // DrawingBoardCard 订阅：画板图片变化时通知下游
        // 注意：DrawingBoardCard 的 notifyDownstream 已被覆盖为静默模式，
        // 仅在"应用"按钮触发时才真正通知下游。此处订阅用于被动响应其他卡片的图片事件。
        // ─────────────────────────────────────────────────────────
        CardEventBus.subscribe(CardEventBus.EventTypes.DATA_CHANGED,
            (event) => {
                if (event.type !== 'image') return;
                ConnectionRules.applyOnDataChanged(
                    CardFactory.getInstance(event.cardId),
                    event.type,
                    event.data
                );
            },
            CardEventBus.byType('image')
        );

        // ─────────────────────────────────────────────────────────
        // AgentCard 订阅：运行完成后自动推送结果到下游
        // ─────────────────────────────────────────────────────────
        CardEventBus.subscribe(CardEventBus.EventTypes.RUN_COMPLETED,
            (event) => {
                if (event.type !== 'text') return;

                const card = CardFactory.getInstance(event.cardId);
                if (!card || card.getType() !== 'agent') return;

                // 找到所有以该 AgentCard 为起点的连接
                const connections = AppState.connections.list
                    .filter(c => c.start === card.id);

                connections.forEach(c => {
                    const downstream = CardFactory.getInstance(c.end);
                    if (!downstream) return;

                    if (downstream.getType() === 'text') {
                        // 追加而非覆盖
                        const textarea = downstream.element?.querySelector('textarea');
                        const existing = textarea?.value?.trim() || '';
                        const newContent = existing
                            ? `${existing}\n\n---\n\n${event.data}`
                            : event.data;
                        downstream.setText(newContent);
                    } else if (downstream.getType() === 'agent') {
                        downstream.updateUpstreamHint?.();
                    } else if (downstream.onReceive) {
                        downstream.onReceive(event.type, event.data, 'run');
                    }
                });
            },
            CardEventBus.byType('text')
        );

        // ─────────────────────────────────────────────────────────
        // AIDrawCard 订阅：生成图片完成后自动通知下游
        // ─────────────────────────────────────────────────────────
        CardEventBus.subscribe(CardEventBus.EventTypes.RUN_COMPLETED,
            (event) => {
                if (event.type !== 'image') return;
                const card = CardFactory.getInstance(event.cardId);
                if (!card || card.getType() !== 'ai-image') return;
                if (!event.data) return;

                const connections = AppState.connections.list
                    .filter(c => c.start === card.id);

                connections.forEach(c => {
                    const downstream = CardFactory.getInstance(c.end);
                    if (!downstream) return;

                    // 通用推送
                    if (downstream.onReceive) {
                        downstream.onReceive(event.type, event.data, event.cardId);
                    }
                });
            },
            CardEventBus.byType('image')
        );

        const pipelineMode = ConnectionRules._usePipelineEngine;
        console.log(`[CardEventBus] 所有订阅初始化完成${pipelineMode ? '（PipelineEngine 模式）' : '（传统模式）'}`);
    }

    // 立即尝试，失败则最多等待 500ms
    waitAndSubscribe(500);

    window.CardEventBusInit = { _doSubscribe };
})();
