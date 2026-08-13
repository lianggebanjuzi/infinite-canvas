/**
 * Select 自定义下拉选择组件
 * 
 * 用法：
 *   const select = Select({
 *     label: '选择模型',
 *     options: [
 *       { value: 'gpt-4o', label: 'GPT-4o' },
 *       { value: 'gpt-4o-mini', label: 'GPT-4o-mini' }
 *     ],
 *     value: 'gpt-4o',
 *     onChange: (value) => { console.log(value) }
 *   });
 *   
 *   document.body.appendChild(select.element);
 */

export interface SelectOption {
  /** 选项值 */
  value: string;
  /** 选项文字 */
  label: string;
  /** 是否禁用 */
  disabled?: boolean;
}

export interface SelectGroup {
  /** 分组标签 */
  label: string;
  /** 分组选项 */
  options: SelectOption[];
}

export interface SelectOptions {
  /** 标签文字 */
  label?: string;
  /** 标签后的小提示 */
  labelHint?: string;
  /** 选项列表 */
  options?: SelectOption[];
  /** 分组选项 */
  groups?: SelectGroup[];
  /** 默认提示（第一个选项） */
  placeholder?: string;
  /** 初始值 */
  value?: string;
  /** 是否禁用 */
  disabled?: boolean;
  /** 底部提示 */
  hint?: string;
  /** 值变化回调 */
  onChange?: (value: string) => void;
}

export interface SelectInstance {
  element: HTMLElement;
  value: string;
  setValue: (value: string) => void;
  setOptions: (options: SelectOption[], groups?: SelectGroup[]) => void;
}

export function Select(options: SelectOptions): SelectInstance {
  const {
    label,
    labelHint,
    options: selectOptions = [],
    groups = [],
    placeholder = '',
    value = '',
    disabled = false,
    hint,
    onChange,
  } = options;

  // 容器
  const group = document.createElement('div');
  group.className = 'form-group';

  // 标签
  if (label) {
    const labelEl = document.createElement('label');
    labelEl.textContent = label;
    if (labelHint) {
      const hintSpan = document.createElement('small');
      hintSpan.style.cssText = 'color:#999;font-weight:normal;margin-left:4px;';
      hintSpan.textContent = labelHint;
      labelEl.appendChild(hintSpan);
    }
    group.appendChild(labelEl);
  }

  // 下拉容器
  const selectWrap = document.createElement('div');
  selectWrap.className = 'custom-select';

  // 触发按钮
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'custom-select__trigger';
  trigger.disabled = disabled;

  function updateTriggerText() {
    const allOptions = [...selectOptions, ...groups.flatMap(g => g.options)];
    const found = allOptions.find(o => o.value === currentValue);
    trigger.textContent = found ? found.label : (placeholder || '请选择');
    trigger.classList.toggle('custom-select__trigger--placeholder', !found);
  }

  // 下拉菜单
  const menu = document.createElement('div');
  menu.className = 'custom-select__menu';

  function renderMenu() {
    menu.innerHTML = '';

    if (placeholder) {
      const opt = document.createElement('div');
      opt.className = 'custom-select__option';
      opt.textContent = placeholder;
      opt.dataset.value = '';
      if (currentValue === '') opt.classList.add('is-selected');
      opt.addEventListener('click', () => setValueAndClose(''));
      menu.appendChild(opt);
    }

    // 普通选项
    selectOptions.forEach(o => {
      const opt = document.createElement('div');
      opt.className = `custom-select__option${o.disabled ? ' is-disabled' : ''}${o.value === currentValue ? ' is-selected' : ''}`;
      opt.textContent = o.label;
      opt.dataset.value = o.value;
      if (!o.disabled) {
        opt.addEventListener('click', () => setValueAndClose(o.value));
      }
      menu.appendChild(opt);
    });

    // 分组选项
    groups.forEach(g => {
      const groupLabel = document.createElement('div');
      groupLabel.className = 'custom-select__group-label';
      groupLabel.textContent = g.label;
      menu.appendChild(groupLabel);

      g.options.forEach(o => {
        const opt = document.createElement('div');
        opt.className = `custom-select__option${o.disabled ? ' is-disabled' : ''}${o.value === currentValue ? ' is-selected' : ''}`;
        opt.textContent = o.label;
        opt.dataset.value = o.value;
        if (!o.disabled) {
          opt.addEventListener('click', () => setValueAndClose(o.value));
        }
        menu.appendChild(opt);
      });
    });
  }

  let currentValue = value;
  let isOpen = false;

  function setValueAndClose(val: string) {
    currentValue = val;
    updateTriggerText();
    close();
    onChange?.(val);
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    renderMenu();
    selectWrap.classList.add('is-open');
    menu.style.display = 'block';
    document.addEventListener('click', handleOutsideClick);
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    selectWrap.classList.remove('is-open');
    menu.style.display = 'none';
    document.removeEventListener('click', handleOutsideClick);
  }

  function handleOutsideClick(e: MouseEvent) {
    if (!selectWrap.contains(e.target as Node)) {
      close();
    }
  }

  trigger.addEventListener('click', () => {
    if (isOpen) close();
    else open();
  });

  selectWrap.appendChild(trigger);
  selectWrap.appendChild(menu);
  group.appendChild(selectWrap);

  // 底部提示
  if (hint) {
    const hintEl = document.createElement('small');
    hintEl.className = 'hint';
    hintEl.textContent = hint;
    group.appendChild(hintEl);
  }

  // 初始化
  updateTriggerText();

  return {
    element: group,
    get value() {
      return currentValue;
    },
    setValue(val: string) {
      currentValue = val;
      updateTriggerText();
    },
    setOptions(opts: SelectOption[], grps?: SelectGroup[]) {
      // 需要外部重新传入完整配置，这里简化处理
    },
  };
}
