# Infinite Canvas 1.0 — UI 设计方案（玻璃极简风）

> 版本：1.0
> 日期：2026-03-21
> 风格：Glassmorphism Lite（轻量化玻璃极简风）

---

## 一、设计理念

### 1.1 核心思想

**「轻而不薄，简而不空」** — 在保持极简克制的同时，通过精细的玻璃层次、克制的光影变化和流畅的微交互，传达专业创意工具的品质感。

### 1.2 设计原则

| 原则 | 说明 |
|------|------|
| **克制的华丽** | 玻璃效果用于浮层和面板，不滥用；卡片本体保持干净纯色 |
| **清晰的层次** | 通过背景明度递增建立 Z 轴感知：画布 → 卡片 → 面板 → 弹出层 |
| **一致的呼吸感** | 统一的圆角系统、间距节奏、动画曲线 |
| **隐性的引导** | 通过悬停反馈、过渡动画暗示交互，不依赖装饰性元素 |

### 1.3 适用范围

- 画布背景、卡片、侧边栏、工具栏、弹出面板
- 所有 UI 组件：按钮、输入框、下拉菜单、开关
- 7 种卡片类型及其变体
- 深色/浅色双主题

---

## 二、色彩系统

### 2.1 色彩层级（5 层）

```
层1（最暗）→ 层5（最亮）
画布背景 → 卡片背景 → 内嵌区域 → 工具栏/侧边栏 → 弹出层/菜单
```

### 2.2 深色主题（默认）

#### 强调色系

| 变量名 | 色值 | 用途 |
|--------|------|------|
| `--accent-primary` | `#6366F1` (Indigo 500) | 主强调色、选中态、高亮 |
| `--accent-primary-hover` | `#4F46E5` (Indigo 600) | 悬停态 |
| `--accent-primary-glow` | `rgba(99, 102, 241, 0.25)` | 光晕/选中描边背景 |
| `--accent-secondary` | `#38BDF8` (Sky 400) | 次强调、图标、提示文字 |
| `--accent-tertiary` | `#A78BFA` (Violet 400) | 第三强调、渐变点缀 |

#### 背景色系

| 变量名 | 色值 | 用途 |
|--------|------|------|
| `--bg-canvas` | `#09090B` | 画布背景（接近纯黑，微暖） |
| `--bg-card` | `#18181B` | 卡片背景（轻量化纯色） |
| `--bg-embedded` | `#27272A` | 内嵌区域（输入框、列表项） |
| `--bg-toolbar` | `rgba(39, 39, 42, 0.85)` | 工具栏/侧边栏背景 |
| `--bg-elevated` | `rgba(63, 63, 70, 0.90)` | 弹出层/菜单背景 |

#### 文字色系

| 变量名 | 色值 | 用途 |
|--------|------|------|
| `--text-primary` | `#FAFAFA` | 主要文字（高对比） |
| `--text-secondary` | `#A1A1AA` | 次要文字（标签、提示） |
| `--text-tertiary` | `#71717A` | 辅助文字（禁用、占位符） |
| `--text-on-accent` | `#FFFFFF` | 强调色上的文字 |

#### 边框与分隔线

| 变量名 | 色值 | 用途 |
|--------|------|------|
| `--border-subtle` | `rgba(255, 255, 255, 0.06)` | 卡片边框、柔和分隔 |
| `--border-default` | `rgba(255, 255, 255, 0.10)` | 输入框边框、次要分隔 |
| `--border-strong` | `rgba(255, 255, 255, 0.15)` | 强调分隔、hover 边框 |

#### 功能色

| 变量名 | 色值 | 用途 |
|--------|------|------|
| `--color-success` | `#22C55E` | 成功状态 |
| `--color-warning` | `#F59E0B` | 警告状态 |
| `--color-error` | `#EF4444` | 错误状态 |
| `--color-info` | `#3B82F6` | 信息状态 |

#### 网格与光斑

| 变量名 | 色值 | 用途 |
|--------|------|------|
| `--grid-color` | `rgba(255, 255, 255, 0.05)` | 点阵网格 |
| `--glow-accent` | `rgba(99, 102, 241, 0.08)` | 右上角装饰光斑 |
| `--glow-secondary` | `rgba(167, 139, 250, 0.06)` | 左下角装饰光斑 |

---

### 2.3 浅色主题

#### 强调色系（保持一致，仅调整透明度）

| 变量名 | 色值 | 用途 |
|--------|------|------|
| `--accent-primary` | `#6366F1` | 主强调色 |
| `--accent-primary-hover` | `#4F46E5` | 悬停态 |
| `--accent-primary-glow` | `rgba(99, 102, 241, 0.15)` | 光晕（更淡） |
| `--accent-secondary` | `#0284C7` | 次强调（更深） |
| `--accent-tertiary` | `#7C3AED` | 第三强调（更深） |

#### 背景色系

| 变量名 | 色值 | 用途 |
|--------|------|------|
| `--bg-canvas` | `#FAFAFA` | 画布背景（暖白） |
| `--bg-card` | `#FFFFFF` | 卡片背景（纯白） |
| `--bg-embedded` | `#F4F4F5` | 内嵌区域 |
| `--bg-toolbar` | `rgba(255, 255, 255, 0.80)` | 工具栏（玻璃） |
| `--bg-elevated` | `rgba(255, 255, 255, 0.90)` | 弹出层（玻璃） |

#### 文字色系

| 变量名 | 色值 | 用途 |
|--------|------|------|
| `--text-primary` | `#18181B` | 主要文字 |
| `--text-secondary` | `#52525B` | 次要文字 |
| `--text-tertiary` | `#A1A1AA` | 辅助文字 |
| `--text-on-accent` | `#FFFFFF` | 强调色上的文字 |

#### 边框与分隔线

| 变量名 | 色值 | 用途 |
|--------|------|------|
| `--border-subtle` | `rgba(0, 0, 0, 0.06)` | 卡片边框 |
| `--border-default` | `rgba(0, 0, 0, 0.10)` | 输入框边框 |
| `--border-strong` | `rgba(0, 0, 0, 0.15)` | 强调分隔 |

---

## 三、字体系统

### 3.1 字体栈

```css
font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 
             'PingFang SC', 'Microsoft YaHei', sans-serif;
```

### 3.2 字号层级

| 变量名 | 字号 | 行高 | 字重 | 用途 |
|--------|------|------|------|------|
| `--text-xs` | 11px | 1.4 | 400 | 徽章、次要标签 |
| `--text-sm` | 13px | 1.5 | 400 | 正文、次要信息 |
| `--text-base` | 14px | 1.5 | 400 | 主要正文 |
| `--text-lg` | 16px | 1.5 | 500 | 标题、次要标题 |
| `--text-xl` | 18px | 1.4 | 600 | 面板标题 |
| `--text-2xl` | 24px | 1.3 | 700 | 大标题（仅 Logo） |

### 3.3 特殊排版

- **标题栏文字**：13px，字重 500，letter-spacing -0.01em
- **按钮文字**：11px，字重 500，letter-spacing 0
- **输入框文字**：13px，字重 400
- **菜单项文字**：13px，字重 400

---

## 四、圆角系统

### 4.1 圆角变量

| 变量名 | 值 | 用途 |
|--------|------|------|
| `--radius-xs` | 4px | 徽章、小标签 |
| `--radius-sm` | 8px | 按钮内元素、分隔区块 |
| `--radius-md` | 12px | 输入框、下拉项 |
| `--radius-lg` | 16px | 卡片、面板 |
| `--radius-xl` | 20px | 大型面板 |
| `--radius-full` | 9999px | 胶囊按钮、工具栏 |

### 4.2 圆角使用规范

| 场景 | 圆角值 |
|------|--------|
| 卡片整体 | `--radius-lg` (16px) |
| 卡片标题栏（顶部） | `--radius-lg` |
| 卡片内容区（底部） | `calc(var(--radius-lg) - 2px)` |
| 工具栏 | `--radius-full` |
| 按钮（默认） | `--radius-sm` |
| 按钮（胶囊） | `--radius-full` |
| 输入框 | `--radius-md` |
| 下拉菜单 | `--radius-md` |
| Toast | `--radius-full` |
| 右键菜单 | `--radius-lg` |
| 设置面板 | `--radius-xl` |

---

## 五、阴影系统

### 5.1 阴影变量

#### 深色主题

| 变量名 | 效果 |
|--------|------|
| `--shadow-xs` | `0 1px 2px rgba(0,0,0,0.4)` |
| `--shadow-sm` | `0 2px 4px rgba(0,0,0,0.5), 0 1px 2px rgba(0,0,0,0.3)` |
| `--shadow-md` | `0 4px 12px rgba(0,0,0,0.5), 0 2px 4px rgba(0,0,0,0.3)` |
| `--shadow-lg` | `0 8px 24px rgba(0,0,0,0.6), 0 4px 8px rgba(0,0,0,0.4)` |
| `--shadow-xl` | `0 16px 40px rgba(0,0,0,0.7), 0 8px 16px rgba(0,0,0,0.5)` |
| `--shadow-glow` | `0 0 0 3px var(--accent-primary-glow)` |

#### 浅色主题

| 变量名 | 效果 |
|--------|------|
| `--shadow-xs` | `0 1px 2px rgba(0,0,0,0.05)` |
| `--shadow-sm` | `0 2px 4px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)` |
| `--shadow-md` | `0 4px 12px rgba(0,0,0,0.10), 0 2px 4px rgba(0,0,0,0.05)` |
| `--shadow-lg` | `0 8px 24px rgba(0,0,0,0.12), 0 4px 8px rgba(0,0,0,0.06)` |
| `--shadow-xl` | `0 16px 40px rgba(0,0,0,0.15), 0 8px 16px rgba(0,0,0,0.08)` |
| `--shadow-glow` | `0 0 0 3px var(--accent-primary-glow)` |

### 5.2 阴影使用规范

| 场景 | 阴影 | 说明 |
|------|------|------|
| 卡片默认 | `--shadow-md` | 柔和浮起感 |
| 卡片悬停 | `--shadow-lg` | 轻微加深 |
| 卡片拖拽 | `--shadow-xl` + 发光边框 | 强调提升感 |
| 卡片选中 | `--shadow-glow` | 聚焦指示 |
| 工具栏 | `--shadow-lg` | 悬浮感 |
| 右键菜单 | `--shadow-xl` | 弹出感 |
| 设置面板 | `--shadow-xl` | 强调弹出 |

---

## 六、毛玻璃效果（Glassmorphism）

### 6.1 使用场景

毛玻璃效果仅用于以下场景，**不适用于卡片本体**：

- 工具栏背景
- 侧边栏背景
- 右键菜单背景
- 弹出面板背景
- 设置面板背景

### 6.2 毛玻璃参数

| 参数 | 值 | 说明 |
|------|------|------|
| `backdrop-filter` | `blur(20px) saturate(180%)` | 模糊 + 饱和度提升 |
| `-webkit-backdrop-filter` | 同上 | Safari 兼容 |
| 背景透明度（深色） | `rgba(39, 39, 42, 0.75) ~ 0.90` | 75%-90% 不透明度 |
| 背景透明度（浅色） | `rgba(255, 255, 255, 0.75) ~ 0.90` | 75%-90% 不透明度 |
| 边框 | `1px solid rgba(255,255,255,0.08)` | 微妙的顶部高光 |
| 内阴影 | `inset 0 1px 0 rgba(255,255,255,0.06)` | 顶部亮线 |

### 6.3 深浅主题毛玻璃差异

| 主题 | 背景色 | 模糊值 | 边框 |
|------|--------|--------|------|
| 深色 | `rgba(39, 39, 42, 0.85)` | 20px | `rgba(255,255,255,0.08)` |
| 浅色 | `rgba(255, 255, 255, 0.80)` | 16px | `rgba(0,0,0,0.06)` |

---

## 七、间距系统

### 7.1 间距变量

| 变量名 | 值 | 用途 |
|--------|------|------|
| `--space-1` | 4px | 紧凑元素间距 |
| `--space-2` | 8px | 默认元素间距 |
| `--space-3` | 12px | 区块内间距 |
| `--space-4` | 16px | 区块间间距 |
| `--space-5` | 20px | 大区块间距 |
| `--space-6` | 24px | 面板内间距 |
| `--space-8` | 32px | 大区块间距 |

### 7.2 典型间距使用

| 场景 | 间距 |
|------|------|
| 按钮内 icon 与文字 | 6px |
| 工具栏按钮间距 | 2px |
| 工具栏与底部边缘 | 24px |
| 卡片标题栏左右内边距 | 12px |
| 卡片内容区内边距 | 12px |
| 面板内容与边缘 | 16px |
| 面板标题与内容 | 16px |
| 表单字段间距 | 16px |
| 菜单项内边距 | 10px 12px |

---

## 八、动画系统

### 8.1 时间曲线

| 变量名 | 值 | 用途 |
|--------|------|------|
| `--duration-instant` | 0ms | 无动画 |
| `--duration-fast` | 100ms | 微交互反馈 |
| `--duration-base` | 150ms | 标准过渡（默认） |
| `--duration-slow` | 250ms | 面板展开/关闭 |
| `--duration-slower` | 350ms | 大型动画 |

### 8.2 缓动函数

| 变量名 | 值 | 用途 |
|--------|------|------|
| `--ease-default` | `cubic-bezier(0.4, 0, 0.2, 1)` | 标准 ease |
| `--ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | 元素进入 |
| `--ease-out` | `cubic-bezier(0, 0, 0.2, 1)` | 元素退出 |
| `--ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | 弹性反馈 |

### 8.3 动画使用规范

| 交互 | 时长 | 缓动 | 说明 |
|------|------|------|------|
| 悬停背景/颜色变化 | 100ms | `--ease-default` | 快速响应 |
| 悬停 transform（scale） | 150ms | `--ease-spring` | 弹性感 |
| 按钮按下缩放 | 80ms | `--ease-out` | 即时反馈 |
| 菜单弹出 | 150ms | `--ease-spring` | 弹性展开 |
| 菜单关闭 | 100ms | `--ease-in` | 快速收起 |
| 面板展开/收起 | 250ms | `--ease-out` | 平滑过渡 |
| 图片 Modal 打开 | 200ms | `--ease-spring` | 缩放淡入 |
| 卡片选中光晕 | 150ms | `--ease-out` | 柔和聚焦 |
| 卡片拖拽提升 | 0ms | 无过渡 | 即时响应 |

### 8.4 减少动画偏好

必须支持 `prefers-reduced-motion`：

```css
@media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
    }
}
```

---

## 九、图标系统

### 9.1 图标库

**Font Awesome 6 Free**（当前使用）

### 9.2 图标尺寸规范

| 场景 | 尺寸 |
|------|------|
| 工具栏按钮 icon | 14px |
| 菜单项 icon | 14px |
| 卡片类型徽章 icon | 10px |
| 面板标题 icon | 16px |
| 输入框前缀 icon | 14px |
| Toast icon | 16px |
| 关闭按钮 icon | 18px |

### 9.3 图标颜色规范

| 场景 | 颜色 |
|------|------|
| 默认状态 | `--text-tertiary` |
| 悬停状态 | `--accent-primary` |
| 激活状态 | `--accent-primary` |
| 禁用状态 | `--text-tertiary` (40% 透明度) |

---

## 十、组件规范

### 10.1 按钮

#### 主要按钮

```css
.btn-primary {
    background: var(--accent-primary);
    color: var(--text-on-accent);
    padding: 8px 16px;
    border-radius: var(--radius-sm);
    font-size: 13px;
    font-weight: 500;
    border: none;
    cursor: pointer;
    transition: background var(--duration-fast) var(--ease-default),
                transform var(--duration-fast) var(--ease-out);
}

.btn-primary:hover {
    background: var(--accent-primary-hover);
}

.btn-primary:active {
    transform: scale(0.97);
}
```

#### 次要按钮

```css
.btn-secondary {
    background: var(--bg-embedded);
    color: var(--text-primary);
    border: 1px solid var(--border-default);
    /* 其他同上 */
}

.btn-secondary:hover {
    background: var(--bg-toolbar);
    border-color: var(--border-strong);
}
```

#### 图标按钮

```css
.icon-btn {
    background: transparent;
    border: none;
    color: var(--text-tertiary);
    padding: 6px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: color var(--duration-fast) var(--ease-default),
                background var(--duration-fast) var(--ease-default);
}

.icon-btn:hover {
    color: var(--text-primary);
    background: var(--bg-embedded);
}
```

### 10.2 输入框

```css
.input {
    background: var(--bg-embedded);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: 8px 12px;
    font-size: 13px;
    color: var(--text-primary);
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
```

### 10.3 开关（Toggle）

```css
.toggle-switch {
    position: relative;
    width: 36px;
    height: 20px;
}

.toggle-switch input {
    opacity: 0;
    width: 0;
    height: 0;
}

.toggle-slider {
    position: absolute;
    cursor: pointer;
    top: 0; left: 0; right: 0; bottom: 0;
    background: var(--bg-embedded);
    border-radius: var(--radius-full);
    transition: background var(--duration-base) var(--ease-default);
}

.toggle-slider::before {
    content: '';
    position: absolute;
    height: 14px;
    width: 14px;
    left: 3px;
    bottom: 3px;
    background: white;
    border-radius: 50%;
    transition: transform var(--duration-base) var(--ease-spring);
}

.toggle-switch input:checked + .toggle-slider {
    background: var(--accent-primary);
}

.toggle-switch input:checked + .toggle-slider::before {
    transform: translateX(16px);
}
```

### 10.4 下拉菜单

```css
.dropdown-menu {
    position: absolute;
    background: var(--bg-elevated);
    backdrop-filter: blur(20px) saturate(180%);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-xl);
    padding: 6px;
    min-width: 160px;
    z-index: 9999;
    animation: dropdownIn 150ms var(--ease-spring);
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

.dropdown-item {
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: background var(--duration-fast) var(--ease-default);
}

.dropdown-item:hover {
    background: var(--accent-primary-glow);
}
```

---

## 十一、卡片规范

### 11.1 卡片结构

```
┌─────────────────────────────────────┐
│  ⠿  卡片标题              [类型徽章] │  ← 标题栏 36px
├─────────────────────────────────────┤
│                                     │
│            卡片内容区                │  ← flex: 1
│                                     │
│  ○                           ◁━━    │  ← 输入口(左) 输出口(右)
└─────────────────────────────────────┘
                                     ◢ ← 缩放手柄
```

### 11.2 卡片颜色区分

| 卡片类型 | 标题栏背景 | 类型徽章颜色 |
|----------|-----------|-------------|
| 文本卡片 | `--accent-primary-glow` | `--accent-primary` |
| 图片卡片 | 橙色透明 | `#F97316` |
| AI绘图卡片 | 紫色透明 | `--accent-tertiary` |
| Agent卡片 | 绿色透明 | `#22C55E` |
| 预览卡片 | 蓝色透明 | `--accent-secondary` |
| 画板卡片 | 与文本卡片相同 | `--accent-primary` |
| 对比卡片 | 青色透明 | `#06B3D4` |

### 11.3 卡片状态

| 状态 | 边框 | 阴影 | 其他 |
|------|------|------|------|
| 默认 | `--border-subtle` | `--shadow-md` | — |
| 悬停 | `--border-default` | `--shadow-lg` | 轻微上浮 `translateY(-2px)` |
| 选中 | `--accent-primary` + 光晕 | `--shadow-glow)` | 双层描边 |
| 多选 | 紫色边框 | 紫色光晕 | — |
| 拖拽 | `--accent-primary` | `--shadow-xl` + 发光 | `scale(1.02)` |
| 错误 | 红色边框 | 红色光晕 | — |

---

## 十二、Z-Index 层级

| 层级 | 元素 | Z-Index |
|------|------|---------|
| 0 | 画布背景 | 0 |
| 1 | 画布内容 | 1 |
| 2 | SVG 连线层 | 2 |
| 3 | 卡片层 | 动态 (99/100/150) |
| 4 | 框选层 | 9998 |
| 5 | 激光切割线 | 9997 |
| 6 | 小地图 | 999 |
| 7 | 底部工具栏 | 1000 |
| 8 | 右键菜单 | 9999 |
| 9 | Toast | 10000 |
| 10 | 设置面板遮罩 | 10000 |
| 11 | 设置面板主体 | 10001 |
| 12 | 图片查看器 | 99999 |

---

## 十三、深色/浅色主题切换

### 13.1 切换方式

通过 `data-theme` 属性控制：

```html
<html data-theme="dark">  <!-- 默认 -->
<html data-theme="light"> <!-- 浅色模式 -->
```

### 13.2 切换逻辑

```javascript
toggle() {
    const html = document.documentElement;
    const isDark = html.getAttribute('data-theme') === 'dark';
    html.setAttribute('data-theme', isDark ? 'light' : 'dark');
    localStorage.setItem('theme', isDark ? 'light' : 'dark');
}
```

### 13.3 主题一致性检查清单

- [ ] 背景色正确切换
- [ ] 文字对比度 ≥ 4.5:1
- [ ] 毛玻璃效果在浅色模式下更淡
- [ ] 边框在浅色模式下使用深色
- [ ] 阴影在浅色模式下更轻
- [ ] 卡片颜色徽章在浅色模式下更明显
- [ ] 网格点在浅色模式下使用深色

---

## 十四、响应式设计

### 14.1 断点

| 断点 | 宽度 | 场景 |
|------|------|------|
| 移动端 | < 768px | 平板竖屏 |
| 平板 | 768px - 1024px | 平板横屏、小笔记本 |
| 桌面 | > 1024px | 标准桌面 |

### 14.2 工具栏响应式

| 屏幕宽度 | 显示内容 |
|----------|----------|
| > 1024px | 图标 + 文字 |
| 768px - 1024px | 仅图标 |
| < 768px | 仅图标，缩小间距 |

---

## 十五、实施优先级

### 第一阶段（核心重构）

1. 更新 `variables.css` — 新变量系统
2. 更新 `app.css` — 新变量系统导入
3. 更新 `base.css` — 全局样式重置
4. 更新 `card.css` — 卡片基础样式
5. 更新 `canvas.css` — 画布背景
6. 更新 `ui.css` — 工具栏、右键菜单、小地图

### 第二阶段（组件优化）

1. 更新 `sidebar.css` — 侧边栏
2. 更新 `settings.css` — 设置面板
3. 更新 `provider.css` — 供应商面板
4. 更新 `model.css` — 模型面板
5. 更新卡片样式文件 — 各类型卡片

### 第三阶段（细节打磨）

1. 微交互优化
2. 深色/浅色模式细节调整
3. 图标颜色一致性检查
4. 无障碍访问优化

---

## 附录 A：CSS 变量完整清单

```css
:root {
    /* === 强调色 === */
    --accent-primary: #6366F1;
    --accent-primary-hover: #4F46E5;
    --accent-primary-glow: rgba(99, 102, 241, 0.25);
    --accent-secondary: #38BDF8;
    --accent-tertiary: #A78BFA;

    /* === 背景色 === */
    --bg-canvas: #09090B;
    --bg-card: #18181B;
    --bg-embedded: #27272A;
    --bg-toolbar: rgba(39, 39, 42, 0.85);
    --bg-elevated: rgba(63, 63, 70, 0.90);

    /* === 文字色 === */
    --text-primary: #FAFAFA;
    --text-secondary: #A1A1AA;
    --text-tertiary: #71717A;
    --text-on-accent: #FFFFFF;

    /* === 边框 === */
    --border-subtle: rgba(255, 255, 255, 0.06);
    --border-default: rgba(255, 255, 255, 0.10);
    --border-strong: rgba(255, 255, 255, 0.15);

    /* === 功能色 === */
    --color-success: #22C55E;
    --color-warning: #F59E0B;
    --color-error: #EF4444;
    --color-info: #3B82F6;

    /* === 网格 === */
    --grid-color: rgba(255, 255, 255, 0.05);
    --glow-accent: rgba(99, 102, 241, 0.08);
    --glow-secondary: rgba(167, 139, 250, 0.06);

    /* === 阴影 === */
    --shadow-xs: 0 1px 2px rgba(0,0,0,0.4);
    --shadow-sm: 0 2px 4px rgba(0,0,0,0.5), 0 1px 2px rgba(0,0,0,0.3);
    --shadow-md: 0 4px 12px rgba(0,0,0,0.5), 0 2px 4px rgba(0,0,0,0.3);
    --shadow-lg: 0 8px 24px rgba(0,0,0,0.6), 0 4px 8px rgba(0,0,0,0.4);
    --shadow-xl: 0 16px 40px rgba(0,0,0,0.7), 0 8px 16px rgba(0,0,0,0.5);
    --shadow-glow: 0 0 0 3px var(--accent-primary-glow);

    /* === 圆角 === */
    --radius-xs: 4px;
    --radius-sm: 8px;
    --radius-md: 12px;
    --radius-lg: 16px;
    --radius-xl: 20px;
    --radius-full: 9999px;

    /* === 间距 === */
    --space-1: 4px;
    --space-2: 8px;
    --space-3: 12px;
    --space-4: 16px;
    --space-5: 20px;
    --space-6: 24px;
    --space-8: 32px;

    /* === 字体 === */
    --text-xs: 11px;
    --text-sm: 13px;
    --text-base: 14px;
    --text-lg: 16px;
    --text-xl: 18px;
    --text-2xl: 24px;

    /* === 动效 === */
    --duration-instant: 0ms;
    --duration-fast: 100ms;
    --duration-base: 150ms;
    --duration-slow: 250ms;
    --duration-slower: 350ms;
    --ease-default: cubic-bezier(0.4, 0, 0.2, 1);
    --ease-in: cubic-bezier(0.4, 0, 1, 1);
    --ease-out: cubic-bezier(0, 0, 0.2, 1);
    --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);

    /* === 卡片 === */
    --card-min-width: 120px;
    --card-min-height: 80px;
    --card-titlebar-height: 36px;
    --card-border-radius: var(--radius-lg);
    --port-size: 20px;
    --port-offset: 23px;
    --resize-handle-size: 18px;
}
```

### 附录 B：浅色主题覆盖

```css
[data-theme="light"] {
    --accent-primary-glow: rgba(99, 102, 241, 0.15);
    --accent-secondary: #0284C7;
    --accent-tertiary: #7C3AED;

    --bg-canvas: #FAFAFA;
    --bg-card: #FFFFFF;
    --bg-embedded: #F4F4F5;
    --bg-toolbar: rgba(255, 255, 255, 0.80);
    --bg-elevated: rgba(255, 255, 255, 0.90);

    --text-primary: #18181B;
    --text-secondary: #52525B;
    --text-tertiary: #A1A1AA;

    --border-subtle: rgba(0, 0, 0, 0.06);
    --border-default: rgba(0, 0, 0, 0.10);
    --border-strong: rgba(0, 0, 0, 0.15);

    --grid-color: rgba(0, 0, 0, 0.06);
    --glow-accent: rgba(99, 102, 241, 0.05);
    --glow-secondary: rgba(167, 139, 250, 0.04);

    --shadow-xs: 0 1px 2px rgba(0,0,0,0.05);
    --shadow-sm: 0 2px 4px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04);
    --shadow-md: 0 4px 12px rgba(0,0,0,0.10), 0 2px 4px rgba(0,0,0,0.05);
    --shadow-lg: 0 8px 24px rgba(0,0,0,0.12), 0 4px 8px rgba(0,0,0,0.06);
    --shadow-xl: 0 16px 40px rgba(0,0,0,0.15), 0 8px 16px rgba(0,0,0,0.08);
}
```

---

## 附录 C：UI 组件库规范（强制）

> 版本：2.0 | 更新日期：2026-06-10
> **所有新功能必须使用组件库，禁止手写原生表单元素。**

### C.1 组件清单

项目提供以下可复用 UI 组件，位于 `gui/js/utils/` 目录：

| 组件 | 文件 | 用途 | 调用方式 |
|---|---|---|---|
| **UIInput** | `ui-components.js` | 文本/密码/数字输入 | `UIInput({ label, type, placeholder, value, onChange, actions })` |
| **UITextarea** | `ui-components.js` | 多行文本输入 | `UITextarea({ label, placeholder, rows, autoResize, onChange })` |
| **UISwitch** | `ui-components.js` | 开关切换 | `UISwitch({ label, hint, value, onChange })` |
| **UISelect** | `ui-select.js` | 自定义下拉选择 | `UISelect({ label, options, groups, placeholder, value, onChange })` |
| **Dialog** | `src/ui/dialog.ts` | 弹窗对话框 | `Dialog({ title, content, onConfirm, onCancel })` |
| **Toast** | `已有全局实现` | 提示消息 | `Toast.show('消息')` / `Toast.success()` / `Toast.error()` |

### C.2 组件返回值接口

所有组件返回统一接口：

```javascript
const component = UIInput({ ... });
// component.element  — DOM 元素，插入到页面
// component.value    — 当前值（getter）
// component.setValue — 设置值
// component.focus    — 聚焦
```

### C.3 使用规范

| ✅ 正确做法 | ❌ 禁止做法 |
|---|---|
| `const input = UIInput({ label: '名称' })` | `document.createElement('input')` |
| `const select = UISelect({ options: [...] })` | `<select><option>...</option></select>` |
| `const sw = UISwitch({ label: '启用' })` | `<label class="toggle-switch"><input type="checkbox">` |
| `const ta = UITextarea({ placeholder: '...' })` | `<textarea placeholder="..."></textarea>` |

### C.4 保留原生的例外

以下场景**允许**保持原生 HTML，无需使用组件：

| 元素 | 原因 |
|---|---|
| `<input type="range">` | 滑块无对应组件 |
| `<input type="color">` | 颜色选择器无对应组件 |
| `<input type="file">` | 文件上传无对应组件 |
| 卡片内的按钮 | 按钮保持原生，样式由卡片 CSS 控制 |

### C.5 自定义下拉组件样式

所有自定义下拉使用 `gui/styles/custom-select.css`，类名规范：

```
.custom-select              — 容器
.custom-select__trigger     — 触发按钮
.custom-select__menu        — 下拉菜单
.custom-select__option      — 选项
.custom-select__group-label — 分组标签
.is-open / .is-selected / .is-disabled — 状态类
```

### C.6 新增面板清单

开发新面板时，按以下顺序检查：

1. **表单元素** — 必须使用 UIInput/UITextarea/UISwitch/UISelect
2. **弹窗** — 使用 Dialog 组件或 `.modal-overlay` + `.modal-dialog` 结构
3. **列表** — 使用 ListItem 组件或 `.list-item` 结构
4. **按钮** — 使用 `.btn-cancel` / `.btn-confirm` / `.btn-secondary` / `.btn-add-provider`
5. **图标** — 必须使用 Font Awesome，禁止 emoji
6. **颜色** — 必须使用 CSS 变量，禁止硬编码
7. **字号** — 必须使用 `--text-*` 变量
8. **圆角** — 必须使用 `--radius-*` 变量
9. **间距** — 必须使用 `--space-*` 变量
