// src/cards/data-source.ts
// 统一数据源管理器 — 所有卡片通过此类获取上游数据

import { AppState } from '../state/app-state';

export interface UpstreamDataItem {
  data: unknown;
  sourceCardId: string;
  connectionId: string;
  endPort?: string;
}

declare const CardFactory: {
  getInstance(id: string): {
    getType?(): string;
    getOutput?(name?: string): unknown;
    constructor?: { getDataType?(): string | null };
  } | null;
};

function getInstanceCard(id: string): {
  getType?(): string;
  getOutput?(name?: string): unknown;
  constructor?: { getDataType?(): string | null };
} | null {
  return CardFactory.getInstance(id);
}

export function getUpstreamData(
  cardId: string,
  dataType: string,
  options: { inputPort?: string; single?: boolean } = {}
): UpstreamDataItem[] {
  const { inputPort = null, single = false } = options;

  const connections = (AppState.connections.list as Array<{
    end: string; start: string; endPort?: string; id?: string;
  }>).filter(c => c.end === cardId);

  const results: UpstreamDataItem[] = [];

  connections.forEach(conn => {
    if (inputPort && conn.endPort !== inputPort) return;

    const upstreamCard = getInstanceCard(conn.start);
    if (!upstreamCard) return;

    const upstreamType = upstreamCard.constructor?.getDataType?.() ?? null;
    if (upstreamType !== dataType) return;

    const data = upstreamCard.getOutput?.();
    if (!data) return;

    results.push({
      data,
      sourceCardId: conn.start,
      connectionId: conn.id || `${conn.start}-${conn.end}`,
      endPort: conn.endPort
    });
  });

  return single ? (results.length > 0 ? [results[0]] : []) : results;
}

export function getUpstreamText(cardId: string, options: { inputPort?: string } = {}): UpstreamDataItem[] {
  return getUpstreamData(cardId, 'text', options);
}

export function getUpstreamImage(cardId: string, options: { inputPort?: string } = {}): UpstreamDataItem[] {
  return getUpstreamData(cardId, 'image', options);
}

export function getFirstUpstream(cardId: string, dataType: string): UpstreamDataItem | null {
  const results = getUpstreamData(cardId, dataType, { single: true });
  return results.length > 0 ? results[0] : null;
}

export function getUpstreamTextMerged(cardId: string): string {
  const texts = getUpstreamText(cardId);
  if (!texts || texts.length === 0) return '';
  return texts.map(t => String(t.data)).join('\n\n');
}

export function getUpstreamImageList(cardId: string): string[] {
  const images = getUpstreamImage(cardId);
  if (!images || images.length === 0) return [];
  return images.map(i => String(i.data));
}

export function hasUpstreamOfType(cardId: string, dataType: string): boolean {
  return getFirstUpstream(cardId, dataType) !== null;
}

export function getUpstreamContent(cardId: string): { texts: string[]; images: string[] } {
  const textResults = getUpstreamText(cardId);
  const imageResults = getUpstreamImage(cardId);

  const texts = textResults
    .map(t => String(t.data))
    .filter(Boolean);

  const images = imageResults
    .map(i => String(i.data))
    .filter((src: string) => {
      if (!src) return false;
      return src.startsWith('data:') ||
             src.startsWith('http') ||
             src.startsWith('file://') ||
             src.startsWith('blob:');
    });

  return { texts, images };
}

interface DownstreamCard {
  getType?(): string;
  getOutput?(name?: string): unknown;
  constructor?: { getDataType?(): string | null };
}

export function getDownstreamCards(
  cardId: string,
  options: { dataType?: string } = {}
): DownstreamCard[] {
  const { dataType = null } = options;

  const connections = (AppState.connections.list as Array<{
    start: string; end: string;
  }>).filter(c => c.start === cardId);

  const results: DownstreamCard[] = [];

  connections.forEach(conn => {
    const downstreamCard = getInstanceCard(conn.end);
    if (!downstreamCard) return;

    if (dataType) {
      const outputType = downstreamCard.constructor?.getDataType?.() ?? null;
      if (outputType !== dataType) return;
    }

    results.push(downstreamCard);
  });

  return results;
}

export function getDownstreamImageCards(cardId: string): DownstreamCard[] {
  return getDownstreamCards(cardId, { dataType: 'image' })
    .filter(card => {
      const t = card.getType?.();
      return t !== 'preview';
    });
}

export function getDownstreamPreviews(cardId: string): DownstreamCard[] {
  return getDownstreamCards(cardId, { dataType: 'image' })
    .filter(card => card.getType?.() === 'preview');
}

export function hasDownstreamOfType(cardId: string, dataType: string): boolean {
  return getDownstreamCards(cardId, { dataType }).length > 0;
}

export const DataSource = {
  getUpstreamData,
  getUpstreamText,
  getUpstreamImage,
  getFirstUpstream,
  getUpstreamTextMerged,
  getUpstreamImageList,
  hasUpstreamOfType,
  getUpstreamContent,
  getDownstreamCards,
  getDownstreamImageCards,
  getDownstreamPreviews,
  hasDownstreamOfType,
};

(window as unknown as { DataSource: typeof DataSource }).DataSource = DataSource;
