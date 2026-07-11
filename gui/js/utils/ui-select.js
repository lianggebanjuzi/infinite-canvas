/**
 * 自定义下拉选择器（JS 版本，供现有代码使用）
 * 用法与 src/ui/select.ts 相同，但无需编译
 */

window.UISelect = function UISelect(options) {
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
            hintSpan.style.cssText = 'color:var(--text-tertiary);font-weight:normal;margin-left:4px;';
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
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    if (label) trigger.setAttribute('aria-label', label);

    let currentValue = value;
    let isOpen = false;

    function getAllOptions() {
        return [...selectOptions, ...groups.flatMap(g => g.options)];
    }

    function updateTriggerText() {
        const allOptions = getAllOptions();
        const found = allOptions.find(o => o.value === currentValue);
        trigger.textContent = found ? found.label : (placeholder || '请选择');
        trigger.classList.toggle('custom-select__trigger--placeholder', !found);
    }

    // 下拉菜单
    const menu = document.createElement('div');
    menu.className = 'custom-select__menu';
    menu.setAttribute('role', 'listbox');

    function renderMenu() {
        menu.innerHTML = '';

        if (placeholder) {
            const opt = document.createElement('div');
            opt.className = 'custom-select__option';
            opt.textContent = placeholder;
            opt.dataset.value = '';
            opt.setAttribute('role', 'option');
            if (currentValue === '') {
                opt.classList.add('is-selected');
                opt.setAttribute('aria-selected', 'true');
            }
            opt.addEventListener('click', () => setValueAndClose(''));
            menu.appendChild(opt);
        }

        // 普通选项
        selectOptions.forEach(o => {
            const opt = document.createElement('div');
            opt.className = 'custom-select__option' +
                (o.disabled ? ' is-disabled' : '') +
                (o.value === currentValue ? ' is-selected' : '');
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
                opt.className = 'custom-select__option' +
                    (o.disabled ? ' is-disabled' : '') +
                    (o.value === currentValue ? ' is-selected' : '');
                opt.textContent = o.label;
                opt.dataset.value = o.value;
                if (!o.disabled) {
                    opt.addEventListener('click', () => setValueAndClose(o.value));
                }
                menu.appendChild(opt);
            });
        });
    }

    function setValueAndClose(val) {
        currentValue = val;
        updateTriggerText();
        close();
        if (onChange) onChange(val);
    }

    function open() {
        if (isOpen) return;
        isOpen = true;
        renderMenu();
        selectWrap.classList.add('is-open');
        menu.style.display = 'block';
        trigger.setAttribute('aria-expanded', 'true');
        document.addEventListener('click', handleOutsideClick);
    }

    function close() {
        if (!isOpen) return;
        isOpen = false;
        selectWrap.classList.remove('is-open');
        menu.style.display = 'none';
        trigger.setAttribute('aria-expanded', 'false');
        document.removeEventListener('click', handleOutsideClick);
    }

    function handleOutsideClick(e) {
        if (!selectWrap.contains(e.target)) {
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
        get value() { return currentValue; },
        setValue(val) {
            currentValue = val;
            updateTriggerText();
        },
    };
};
