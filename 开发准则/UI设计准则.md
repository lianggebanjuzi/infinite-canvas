# Infinite Canvas 1.0 — UI 设计准则

> 版本：1.0
> 日期：2026-03-21
> 关联文档：[UI设计方案-玻璃极简风.md](UI设计方案-玻璃极简风.md)

---

## 目的

本准则为 Infinite Canvas 1.0 的 UI 开发提供统一的规范指导，确保新增功能或修改现有功能时保持设计一致性。所有开发者在进行 UI 相关工作时都应遵循本准则。

---

## 一、通用原则

### 1.1 设计优先级

| 优先级 | 说明 |
|--------|------|
| **功能可用性** | 功能必须可用，这是最低底线 |
| **视觉一致性** | 新增 UI 必须与现有风格保持一致 |
| **交互流畅性** | 所有交互必须有即时或近即时的视觉反馈 |
| **无障碍性** | 满足 WCAG 2.1 AA 级标准 |

### 1.2 禁止事项

| 禁止 | 原因 | 正确做法 |
|------|------|----------|
| 使用 emoji 作为 UI 图标 | 不可缩放、不可控制颜色 | 使用 Font Awesome SVG |
| 硬编码颜色值 | 破坏主题一致性 | 使用 CSS 变量 |
| 硬编码字号 | 破坏字体层级 | 使用 `--text-*` 变量 |
| 硬编码圆角值 | 破坏圆角一致性 | 使用 `--radius-*` 变量 |
| 硬编码阴影值 | 破坏阴影一致性 | 使用 `--shadow-*` 变量 |
| 使用 `!important` | 破坏级联 | 重构选择器特异性 |
| 内联样式 | 不可复用、不可主题化 | 使用 CSS 类 |

---

## 二、CSS 变量使用规范

### 2.1 必须使用的变量

新增任何 UI 时，**必须**使用以下变量类别：

#### 颜色变量

```css
/* 强调色 */
var(--accent-primary)           /* 主强调色 */
var(--accent-secondary)         /* 次强调色 */
var(--accent-tertiary)          /* 第三强调色 */

/* 背景色 */
var(--bg-canvas)                /* 画布背景 */
var(--bg-card)                  /* 卡片背景 */
var(--bg-embedded)              /* 内嵌区域（输入框、列表等） */
var(--bg-toolbar)               /* 工具栏/侧边栏 */
var(--bg-elevated)              /* 弹出层/菜单 */

/* 文字色 */
var(--text-primary)             /* 主要文字 */
var(--text-secondary)           /* 次要文字 */
var(--text-tertiary)            /* 辅助文字 */
var(--text-on-accent)           /* 强调色上的文字 */

/* 边框 */
var(--border-subtle)            /* 柔和边框 */
var(--border-default)           /* 默认边框 */
var(--border-strong)            /* 强调边框 */

/* 功能色 */
var(--color-success)            /* 成功 */
var(--color-warning)           /* 警告 */
var(--color-error)             /* 错误 */
var(--color-info)              /* 信息 */
```

#### 字号变量

```css
var(--text-xs)     /* 11px：徽章、次要标签 */
var(--text-sm)     /* 13px：正文、次要信息 */
var(--text-base)   /* 14px：主要正文 */
var(--text-lg)     /* 16px：标题、次要标题 */
var(--text-xl)     /* 18px：面板标题 */
```

#### 圆角变量

```css
var(--radius-xs)    /* 4px：徽章、小标签 */
var(--radius-sm)    /* 8px：按钮、分隔区块 */
var(--radius-md)    /* 12px：输入框、下拉项 */
var(--radius-lg)    /* 16px：卡片、面板 */
var(--radius-xl)    /* 20px：大型面板 */
var(--radius-full)  /* 9999px：胶囊按钮、Toast */
```

#### 阴影变量

```css
var(--shadow-xs)    /* 轻微：内嵌元素 */
var(--shadow-sm)    /* 小阴影：按钮悬停 */
var(--shadow-md)    /* 中等：卡片默认 */
var(--shadow-lg)    /* 大阴影：卡片悬停、工具栏 */
var(--shadow-xl)    /* 极大：弹出菜单、面板 */
var(--shadow-glow)  /* 发光：聚焦状态 */
```

#### 动画变量

```css
/* 时长 */
var(--duration-instant)   /* 0ms：无动画 */
var(--duration-fast)       /* 100ms：微交互 */
var(--duration-base)       /* 150ms：标准过渡 */
var(--duration-slow)       /* 250ms：面板展开 */
var(--duration-slower)     /* 350ms：大型动画 */

/* 缓动 */
var(--ease-default)   /* 标准 ease */
var(--ease-in)        /* 进入动画 */
var(--ease-out)       /* 退出动画 */
var(--ease-spring)    /* 弹性反馈 */
```

### 2.2 变量命名规范

新增变量时遵循以下命名规范：

| 类型 | 命名格式 | 示例 |
|------|----------|------|
| 颜色 | `--[prefix]-[color]` | `--accent-primary`, `--bg-card` |
| 字号 | `--text-[size]` | `--text-sm`, `--text-lg` |
| 圆角 | `--radius-[size]` | `--radius-sm`, `--radius-lg` |
| 阴影 | `--shadow-[size]` | `--shadow-md`, `--shadow-xl` |
| 间距 | `--space-[n]` | `--space-2`, `--space-4` |
| 动效 | `--duration-[name]` | `--duration-fast` |

### 2.3 禁止硬编码

以下场景**禁止**硬编码，必须使用变量：

```css
/* ❌ 错误：硬编码颜色 */
color: #6366F1;
background: #18181B;
border-color: rgba(255, 255, 255, 0.1);

/* ✅ 正确：使用变量 */
color: var(--accent-primary);
background: var(--bg-card);
border-color: var(--border-default);
```

---

## 三、组件开发规范

### 3.1 新增组件流程

```
1. 确认功能需求
   ↓
2. 查看设计文档确认样式规范
   ↓
3. 确定使用的 CSS 变量
   ↓
4. 编写 HTML 结构
   ↓
5. 编写 CSS 样式（使用变量）
   ↓
6. 添加交互 JavaScript
   ↓
7. 检查一致性
   ↓
8. 提交代码
```

### 3.2 组件结构规范

#### HTML 结构原则

```html
<!-- ✅ 使用语义化标签 -->
<button class="btn">保存</button>
<div class="panel">
    <header class="panel-header">标题</header>
    <main class="panel-content">内容</main>
    <footer class="panel-footer">操作</footer>
</div>

<!-- ❌ 避免：无意义 div -->
<div class="wrapper">
    <div class="inner">
        <div class="content-wrapper">
            <span class="text">保存</span>
        </div>
    </div>
</div>
```

#### BEM 命名规范

使用 BEM（Block Element Modifier）命名 CSS 类：

```css
/* Block：独立组件 */
.panel { }

/* Element：组件的子元素 */
.panel__header { }
.panel__content { }
.panel__footer { }

/* Modifier：组件的变体 */
.panel--dark { }
.panel__header--large { }
```

```html
<div class="panel panel--dark">
    <header class="panel__header panel__header--large">标题</header>
    <div class="panel__content">内容</div>
</div>
```

### 3.3 组件状态规范

所有交互组件必须实现以下状态：

| 状态 | 必须实现 | 说明 |
|------|---------|------|
| 默认态 | ✅ | 组件的默认外观 |
| 悬停态 | ✅ | 鼠标悬停时的反馈 |
| 激活态 | ✅ | 鼠标按下时的反馈 |
| 聚焦态 | ✅ | 键盘焦点的可见指示 |
| 禁用态 | 如需要 | 禁用状态的外观 |

#### 状态实现示例

```css
/* 默认状态 */
.btn {
    background: var(--accent-primary);
    color: var(--text-on-accent);
    border-radius: var(--radius-sm);
    transition: background var(--duration-fast) var(--ease-default),
                transform var(--duration-fast) var(--ease-out);
}

/* 悬停状态 */
.btn:hover {
    background: var(--accent-primary-hover);
}

/* 激活状态 */
.btn:active {
    transform: scale(0.97);
}

/* 聚焦状态（无障碍） */
.btn:focus-visible {
    outline: 2px solid var(--accent-primary);
    outline-offset: 2px;
}

/* 禁用状态 */
.btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}
```

### 3.4 组件模板

#### 按钮组件模板

```css
/* === 按钮基础样式 === */
.btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    font-size: var(--text-sm);
    font-weight: 500;
    border-radius: var(--radius-sm);
    border: none;
    cursor: pointer;
    transition: all var(--duration-fast) var(--ease-default);
}

/* 主要按钮 */
.btn--primary {
    background: var(--accent-primary);
    color: var(--text-on-accent);
}

.btn--primary:hover {
    background: var(--accent-primary-hover);
}

/* 次要按钮 */
.btn--secondary {
    background: var(--bg-embedded);
    color: var(--text-primary);
    border: 1px solid var(--border-default);
}

.btn--secondary:hover {
    background: var(--bg-toolbar);
    border-color: var(--border-strong);
}

/* 图标按钮 */
.btn--icon {
    padding: var(--space-2);
    background: transparent;
    color: var(--text-tertiary);
}

.btn--icon:hover {
    background: var(--bg-embedded);
    color: var(--text-primary);
}
```

#### 卡片组件模板

```css
/* === 卡片基础样式 === */
.card {
    position: absolute;
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--card-border-radius);
    box-shadow: var(--shadow-md);
    display: flex;
    flex-direction: column;
    overflow: visible;
    transition: box-shadow var(--duration-base) var(--ease-default),
                border-color var(--duration-fast) var(--ease-default),
                transform var(--duration-fast) var(--ease-spring);
}

/* 悬停状态 */
.card:hover {
    box-shadow: var(--shadow-lg);
    border-color: var(--border-default);
    transform: translateY(-2px);
}

/* 选中状态 */
.card--selected {
    border-color: var(--accent-primary);
    box-shadow: var(--shadow-glow), var(--shadow-lg);
}

/* 拖拽状态 */
.card--dragging {
    box-shadow: var(--shadow-xl), 0 0 0 2px var(--accent-primary);
    transform: scale(1.02);
    transition: none;
}

/* 标题栏 */
.card__header {
    height: var(--card-titlebar-height);
    padding: 0 var(--space-3);
    display: flex;
    align-items: center;
    background: rgba(255, 255, 255, 0.04);
    border-bottom: 1px solid var(--border-subtle);
    border-radius: var(--card-border-radius) var(--card-border-radius) 0 0;
    cursor: grab;
}

/* 内容区 */
.card__body {
    flex: 1;
    padding: var(--space-3);
    overflow: hidden;
}
```

#### 输入框组件模板

```css
/* === 输入框基础样式 === */
.input {
    width: 100%;
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-sm);
    color: var(--text-primary);
    background: var(--bg-embedded);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    transition: border-color var(--duration-fast) var(--ease-default),
                box-shadow var(--duration-fast) var(--ease-default);
}

.input::placeholder {
    color: var(--text-tertiary);
}

.input:focus {
    outline: none;
    border-color: var(--accent-primary);
    box-shadow: var(--shadow-glow);
}

.input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}
```

---

## 四、动画规范

### 4.1 动画使用原则

| 原则 | 说明 |
|------|------|
| **有目的** | 每个动画必须有明确的交互目的 |
| **快速响应** | 微交互动画不超过 200ms |
| **可中断** | 用户操作应立即取消正在进行的动画 |
| **可关闭** | 必须支持 `prefers-reduced-motion` |

### 4.2 动画时长选择

| 时长 | 用途 | 示例 |
|------|------|------|
| `0ms` | 无动画 | 拖拽实时更新 |
| `100ms` | 微交互 | 悬停背景变化 |
| `150ms` | 标准过渡 | 按钮状态变化 |
| `250ms` | 面板展开 | 下拉菜单、浮层 |
| `350ms` | 大型动画 | 页面切换 |

### 4.3 缓动函数选择

| 缓动 | 用途 | 示例 |
|------|------|------|
| `--ease-default` | 标准过渡 | 颜色、背景变化 |
| `--ease-out` | 进入动画 | 面板打开 |
| `--ease-in` | 退出动画 | 面板关闭 |
| `--ease-spring` | 弹性反馈 | 按钮按下、菜单弹出 |

### 4.4 动画实现示例

```css
/* 菜单弹出 */
.dropdown {
    transform-origin: top center;
    animation: dropdownIn var(--duration-base) var(--ease-spring);
}

@keyframes dropdownIn {
    from {
        opacity: 0;
        transform: scale(0.95) translateY(-4px);
    }
    to {
        opacity: 1;
        transform: scale(1) translateY(0);
    }
}

/* 减少动画偏好 */
@media (prefers-reduced-motion: reduce) {
    .dropdown {
        animation: none;
    }
    
    *, *::before, *::after {
        animation-duration: 0.01ms !important;
        transition-duration: 0.01ms !important;
    }
}
```

---

## 五、深色/浅色主题规范

### 5.1 主题切换机制

```javascript
// 主题切换函数
toggleTheme() {
    const html = document.documentElement;
    const currentTheme = html.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    
    html.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
}
```

### 5.2 主题变量覆盖规则

所有主题相关变量必须在 `[data-theme="light"]` 选择器中覆盖：

```css
:root {
    /* 深色主题（默认） */
    --bg-card: #18181B;
    --text-primary: #FAFAFA;
}

[data-theme="light"] {
    /* 浅色主题覆盖 */
    --bg-card: #FFFFFF;
    --text-primary: #18181B;
}
```

### 5.3 主题一致性检查

新增 UI 元素时，必须检查：

- [ ] 深色主题下背景色正确
- [ ] 浅色主题下背景色正确
- [ ] 文字在深色主题下对比度 ≥ 4.5:1
- [ ] 文字在浅色主题下对比度 ≥ 4.5:1
- [ ] 边框在深色主题下可见
- [ ] 边框在浅色主题下可见
- [ ] 阴影在深色主题下足够深
- [ ] 阴影在浅色主题下足够浅

---

## 六、无障碍规范

### 6.1 键盘无障碍

| 要求 | 实现方法 |
|------|----------|
| 所有交互元素可 Tab 聚焦 | 使用 `button`、`a` 等可聚焦元素 |
| 焦点指示器可见 | 使用 `:focus-visible` 样式 |
| 焦点顺序合理 | 使用 DOM 顺序或 `tabindex` |
| 支持键盘操作 | ESC 关闭弹窗，Enter 确认 |

### 6.2 屏幕阅读器支持

| 要求 | 实现方法 |
|------|----------|
| 图片有 alt 文本 | `<img alt="描述">` |
| 图标按钮有 aria-label | `<button aria-label="保存">` |
| 状态变化有提示 | 使用 `aria-live` 区域 |
| 表单有标签 | `<label>` 或 `aria-label` |

### 6.3 无障碍检查清单

```css
/* ✅ 正确的焦点样式 */
button:focus-visible {
    outline: 2px solid var(--accent-primary);
    outline-offset: 2px;
}

/* ✅ 语义化 HTML */
<button class="btn" aria-label="关闭菜单">×</button>

/* ❌ 错误的做法 */
<div class="close-btn" onclick="close()">×</div>
```

---

## 七、图标规范

### 7.1 图标来源

**必须使用 Font Awesome 6 Free**

```html
<!-- 在 index.html 中引入 -->
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
```

### 7.2 图标使用规范

| 场景 | 使用方式 | 示例 |
|------|----------|------|
| 按钮内图标 | `<i class="fas fa-save"></i>` | 保存按钮 |
| 菜单图标 | `<i class="fas fa-copy"></i>` | 右键菜单 |
| 面板图标 | `<i class="fas fa-cog"></i>` | 设置面板标题 |

### 7.3 图标颜色规范

```css
/* 图标颜色跟随文字颜色 */
.tool-btn {
    color: var(--text-primary);
}

.tool-btn i {
    color: var(--text-tertiary);  /* 默认灰色 */
    transition: color var(--duration-fast) var(--ease-default);
}

.tool-btn:hover i {
    color: var(--accent-primary);  /* 悬停时主题色 */
}
```

### 7.4 禁止使用 emoji

```html
<!-- ❌ 禁止 -->
<button>保存 🎮</button>

<!-- ✅ 正确 -->
<button><i class="fas fa-save"></i> 保存</button>
```

---

## 八、命名规范

### 8.1 CSS 类命名

| 类型 | 命名格式 | 示例 |
|------|----------|------|
| 组件 | kebab-case | `.card`, `.toolbar`, `.sidebar` |
| 组件子元素 | BEM | `.card__header`, `.toolbar__btn` |
| 组件变体 | BEM Modifier | `.btn--primary`, `.card--selected` |
| 状态类 | is-/has- 前缀 | `.is-active`, `.has-error` |
| 工具类 | kebab-case | `.text-center`, `.mt-4` |

### 8.2 JavaScript 命名

| 类型 | 命名格式 | 示例 |
|------|----------|------|
| 变量 | camelCase | `currentTheme`, `isDragging` |
| 常量 | UPPER_SNAKE_CASE | `MAX_FILE_SIZE`, `DEFAULT_ZOOM` |
| 函数 | camelCase | `toggleTheme()`, `openModal()` |
| 类/模块 | PascalCase | `ThemeManager`, `CardFactory` |
| DOM 变量 | $ 前缀 | `$canvasContainer`, `$cardBody` |

### 8.3 文件命名

| 类型 | 命名格式 | 示例 |
|------|----------|------|
| CSS 文件 | kebab-case | `card.css`, `card-preview.css` |
| JS 文件 | kebab-case | `theme-manager.js`, `card-factory.js` |
| HTML 文件 | kebab-case | `index.html` |
| 图片文件 | kebab-case | `icon-save.svg`, `bg-canvas.png` |

---

## 九、代码组织规范

### 9.1 CSS 文件结构

```css
/* styles/card.css */

/* ═══════════════════════════════════════
   注释：区块标题
═══════════════════════════════════════ */

/* ── 子区块标题 ── */

/* 单行注释：简短说明 */

.card {
    /* CSS 属性按功能分组 */
    /* 布局 */
    position: absolute;
    display: flex;
    /* 外观 */
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--card-border-radius);
    /* 效果 */
    box-shadow: var(--shadow-md);
    /* 过渡 */
    transition: all var(--duration-base) var(--ease-default);
}
```

### 9.2 CSS 属性顺序

```css
.selector {
    /* 1. 定位 */
    position: absolute;
    top: 0; left: 0;
    
    /* 2. 尺寸 */
    width: 100%;
    height: 100px;
    
    /* 3. 布局 */
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    
    /* 4. 外边距 */
    margin: 0;
    padding: 16px;
    
    /* 5. 边框 */
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    
    /* 6. 背景 */
    background: var(--bg-card);
    
    /* 7. 文字 */
    font-size: var(--text-sm);
    color: var(--text-primary);
    
    /* 8. 其他 */
    overflow: hidden;
    cursor: pointer;
    
    /* 9. 过渡 */
    transition: all var(--duration-fast) var(--ease-default);
}
```

---

## 十、调试与验证

### 10.1 开发自检清单

在提交代码前，必须检查：

- [ ] 所有颜色使用 CSS 变量
- [ ] 所有字号使用 CSS 变量
- [ ] 所有圆角使用 CSS 变量
- [ ] 所有阴影使用 CSS 变量
- [ ] 所有动画使用 CSS 变量
- [ ] 图标使用 Font Awesome，不使用 emoji
- [ ] 组件状态完整（默认、悬停、激活、聚焦）
- [ ] 深色主题下显示正确
- [ ] 浅色主题下显示正确
- [ ] 键盘可聚焦、有焦点指示
- [ ] 支持 `prefers-reduced-motion`

### 10.2 常见错误

| 错误 | 检测方法 |
|------|----------|
| 硬编码颜色 | 全局搜索 `#` 十六进制颜色 |
| 硬编码字号 | 全局搜索 `font-size:` 后跟数字 |
| 硬编码圆角 | 全局搜索 `border-radius:` 后跟数字 |
| 使用 emoji | 全局搜索 Unicode emoji 范围 |

---

## 附录：快速参考

### A.1 CSS 变量速查表

```
颜色变量：
  --accent-primary        主强调色
  --accent-secondary      次强调色
  --accent-tertiary       第三强调色
  --bg-canvas            画布背景
  --bg-card              卡片背景
  --bg-embedded          内嵌区域
  --bg-toolbar           工具栏
  --bg-elevated          弹出层
  --text-primary         主文字
  --text-secondary       次文字
  --text-tertiary        辅助文字
  --border-subtle        柔和边框
  --border-default       默认边框
  --border-strong        强调边框

字号变量：
  --text-xs (11px)       徽章
  --text-sm (13px)       正文
  --text-base (14px)     主要正文
  --text-lg (16px)       标题
  --text-xl (18px)       面板标题

圆角变量：
  --radius-xs (4px)      小标签
  --radius-sm (8px)      按钮
  --radius-md (12px)     输入框
  --radius-lg (16px)     卡片
  --radius-xl (20px)     大面板
  --radius-full (9999px) 胶囊

阴影变量：
  --shadow-xs            微阴影
  --shadow-sm            小阴影
  --shadow-md            中阴影
  --shadow-lg            大阴影
  --shadow-xl            极大阴影
  --shadow-glow          发光

动效变量：
  --duration-fast (100ms)   微交互
  --duration-base (150ms)   标准过渡
  --duration-slow (250ms)   面板动画
  --ease-spring             弹性缓动
  --ease-out                退出缓动
```

### A.2 常用代码片段

```css
/* 玻璃效果 */
.glass {
    background: var(--bg-toolbar);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border: 1px solid var(--border-subtle);
}

/* 聚焦效果 */
.focus-ring:focus-visible {
    outline: 2px solid var(--accent-primary);
    outline-offset: 2px;
}

/* 卡片状态 */
.card {
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--card-border-radius);
    box-shadow: var(--shadow-md);
    transition: all var(--duration-base) var(--ease-default);
}

.card:hover {
    box-shadow: var(--shadow-lg);
    transform: translateY(-2px);
}

.card--selected {
    border-color: var(--accent-primary);
    box-shadow: var(--shadow-glow), var(--shadow-lg);
}
```
