// src/cards/connection-rules.ts
// 卡片连接规则引擎 — 基于契约的通用规则系统

import { AppState } from '../state/app-state';

type LifecycleHook = (sourceCard: unknown, targetCard: unknown, endPort: unknown) => void;

const _lifecycleHooks: Record<string, LifecycleHook> = {};

/** PipelineEngine 模式开关 */
const _usePipelineEngine = true;

export function register(key: string, handler: LifecycleHook): void {
  _lifecycleHooks[key] = handler;
}

function _getKey(sourceCard: { getType(): string }, targetCard: { getType(): string }): string {
  if (targetCard.getType() === 'compare') {
    return `${sourceCard.getType()}+compare`;
  }
  return `${sourceCard.getType()}→${targetCard.getType()}`;
}

function _applyHook(
  key: string,
  sourceCard: unknown,
  targetCard: unknown,
  endPort: unknown,
  isDisconnect: boolean
): void {
  const hookKey = isDisconnect ? `${key}:disconnect` : key;
  const hook = _lifecycleHooks[hookKey];
  if (hook) {
    try {
      hook(sourceCard, targetCard, endPort);
    } catch (e) {
      console.error(`[ConnectionRules] Hook error (${hookKey}):`, e);
    }
  }
}

// ── 类型别名，展开嵌套泛型以避免 >> 解析错误 ──
type CardInputItem = { name: string; type: string; receivePolicy?: string; multiple?: boolean };
type CardInputs = Array<CardInputItem>;
type ContractOutput = { inputs?: CardInputs };

type SourceCardWithCtor = { constructor: { getDataType?(): string | null } };
type TargetCardWithContract = { constructor: { getContract?(): ContractOutput } };

function _applyContractRules(
  sourceCard: SourceCardWithCtor,
  targetCard: TargetCardWithContract,
  endPort: string | null
): void {
  const sourceDataType = sourceCard.constructor.getDataType?.() || null;
  if (!sourceDataType) return;

  const contract = targetCard.constructor.getContract?.() || {};
  const inputs = contract.inputs || [];

  let matchingInput: CardInputItem | null = null;
  if (endPort) {
    matchingInput = inputs.find((i) => i.name === endPort) ?? null;
  }

  if (!matchingInput) {
    matchingInput = inputs.find((i) =>
      i.type === sourceDataType || (i.multiple && i.type === sourceDataType)
    ) ?? null;
  }

  if (!matchingInput) return;

  const policy = matchingInput.receivePolicy || 'replace';
  if (policy === 'ignore') return;

  const upstreamData = (sourceCard as unknown as { getOutput?(name?: string): unknown }).getOutput?.() ?? null;
  if (!upstreamData) return;

  const onReceive = (targetCard as unknown as { onReceive?: Function }).onReceive;
  if (onReceive) {
    onReceive(sourceDataType, upstreamData, (sourceCard as unknown as { id: string }).id, endPort);
  }
}

type TargetCardFull = {
  getType(): string;
  constructor: {
    getContract?(): ContractOutput;
    getDataType?(): string | null;
  };
  onReceive?: Function;
  _updatePortsVisibility?: Function;
};

function _applyOnConnect(
  sourceCard: { getType(): string; constructor: { getDataType?(): string | null } } | null,
  targetCard: TargetCardFull | null,
  endPort: string | null
): void {
  if (!sourceCard || !targetCard) return;

  const key = _getKey(sourceCard as { getType(): string }, targetCard as { getType(): string });

  _applyHook(key, sourceCard, targetCard, endPort, false);

  if (_usePipelineEngine && typeof PipelineEngine !== 'undefined') {
    const dataType = (sourceCard.constructor as { getDataType?(): string | null }).getDataType?.();
    if (dataType) {
      PipelineEngine.trigger((sourceCard as unknown as { id: string }).id, dataType);
    }
  } else {
    _applyContractRules(sourceCard, targetCard as TargetCardWithContract, endPort);
  }

  (sourceCard as unknown as { _updatePortsVisibility?(): void })._updatePortsVisibility?.();
  (targetCard as unknown as { _updatePortsVisibility?(): void })._updatePortsVisibility?.();
}

function _applyOnDisconnect(
  sourceCard: { getType(): string } | null,
  targetCard: { getType(): string; refreshUpstream?: Function; _updatePortsVisibility?: Function } | null
): void {
  if (!sourceCard || !targetCard) return;

  const key = _getKey(sourceCard as { getType(): string }, targetCard as { getType(): string });
  _applyHook(key, sourceCard, targetCard, null, true);

  if ((targetCard as { refreshUpstream?: Function }).refreshUpstream) {
    (targetCard as { refreshUpstream: Function }).refreshUpstream();
  }

  (sourceCard as unknown as { _updatePortsVisibility?(): void })._updatePortsVisibility?.();
  (targetCard as unknown as { _updatePortsVisibility?(): void })._updatePortsVisibility?.();
}

function _applyOnDataChanged(
  sourceCard: SourceCardWithCtor | null,
  dataType: string,
  data: unknown
): void {
  if (!sourceCard) return;

  if (_usePipelineEngine && typeof PipelineEngine !== 'undefined') {
    PipelineEngine.trigger((sourceCard as { id: string }).id, dataType);
  } else {
    const connections = (AppState.connections.list as Array<{
      start: string; end: string; endPort?: string;
    }>).filter(c => c.start === (sourceCard as { id: string }).id);

    connections.forEach(c => {
      const targetCard = CardFactory.getInstance(c.end);
      if (!targetCard) return;

      const contract = (targetCard as unknown as { constructor: { getContract?(): ContractOutput } }).constructor?.getContract?.() || {};
      const inputs = contract.inputs || [];

      let matchingInput: CardInputItem | null = null;
      if (c.endPort) {
        matchingInput = inputs.find((i) => i.name === c.endPort) ?? null;
      }
      if (!matchingInput) {
        matchingInput = inputs.find((i) => i.type === dataType) ?? null;
      }

      if (matchingInput && (targetCard as { onReceive?: Function }).onReceive) {
        const policy = matchingInput.receivePolicy || 'replace';
        if (policy !== 'ignore') {
          (targetCard as { onReceive: Function }).onReceive(
            dataType, data, (sourceCard as { id: string }).id, c.endPort
          );
        }
      }
    });
  }
}

function _applyOnRunCompleted(
  card: SourceCardWithCtor | null,
  dataType: string,
  data: unknown
): void {
  if (!card) return;

  if (_usePipelineEngine && typeof PipelineEngine !== 'undefined') {
    PipelineEngine.trigger((card as { id: string }).id, dataType);
  } else {
    const connections = (AppState.connections.list as Array<{ start: string; end: string }>)
      .filter(c => c.start === (card as { id: string }).id);

    connections.forEach(c => {
      const targetCard = CardFactory.getInstance(c.end);
      if (!targetCard) return;
      if ((targetCard as { onReceive?: Function }).onReceive) {
        (targetCard as { onReceive: Function }).onReceive(dataType, data, (card as { id: string }).id);
      }
    });
  }
}

export const ConnectionRules = {
  register,
  applyOnConnect: _applyOnConnect,
  applyOnDisconnect: _applyOnDisconnect,
  applyOnDataChanged: _applyOnDataChanged,
  applyOnRunCompleted: _applyOnRunCompleted,
  execute: _applyOnConnect,
  _usePipelineEngine,
};

// 生命周期钩子注册
declare const PipelineEngine: { trigger(cardId: string, dataType: string): void };
declare const CardFactory: { getInstance(id: string): unknown };

ConnectionRules.register('text→ai-image', (sourceCard, targetCard) => {
  (targetCard as unknown as { updateUpstreamTextHint?(): void }).updateUpstreamTextHint?.();
});

// agent → AIDrawCard：与 text→ai-image 相同，更新上游文本提示
ConnectionRules.register('agent→ai-image', (sourceCard, targetCard) => {
  (targetCard as unknown as { updateUpstreamTextHint?(): void }).updateUpstreamTextHint?.();
});

ConnectionRules.register('image→ai-image', (sourceCard, targetCard, _endPort) => {
  const card = targetCard as unknown as { addRefImage?(src: string, sourceCardId: string): void };
  const source = sourceCard as unknown as { getOutput?(): unknown };
  const src = source.getOutput?.();
  if (src && typeof src === 'string') {
    card.addRefImage?.(src, (sourceCard as unknown as { id: string }).id);
  }
});

ConnectionRules.register('image→drawing-board', (sourceCard, targetCard, _endPort) => {
  (targetCard as unknown as { refreshUpstream?(): void }).refreshUpstream?.();
});

ConnectionRules.register('image→preview', (_sourceCard, targetCard, _endPort) => {
  (targetCard as unknown as { refreshUpstream?(): void }).refreshUpstream?.();
});

ConnectionRules.register('text→agent', (_sourceCard, targetCard, _endPort) => {
  (targetCard as unknown as { updateUpstreamHint?(): void }).updateUpstreamHint?.();
});

ConnectionRules.register('image→agent', (_sourceCard, targetCard, _endPort) => {
  (targetCard as unknown as { updateUpstreamHint?(): void }).updateUpstreamHint?.();
});

// preview/agent → compare：通过 refreshUpstream 处理（通用方式）
ConnectionRules.register('preview+compare', (_sourceCard, targetCard, _endPort) => {
  (targetCard as unknown as { refreshUpstream?(): void }).refreshUpstream?.();
});
ConnectionRules.register('agent+compare', (_sourceCard, targetCard, _endPort) => {
  (targetCard as unknown as { refreshUpstream?(): void }).refreshUpstream?.();
});

ConnectionRules.register('image→compare:disconnect', (_sourceCard, targetCard, _endPort) => {
  (targetCard as unknown as { refreshUpstream?(): void }).refreshUpstream?.();
});

ConnectionRules.register('image→compare', (_sourceCard, targetCard, _endPort) => {
  (targetCard as unknown as { refreshUpstream?(): void }).refreshUpstream?.();
});

// agent → Agent：更新上游提示（JS 版兼容）
ConnectionRules.register('agent→agent', (sourceCard, targetCard) => {
  (targetCard as unknown as { updateUpstreamHint?(): void }).updateUpstreamHint?.();
});

(window as unknown as { ConnectionRules: typeof ConnectionRules }).ConnectionRules = ConnectionRules;
