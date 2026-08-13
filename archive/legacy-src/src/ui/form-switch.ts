/**
 * FormSwitch 开关组件
 * 
 * 用法：
 *   const sw = FormSwitch({
 *     label: '使用代理',
 *     hint: '关闭后请求将绕过系统代理直连',
 *     value: true,
 *     onChange: (checked) => { console.log(checked) }
 *   });
 *   
 *   document.body.appendChild(sw.element);
 */

export interface FormSwitchOptions {
  /** 标签文字 */
  label?: string;
  /** 底部提示文字 */
  hint?: string;
  /** 初始状态，默认 false */
  value?: boolean;
  /** 是否禁用 */
  disabled?: boolean;
  /** 状态变化回调 */
  onChange?: (checked: boolean) => void;
}

export interface FormSwitchInstance {
  element: HTMLElement;
  value: boolean;
  setValue: (checked: boolean) => void;
}

export function FormSwitch(options: FormSwitchOptions): FormSwitchInstance {
  const {
    label,
    hint,
    value = false,
    disabled = false,
    onChange,
  } = options;

  // 容器
  const group = document.createElement('div');
  group.className = 'form-group form-group--inline';

  // 左侧文字区域
  const textWrap = document.createElement('div');
  const labelEl = document.createElement('label');
  labelEl.textContent = label || null;
  labelEl.style.marginBottom = hint ? '2px' : '0';
  textWrap.appendChild(labelEl);

  if (hint) {
    const hintEl = document.createElement('small');
    hintEl.className = 'hint';
    hintEl.textContent = hint;
    textWrap.appendChild(hintEl);
  }
  group.appendChild(textWrap);

  // 开关
  const switchLabel = document.createElement('label');
  switchLabel.className = 'toggle-switch';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = value;
  checkbox.disabled = disabled;
  checkbox.addEventListener('change', () => {
    onChange?.(checkbox.checked);
  });

  const slider = document.createElement('span');
  slider.className = 'toggle-slider';

  switchLabel.appendChild(checkbox);
  switchLabel.appendChild(slider);
  group.appendChild(switchLabel);

  return {
    element: group,
    get value() {
      return checkbox.checked;
    },
    setValue(checked: boolean) {
      checkbox.checked = checked;
      onChange?.(checked);
    },
  };
}
