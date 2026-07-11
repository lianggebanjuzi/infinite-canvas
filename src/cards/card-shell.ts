// src/cards/card-shell.ts
// 卡片外壳构造：DOM 树 + 事件绑定（从 BaseCard 拆出，避免类文件过大）
// 不持有状态，只读取 BaseCard 实例字段；通过 type-only import 打破循环依赖

import type { BaseCard } from './base-card';
import { AppState } from '../state/app-state';

// ─── 全局声明（与 BaseCard 一致，shell 直接调用）───
declare const CmdManager: {
  execute(cmd: unknown): void;
};

declare const CardFactory: {
  deselectAll(): void;
};

declare const ConnectionManager: {
  startConnection(el: HTMLElement, port: HTMLElement, portRole: string): void;
  scheduleUpdate(cardId: string): void;
};

declare const Minimap: {
  scheduleUpdate(): void;
};

declare const GroupManager: {
  expandBoundsByCards(groupId: string): void;
  checkCardEscape(cardId: string): void;
};

declare const PropertyChangeCommand: any;
declare const MoveCardsCommand: any;

// ─── 主入口：构造卡片 DOM 树并绑定全部交互 ───
export function buildCardShell(self: BaseCard): HTMLElement {
  const el = document.createElement('div');
  el.className = 'card';
  el.id = self.id;
  el.dataset.type = self.getType();
  el.style.left = self.x + 'px';
  el.style.top = self.y + 'px';
  el.style.width = self.width;
  el.style.height = self.height;
  if (self.bg) el.style.backgroundColor = self.bg;

  const portLeft = createPort('port-left', 'input');

  const header = document.createElement('div');
  header.className = 'card-header';

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'card-title-input';
  titleInput.value = self.title;
  titleInput.spellcheck = false;

  titleInput.addEventListener('blur', () => {
    const newVal = titleInput.value;
    const prevVal = self.title || '';
    if (newVal !== prevVal && CmdManager) {
      CmdManager.execute(new PropertyChangeCommand(self.id, 'title', newVal, prevVal, '修改标题'));
    }
    self.title = newVal;
  });
  titleInput.addEventListener('keydown', e => e.stopPropagation());
  titleInput.addEventListener('dblclick', e => {
    e.stopPropagation();
    titleInput.focus();
    titleInput.select();
  });
  titleInput.addEventListener('mousedown', e => {
    if (document.activeElement !== titleInput) {
      e.preventDefault();
    }
  });

  const typeBadge = document.createElement('span');
  typeBadge.className = 'card-type-badge';
  const typeLabels: Record<string, string> = {
    'text': 'Text',
    'image': 'Image',
    'ai-image': 'AI Draw',
    'drawing-board': '画',
    'preview': 'Preview',
    'compare': 'Compare',
    'agent': 'Agent'
  };
  typeBadge.textContent = typeLabels[self.getType()] || self.getType();

  header.appendChild(titleInput);
  header.appendChild(typeBadge);

  const dragStrip = document.createElement('div');
  dragStrip.className = 'drag-strip';

  const body = document.createElement('div');
  body.className = 'card-body';

  const contentResult = self.renderContent();
  if ((contentResult as unknown) instanceof HTMLElement) {
    body.appendChild(contentResult as unknown as HTMLElement);
  } else if (typeof contentResult === 'string' && contentResult.trim()) {
    body.innerHTML = contentResult;
  }

  const portRight = createPort('port-right', 'output');

  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'resize-handle';

  el.appendChild(portLeft);
  el.appendChild(header);
  el.appendChild(dragStrip);
  el.appendChild(body);
  el.appendChild(portRight);
  el.appendChild(resizeHandle);

  self.element = el;

  bindDrag(self, el, header);
  bindSelect(self, el);
  bindPortDrag(self, portLeft, 'input');
  bindPortDrag(self, portRight, 'output');
  bindResize(self, el, resizeHandle);

  (self as unknown as { _portLeft?: HTMLElement })._portLeft = portLeft;
  (self as unknown as { _portRight?: HTMLElement })._portRight = portRight;

  return el;
}

export function createPort(extraClass: string, portRole: string): HTMLElement {
  const port = document.createElement('div');
  port.className = `port ${extraClass}`;
  port.dataset.portRole = portRole;
  return port;
}

function bindDrag(self: BaseCard, el: HTMLElement, handle: HTMLElement): void {
  handle.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();

    if (!(AppState.cards.multiSelected as unknown[]).includes(el)) {
      CardFactory.deselectAll();
      el.classList.add('selected');
      AppState.cards.activeCardId = self.id;
    }

    const startX = e.clientX;
    const startY = e.clientY;
    let dragStarted = false;

    const scale = AppState.canvas.scale;
    const offsetX =
      (e.clientX - AppState.canvas.panX) / scale - parseFloat(el.style.left);
    const offsetY =
      (e.clientY - AppState.canvas.panY) / scale - parseFloat(el.style.top);

    const onMove = (e: MouseEvent) => {
      const dx = Math.abs(e.clientX - startX);
      const dy = Math.abs(e.clientY - startY);

      if (!dragStarted && (dx > 4 || dy > 4)) {
        dragStarted = true;
        self._drag.active = true;
        self._drag.offsetX = offsetX;
        self._drag.offsetY = offsetY;
        el.classList.add('dragging');

        if (!(AppState.cards.multiSelected as unknown[]).includes(el)) {
          CardFactory.deselectAll();
          el.classList.add('selected');
          AppState.cards.activeCardId = self.id;
        }
      }

      if (!dragStarted) return;

      const s = AppState.canvas.scale;
      const newX = (e.clientX - AppState.canvas.panX) / s - self._drag.offsetX;
      const newY = (e.clientY - AppState.canvas.panY) / s - self._drag.offsetY;

      if (AppState.cards.multiSelected.length > 1) {
        const moveDx = newX - parseFloat(el.style.left);
        const moveDy = newY - parseFloat(el.style.top);
        (AppState.cards.multiSelected as HTMLElement[]).forEach(cardEl => {
          cardEl.style.left = (parseFloat(cardEl.style.left) + moveDx) + 'px';
          cardEl.style.top = (parseFloat(cardEl.style.top) + moveDy) + 'px';
          ConnectionManager.scheduleUpdate(cardEl.id);
        });
      } else {
        el.style.left = newX + 'px';
        el.style.top = newY + 'px';
        ConnectionManager.scheduleUpdate(self.id);
      }

      Minimap.scheduleUpdate();
    };

    const startLeft = parseFloat(el.style.left);
    const startTop = parseFloat(el.style.top);

    const onUp = () => {
      window.removeEventListener('mousemove', onMove as EventListener);
      window.removeEventListener('mouseup', onUp);

      if (dragStarted) {
        self._drag.active = false;
        el.classList.remove('dragging');

        const endLeft = parseFloat(el.style.left);
        const endTop = parseFloat(el.style.top);
        const dx = Math.round((endLeft - startLeft) * 100) / 100;
        const dy = Math.round((endTop - startTop) * 100) / 100;

        if (dx !== 0 || dy !== 0) {
          let movedIds: string[];
          if (AppState.cards.multiSelected.length > 1) {
            movedIds = (AppState.cards.multiSelected as HTMLElement[])
              .map(e => e.id)
              .filter((id): id is string => !!id);
          } else {
            movedIds = [self.id];
          }
          CmdManager.execute(new MoveCardsCommand(movedIds, dx, dy));
        }

        if (self.groupId && GroupManager) {
          GroupManager.expandBoundsByCards(self.groupId);
          GroupManager.checkCardEscape(self.id);
        }
      }
    };

    window.addEventListener('mousemove', onMove as EventListener);
    window.addEventListener('mouseup', onUp);
  });
}

function bindSelect(self: BaseCard, el: HTMLElement): void {
  el.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 0) return;

    if (!(AppState.cards.multiSelected as unknown[]).includes(el)) {
      CardFactory.deselectAll();
      el.classList.add('selected');
      AppState.cards.activeCardId = self.id;
    }
  });
}

export function bindPortDrag(self: BaseCard, port: HTMLElement, portRole: string): void {
  port.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    ConnectionManager.startConnection(self.element!, port, portRole);
  });
}

function bindResize(self: BaseCard, el: HTMLElement, handle: HTMLElement): void {
  handle.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();

    const startX = e.clientX;
    const startY = e.clientY;
    const startW = el.offsetWidth;
    const startH = el.offsetHeight;
    const scale = AppState.canvas.scale;

    const prevZ = el.style.zIndex;
    el.style.zIndex = '200';

    const body = el.querySelector('.card-body') as HTMLElement | null;
    if (body) body.style.overflow = 'visible';

    const minW = self.minWidth ?? 120;
    const minH = self.minHeight ?? 80;
    let rafId: number | null = null;
    let lastX = startX;
    let lastY = startY;

    const onMove = (e: MouseEvent) => {
      lastX = e.clientX;
      lastY = e.clientY;
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const newW = Math.max(minW, startW + (lastX - startX) / scale);
        const newH = Math.max(minH, startH + (lastY - startY) / scale);
        el.style.width = newW + 'px';
        el.style.height = newH + 'px';
        ConnectionManager.scheduleUpdate(el.id);
        Minimap.scheduleUpdate();
      });
    };

    const onUp = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      const newW = Math.max(minW, startW + (lastX - startX) / scale);
      const newH = Math.max(minH, startH + (lastY - startY) / scale);
      el.style.width = newW + 'px';
      el.style.height = newH + 'px';
      ConnectionManager.scheduleUpdate(el.id);
      Minimap.scheduleUpdate();

      if (body) body.style.overflow = '';
      el.style.zIndex = prevZ;

      if (Math.abs(newW - startW) > 0.5 || Math.abs(newH - startH) > 0.5) {
        if (CmdManager) {
          CmdManager.execute(new PropertyChangeCommand(
            self.id, 'size',
            { width: newW + 'px', height: newH + 'px' },
            { width: startW + 'px', height: startH + 'px' },
            '调整大小'
          ));
        }
      }

      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}