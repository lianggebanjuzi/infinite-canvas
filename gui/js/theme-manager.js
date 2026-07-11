/**
 * 主题管理器模块
 * 负责浅色/深色主题切换，使用 localStorage 持久化用户偏好
 */
window.ThemeManager = {
    init() {
        const saved = localStorage.getItem('infinite_canvas_theme');
        if (saved === 'light') {
            document.documentElement.setAttribute('data-theme', 'light');
            this._updateThemeButton(true);
        } else {
            // 默认使用深色主题（无 data-theme 时 :root 就是深色）
            document.documentElement.removeAttribute('data-theme');
            this._updateThemeButton(false);
        }
    },
    toggle() {
        const isDark = document.documentElement.getAttribute('data-theme') === 'light';
        if (isDark) {
            // 从浅色切到深色：移除属性，:root 即为深色
            document.documentElement.removeAttribute('data-theme');
            localStorage.setItem('infinite_canvas_theme', 'dark');
            this._updateThemeButton(false);
        } else {
            // 从深色切到浅色：设置 light 属性
            document.documentElement.setAttribute('data-theme', 'light');
            localStorage.setItem('infinite_canvas_theme', 'light');
            this._updateThemeButton(true);
        }
    },
    _updateThemeButton(isDark) {
        const btn = document.getElementById('theme-toggle-btn');
        if (!btn) return;
        btn.innerHTML = isDark
            ? '<i class="fas fa-sun"></i> 浅色'
            : '<i class="fas fa-moon"></i> 暗色';
    }
};
