/**
 * FormInput 表单输入组件
 * 
 * 用法：
 *   const input = FormInput({
 *     label: 'API 密钥',
 *     type: 'password',
 *     placeholder: '输入你的 API 密钥',
 *     hint: '多个密钥使用逗号分隔',
 *     value: '',
 *     onChange: (value) => { console.log(value) }
 *   });
 *   
 *   document.body.appendChild(input.element);
 *   
 *   // 获取值
 *   console.log(input.value);
 *   
 *   // 设置值
 *   input.setValue('new value');
 */

export interface FormInputOptions {
  /** 标签文字 */
  label?: string;
  /** 标签后的小提示（灰色） */
  labelHint?: string;
  /** 输入类型，默认 'text' */
  type?: 'text' | 'password' | 'number' | 'email' | 'url';
  /** 占位符 */
  placeholder?: string;
  /** 底部提示文字 */
  hint?: string;
  /** 初始值 */
  value?: string;
  /** 最大长度 */
  maxLength?: number;
  /** 是否禁用 */
  disabled?: boolean;
  /** 是否只读 */
  readonly?: boolean;
  /** 输入框宽度，默认 '100%' */
  width?: string;
  /** 值变化回调 */
  onChange?: (value: string) => void;
  /** 按下回车回调 */
  onEnter?: (value: string) => void;
  /** 右侧操作按钮 */
  actions?: Array<{
    icon: string;
    title?: string;
    onClick: (value: string) => void;
  }>;
}

export interface FormInputInstance {
  element: HTMLElement;
  value: string;
  setValue: (value: string) => void;
  focus: () => void;
}

export function FormInput(options: FormInputOptions): FormInputInstance {
  const {
    label,
    labelHint,
    type = 'text',
    placeholder,
    hint,
    value = '',
    maxLength,
    disabled = false,
    readonly = false,
    width = '100%',
    onChange,
    onEnter,
    actions,
  } = options;

  // 容器
  const group = document.createElement('div');
  group.className = 'form-group';

  // 标签
  const labelEl = document.createElement('label');
  labelEl.textContent = label || null;
  if (labelHint) {
    const hintSpan = document.createElement('small');
    hintSpan.style.cssText = 'color:#999;font-weight:normal;margin-left:4px;';
    hintSpan.textContent = labelHint;
    labelEl.appendChild(hintSpan);
  }
  group.appendChild(labelEl);

  // 输入框容器
  const inputWrap = document.createElement('div');
  inputWrap.className = actions ? 'input-with-actions' : '';

  // 输入框
  const input = document.createElement('input');
  input.type = type;
  input.value = value;
  input.placeholder = placeholder || '';
  input.disabled = disabled;
  if (readonly) input.readOnly = true;
  input.style.width = width;
  if (maxLength) input.maxLength = maxLength;

  // 事件
  input.addEventListener('input', () => {
    onChange?.(input.value);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      onEnter?.(input.value);
    }
    e.stopPropagation();
  });

  inputWrap.appendChild(input);

  // 操作按钮
  if (actions) {
    actions.forEach(({ icon, title, onClick }) => {
      const btn = document.createElement('button');
      btn.className = 'icon-btn';
      if (title) btn.title = title;
      btn.innerHTML = `<i class="${icon}"></i>`;
      btn.addEventListener('click', () => onClick(input.value));
      inputWrap.appendChild(btn);
    });
  }

  group.appendChild(inputWrap);

  // 底部提示
  if (hint) {
    const hintEl = document.createElement('small');
    hintEl.className = 'hint';
    hintEl.textContent = hint;
    group.appendChild(hintEl);
  }

  return {
    element: group,
    get value() {
      return input.value;
    },
    setValue(v: string) {
      input.value = v;
      onChange?.(v);
    },
    focus() {
      input.focus();
    },
  };
}
