// src/cards/base-card.ts
// 卡片基类 所有卡片的父类

import { uid } from '../utils/uid';
import { AppState } from '../state/app-state';
import { CardSerializedData, CardOptions, CardContract } from '../types/cards';
import { buildCardShell, createPort, bindPortDrag as bindPortDragShell } from './card-shell';

// ─── 全局声明（仅 CardEventBus，其余全局在 card-shell.ts 声明）───
declare const CardEventBus: {
  EventTypes: { DATA_CHANGED: string };
  emit(type: string, payload: { cardId: string; type: string; data: unknown; source: string }): void;
};


export abstract class BaseCard {
  id: string;
  x: number;
  y: number;
  width: string;
  height: string;
  minWidth: number;
  minHeight: number;
  title: string;
  bg: string;
  element: HTMLElement | null = null;
  groupId: string | null = null;
  bypass: boolean = false;
  content: string = '';

  _drag = {
    active: false,
    offsetX: 0,
    offsetY: 0
  };

  _portLeft?: HTMLElement;
  _portRight?: HTMLElement;

  constructor(options: CardOptions = {}) {
    this.id = options.id || uid('card');

    this.x = typeof options.x === 'number' ? options.x : 100;
    this.y = typeof options.y === 'number' ? options.y : 100;
    this.width = options.width || '200px';
    this.height = options.height || '160px';
    this.minWidth = options.minWidth ?? 120;
    this.minHeight = options.minHeight ?? 80;
    this.title = options.title || 'Untitled';
    this.bg = options.bg || '';
    this.groupId = options.groupId || null;
    this.bypass = options.bypass || false;
  }

  abstract getType(): string;

  static getContract(): CardContract {
    return {
      outputs: [],
      inputs: []
    };
  }

  static getDataType(): 'text' | 'image' | null {
    const contract = this.getContract();
    if (!contract || !contract.outputs || contract.outputs.length === 0) {
      return null;
    }
    return contract.outputs[0].type;
  }

  createElement(): HTMLElement {
    const el = buildCardShell(this);
    this._updatePortsVisibility();
    return el;
  }

  _createPort(extraClass: string, portRole: string): HTMLElement {
    return createPort(extraClass, portRole);
  }

  _bindPortDrag(port: HTMLElement, portRole: string): void {
    bindPortDragShell(this, port, portRole);
  }

  renderContent(): string {
    return '';
  }

  _updatePortsVisibility(): void {
    const cardId = this.element?.id;
    if (!cardId) return;

    const connections = AppState.connections.list;
    const hasInput = connections.some(c => c.end === cardId);
    const hasOutput = connections.some(c => c.start === cardId);

    if (this._portLeft) {
      this._portLeft.style.display = '';
      this._portLeft.classList.toggle('port--linked', hasInput);
    }
    if (this._portRight) {
      this._portRight.style.display = '';
      this._portRight.classList.toggle('port--linked', hasOutput);
    }
  }

  onUpstreamChanged(_upstreamCard: BaseCard, _endPort?: string): void {}

  onReceive(_type: 'text' | 'image', _data: unknown, _source = 'upstream'): void {}

  onPush(_type: 'text' | 'image', _data: unknown): void {}

  getPushData(type: 'text' | 'image'): unknown {
    return this.getOutput ? this.getOutput() : null;
  }

  notifyDownstream(source = 'manual'): void {
    if (!AppState.connections) return;

    const dataType = (this.constructor as typeof BaseCard).getDataType?.() || null;
    if (!dataType) return;

    if (CardEventBus && CardEventBus.EventTypes) {
      CardEventBus.emit(CardEventBus.EventTypes.DATA_CHANGED, {
        cardId: this.id,
        type: dataType,
        data: this.getOutput ? this.getOutput() : null,
        source
      });
    }
  }

  destroy(): void {
    this.element?.remove();
    this.element = null;
  }

  serialize(): CardSerializedData {
    const el = this.element;
    return {
      id: this.id,
      type: this.getType(),
      title: (el?.querySelector('.card-title-input') as HTMLInputElement)?.value ?? this.title,
      left: el?.style.left ?? (this.x + 'px'),
      top: el?.style.top ?? (this.y + 'px'),
      width: el?.style.width ?? this.width,
      height: el?.style.height ?? this.height,
      bg: el?.style.backgroundColor ?? this.bg,
      content: '',
      groupId: this.groupId || null,
      bypass: this.bypass || false
    };
  }

  getOutput(_outputName = 'default'): unknown {
    return null;
  }

  getAllOutputs(): Record<string, unknown> {
    const contract = (this.constructor as typeof BaseCard).getContract();
    const outputs: Record<string, unknown> = {};
    (contract.outputs || []).forEach(port => {
      outputs[port.name] = this.getOutput(port.name);
    });
    return outputs;
  }

  hasLocalUndo(): boolean {
    return false;
  }

  undo(): boolean {
    return false;
  }

  redo(): boolean {
    return false;
  }
}
