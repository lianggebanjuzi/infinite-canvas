# TypeScript 全面升级方案 — Infinite Canvas 1.0

## 🎯 目标

将 56 个 JS 文件的 vanilla JS 项目升级为 **TypeScript + ES Modules + Vite 构建 + SCSS** 的现代工程化项目。

## 📊 核心决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 构建工具 | **Vite** | 零配置 TS/SCSS 支持，极快的 HMR |
| 迁移策略 | **渐进式 + 桥接全局变量** | 每一步可测试，不需要 Big Bang |
| 模块化 | **ES Modules (import/export)** | 原生支持，消除脚本加载顺序问题 |
| CSS | **SCSS** | Vite 原生支持，零额外成本获得嵌套/mixin |
| Icon | **npm 本地打包** | 替换 Font Awesome CDN，桌面应用不需要网络 |
| 类型严格度 | **strict: true 逐步启用** | 先用 `any` 过渡，逐步收紧 |

## 🏗️ 新架构概览

```
项目根目录/
├── src/                    # ← 新 TypeScript 源码
│   ├── index.html          # Vite 入口 HTML
│   ├── main.ts             # 应用入口
│   ├── types/              # 类型声明
│   │   ├── pywebview.d.ts   # pywebview.api 类型
│   │   ├── app-state.d.ts   # AppState 类型
│   │   └── cards.d.ts       # 卡片相关类型
│   ├── state/              # 状态层 (7个文件)
│   ├── utils/              # 工具层 (dom, api, uid)
│   ├── core/               # 核心层 (canvas, commands, history...)
│   ├── services/           # 服务层 (provider, model, prompt)
│   ├── components/         # UI 组件 (connection, minimap, settings...)
│   ├── cards/              # 卡片系统 (15个文件)
│   ├── independent/        # 独立模块 (theme, project, laser...)
│   ├── groups/             # 分组模块
│   ├── agent/              # Agent 面板
│   └── styles/             # SCSS 样式 (18个文件)
├── gui/                    # ← 旧代码保留，逐步废弃
│   └── dist/               # Vite 构建输出
├── vite.config.ts
├── tsconfig.json
├── package.json
└── main.py                 # ← 修改：dev/prod 双模式
```

## 🔄 增量迁移策略

**核心原则**：每个迁移的 TS 模块同时发布到 `window.*`，旧代码继续可用。

```
Phase 0:  搭建 Vite + TS + SCSS 脚手架 (1-2h)
Phase 1:  类型声明文件 (2-3h) ← 先写类型，后写代码
Phase 2:  State 层 (2h)       ← 叶子节点，无依赖
Phase 3:  Utils 层 (1h)       ← 依赖 state
Phase 4:  Core 层 (4h)        ← 依赖 utils + state
Phase 5:  Services 层 (1h)    ← 依赖 utils
Phase 6:  Cards 系统 (8h)     ← 最大最复杂
Phase 7:  Components (3h)     ← 依赖 cards
Phase 8:  Independent (2h)    ← 独立模块
Phase 9:  Groups (2h)         ← 依赖 cards + state
Phase 10: Agent Panel (1h)    ← 依赖 state + services
Phase 11: Main + HTML (3h)    ← 整合入口
Phase 12: CSS → SCSS (2h)     ← 样式升级
Phase 13: Python 适配 (2h)    ← 后端 dev/prod 模式
Phase 14: 清理 + 打包测试 (3h) ← 移除旧代码
```

**总计：约 35-45 小时**

## 🔑 关键技术要点

### 1. pywebview 集成方案

```python
# main.py — 开发模式用 Vite dev server，生产模式用构建产物
IS_DEV = not getattr(sys, 'frozen', False)

if IS_DEV:
    url = 'http://localhost:5173/src/index.html'  # Vite HMR
else:
    url = os.path.join(RESOURCE_DIR, 'gui', 'dist', 'index.html')  # 构建产物
```

### 2. 类型声明 (pywebview.d.ts)

```typescript
// 声明运行时的 pywebview.api，让 TS 认识所有后端方法
declare global {
  interface Window {
    pywebview: { api: PywebviewAPI };
  }
}
```

### 3. 消除加载顺序依赖

```typescript
// 旧: event-bus-init.js 用 retry 等待依赖加载
// 新: ES module import 保证依赖就绪
import { CardEventBus } from './CardEventBus';
import { ConnectionRules } from './ConnectionRules';
// 直接执行，无需等待！
```

### 4. 消除 HTML 内联 onclick

```html
<!-- 旧: 30+ 处内联 onclick -->
<button onclick="ProjectManager.save()">保存</button>

<!-- 新: 纯 HTML -->
<button id="save-btn">保存</button>
```

```typescript
// 新: TS 中注册事件
document.getElementById('save-btn')?.addEventListener('click', () => {
  ProjectManager.save();
});
```

### 5. Font Awesome 本地化

```bash
npm install @fortawesome/fontawesome-free
# 不再依赖 CDN，桌面应用离线可用
```

## ⚠️ 风险与对策

| 风险 | 对策 |
|------|------|
| pywebview 不支持 ES modules | Edge/Chromium 原生支持，已验证 |
| file:// 协议兼容性 | Vite `base: './'`，关闭代码分割 |
| 56 个文件迁移耗时太长 | 渐进式策略，随时可暂停，app 始终可用 |
| 类型错误雪崩 | 先用 `any` 过渡，逐步收紧 strict |
| PyInstaller 遗漏新文件 | 更新 .spec 的 datas 指向 `gui/dist/` |

## 📝 第一步做什么

1. `npm init` + 安装 Vite/TypeScript/Sass
2. 创建 `tsconfig.json` + `vite.config.ts`
3. 写类型声明文件 (`pywebview.d.ts`, `app-state.d.ts`)
4. 创建 `src/index.html`（从 `gui/index.html` 复制）
5. 跑通 `npm run dev` → pywebview 从 localhost:5173 加载

---

> **准备好了就告诉我，我立刻开始 Phase 0 的脚手架搭建！**
