// src/cards/card-contract.ts
// 卡片契约系统 — 基于声明式的数据流转

import { CardPortDeclaration } from '../types/cards';
import { TextCard } from './text-card';
import { ImageInputCard } from './image-input-card';
import { AIDrawCard } from './ai-draw-card';
import { DrawingBoardCard } from './drawing-board-card';
import { PreviewCard } from './preview-card';
import { AgentCard } from './agent-card';
import { CompareCard } from './compare-card';

interface CardContract {
  outputs?: CardPortDeclaration[];
  inputs?: CardPortDeclaration[];
}

const CARD_TYPE_MAP: Record<string, { getContract(): CardContract }> = {
  'text': TextCard,
  'image': ImageInputCard,
  'ai-image': AIDrawCard,
  'drawing-board': DrawingBoardCard,
  'preview': PreviewCard,
  'agent': AgentCard,
  'compare': CompareCard,
};

interface CompatibilityResult {
  compatible: boolean;
  reason?: string;
}

export function getCardContract(
  cardOrType: { constructor: { getContract(): CardContract } } | string
): CardContract | null {
  let CardClass: { getContract(): CardContract } | null = null;

  if (typeof cardOrType === 'string') {
    CardClass = CARD_TYPE_MAP[cardOrType] ?? null;
  } else {
    CardClass = (cardOrType as { constructor: { getContract(): CardContract } }).constructor;
  }

  if (!CardClass || typeof (CardClass as unknown as { getContract?: unknown }).getContract !== 'function') {
    console.warn(`[CardContract] ${String(cardOrType)} 没有声明契约`);
    return null;
  }

  return CardClass.getContract();
}

export function checkCompatibility(
  sourceCard: { getType(): string; constructor: { getContract(): CardContract } },
  targetCard: { getType(): string; constructor: { getContract(): CardContract } },
  endPort: string | null = null
): CompatibilityResult {
  const sourceContract = getCardContract(sourceCard);
  const targetContract = getCardContract(targetCard);

  if (!sourceContract || !targetContract) {
    return { compatible: false, reason: '缺少契约声明' };
  }

  if (!targetContract.inputs || targetContract.inputs.length === 0) {
    return { compatible: false, reason: '目标卡片不接受输入' };
  }

  const sourceOutputs = sourceContract.outputs || [];
  const targetInputs = targetContract.inputs || [];

  let targetInput: CardPortDeclaration | null = null;
  if (endPort && targetContract.inputs.length > 1) {
    targetInput = targetInputs.find(i => i.name === endPort) ?? null;
  } else {
    targetInput = targetInputs[0] ?? null;
  }

  if (!targetInput) {
    return { compatible: false, reason: '未找到目标输入端口' };
  }

  const hasMatch = sourceOutputs.some(output =>
    output.type === targetInput!.type ||
    (output.type === 'image' && targetInput!.type === 'image')
  );

  if (!hasMatch) {
    return {
      compatible: false,
      reason: `类型不匹配: 输出 ${sourceOutputs.map(o => o.type).join('/')} → 输入 ${targetInput!.type}`
    };
  }

  return { compatible: true };
}

export function getReceivePolicy(
  card: { constructor: { getContract?(): CardContract } },
  inputType: string
): { policy: 'replace' | 'append' | 'ignore'; input: CardPortDeclaration | null } {
  const contract = card.constructor.getContract?.() ?? null;
  if (!contract) return { policy: 'replace', input: null };

  const input = contract.inputs?.find(i => i.type === inputType) ?? null;
  if (!input) return { policy: 'ignore', input: null };

  return {
    policy: (input.receivePolicy || 'replace') as 'replace' | 'append' | 'ignore',
    input
  };
}

export function shouldReceive(card: { constructor: { getContract?(): CardContract } }, inputType: string): boolean {
  const { policy } = getReceivePolicy(card, inputType);
  return policy !== 'ignore';
}

const CardContractModule = {
  get: getCardContract,
  checkCompatibility,
  getReceivePolicy,
  shouldReceive,
};

export { CardContractModule as CardContract };
(window as unknown as { CardContract: typeof CardContractModule }).CardContract = CardContractModule;
