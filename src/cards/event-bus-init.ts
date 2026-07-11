// src/cards/event-bus-init.ts
// 事件总线订阅初始化

import { AppState } from '../state/app-state';

declare const CardEventBus: {
  EventTypes: { DATA_CHANGED: string; RUN_COMPLETED: string };
  subscribe(type: string, handler: Function, filter?: (event: unknown) => boolean): void;
  byType(type: string): (event: unknown) => boolean;
};
declare const ConnectionRules: {
  applyOnDataChanged(sourceCard: unknown, dataType: string, data: unknown): void;
};
declare const PipelineEngine: { trigger(cardId: string, dataType: string): void };
declare const CardFactory: {
  getInstance(cardId: string): {
    id: string;
    getType?(): string;
    getOutput?(name?: string): unknown;
    onReceive?(type: string, data: unknown, source?: unknown): void;
    updateUpstreamHint?(): void;
    setText?(text: string): void;
    element?: HTMLElement | null;
  } | null;
};
declare const DataSource: { getUpstreamContent(cardId: string): { texts: string[]; images: string[] } };

function waitAndSubscribe(timeout: number): void {
  if (typeof CardEventBus === 'undefined' ||
      typeof CardFactory === 'undefined' ||
      typeof ConnectionRules === 'undefined' ||
      typeof PipelineEngine === 'undefined' ||
      typeof DataSource === 'undefined') {
    if (timeout > 0) setTimeout(() => waitAndSubscribe(timeout - 100), 100);
    return;
  }
  _doSubscribe();
}

function _doSubscribe(): void {
  // TextCard & ImageInputCard & PreviewCard & DrawingBoardCard: 数据变化通知下游
  ['text', 'image'].forEach(dataType => {
    CardEventBus.subscribe(
      CardEventBus.EventTypes.DATA_CHANGED,
      (event: unknown) => {
        const ev = event as { cardId: string; type: string; data: unknown };
        if (ev.type !== dataType) return;
        ConnectionRules.applyOnDataChanged(CardFactory.getInstance(ev.cardId), ev.type, ev.data);
      },
      CardEventBus.byType(dataType)
    );
  });

  // AgentCard: 运行完成后推送结果到下游
  CardEventBus.subscribe(
    CardEventBus.EventTypes.RUN_COMPLETED,
    (event: unknown) => {
      const ev = event as { cardId: string; type: string; data: unknown };
      if (ev.type !== 'text') return;
      const card = CardFactory.getInstance(ev.cardId);
      if (!card || card.getType?.() !== 'agent') return;

      const connections = (AppState.connections.list as Array<{ start: string; end: string }>)
        .filter(c => c.start === card.id);

      connections.forEach(c => {
        const downstream = CardFactory.getInstance(c.end);
        if (!downstream) return;

        const type = downstream.getType?.();
        if (type === 'text') {
          const textarea = downstream.element?.querySelector('textarea') as HTMLTextAreaElement | null;
          const existing = textarea?.value?.trim() || '';
          const newContent = existing ? `${existing}\n\n---\n\n${ev.data}` : String(ev.data);
          downstream.setText?.(newContent);
        } else if (type === 'agent') {
          downstream.updateUpstreamHint?.();
        } else if (downstream.onReceive) {
          downstream.onReceive(ev.type, ev.data, 'run');
        }
      });
    },
    CardEventBus.byType('text')
  );

  // AIDrawCard: 生成图片完成后通知下游
  CardEventBus.subscribe(
    CardEventBus.EventTypes.RUN_COMPLETED,
    (event: unknown) => {
      const ev = event as { cardId: string; type: string; data: unknown };
      if (ev.type !== 'image') return;
      const card = CardFactory.getInstance(ev.cardId);
      if (!card || card.getType?.() !== 'ai-image') return;
      if (!ev.data) return;

      const connections = (AppState.connections.list as Array<{ start: string; end: string }>)
        .filter(c => c.start === card.id);

      connections.forEach(c => {
        const downstream = CardFactory.getInstance(c.end);
        if (!downstream) return;
        if (downstream.onReceive) {
          downstream.onReceive(ev.type, ev.data, ev.cardId);
        }
      });
    },
    CardEventBus.byType('image')
  );

  const pipelineMode = (ConnectionRules as unknown as { _usePipelineEngine?: boolean })._usePipelineEngine;
  console.log(`[CardEventBus] 所有订阅初始化完成${pipelineMode ? '（PipelineEngine 模式）' : '（传统模式）'}`);
}

waitAndSubscribe(500);

(window as unknown as { CardEventBusInit: { _doSubscribe: () => void } }).CardEventBusInit = { _doSubscribe };
