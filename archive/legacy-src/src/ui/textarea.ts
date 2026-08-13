/**
 * Textarea 多行文本输入组件
 * 
 * 用法：
 *   const ta = Textarea({
 *     label: '提示词',
 *     placeholder: '输入提示词...',
 *     rows: 3,
 *     maxLength: 500,
 *     onChange: (value) => { console.log(value) }
 *   });
 */

export interface TextareaOptions {
  /** 标签文字 */
  label?: string;
  /** 占位符 */
  placeholder?: string;
  /** 初始值 */
  value?: string;
  /** 行数 */
  rows?: number;
  /** 最大长度 */
  maxLength?: number;
  /** 是否禁用 */
  disabled?: boolean;
  /** 是否自动增高 */
  autoResize?: boolean;
  /** 值变化回调 */
  onChange?: (value: string) => void;
  /** 按下回车回调（Ctrl/Cmd+Enter） */
  onEnter?: (value: string) => void;
}

export interface TextareaInstance {
  element: HTMLElement;
  value: string;
  setValue: (value: string) => void;
  focus: () => void;
}

export function Textarea(options: TextareaOptions): TextareaInstance {
  const {
    label,
    placeholder = '',
    value = '',
    rows = 3,
    maxLength,
    disabled = false,
    autoResize = false,
    onChange,
    onEnter,
  } = options;

  const group = document.createElement('div');
  group.className = 'form-group';

  if (label) {
    const labelEl = document.createElement('label');
    labelEl.textContent = label;
    group.appendChild(labelEl);
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.placeholder = placeholder;
  textarea.rows = rows;
  textarea.disabled = disabled;
  if (maxLength) textarea.maxLength = maxLength;

  textarea.addEventListener('input', () => {
    if (autoResize) {
      textarea.style.height = 'auto';
      textarea.style.height = textarea.scrollHeight + 'px';
    }
    onChange?.(textarea.value);
  });

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      onEnter?.(textarea.value);
    }
    e.stopPropagation();
  });

  group.appendChild(textarea);

  return {
    element: group,
    get value() {
      return textarea.value;
    },
    setValue(v: string) {
      textarea.value = v;
      if (autoResize) {
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
      }
    },
    focus() {
      textarea.focus();
    },
  };
}
