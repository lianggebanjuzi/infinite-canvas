// src/cards/pipeline-engine.ts
// 统一执行调度器 — 拓扑排序 + 批量调度

import { AppState } from '../state/app-state';
import { getUpstreamData } from './data-source';

declare const CardFactory: {
  getInstance(id: string): {
    onReceive?: Function;
    getOutput?: (name?: string) => unknown;
    constructor?: {
      getContract?(): { inputs?: Array<{ name?: string; type: string; receivePolicy?: string }> };
      getDataType?(): string | null;
    };
  } | null;
};

const PipelineEngine = {
  _processing: new Set<string>(),

  trigger(sourceCardId: string, dataType: string): void {
    if (this._processing.has(sourceCardId)) return;
    this._processing.add(sourceCardId);

    try {
      const downstreamCards = this._getDownstreamCards(sourceCardId, dataType);
      if (downstreamCards.length === 0) return;

      const sorted = this._topoSort(downstreamCards);
      if (!sorted) {
        console.warn('[PipelineEngine] 检测到循环依赖，跳过执行');
        return;
      }

      for (const cardId of sorted) {
        this._dispatch(cardId, dataType);
      }
    } finally {
      this._processing.delete(sourceCardId);
    }
  },

  _dispatch(cardId: string, dataType: string): void {
    const card = CardFactory.getInstance(cardId);
    if (!card || !card.onReceive) return;

    const upstreamData = getUpstreamData(cardId, dataType);
    if (!upstreamData || upstreamData.length === 0) return;

    const contract = card.constructor?.getContract?.() || {};
    const inputs = contract.inputs || [];
    const matchingInput = inputs.find((i: { type: string }) => i.type === dataType);
    const policy = matchingInput?.receivePolicy || 'replace';

    if (policy === 'ignore') return;

    const onReceive = card.onReceive as Function | undefined;
    if (!onReceive) return;

    if (dataType === 'text') {
      if (policy === 'replace') {
        onReceive.call(card, dataType, upstreamData[0].data, {
          source: 'upstream',
          sourceCardId: upstreamData[0].sourceCardId,
          connectionId: upstreamData[0].connectionId,
          endPort: upstreamData[0].endPort
        });
      } else {
        upstreamData.forEach(item => {
          onReceive.call(card, dataType, item.data, {
            source: 'upstream',
            sourceCardId: item.sourceCardId,
            connectionId: item.connectionId,
            endPort: item.endPort
          });
        });
      }
    } else if (dataType === 'image') {
      upstreamData.forEach(item => {
        onReceive.call(card, dataType, item.data, {
          source: 'upstream',
          sourceCardId: item.sourceCardId,
          connectionId: item.connectionId,
          endPort: item.endPort
        });
      });
    }
  },

  _getDownstreamCards(sourceCardId: string, dataType: string): string[] {
    const result: string[] = [];

    const connections = AppState.connections.list as Array<{ start: string; end: string }>;
    connections.filter(c => c.start === sourceCardId).forEach(conn => {
      const targetCard = CardFactory.getInstance(conn.end);
      if (!targetCard) return;

      const contract = targetCard.constructor?.getContract?.() || {};
      const inputs = contract.inputs || [];
      const matchingInput = inputs.find((i: { type: string }) => i.type === dataType);
      if (matchingInput) result.push(conn.end);
    });

    return result;
  },

  _topoSort(cardIds: string[]): string[] | null {
    const idSet = new Set(cardIds);
    const connections = AppState.connections.list as Array<{ start: string; end: string }>;

    const inDegree = new Map<string, number>();
    const adjList = new Map<string, string[]>();

    cardIds.forEach(id => {
      inDegree.set(id, 0);
      adjList.set(id, []);
    });

    cardIds.forEach(id => {
      connections.forEach(conn => {
        if (conn.start === id && idSet.has(conn.end)) {
          adjList.get(id)!.push(conn.end);
          inDegree.set(conn.end, (inDegree.get(conn.end) ?? 0) + 1);
        }
      });
    });

    const queue: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    const result: string[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      result.push(id);

      (adjList.get(id) || []).forEach(neighbor => {
        inDegree.set(neighbor, inDegree.get(neighbor)! - 1);
        if (inDegree.get(neighbor) === 0) queue.push(neighbor);
      });
    }

    return result.length === cardIds.length ? result : null;
  },

  getDependencyChain(cardId: string): Array<{ from: string; to: string; type: string | null }> {
    const chain: Array<{ from: string; to: string; type: string | null }> = [];
    const visited = new Set<string>();

    const traverse = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);

      (AppState.connections.list as Array<{ start: string; end: string }>)
        .filter(c => c.end === id)
        .forEach(conn => {
          const upstream = CardFactory.getInstance(conn.start);
          if (upstream) {
            chain.push({
              from: conn.start,
              to: id,
              type: (upstream.constructor as { getDataType?(): string | null } | undefined)?.getDataType?.() ?? null
            });
            traverse(conn.start);
          }
        });
    };

    traverse(cardId);
    return chain;
  },

  hasCycle(cardId: string): boolean {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const dfs = (id: string): boolean => {
      visited.add(id);
      recursionStack.add(id);

      const connections = AppState.connections.list as Array<{ start: string; end: string }>;
      for (const conn of connections.filter(c => c.start === id)) {
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

export { PipelineEngine };
(window as unknown as { PipelineEngine: typeof PipelineEngine }).PipelineEngine = PipelineEngine;
