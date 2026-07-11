// src/utils/dom.ts
// DOM 工具函数：创建元素、查找、事件委托等

export const Dom = {

    create<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, innerHTML = ''): HTMLElementTagNameMap[K] {
        const el = document.createElement(tag);
        Object.entries(attrs).forEach(([key, val]) => {
            if (key === 'className') {
                el.className = val as string;
            } else if (key === 'style' && typeof val === 'object') {
                Object.assign(el.style, val as CSSStyleDeclaration);
            } else {
                el.setAttribute(key, String(val));
            }
        });
        if (innerHTML) el.innerHTML = innerHTML;
        return el;
    },

    createSVG(tag: string, attrs: Record<string, string | number> = {}): SVGElement {
        const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
        Object.entries(attrs).forEach(([key, val]) => {
            el.setAttribute(key, String(val));
        });
        return el;
    },

    get<K extends keyof HTMLElementTagNameMap>(
        selector: string,
        parent: ParentNode = document
    ): HTMLElementTagNameMap[K] | null {
        return parent.querySelector(selector) as HTMLElementTagNameMap[K] | null;
    },

    getAll<K extends keyof HTMLElementTagNameMap>(
        selector: string,
        parent: ParentNode = document
    ): HTMLElementTagNameMap[K][] {
        return Array.from(parent.querySelectorAll(selector)) as HTMLElementTagNameMap[K][];
    },

    getById(id: string): HTMLElement | null {
        return document.getElementById(id);
    },

    show(el: HTMLElement | string, display = 'flex'): void {
        if (typeof el === 'string') el = this.getById(el) as HTMLElement;
        if (el) el.style.display = display;
    },

    hide(el: HTMLElement | string): void {
        if (typeof el === 'string') el = this.getById(el) as HTMLElement;
        if (el) el.style.display = 'none';
    },

    toggle(el: HTMLElement | string, className: string): void {
        if (typeof el === 'string') el = this.getById(el) as HTMLElement;
        if (el) el.classList.toggle(className);
    },

    setPos(el: HTMLElement, x: number, y: number): void {
        el.style.left = x + 'px';
        el.style.top  = y + 'px';
    },

    setSize(el: HTMLElement, w: number, h: number): void {
        el.style.width  = w + 'px';
        el.style.height = h + 'px';
    },

    delegate<E extends Event = Event>(
        parent: Element,
        selector: string,
        event: string,
        handler: (e: E, target: Element) => void
    ): void {
        parent.addEventListener(event, (e) => {
            const target = (e as unknown as { target: Element }).target.closest(selector);
            if (target && parent.contains(target)) {
                handler(e as E, target);
            }
        });
    },

    showToast(message: string, duration = 2000): void {
        const toast = this.getById('toast') as HTMLElement;
        if (!toast) return;

        toast.textContent  = message;
        toast.style.display = 'block';

        requestAnimationFrame(() => {
            toast.classList.add('show');
        });

        clearTimeout((this as unknown as { _toastTimer: ReturnType<typeof setTimeout> })._toastTimer);
        (this as unknown as { _toastTimer: ReturnType<typeof setTimeout> })._toastTimer = setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => {
                toast.style.display = 'none';
            }, 300);
        }, duration);
    }
};

export const Toast = {
    show: (msg: string, duration?: number) => Dom.showToast(msg, duration)
};

(window as unknown as { Dom: typeof Dom }).Dom = Dom;
