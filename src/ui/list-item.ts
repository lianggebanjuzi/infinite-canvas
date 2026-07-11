/**
 * ListItem 列表项组件
 * 
 * 用法：
 *   const item = ListItem({
 *     icon: 'fa-solid fa-server',
 *     title: 'OpenAI',
 *     description: 'GPT-4o, GPT-4o-mini',
 *     badge: { text: '在线', type: 'success' },
 *     actions: [
 *       { icon: 'fa-solid fa-pen', title: '编辑', onClick: () => {} },
 *       { icon: 'fa-solid fa-trash', title: '删除', danger: true, onClick: () => {} }
 *     ],
 *     onClick: () => { console.log('点击') }
 *   });
 *   
 *   document.body.appendChild(item.element);
 */

export interface ListItemBadge {
  /** 徽章文字 */
  text: string;
  /** 徽章类型 */
  type?: 'default' | 'success' | 'warning' | 'error' | 'info';
}

export interface ListItemAction {
  /** 图标类名 */
  icon: string;
  /** 提示文字 */
  title?: string;
  /** 是否为危险操作（红色） */
  danger?: boolean;
  /** 点击回调 */
  onClick: (e: Event) => void;
}

export interface ListItemOptions {
  /** 左侧图标类名 */
  icon?: string;
  /** 左侧图标颜色 */
  iconColor?: string;
  /** 标题 */
  title: string;
  /** 描述文字 */
  description?: string;
  /** 右侧徽章 */
  badge?: ListItemBadge;
  /** 右侧操作按钮 */
  actions?: ListItemAction[];
  /** 是否选中 */
  selected?: boolean;
  /** 点击整个列表项的回调 */
  onClick?: () => void;
}

export interface ListItemInstance {
  element: HTMLElement;
  setSelected: (selected: boolean) => void;
  setTitle: (title: string) => void;
  setDescription: (desc: string) => void;
  remove: () => void;
}

export function ListItem(options: ListItemOptions): ListItemInstance {
  const {
    icon,
    iconColor,
    title,
    description,
    badge,
    actions,
    selected = false,
    onClick,
  } = options;

  // 容器
  const item = document.createElement('div');
  item.className = `list-item${selected ? ' selected' : ''}`;

  // 左侧图标
  if (icon) {
    const iconEl = document.createElement('div');
    iconEl.className = 'list-item__icon';
    if (iconColor) iconEl.style.color = iconColor;
    iconEl.innerHTML = `<i class="${icon}"></i>`;
    item.appendChild(iconEl);
  }

  // 中间信息
  const info = document.createElement('div');
  info.className = 'list-item__info';

  const titleEl = document.createElement('div');
  titleEl.className = 'list-item__title';
  titleEl.textContent = title;
  info.appendChild(titleEl);

  if (description) {
    const descEl = document.createElement('div');
    descEl.className = 'list-item__desc';
    descEl.textContent = description;
    info.appendChild(descEl);
  }

  item.appendChild(info);

  // 徽章
  if (badge) {
    const badgeEl = document.createElement('span');
    badgeEl.className = `badge badge--${badge.type || 'default'}`;
    badgeEl.textContent = badge.text;
    item.appendChild(badgeEl);
  }

  // 操作按钮
  if (actions && actions.length > 0) {
    const actionsEl = document.createElement('div');
    actionsEl.className = 'list-item__actions';

    actions.forEach(({ icon: actionIcon, title: actionTitle, danger, onClick: onActionClick }) => {
      const btn = document.createElement('button');
      btn.className = `icon-btn${danger ? ' icon-btn--danger' : ''}`;
      if (actionTitle) btn.title = actionTitle;
      btn.innerHTML = `<i class="${actionIcon}"></i>`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        onActionClick(e);
      });
      actionsEl.appendChild(btn);
    });

    item.appendChild(actionsEl);
  }

  // 整体点击
  if (onClick) {
    item.addEventListener('click', onClick);
    item.style.cursor = 'pointer';
  }

  return {
    element: item,
    setSelected(sel: boolean) {
      item.classList.toggle('selected', sel);
    },
    setTitle(t: string) {
      titleEl.textContent = t;
    },
    setDescription(d: string) {
      const descEl = item.querySelector('.list-item__desc') as HTMLElement;
      if (descEl) descEl.textContent = d;
    },
    remove() {
      item.remove();
    },
  };
}
