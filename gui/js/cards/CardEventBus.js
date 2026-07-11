/**
 * 卡片事件总线
 * 所有卡片通过事件总线通信，不直接调用其他卡片的方法
 * 事件按类型过滤（text/image），订阅方根据契约自动匹配
 */
const CardEventBus = (() => {
    // 事件类型常量
    const EventTypes = {
        DATA_CHANGED:   'data:changed',    // 数据变化（blur/手动修改/上游推送）
        RUN_STARTED:    'run:started',     // 开始运行
        RUN_COMPLETED:  'run:completed',   // 运行完成
        CONNECTED:      'connected',        // 连接建立
        DISCONNECTED:   'disconnected',    // 连接断开
    };

    // 订阅者 Map: eventType -> [{ filter, callback }]
    const _subscribers = new Map();

    // 订阅事件
    function subscribe(eventType, callback, filter = null) {
        if (!_subscribers.has(eventType)) {
            _subscribers.set(eventType, []);
        }
        _subscribers.get(eventType).push({ callback, filter });
    }

    // 退订事件
    function unsubscribe(eventType, callback) {
        const list = _subscribers.get(eventType);
        if (!list) return;
        const index = list.findIndex(s => s.callback === callback);
        if (index !== -1) list.splice(index, 1);
    }

    // 发布事件
    function emit(eventType, payload) {
        const list = _subscribers.get(eventType) || [];
        list.forEach(({ callback, filter }) => {
            // 如果有 filter，执行 filter 后返回 true 才调用
            if (filter && !filter(payload)) return;
            try {
                callback(payload);
            } catch (e) {
                console.error(`[CardEventBus] ${eventType} handler error:`, e);
            }
        });
    }

    // 按类型过滤：只关心特定 output type 的事件
    function byType(outputType) {
        return (payload) => payload.type === outputType;
    }

    // 按卡片 ID 过滤：只关心特定卡片的事件
    function byCard(cardId) {
        return (payload) => payload.cardId === cardId;
    }

    // 按连接方向过滤：以某卡片为起点连接到 payload.cardId 的连接是否存在
    // 注意：此处逻辑与「检查有没有卡片连接到 cardId」不同
    function byUpstreamOf(cardId) {
        return (payload) => {
            return AppState.connections.list.some(
                c => c.start === cardId && c.end === payload.cardId
            );
        };
    }

    return {
        EventTypes,
        subscribe,
        unsubscribe,
        emit,
        byType,
        byCard,
        byUpstreamOf,
    };
})();

window.CardEventBus = CardEventBus;
