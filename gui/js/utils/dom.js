// js/utils/dom.js
// DOM 工具函数：创建元素、查找、事件委托等
// 纯工具，无状态，无副作用

const Dom = {

    // ─────────────────────────────────────────
    // 创建元素
    // ─────────────────────────────────────────

    /**
     * 快速创建 DOM 元素
     * @param {string} tag        - 标签名
     * @param {object} attrs      - 属性对象
     * @param {string} innerHTML  - 内部 HTML
     */
    create(tag, attrs = {}, innerHTML = '') {
        const el = document.createElement(tag);
        Object.entries(attrs).forEach(([key, val]) => {
            if (key === 'className') {
                el.className = val;
            } else if (key === 'style' && typeof val === 'object') {
                Object.assign(el.style, val);
            } else {
                el.setAttribute(key, val);
            }
        });
        if (innerHTML) el.innerHTML = innerHTML;
        return el;
    },

    /** 创建 SVG 元素 */
    createSVG(tag, attrs = {}) {
        const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
        Object.entries(attrs).forEach(([key, val]) => {
            el.setAttribute(key, val);
        });
        return el;
    },

    // ─────────────────────────────────────────
    // 查找元素
    // ─────────────────────────────────────────

    /** 查找单个元素 */
    get(selector, parent = document) {
        return parent.querySelector(selector);
    },

    /** 查找多个元素 */
    getAll(selector, parent = document) {
        return Array.from(parent.querySelectorAll(selector));
    },

    /** 根据 ID 查找 */
    getById(id) {
        return document.getElementById(id);
    },

    // ─────────────────────────────────────────
    // 样式操作
    // ─────────────────────────────────────────

    /** 显示元素（flex 布局） */
    show(el, display = 'flex') {
        if (typeof el === 'string') el = this.getById(el);
        if (el) el.style.display = display;
    },

    /** 隐藏元素 */
    hide(el) {
        if (typeof el === 'string') el = this.getById(el);
        if (el) el.style.display = 'none';
    },

    /** 切换 class */
    toggle(el, className) {
        if (typeof el === 'string') el = this.getById(el);
        if (el) el.classList.toggle(className);
    },

    // ─────────────────────────────────────────
    // 位置和尺寸
    // ─────────────────────────────────────────

    /** 设置元素位置 */
    setPos(el, x, y) {
        el.style.left = x + 'px';
        el.style.top  = y + 'px';
    },

    /** 设置元素尺寸 */
    setSize(el, w, h) {
        el.style.width  = w + 'px';
        el.style.height = h + 'px';
    },

    // ─────────────────────────────────────────
    // 事件
    // ─────────────────────────────────────────

    /**
     * 事件委托：在父元素上监听子元素的事件
     * @param {Element} parent    - 父元素
     * @param {string}  selector  - 子元素选择器
     * @param {string}  event     - 事件名
     * @param {Function} handler  - 回调
     */
    delegate(parent, selector, event, handler) {
        parent.addEventListener(event, (e) => {
            const target = e.target.closest(selector);
            if (target && parent.contains(target)) {
                handler(e, target);
            }
        });
    },

    // ─────────────────────────────────────────
    // Toast 提示（全局通知）
    // ─────────────────────────────────────────

    showToast(message, duration = 2000) {
        const toast = this.getById('toast');
        if (!toast) return;

        toast.textContent  = message;
        toast.style.display = 'block';

        // 强制重绘后添加 show 类触发过渡动画
        requestAnimationFrame(() => {
            toast.classList.add('show');
        });

        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => {
                toast.style.display = 'none';
            }, 300);
        }, duration);
    }
};

// Toast 单独暴露为全局，方便各模块直接调用 Toast.show()
const Toast = {
    show: (msg, duration) => Dom.showToast(msg, duration)
};

window.Dom   = Dom;
window.Toast = Toast;
