// src/cards/card-factory.ts
// 卡片工厂：统一创建删除查找卡片的入口

import { TextCard } from './text-card';
import { ImageInputCard } from './image-input-card';
import { AIDrawCard } from './ai-draw-card';
import { DrawingBoardCard } from './drawing-board-card';
import { PreviewCard } from './preview-card';
import { AgentCard } from './agent-card';
import { CompareCard } from './compare-card';
import { AppState } from '../state/app-state';

declare const CmdManager: { execute(cmd: unknown): void; _pushCreateMarker(cardId: string): void };
declare const GroupManager: { removeCardFromGroup(cardId: string): void };
declare const ConnectionManager: { removeByCardId(cardId: string): void; clearAll(): void };
declare const Minimap: { scheduleUpdate(): void };
declare const CardEventBus: { EventTypes: { RUN_COMPLETED: string }; emit(type: string, payload: unknown): void };
// Legacy command pattern
declare const DeleteCardsCommand: any;

export interface AnimOptions { isPaste?: boolean; pasteIndex?: number }

export interface CardInstance {
  id: string;
  groupId?: string;
  createElement(): HTMLElement;
  destroy?(): void;
  notifyDownstream?(): void;
  getOutput?(outputName?: string): unknown;
  getType?(): string;
  el?: HTMLElement;
}

const CardFactory = {

  _instances: {} as Record<string, CardInstance>,

  create(type: string, options: Record<string, unknown> = {}, saveHistory = true, animOptions: AnimOptions = {}): CardInstance {
    let card: CardInstance;

    switch (type) {
      case 'text': card = new TextCard(options) as CardInstance; break;
      case 'image': card = new ImageInputCard(options) as CardInstance; break;
      case 'ai-image': card = new AIDrawCard(options) as CardInstance; break;
      case 'drawing-board': card = new DrawingBoardCard(options) as CardInstance; break;
      case 'preview': card = new PreviewCard(options) as CardInstance; break;
      case 'agent': card = new AgentCard(options) as CardInstance; break;
      case 'compare': card = new CompareCard(options) as CardInstance; break;
      default:
        console.warn(`未知卡片类型: ${type}`);
        return null as unknown as CardInstance;
    }

    const el = card.createElement();
    const container = document.getElementById('cards-container');
    container?.appendChild(el);

    if (animOptions.isPaste && animOptions.pasteIndex !== undefined) {
      el.classList.add('paste-stagger');
      el.style.setProperty('--stagger-delay', `${animOptions.pasteIndex * 30}ms`);
    }

    this._instances[card.id] = card;

    this.deselectAll();
    el.classList.add('selected');
    AppState.cards.activeCardId = card.id;

    if (saveHistory && (window as unknown as { CmdManager?: typeof CmdManager }).CmdManager) {
      CmdManager._pushCreateMarker(card.id);
    }

    if ((window as unknown as { Minimap?: typeof Minimap }).Minimap) {
      Minimap.scheduleUpdate();
    }

    return card;
  },

  createAtPos(type: string): void {
    const pos = AppState.canvas.contextClickPos;
    this.create(type, { x: pos.x, y: pos.y });
    document.querySelectorAll('.context-menu').forEach(m => { (m as HTMLElement).style.display = 'none'; });
  },

  triggerImageUpload(cardId?: string): void {
    if (cardId) {
      AppState.cards.targetUploadCardId = cardId;
    } else {
      const pos = AppState.canvas.contextClickPos;
      const card = this.create('image', { x: pos.x, y: pos.y }, false) as CardInstance;
      AppState.cards.targetUploadCardId = card.id;
    }
    document.getElementById('image-upload')?.click();
  },

  deleteSelected(): void {
    const toDelete: Element[] = [];

    if (AppState.cards.multiSelected.length > 0) {
      toDelete.push(...AppState.cards.multiSelected);
    } else {
      const selected = document.querySelector('.card.selected');
      if (selected) toDelete.push(selected);
    }

    if (toDelete.length === 0) return;

    const cardIdsToDelete = toDelete.map(el => (el as unknown as { id: string }).id);

    if ((window as unknown as { CmdManager?: typeof CmdManager }).CmdManager) {
      CmdManager.execute(new DeleteCardsCommand( cardIdsToDelete));
      return;
    }

    toDelete.forEach(el => {
      const cardId = (el as unknown as { id: string }).id;
      const instance = this._instances[cardId];

      if ((window as unknown as { GroupManager?: typeof GroupManager }).GroupManager && instance?.groupId) {
        GroupManager.removeCardFromGroup(cardId);
      }

      ConnectionManager.removeByCardId(cardId);

      if ((instance as unknown as { constructor?: { name?: string } }).constructor?.name === 'ImageInputCard') {
        Object.values(this._instances).forEach(c => {
          if ((c as unknown as { constructor?: { name?: string } }).constructor?.name === 'AIDrawCard') {
            (c as unknown as { removeRefImage?(id: string): void }).removeRefImage?.(cardId);
          }
        });
      }

      instance?.notifyDownstream?.();
      instance?.destroy?.();
      delete this._instances[cardId];
    });

    AppState.cards.multiSelected = [];
    AppState.cards.activeCardId = null;

    if ((window as unknown as { Minimap?: typeof Minimap }).Minimap) {
      Minimap.scheduleUpdate();
    }
  },

  deselectAll(): void {
    document.querySelectorAll('.card.selected, .card.multi-selected').forEach(c => c.classList.remove('selected', 'multi-selected'));
    AppState.cards.multiSelected = [];
    AppState.cards.activeCardId = null;
  },

  getInstance(cardId: string): CardInstance | null {
    return this._instances[cardId] || null;
  },

  getAllInstances(): CardInstance[] {
    return Object.values(this._instances);
  },

  async destroyInstance(cardId: string): Promise<void> {
    const instance = this._instances[cardId];
    if (!instance) return;

    const el = (instance as unknown as { el?: HTMLElement }).el;
    if (el) el.classList.add('removing');

    await new Promise(r => setTimeout(r, 120));
    instance.destroy?.();
    delete this._instances[cardId];
  },

  clearAll(): void {
    Object.values(this._instances).forEach(c => c.destroy?.());
    this._instances = {};
    AppState.cards.multiSelected = [];
    AppState.cards.activeCardId = null;
    ConnectionManager.clearAll();

    if (AppState.groups) {
      AppState.groups.list = [];
      AppState.groups.activeGroupId = null;
      document.querySelectorAll('.group-box').forEach(el => el.remove());
    }
  },

  wrapRunCallback(cardId: string, onComplete: ((...args: unknown[]) => void) | null): ((...args: unknown[]) => void) | null {
    if (!onComplete) return null;
    return (...args: unknown[]) => {
      onComplete(...args);
      const card = CardFactory.getInstance(cardId) as CardInstance | null;
      if (card && (window as unknown as { CardEventBus?: typeof CardEventBus }).CardEventBus && CardEventBus.EventTypes) {
        const dataType = (card.constructor as unknown as { getDataType?: () => string | null }).getDataType?.() || null;
        if (dataType) {
          CardEventBus.emit(CardEventBus.EventTypes.RUN_COMPLETED, {
            cardId,
            type: dataType,
            data: card.getOutput?.() || null,
          });
        }
      }
    };
  }
};

export { CardFactory };
(window as unknown as { CardFactory: typeof CardFactory }).CardFactory = CardFactory;

