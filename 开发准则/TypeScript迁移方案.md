# Infinite Canvas 1.0 — TypeScript 迁移方案

> 版本：1.0 | 日期：2026-06-11
> 状态：规划中（未执行）

---

## 一、现状分析

### 1.1 当前架构

```
运行时路径：
pywebview → gui/index.html → gui/js/*.js（原生 JS，实际运行）

构建路径：
Vite → src/*.ts → gui/dist/assets/*.js（构建产物，未被加载）
```

### 1.2 已迁移的 TS 代码（`src/` 目录）

| 模块 | 文件数 | 状态 | 说明 |
|---|---|---|---|
| `src/cards/` | 16 | ✅ 完整 | 卡片系统（BaseCard、7 种卡片、CardFactory、PipelineEngine 等） |
| `src/core/` | 8 | ✅ 完整 | 命令系统（commands、command-manager、canvas、snapshot、clipboard） |
| `src/state/` | 7 | ✅ 完整 | 状态管理（app-state、canvas/card/connection/group/providers/ui state） |
| `src/services/` | 3 | ✅ 完整 | 服务层（model-service、provider-service、prompt-service） |
| `src/types/` | 5 | ✅ 完整 | 类型定义（pywebview.d.ts、cards.d.ts、app-state.d.ts 等） |
| `src/utils/` | 6 | ✅ 完整 | 工具函数（api、dom、lazy-loader、snapshot、uid） |
| `src/ui/` | 8 | ✅ 新增 | UI 组件库（Dialog、FormInput、FormSwitch、Select、Textarea、Button、Toast、ListItem） |
| `src/main.ts` | 1 | ⚠️ 脚手架 | 仅验证脚手架，无实际功能 |
| `src/index.html` | 1 | ❓ 未确认 | Vite 构建入口 |

### 1.3 未迁移的 JS 代码（`gui/js/` 目录）

| 模块 | 文件数 | 说明 |
|---|---|---|
| `gui/js/agent/` | 1 | Agent 面板（已使用 UI 组件） |
| `gui/js/components/` | 6 | 面板组件（settings、provider、model、prompt-library、connection、minimap、history-sidebar） |
| `gui/js/main.js` | 1 | 前端入口（初始化所有模块） |
| `gui/js/state.js` | 1 | 聚合状态 |
| `gui/js/image-modal.js` | 1 | 图片查看器 |
| `gui/js/laser-cutter.js` | 1 | 激光切割 |
| `gui/js/project-manager.js` | 1 | 项目管理器 |
| `gui/js/selection-box.js` | 1 | 选择框 |
| `gui/js/theme-manager.js` | 1 | 主题管理器 |
| `gui/js/utils/ui-components.js` | 1 | JS 版 UI 组件（UIInput/UISwitch/UITextarea） |
| `gui/js/utils/ui-select.js` | 1 | JS 版 UISelect |

---

## 二、迁移策略

### 2.1 方案选择

| 方案 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| **A. 渐进迁移（推荐）** | 逐步将 JS 模块迁移到 TS，保持双轨运行 | 风险低，可随时回退 | 周期长 |
| B. 一次性重写 | 全部重写为 TS，一次性切换 | 干净彻底 | 风险高，工作量大 |
| C. 放弃迁移 | 继续用 JS，TS 仅用于类型检查 | 零风险 | 失去 TS 收益 |

**推荐方案 A：渐进迁移**

### 2.2 迁移顺序（按依赖关系）

```
Phase 1: 基础设施
├── src/main.ts → 连接 pywebview API
├── src/index.html → 对齐 gui/index.html 结构
└── vite.config.ts → 确认构建输出路径

Phase 2: 状态与服务（已迁移，需验证）
├── src/state/ → 验证与 JS 版功能对等
├── src/services/ → 验证与 JS 版功能对等
└── src/utils/ → 验证与 JS 版功能对等

Phase 3: 核心模块（已迁移，需验证）
├── src/core/ → 验证命令系统、画布、快照
└── src/cards/ → 验证所有卡片类型

Phase 4: 组件层（未迁移）
├── src/components/settings.ts
├── src/components/provider-panel.ts
├── src/components/model-panel.ts
├── src/components/prompt-library.ts
├── src/components/connection.ts
├── src/components/minimap.ts
└── src/components/history-sidebar.ts

Phase 5: 独立模块（未迁移）
├── src/agent/agent-panel.ts
├── src/image-modal.ts
├── src/laser-cutter.ts
├── src/project-manager.ts
├── src/selection-box.ts
└── src/theme-manager.ts

Phase 6: 切换与清理
├── main.py → 加载 gui/dist/index.html
├── 删除 gui/js/ 旧代码
└── 删除 gui/styles/ 中不再需要的文件
```

---

## 三、关键决策点

### 3.1 pywebview API 桥接

**问题**：JS 版通过 `window.pywebview.api.xxx()` 调用 Python 后端，TS 版需要类型安全的桥接。

**方案**：
```typescript
// src/types/pywebview.d.ts 已定义类型
// src/utils/api.ts 已封装调用

// 需要确保：
// 1. pywebview 对象在 TS 代码执行前已注入
// 2. 所有 API 调用都有错误处理
// 3. 类型定义与 Python 后端保持同步
```

### 3.2 全局状态兼容

**问题**：JS 版通过 `window.AppState` 共享状态，TS 版需要类型安全的访问。

**方案**：
```typescript
// src/state/app-state.ts 已定义
export const AppState = { ... };
(window as any).AppState = AppState;  // 桥接到 window

// 迁移时需要确保：
// 1. JS 模块和 TS 模块访问同一个 AppState
// 2. 不会出现时序问题（TS 模块在 JS 模块之前初始化）
```

### 3.3 CSS 样式加载

**问题**：JS 版通过 `<link>` 标签加载 CSS，TS 版（Vite）可以通过 import 加载。

**方案**：
- 保持 CSS 文件在 `gui/styles/` 目录
- `src/index.html` 中用 `<link>` 引入（与 JS 版一致）
- 不使用 Vite 的 CSS import，避免路径变化

### 3.4 构建输出路径

**当前配置**：
```typescript
// vite.config.ts
build: {
  outDir: 'gui/dist',  // 输出到 gui/dist/
}
```

**pywebview 加载路径需要改为**：
```python
# main.py
INDEX_HTML = os.path.join(RESOURCE_DIR, 'gui', 'dist', 'index.html')
```

---

## 四、风险与回退

### 4.1 风险点

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| pywebview API 时序问题 | TS 模块在 API 注入前执行 | 在 main.ts 中等待 `window.pywebviewready` 事件 |
| 全局变量冲突 | JS 和 TS 模块同时操作 AppState | 逐步迁移，每阶段验证 |
| CSS 加载路径变化 | 样式丢失 | 保持 CSS 文件位置不变 |
| 构建产物过大 | 单 chunk 文件过大 | 配置 code splitting |
| 功能回归 | 迁移后功能异常 | 每阶段编写测试用例 |

### 4.2 回退方案

每个 Phase 完成后，如果出现问题：
1. `main.py` 中 `INDEX_HTML` 改回 `gui/index.html`
2. 重启应用，回到 JS 版本
3. TS 代码保留在 `src/` 目录，不影响运行

---

## 五、验收标准

### 5.1 每个 Phase 的验收

- [ ] TypeScript 编译无错误（`tsc --noEmit`）
- [ ] Vite 构建成功（`vite build`）
- [ ] 应用启动正常（无控制台错误）
- [ ] 所有功能手动测试通过
- [ ] 深色/浅色主题切换正常
- [ ] 撤销/重做正常
- [ ] 项目保存/加载正常

### 5.2 最终验收

- [ ] `gui/dist/index.html` 作为唯一入口
- [ ] `gui/js/` 目录已删除
- [ ] 所有功能与 JS 版完全对等
- [ ] 构建产物大小合理（< 500KB）
- [ ] 首次加载时间无明显增加

---

## 六、预计工作量

| Phase | 工作量 | 说明 |
|---|---|---|
| Phase 1: 基础设施 | 2-3 天 | main.ts、index.html、vite 配置 |
| Phase 2: 状态与服务验证 | 1-2 天 | 已迁移，只需验证 |
| Phase 3: 核心模块验证 | 2-3 天 | 命令系统、卡片系统验证 |
| Phase 4: 组件层迁移 | 5-7 天 | 6 个组件模块，工作量最大 |
| Phase 5: 独立模块迁移 | 2-3 天 | 6 个小模块 |
| Phase 6: 切换与清理 | 1-2 天 | 路径切换、删除旧代码 |
| **总计** | **13-20 天** | |

---

## 七、执行检查清单

开始迁移前确认：

- [ ] `src/` 目录的 TS 代码已通过 `tsc --noEmit` 编译
- [ ] `gui/js/` 的 JS 代码是当前功能完整的版本
- [ ] 有完整的 git 备份，可随时回退
- [ ] 已手动记录当前 JS 版的所有功能点（用于验收对比）

---

## 附录 A：文件映射表

| JS 文件 | 对应 TS 文件 | 迁移状态 |
|---|---|---|
| `gui/js/main.js` | `src/main.ts` | ⚠️ 需重写 |
| `gui/js/state.js` | `src/state/index.ts` | ✅ 已迁移 |
| `gui/js/core/canvas.js` | `src/core/canvas.ts` | ✅ 已迁移 |
| `gui/js/core/commands.js` | `src/core/commands.ts` | ✅ 已迁移 |
| `gui/js/core/command-manager.js` | `src/core/command-manager.ts` | ✅ 已迁移 |
| `gui/js/core/snapshot.js` | `src/core/snapshot.ts` | ✅ 已迁移 |
| `gui/js/core/clipboard.js` | `src/core/clipboard.ts` | ✅ 已迁移 |
| `gui/js/cards/*.js` | `src/cards/*.ts` | ✅ 已迁移 |
| `gui/js/services/*.js` | `src/services/*.ts` | ✅ 已迁移 |
| `gui/js/utils/api.js` | `src/utils/api.ts` | ✅ 已迁移 |
| `gui/js/utils/dom.js` | `src/utils/dom.ts` | ✅ 已迁移 |
| `gui/js/components/settings.js` | `src/components/settings.ts` | ❌ 未迁移 |
| `gui/js/components/provider-panel.js` | `src/components/provider-panel.ts` | ❌ 未迁移 |
| `gui/js/components/model-panel.js` | `src/components/model-panel.ts` | ❌ 未迁移 |
| `gui/js/components/prompt-library.js` | `src/components/prompt-library.ts` | ❌ 未迁移 |
| `gui/js/components/connection.js` | `src/components/connection.ts` | ❌ 未迁移 |
| `gui/js/components/minimap.js` | `src/components/minimap.ts` | ❌ 未迁移 |
| `gui/js/components/history-sidebar.js` | `src/components/history-sidebar.ts` | ❌ 未迁移 |
| `gui/js/agent/agent-panel.js` | `src/agent/agent-panel.ts` | ❌ 未迁移 |
| `gui/js/image-modal.js` | `src/image-modal.ts` | ❌ 未迁移 |
| `gui/js/laser-cutter.js` | `src/laser-cutter.ts` | ❌ 未迁移 |
| `gui/js/project-manager.js` | `src/project-manager.ts` | ❌ 未迁移 |
| `gui/js/selection-box.js` | `src/selection-box.ts` | ❌ 未迁移 |
| `gui/js/theme-manager.js` | `src/theme-manager.ts` | ❌ 未迁移 |
| `gui/js/utils/ui-components.js` | `src/ui/form-input.ts` 等 | ✅ 已重写 |
| `gui/js/utils/ui-select.js` | `src/ui/select.ts` | ✅ 已重写 |

## 附录 B：TypeScript 配置参考

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "preserve",
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["src/**/*.ts", "src/**/*.d.ts"],
  "exclude": ["node_modules", "gui/dist"]
}
```

## 附录 C：Vite 配置参考

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'gui/dist',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'src/index.html'),
      output: {
        // 单 chunk，简化 pywebview 加载
        manualChunks: undefined,
      },
    },
    // 生产环境 sourcemap（调试用，发布时关闭）
    sourcemap: false,
    // 压缩
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true,  // 移除 console.log
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    open: false,
  },
});
```
