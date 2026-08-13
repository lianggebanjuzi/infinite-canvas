// src/cards/card-event-bus.ts
// 卡片事件总线 — 所有卡片通过事件总线通信，不直接调用其他卡片的方法

import { CardEventPayload, CardEventFilter, CardEventCallback } from '../types/cards';
import { AppState } from '../state/app-state';

// 事件类型常量
const EventTypes = {
  DATA_CHANGED:   'data:changed',
  RUN_STARTED:    'run:started',
  RUN_COMPLETED:  'run:completed',
  CONNECTED:      'connected',
  DISCONNECTED:   'disconnected',
} as const;

type EventType = typeof EventTypes[keyof typeof EventTypes];

// 订阅者 Map: eventType -> [{ callback, filter }]
const _subscribers = new Map<string, Array<{ callback: CardEventCallback; filter?: CardEventFilter }>>();

function subscribe(eventType: string, callback: CardEventCallback, filter?: CardEventFilter): void {
  if (!_subscribers.has(eventType)) {
    _subscribers.set(eventType, []);
  }
  _subscribers.get(eventType)!.push({ callback, filter });
}

function unsubscribe(eventType: string, callback: CardEventCallback): void {
  const list = _subscribers.get(eventType);
  if (!list) return;
  const idx = list.findIndex(s => s.callback === callback);
  if (idx !== -1) list.splice(idx, 1);
}

function emit(eventType: string, payload: CardEventPayload): void {
  const list = _subscribers.get(eventType) || [];
  list.forEach(({ callback, filter }) => {
    if (filter && !filter(payload)) return;
    try {
      callback(payload);
    } catch (e) {
      console.error(`[CardEventBus] ${eventType} handler error:`, e);
    }
  });
}

function byType(outputType: string): CardEventFilter {
  return (payload) => payload.type === outputType;
}

function byCard(cardId: string): CardEventFilter {
  return (payload) => payload.cardId === cardId;
}

function byUpstreamOf(cardId: string): CardEventFilter {
  return (payload) => {
    return (AppState.connections.list as Array<{ start: string; end: string }>).some(
      c => c.start === cardId && c.end === payload.cardId
    );
  };
}

export const CardEventBus = {
  EventTypes,
  subscribe,
  unsubscribe,
  emit,
  byType,
  byCard,
  byUpstreamOf,
};

// 桥接到 window
(window as unknown as { CardEventBus: typeof CardEventBus }).CardEventBus = CardEventBus;
