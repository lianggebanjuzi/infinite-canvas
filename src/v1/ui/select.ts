// src/v1/ui/select.ts
// 轻量自定义下拉：与 .param-menu 交互一致（点击触发 → 弹出菜单 → 选中高亮 → 点外部关闭）
// 独立于 src/ui/ 下的旧组件，不依赖 AppState / FontAwesome

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectConfig {
  options?: SelectOption[];
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  onChange?: (value: string) => void;
}

export interface SelectHandle {
  element: HTMLElement;
  setValue(value: string): void;
  getValue(): string;
  setOptions(options: SelectOption[]): void;
  destroy(): void;
}

/** 工厂函数：创建一个自定义下拉，返回元素与读写接口 */
export function createSelect(config: SelectConfig = {}): SelectHandle {
  const options: SelectOption[] = config.options ? [...config.options] : [];
  const placeholder = config.placeholder ?? '请选择';
  const onChange = config.onChange;
  let value = config.value ?? '';
  let menu: HTMLElement | null = null;
  let destroyed = false;

  const element = document.createElement('div');
  element.className = 'settings-select';
  if (config.disabled) element.classList.add('disabled');
  element.setAttribute('tabindex', '0');
  element.setAttribute('role', 'button');

  const labelEl = document.createElement('span');
  labelEl.className = 'settings-select-value';

  const chev = document.createElement('span');
  chev.className = 'settings-select-chev';
  chev.textContent = '\u25BE';

  element.appendChild(labelEl);
  element.appendChild(chev);

  const refreshLabel = (): void => {
    const opt = options.find(o => o.value === value);
    labelEl.textContent = opt ? opt.label : placeholder;
    labelEl.classList.toggle('placeholder', !opt);
  };

  const closeMenu = (): void => {
    if (menu) {
      menu.remove();
      menu = null;
    }
    element.classList.remove('open');
    document.removeEventListener('click', onDocClick, true);
  };

  const openMenu = (): void => {
    if (destroyed || menu || options.length === 0) return;

    const rect = element.getBoundingClientRect();
    const menuEl = document.createElement('div');
    menuEl.className = 'settings-select-menu';
    menuEl.style.minWidth = Math.max(rect.width, 168) + 'px';
    menuEl.style.left = Math.round(rect.left) + 'px';

    const estHeight = Math.min(options.length * 32 + 8, 280);
    let top = rect.bottom + 5;
    if (top + estHeight > window.innerHeight - 8) {
      top = rect.top - estHeight - 5;
    }
    if (top < 8) top = 8;
    menuEl.style.top = Math.round(top) + 'px';

    options.forEach(opt => {
      const item = document.createElement('div');
      item.className = 'settings-select-item' + (opt.value === value ? ' selected' : '');
      item.textContent = opt.label;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        value = opt.value;
        refreshLabel();
        closeMenu();
        if (onChange) onChange(value);
      });
      menuEl.appendChild(item);
    });

    document.body.appendChild(menuEl);
    menu = menuEl;
    element.classList.add('open');
    document.addEventListener('click', onDocClick, true);
  };

  // 捕获阶段监听：点击触发器/菜单内不关闭（由各自 handler 处理），点击外部关闭
  const onDocClick = (e: MouseEvent): void => {
    if (!menu) return;
    const target = e.target as Node;
    if (element.contains(target)) return;
    if (menu.contains(target)) return;
    closeMenu();
  };

  element.addEventListener('click', () => {
    if (menu) closeMenu();
    else openMenu();
  });

  element.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (menu) closeMenu();
      else openMenu();
    } else if (e.key === 'Escape') {
      closeMenu();
    }
  });

  refreshLabel();

  return {
    element,
    setValue(v: string): void {
      value = v;
      refreshLabel();
    },
    getValue(): string {
      return value;
    },
    setOptions(next: SelectOption[]): void {
      options.length = 0;
      next.forEach(o => options.push(o));
      refreshLabel();
    },
    destroy(): void {
      destroyed = true;
      closeMenu();
      element.remove();
    },
  };
}
