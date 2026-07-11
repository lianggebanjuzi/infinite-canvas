/**
 * 自定义表单输入框（JS 版本，供现有代码使用）
 */
window.UIInput = function UIInput(options) {
    const {
        label, labelHint, type = 'text', placeholder = '', hint,
        value = '', maxLength, disabled = false, readonly = false,
        width = '100%', onChange, onEnter, actions,
    } = options;

    const group = document.createElement('div');
    group.className = 'form-group';

    if (label) {
        const labelEl = document.createElement('label');
        labelEl.textContent = label;
        if (labelHint) {
            const hintSpan = document.createElement('small');
            hintSpan.style.cssText = 'color:var(--text-tertiary);font-weight:normal;margin-left:4px;';
            hintSpan.textContent = labelHint;
            labelEl.appendChild(hintSpan);
        }
        group.appendChild(labelEl);
    }

    const inputWrap = document.createElement('div');
    if (actions && actions.length > 0) inputWrap.className = 'input-with-actions';

    const input = document.createElement('input');
    input.type = type;
    input.value = value;
    input.placeholder = placeholder;
    input.disabled = disabled;
    input.readOnly = readonly;
    input.style.width = width;
    if (maxLength) input.maxLength = maxLength;

    input.addEventListener('input', () => { if (onChange) onChange(input.value); });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && onEnter) { onEnter(input.value); e.preventDefault(); }
        e.stopPropagation();
    });

    inputWrap.appendChild(input);

    if (actions) {
        actions.forEach(({ icon, title, onClick }) => {
            const btn = document.createElement('button');
            btn.className = 'icon-btn';
            if (title) btn.title = title;
            btn.innerHTML = '<i class="' + icon + '"></i>';
            btn.addEventListener('click', () => onClick(input.value));
            inputWrap.appendChild(btn);
        });
    }

    group.appendChild(inputWrap);

    if (hint) {
        const hintEl = document.createElement('small');
        hintEl.className = 'hint';
        hintEl.textContent = hint;
        group.appendChild(hintEl);
    }

    return {
        element: group,
        get value() { return input.value; },
        setValue(v) { input.value = v; if (onChange) onChange(v); },
        focus() { input.focus(); },
        input: input,
    };
};

/**
 * 自定义开关组件（JS 版本）
 */
window.UISwitch = function UISwitch(options) {
    const { label, hint, value = false, disabled = false, onChange } = options;

    const group = document.createElement('div');
    group.className = 'form-group form-group--inline';

    const textWrap = document.createElement('div');
    const labelEl = document.createElement('label');
    labelEl.textContent = label;
    labelEl.style.marginBottom = hint ? '2px' : '0';
    textWrap.appendChild(labelEl);

    if (hint) {
        const hintEl = document.createElement('small');
        hintEl.className = 'hint';
        hintEl.textContent = hint;
        textWrap.appendChild(hintEl);
    }
    group.appendChild(textWrap);

    const switchLabel = document.createElement('label');
    switchLabel.className = 'toggle-switch';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = value;
    checkbox.disabled = disabled;
    checkbox.setAttribute('role', 'switch');
    checkbox.setAttribute('aria-checked', String(value));
    if (label) checkbox.setAttribute('aria-label', label);
    checkbox.addEventListener('change', () => {
        checkbox.setAttribute('aria-checked', String(checkbox.checked));
        if (onChange) onChange(checkbox.checked);
    });

    const slider = document.createElement('span');
    slider.className = 'toggle-slider';

    switchLabel.appendChild(checkbox);
    switchLabel.appendChild(slider);
    group.appendChild(switchLabel);

    return {
        element: group,
        get value() { return checkbox.checked; },
        setValue(checked) { checkbox.checked = checked; if (onChange) onChange(checked); },
    };
};

/**
 * 自定义文本域组件（JS 版本）
 */
window.UITextarea = function UITextarea(options) {
    const {
        label, placeholder = '', value = '', rows = 3,
        maxLength, disabled = false, autoResize = false,
        onChange, onEnter,
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
        if (autoResize) { textarea.style.height = 'auto'; textarea.style.height = textarea.scrollHeight + 'px'; }
        if (onChange) onChange(textarea.value);
    });

    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && onEnter) { onEnter(textarea.value); }
        e.stopPropagation();
    });

    group.appendChild(textarea);

    return {
        element: group,
        get value() { return textarea.value; },
        setValue(v) { textarea.value = v; if (autoResize) { textarea.style.height = 'auto'; textarea.style.height = textarea.scrollHeight + 'px'; } },
        focus() { textarea.focus(); },
    };
};
