# Infinite Canvas 1.0 结构目录

## 项目结构

```
Infinite Canvas 1.0/
├── main.py                    # 应用入口，初始化 pywebview 窗口，注册统一 API 路由层
├── test_api.py                # API 测试脚本
├── icon.ico                   # 应用图标
├── InfiniteCanvas.spec        # PyInstaller 打包配置
├── build.py                   # 打包构建脚本
├── requirements.txt           # Python 依赖
├── providers_data.json        # AI 供应商配置数据存储
├── settings.json              # 应用设置存储
├── prompts_library.json       # 提示词/技能库本地存储（common / skill / draw 三类）
├── package.json               # 前端依赖（Vite + TypeScript）
├── tsconfig.json              # TypeScript 配置
├── vite.config.ts             # Vite 构建配置
├── reasonix.toml              # Reasonix AI 助手配置
│
├── backend/                   # Python 后端
│   ├── __init__.py
│   └── api/
│       ├── __init__.py
│       ├── errors.py          # 统一错误码定义（AppError 基类及 4xx/5xx 子类）
│       ├── utils.py           # 公共工具函数（get_tk_root 等）
│       ├── clipboard_api.py   # 剪贴板操作（复制/粘贴画布数据）
│       ├── image_api.py       # 图片处理（保存到本地、Base64/URL 转换、扩图 Outpaint）
│       ├── project_api.py     # 项目文件管理（保存/另存为/打开）
│       ├── provider_api.py    # AI 供应商管理（增删改查、测试连接、获取模型）
│       ├── unified_api.py     # 统一 API 路由层（自动识别模型类型和 API 格式，线程安全）
│       ├── settings_api.py    # 设置读写、文件夹选择、提示词库读写
│       └── gemini_compat.py   # Gemini API 兼容层
│
├── gui/                       # 前端界面（生产版本）
│   ├── index.html             # 主页面（画布、侧边栏、工具栏、弹层）
│   │
│   ├── styles/                # CSS 样式
│   │   ├── app.css            # 样式入口，聚合其他样式文件
│   │   ├── variables.css      # CSS 变量定义（深色/浅色双主题，20+ 语义变量）
│   │   ├── base.css           # 基础样式（重置、字体、prefers-reduced-motion）
│   │   ├── canvas.css         # 画布样式
│   │   ├── animations.css     # 公共动画定义（panelSlideUp/fadeIn/menuPop 等 9 个）
│   │   ├── custom-select.css  # 自定义下拉选择器样式（UISelect 组件）
│   │   ├── ui.css             # 通用 UI（工具栏、右键菜单、小地图、Toast、Modal）
│   │   ├── card.css           # 卡片通用样式
│   │   ├── card-text.css      # 文本卡片样式
│   │   ├── card-image-input.css   # 图片输入卡片样式
│   │   ├── card-ai-draw.css   # AI 绘图卡片样式
│   │   ├── card-drawing-board.css # 画板卡片样式
│   │   ├── card-agent.css     # Agent 对话卡片样式
│   │   ├── card-preview.css   # 预览卡片样式
│   │   ├── model.css          # 模型管理面板样式
│   │   ├── provider.css       # 供应商管理面板样式
│   │   ├── settings.css       # 设置面板样式
│   │   ├── sidebar.css        # 左侧历史图库侧边栏样式
│   │   ├── agent-panel.css    # Agent 右侧对话面板样式
│   │   └── group.css          # 分组功能样式
│   │
│   ├── js/
│   │   ├── main.js            # 前端入口，初始化应用
│   │   ├── state.js           # 全局状态管理（AppState 顶层对象）
│   │   │
│   │   ├── core/              # 核心功能模块
│   │   │   ├── canvas.js      # 画布逻辑（缩放、平移、视口管理）
│   │   │   ├── clipboard.js   # 剪贴板功能
│   │   │   ├── commands.js    # 命令实现（CreateCard/DeleteCards/MoveCards/Connect 等）
│   │   │   ├── command-base.js    # 命令基类
│   │   │   ├── command-manager.js # 命令管理器（执行/撤销/重做）
│   │   │   ├── history.js     # 历史记录管理
│   │   │   ├── snapshot.js    # 快照序列化/反序列化
│   │   │   ├── storage.js     # 本地存储
│   │   │   └── undo-redo.js   # 撤销/重做功能
│   │   │
│   │   ├── cards/             # 卡片组件（全部使用 UI 组件库）
│   │   │   ├── BaseCard.js    # 卡片基类（拖拽、缩放、删除等通用功能）
│   │   │   ├── CardFactory.js # 卡片工厂（按类型创建卡片）
│   │   │   ├── TextCard.js    # 文本卡片（UITextarea）
│   │   │   ├── ImageInputCard.js  # 图片输入卡片
│   │   │   ├── AIDrawCard.js  # AI 绘图卡片（UITextarea）
│   │   │   ├── AgentCard.js   # Agent 对话卡片（UITextarea ×2）
│   │   │   ├── PreviewCard.js # 预览卡片
│   │   │   ├── DrawingBoardCard.js # 画板卡片（UISelect + UIInput）
│   │   │   ├── CompareCard.js # 对比卡片
│   │   │   ├── CardContract.js    # 卡片接口契约
│   │   │   ├── CardEventBus.js    # 卡片事件总线
│   │   │   ├── ConnectionRules.js # 连接规则定义
│   │   │   ├── DataSource.js      # 数据源管理
│   │   │   ├── PipelineEngine.js  # 管线执行引擎
│   │   │   └── event-bus-init.js  # 事件总线初始化
│   │   │
│   │   ├── groups/            # 分组功能模块
│   │   │   ├── GroupManager.js    # 组管理器
│   │   │   ├── GroupRenderer.js   # 组渲染器
│   │   │   ├── GroupExecutor.js   # 组执行器
│   │   │   └── group-actions.js   # 组操作辅助
│   │   │
│   │   ├── components/        # UI 面板组件（使用 UI 组件库）
│   │   │   ├── connection.js       # 卡片连接线
│   │   │   ├── minimap.js          # 小地图导航
│   │   │   ├── model-panel.js      # 模型管理面板（UISwitch + UIInput）
│   │   │   ├── provider-panel.js   # 供应商管理面板（UIInput + UISelect + UISwitch）
│   │   │   ├── prompt-library.js   # 提示词库浮层（UIInput + UITextarea）
│   │   │   ├── settings.js         # 设置面板（UIInput）
│   │   │   └── history-sidebar.js  # 左侧历史图库侧边栏
│   │   │
│   │   ├── state/             # 状态管理子模块
│   │   │   ├── canvas-state.js     # 画布状态
│   │   │   ├── card-state.js       # 卡片状态
│   │   │   ├── connection-state.js # 连接线状态
│   │   │   ├── providers-state.js  # 供应商状态
│   │   │   ├── group-state.js      # 分组状态
│   │   │   └── ui-state.js         # UI 状态
│   │   │
│   │   ├── services/          # 服务层（业务逻辑）
│   │   │   ├── model-service.js    # 模型数据服务
│   │   │   ├── provider-service.js # 供应商数据服务
│   │   │   └── prompt-service.js   # 提示词库数据服务
│   │   │
│   │   ├── utils/             # 工具函数
│   │   │   ├── api.js          # 后端 API 调用封装（pywebview.api）
│   │   │   ├── dom.js          # DOM 操作工具
│   │   │   ├── lazy-loader.js  # 懒加载工具
│   │   │   ├── snapshot.js     # 快照工具
│   │   │   ├── ui-components.js    # UI 组件库（UIInput/UITextarea/UISwitch）
│   │   │   └── ui-select.js    # 自定义下拉选择器（UISelect）
│   │   │
│   │   ├── agent/             # Agent 面板（使用 UI 组件库）
│   │   │   └── agent-panel.js  # Agent 右侧对话面板（UISelect + UITextarea）
│   │   │
│   │   ├── image-modal.js     # 图片查看器
│   │   ├── laser-cutter.js    # 激光切割连线
│   │   ├── project-manager.js # 项目管理器
│   │   ├── selection-box.js   # 选择框组件
│   │   └── theme-manager.js   # 主题管理器
│   │
│   └── dist/                  # Vite 构建输出
│       └── assets/            # 编译后的 TS 资源
│
├── src/                       # TypeScript 迁移版本（进行中）
│   ├── main.ts                # TS 入口（脚手架验证）
│   ├── cards/                 # 卡片系统（TS 版）
│   ├── core/                  # 命令系统、画布、快照（TS 版）
│   ├── state/                 # 状态管理（TS 版）
│   ├── types/                 # 类型定义（pywebview.d.ts, cards.d.ts 等）
│   ├── services/              # 服务层（TS 版）
│   ├── utils/                 # 工具函数（TS 版）
│   └── ui/                    # UI 组件库（TS 版）
│       ├── index.ts           # 统一导出
│       ├── dialog.ts          # 弹窗组件
│       ├── form-input.ts      # 表单输入
│       ├── form-switch.ts     # 开关组件
│       ├── select.ts          # 自定义下拉
│       ├── textarea.ts        # 多行输入
│       ├── button.ts          # 按钮组件
│       ├── toast.ts           # 提示组件
│       └── list-item.ts       # 列表项组件
│
├── 开发准则/                   # 开发规范文档
│   ├── UI设计方案-玻璃极简风.md     # 完整设计方案（含附录C：UI组件库规范）
│   ├── UI设计准则.md               # UI 开发准则
│   ├── 卡片开发信息流转规则.md       # 卡片开发规范
│   └── 后续开发规范文档.md          # 后续开发规范
│
├── _defaults/                 # 默认配置文件
│   ├── providers_data.json
│   ├── settings.json
│   └── prompts_library.json
│
├── build/                     # PyInstaller 构建输出目录
├── dist/                      # 打包输出目录
├── .idea/                     # JetBrains IDE 配置
├── .venv/                     # Python 虚拟环境
└── node_modules/              # 前端依赖
```

## 核心功能

- **无限画布**：支持缩放、平移，在画布上自由放置卡片
- **多种卡片类型**：文本、图片输入、AI 绘图、Agent 对话、预览、画板、对比
- **卡片连接线**：卡片之间可连线，形成数据流，支持激光切割删除连线
- **节点分组**：选中多张卡片创建分组，支持颜色预设、折叠、批量运行
- **提示词库**：内置常用、技能、绘图三类提示词
- **AI 供应商管理**：支持多个 OpenAI 兼容 API 供应商，区分对话/绘图模型
- **历史图库**：右侧侧边栏展示历史生成图片
- **项目管理**：保存/打开项目文件（.icproj 格式）
- **撤销/重做**：完整的命令模式操作历史
- **主题切换**：浅色/深色模式，CSS 变量自动适配
- **图片查看器**：全屏查看，支持 ESC 关闭、滚轮缩放
- **激光切割**：Ctrl+右键拖动切割连线

## UI 组件库

项目内置可复用 UI 组件，所有新功能**必须使用组件库**，禁止手写原生表单元素：

| 组件 | 文件 | 用途 |
|---|---|---|
| **UIInput** | `gui/js/utils/ui-components.js` | 文本/密码/数字输入 |
| **UITextarea** | `gui/js/utils/ui-components.js` | 多行文本输入 |
| **UISwitch** | `gui/js/utils/ui-components.js` | 开关切换 |
| **UISelect** | `gui/js/utils/ui-select.js` | 自定义下拉选择 |
| **Dialog** | `src/ui/dialog.ts` | 弹窗对话框（TS 版） |
| **Toast** | 全局 | 提示消息 |

详细规范见 `开发准则/UI设计方案-玻璃极简风.md` 附录 C。

## 设计系统

- **风格**：Glassmorphism Lite（玻璃极简风）
- **色彩**：Indigo/Cyan/Purple 三色系，5 层背景明度递进
- **主题**：深色/浅色双主题，通过 `data-theme` 属性切换
- **变量**：`gui/styles/variables.css` 定义所有设计 token
- **动画**：`gui/styles/animations.css` 统一管理 9 个公共动画
