# AgentCard（Agent 对话卡片）

## 文件路径
`gui\js\cards\AgentCard.js`

## 功能概述
AgentCard 是一个支持 AI 对话的多功能卡片，包含 Meta Prompt（系统提示词）和 User Input（用户输入）两部分。支持多模态输入，可以同时接收文字和图片，处理后输出文字回复。

## 核心特性

- Meta Prompt + User Input 双重输入
- 多模态支持：可接收和处理图片
- 模型选择功能
- 实时加载状态显示
- 输出文本复制功能
- 支持上游数据追加

## 卡片信息

| 属性 | 值 |
|------|-----|
| 卡片类型标识 | `agent` |
| 默认尺寸 | 460px × 520px |
| 最小尺寸 | 360px × 420px |
| 继承自 | BaseCard |

## 契约声明

```javascript
static getContract() {
    return {
        outputs: [{ name: 'default', type: 'text', notifyOn: 'onRun' }],
        inputs: [
            { name: 'prompt', type: 'text', multiple: true, receivePolicy: 'append' },
            { name: 'reference', type: 'image', multiple: true, receivePolicy: 'append' }
        ]
    };
}
```

| 端口类型 | 端口名称 | 数据类型 | 接收策略 | 说明 |
|---------|---------|---------|---------|------|
| 输出 | `default` | `text` | - | AI 回复文本（仅在运行时通知） |
| 输入 | `prompt` | `text` | append | 提示词输入（支持多个上游） |
| 输入 | `reference` | `image` | append | 参考图输入（支持多个上游） |

## 核心属性

| 属性名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `agentConfig` | object | `{}` | Agent 配置对象 |
| `model` | string | '' | 当前选中的模型 ID |
| `metaPrompt` | string | '' | 系统提示词（Meta Prompt） |
| `userInput` | string | '' | 用户输入文本 |
| `output` | string | '' | AI 输出回复 |
| `_loading` | boolean | false | 是否正在加载 |
| `_upstreamText` | array | `[]` | 上游文本内容数组 |
| `_upstreamImages` | array | `[]` | 上游图片内容数组 |

### agentConfig 配置对象结构

```javascript
{
    model: 'gpt-4o',              // 模型 ID
    metaPrompt: '',               // 系统提示词
    userInput: '',                // 用户输入
    output: ''                    // AI 输出
}
```

## 核心方法

### _getUpstreamContent()
获取上游内容（文字 + 图片）。
```javascript
_getUpstreamContent() {
    return {
        texts: this._upstreamText,
        images: this._upstreamImages
    };
}
```

### updateUpstreamHint()
更新上游连接提示，显示当前连接的数据来源。
```javascript
updateUpstreamHint() {
    // 更新 UI 显示上游数据来源
}
```

### refreshUpstream()
刷新上游预览。
```javascript
refreshUpstream() {
    // 更新参考图预览区域
}
```

### _setModel(modelId, displayText)
设置模型。
```javascript
_setModel(modelId, displayText) {
    this.model = modelId;
    this.agentConfig.model = modelId;
    // 更新 UI 显示
}
```

### _setOutput(text)
设置输出内容。
```javascript
_setOutput(text) {
    this.output = text;
    this.agentConfig.output = text;
    // 更新 UI 显示
}
```

### _setLoading(loading)
设置加载状态。
```javascript
_setLoading(loading) {
    this._loading = loading;
    // 更新 UI 显示加载动画
}
```

## 静态方法

### showModelMenu(event, cardId)
显示模型选择菜单。
```javascript
static showModelMenu(event, cardId) {
    // 显示可用模型列表
}
```

### _openLib(event, cardId, category)
打开提示词库。
```javascript
static _openLib(event, cardId, category) {
    // category: 'meta' 或 'user'
    // 打开提示词库选择面板
}
```

### _compressImage(dataUrl, maxSize, quality)
压缩图片以适应 API 调用。
```javascript
static _compressImage(dataUrl, maxSize = 800, quality = 0.8) {
    // 返回压缩后的 base64 数据
}
```

### run(cardId)
运行 Agent 对话。
```javascript
static run(cardId) {
    const card = CardFactory.getInstance(cardId);
    if (!card) return;

    // 收集上游内容
    const content = card._getUpstreamContent();

    // 调用后端 API
    card._setLoading(true);

    // 处理回复
    card._setOutput(response);
    card._setLoading(false);

    // 通知下游
    card.notifyDownstream(cardId);
}
```

### _copyOutput(cardId)
复制输出内容到剪贴板。
```javascript
static _copyOutput(cardId) {
    const card = CardFactory.getInstance(cardId);
    if (card && card.output) {
        navigator.clipboard.writeText(card.output);
    }
}
```

### _getChatModels()
获取可用的对话模型列表。
```javascript
static _getChatModels() {
    // 返回模型列表 [{ id, name, description }]
}
```

## UI 结构

```html
<div class="card-content agent-card">
    <!-- Meta Prompt 区域 -->
    <div class="section meta-prompt-section">
        <div class="section-header">
            <span class="section-title">Meta Prompt</span>
            <button class="lib-btn">Library</button>
        </div>
        <textarea class="meta-prompt-input" placeholder="系统提示词..."></textarea>
        <div class="upstream-hint meta-hint"></div>
    </div>

    <!-- 模型选择 -->
    <div class="model-selector">
        <button class="model-btn">选择模型</button>
    </div>

    <!-- User Input 区域 -->
    <div class="section user-input-section">
        <div class="section-header">
            <span class="section-title">User Input</span>
            <button class="lib-btn">Library</button>
        </div>
        <textarea class="user-input-textarea" placeholder="用户输入..."></textarea>
        <div class="upstream-hint user-hint"></div>
    </div>

    <!-- 参考图预览 -->
    <div class="reference-images">
        <div class="ref-images-grid"></div>
    </div>

    <!-- 运行按钮 -->
    <button class="run-btn">Run</button>

    <!-- 输出区域 -->
    <div class="output-section">
        <div class="output-header">
            <span>Output</span>
            <button class="copy-btn">Copy</button>
        </div>
        <div class="output-content"></div>
        <div class="loading-indicator"></div>
    </div>
</div>
```

## 样式特点

- 清晰的分区设计（Meta/User/Output）
- 模型选择器位于中间位置
- 参考图以小缩略图显示
- 输出区域支持滚动
- 加载动画覆盖输出区域
- 支持拖拽调整卡片大小

## 支持的模型类型

卡片会从后端获取可用的对话模型列表，常见模型包括：

- GPT-4 系列
- Claude 系列
- Gemini 系列
- 本地部署模型

## 使用场景

1. **AI 对话**：作为通用 AI 对话界面
2. **提示词优化**：接收简单文本，输出优化后的提示词
3. **多模态处理**：接收图片和文字，进行分析和描述
4. **工作流节点**：作为中间处理节点，转换或增强数据

## 数据流转

```
TextCard 输出 (text) ─→ AgentCard 输入 (prompt)
ImageInputCard 输出 (image) ─→ AgentCard 输入 (reference)
        ↓
        [调用 AI 模型处理]
        ↓
AgentCard 输出 (text) ─→ TextCard (存储输出)
        ↓
        └─→ AIDrawCard (作为提示词生成图片)
```

## 与其他卡片的配合

| 来源卡片 | 连接效果 |
|---------|---------|
| TextCard | 追加到 Meta Prompt 或 User Input |
| ImageInputCard | 添加到参考图列表 |
| AIDrawCard | 可以接收 Agent 输出作为绘图提示词 |
| CompareCard | Agent 输出可作为对比参考 |

## 提示词库

AgentCard 内置提示词库，支持保存和加载常用提示词。

### 提示词分类

| 分类 | 说明 |
|------|------|
| `meta` | Meta Prompt 提示词库 |
| `user` | User Input 提示词库 |

### 保存提示词

用户可以将当前输入保存到提示词库中，供后续使用。

## 图片压缩

当接收的图片过大时，会自动压缩以适应 API 调用限制：

- 最大尺寸：800px（宽或高）
- 压缩质量：0.8

## 注意事项

1. 支持多个上游卡片连接，数据会追加而非替换
2. 参考图支持多张，会在发送给 API 时一起发送
3. 加载状态会阻止重复点击运行按钮
4. 输出文本过长时支持滚动查看
5. 复制功能仅复制文本内容，不包含格式
6. 模型列表从后端动态获取
