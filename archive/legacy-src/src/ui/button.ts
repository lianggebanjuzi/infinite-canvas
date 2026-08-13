/**
 * Button 按钮组件
 * 
 * 用法：
 *   const btn = Button({ text: '确认', type: 'primary', onClick: () => {} });
 *   const btn2 = Button({ icon: 'fa-solid fa-plus', type: 'primary', onClick: () => {} });
 */

export interface ButtonOptions {
  /** 按钮文字 */
  text?: string;
  /** 图标类名 */
  icon?: string;
  /** 按钮类型 */
  type?: 'primary' | 'secondary' | 'danger' | 'ghost';
  /** 按钮尺寸 */
  size?: 'sm' | 'md' | 'lg';
  /** 是否禁用 */
  disabled?: boolean;
  /** 是否为块级按钮（占满宽度） */
  block?: boolean;
  /** 点击回调（支持异步，自动显示加载状态） */
  onClick?: (e: Event) => void | Promise<void>;
}

export interface ButtonInstance {
  element: HTMLButtonElement;
  setDisabled: (disabled: boolean) => void;
  setText: (text: string) => void;
  setLoading: (loading: boolean) => void;
}

export function Button(options: ButtonOptions): ButtonInstance {
  const {
    text,
    icon,
    type = 'primary',
    size = 'md',
    disabled = false,
    block = false,
    onClick,
  } = options;

  const btn = document.createElement('button');
  
  // 构建类名
  const classes = ['btn'];
  classes.push(`btn--${type}`);
  if (size !== 'md') classes.push(`btn--${size}`);
  if (block) classes.push('btn--block');
  btn.className = classes.join(' ');

  btn.disabled = disabled;

  // 内容
  if (icon && !text) {
    btn.innerHTML = `<i class="${icon}"></i>`;
  } else if (icon && text) {
    btn.innerHTML = `<i class="${icon}"></i> ${text}`;
  } else if (text) {
    btn.textContent = text;
  }

  // 点击事件
  if (onClick) {
    btn.addEventListener('click', async (e) => {
      if (btn.disabled) return;
      
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.classList.add('btn--loading');
      
      try {
        await onClick(e);
      } catch (err) {
        console.error('[Button] 点击回调出错:', err);
      } finally {
        btn.disabled = disabled;
        btn.classList.remove('btn--loading');
      }
    });
  }

  return {
    element: btn,
    setDisabled(d: boolean) {
      btn.disabled = d;
    },
    setText(t: string) {
      btn.textContent = t;
    },
    setLoading(loading: boolean) {
      btn.disabled = loading;
      btn.classList.toggle('btn--loading', loading);
    },
  };
}
