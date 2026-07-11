# TextCard（文本卡片）

## 文件路径
`gui\js\cards\TextCard.js`

## 功能概述
TextCard 是一个简单的文本输入卡片，用于输入提示词或文字内容。它可以将文本数据推送给下游卡片，支持与 AI 绘图卡片、Agent 卡片等配合使用。

## 核心特性

- 简洁的文本输入区域
- 自动将文本推送给下游卡片
- 支持从上游接收数据并追加或替换
- 300ms 防抖推送，避免频繁触发
- 支持历史记录保存（失焦时保存）

## 卡片信息

| 属性 | 值 |
|------|-----|
| 卡片类型标识 | `text` |
| 默认尺寸 | 200px × 120px |
| 最小尺寸 | 150px × 80px |
| 继承自 | BaseCard |

## 契约声明

```javascript
static getContract() {
    return {
        outputs: [{ name: 'default', type: 'text' }],
        inputs: []
    };
}
```

| 端口类型 | 端口名称 | 数据类型 | 说明 |
|---------|---------|---------|------|
| 输出 | `default` | `text` | 输出文本内容 |
| 输入 | 无 | - | 无输入端口 |

## 核心属性

| 属性名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `content` | string | '' | 文本内容 |
| `text` | string | '' | 文本内容（与 content 相同） |

## 核心方法

### getOutput(outputName)
获取输出端口的数据。
```javascript
getOutput(outputName) {
    if (outputName === 'default') {
        return this.textarea?.value || '';
    }
    return null;
}
```

### setText(text)
设置文本内容并自动推送给下游卡片。
```javascript
setText(text) {
    if (this.textarea) {
        this.textarea.value = text;
        // 自动推送给下游
        this.notifyDownstream(this.id);
    }
}
```

### onReceive(type, data, source)
处理从上游卡片接收的数据。
```javascript
onReceive(type, data, source) {
    if (type === 'text' && data) {
        // 可以选择替换或追加文本
        this.setText(data);
    }
}
```

## 静态方法

### setText(cardId, text)
静态方法，用于从外部设置卡片文本。
```javascript
static setText(cardId, text) {
    const card = CardFactory.getInstance(cardId);
    if (card) {
        card.setText(text);
    }
}
```

## 渲染结构

```html
<div class="card-content">
    <textarea class="text-card-input" placeholder="输入文本..."></textarea>
</div>
```

## 样式特点

- 深色背景 (#1e1e1e)
- 圆角边框 (6px)
- 文本区域占满整个内容区
- 支持多行文本输入
- placeholder 提示文字

## 使用场景

1. **提示词输入**：作为 AI 绘图卡片的提示词来源
2. **文字传递**：将文本传递给 Agent 卡片进行处理
3. **工作流节点**：在复杂工作流中作为数据传递节点
4. **模板存储**：存储常用提示词模板

## 数据流转

```
TextCard 输出 (text)
    ↓
    ├─→ AIDrawCard (作为 prompt 输入)
    ├─→ AgentCard (作为 userInput 或 metaPrompt)
    ├─→ DrawingBoardCard
    └─→ 其他支持 text 输入的卡片
```

## 与其他卡片的配合

| 目标卡片 | 连接效果 |
|---------|---------|
| AIDrawCard | 自动填充提示词字段，启用生成按钮 |
| AgentCard | 追加或替换用户输入内容 |
| DrawingBoardCard | 可作为图层标注使用 |

## 注意事项

1. 文本修改后会自动推送给下游，但使用 300ms 防抖
2. 失焦时会保存历史记录
3. 输出的文本为空字符串时不会触发下游更新
4. 支持从其他 TextCard 接收数据进行合并或替换
