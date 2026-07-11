// src/independent/theme-manager.ts
// 主题管理器：深色/浅色主题切换，localStorage 持久化

export const ThemeManager = {
    init(): void {
        const saved = localStorage.getItem('infinite_canvas_theme');
        if (saved === 'light') {
            document.documentElement.setAttribute('data-theme', 'light');
            this._updateThemeButton(true);
        } else {
            document.documentElement.removeAttribute('data-theme');
            this._updateThemeButton(false);
        }
    },

    toggle(): void {
        const isDark = document.documentElement.getAttribute('data-theme') === 'light';
        if (isDark) {
            document.documentElement.removeAttribute('data-theme');
            localStorage.setItem('infinite_canvas_theme', 'dark');
            this._updateThemeButton(false);
        } else {
            document.documentElement.setAttribute('data-theme', 'light');
            localStorage.setItem('infinite_canvas_theme', 'light');
            this._updateThemeButton(true);
        }
    },

    _updateThemeButton(isDark: boolean): void {
        const btn = document.getElementById('theme-toggle-btn');
        if (!btn) return;
        btn.innerHTML = isDark
            ? '<i class="fas fa-sun"></i> 浅色'
            : '<i class="fas fa-moon"></i> 暗色';
    }
};

(window as unknown as Record<string, unknown>).ThemeManager = ThemeManager;
