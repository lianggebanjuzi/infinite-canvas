# CardContract（卡片契约系统）

## 文件路径
`gui\js\cards\CardContract.js`

## 功能概述
CardContract 是卡片契约系统的核心，它基于声明式的方式定义卡片的输入输出规范。这个系统使得卡片之间的连接更加智能和安全，支持类型检查、连接规则验证和数据流转控制。

## 设计理念

契约系统的核心思想是将卡片的"能力"（能输出什么）和"需求"（需要什么输入）声明出来，让系统自动验证连接兼容性并处理数据流转逻辑。

```
┌─────────────────────────────────────────────────────────────┐
│                    契约声明示例                              │
├─────────────────────────────────────────────────────────────┤
│  TextCard                                                    │
│  {                                                          │
│    outputs: [{ name: 'default', type: 'text' }],            │
│    inputs: []                                                │
│  }                                                          │
│                           ↓                                  │
│    outputs[0].type = 'text' ─── matches ──→ inputs[0].type  │
└─────────────────────────────────────────────────────────────┘
```

## 契约结构

### 完整契约声明

```javascript
static getContract() {
    return {
        outputs: [
            {
                name: 'default',           // 输出端口名称
                type: 'text',              // 数据类型
                notifyOn: 'onRun'           // 通知时机（可选）
            }
        ],
        inputs: [
            {
                name: 'prompt',             // 输入端口名称
                type: 'text',               // 数据类型
                multiple: false,            // 是否支持多个连接
                receivePolicy: 'replace'    // 接收策略
            }
        ]
    };
}
```

### 输出端口定义

| 属性 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 端口名称，用于 `getOutput(name)` 获取数据 |
| `type` | string | 是 | 数据类型 (`text`, `image` 等) |
| `notifyOn` | string | 否 | 触发通知的时机 (`onRun`, `onApply`, 默认立即) |

### 输入端口定义

| 属性 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 端口名称 |
| `type` | string | 是 | 期望的数据类型 |
| `multiple` | boolean | 否 | 是否支持多个上游连接（默认 false） |
| `receivePolicy` | string | 否 | 接收策略 (`replace`, `append`) |

## 数据类型

系统支持的数据类型：

| 类型 | 说明 | 典型用途 |
|------|------|---------|
| `text` | 文本字符串 | 提示词、对话内容、标签 |
| `image` | 图片数据 | Base64、URL、本地路径 |

## 接收策略

### replace（替换）
新数据完全替换旧数据。

```javascript
// 当收到新数据时
{
    receivePolicy: 'replace'
}
// 效果：currentData = newData
```

### append（追加）
新数据追加到现有数据中。

```javascript
// 当收到新数据时
{
    receivePolicy: 'append'
}
// 效果：currentData = [...currentData, ...newData]
```

适用场景：
- AgentCard：多个 TextCard 的内容追加
- DrawingBoardCard：多张参考图追加为图层
- AIDrawCard：多张参考图追加

## 通知时机

### 立即通知（默认）
数据变化时立即通知下游。

```javascript
// 无 notifyOn 字段
outputs: [{ name: 'default', type: 'text' }]
```

### 运行时通知
仅在用户触发运行操作时通知下游。

```javascript
// notifyOn: 'onRun'
outputs: [{ name: 'default', type: 'image', notifyOn: 'onRun' }]
// 适用：AIDrawCard、AgentCard（生成完成后才通知）
```

### 应用后通知
仅在用户点击"应用"按钮时通知。

```javascript
// notifyOn: 'onApply'
outputs: [{ name: 'default', type: 'image', notifyOn: 'onApply' }]
// 适用：DrawingBoardCard（编辑完成后才通知）
```

## 核心方法

### get(cardOrType)
获取卡片的契约定义。

```javascript
// 通过卡片实例获取
const contract = CardContract.get(myCard);

// 通过类型名称获取
const contract = CardContract.get('agent');
```

### checkCompatibility(sourceCard, targetCard, endPort)
检查两个卡片之间的连接是否兼容。

```javascript
const result = CardContract.checkCompatibility(
    textCard,      // 源卡片
    aiDrawCard,    // 目标卡片
    'prompt'       // 目标端口名称
);

// 返回结构
{
    compatible: true,           // 是否兼容
    sourceOutput: {...},        // 源输出定义
    targetInput: {...},         // 目标输入定义
    rule: {...},                // 匹配的连接规则
    reason: '类型匹配'           // 原因说明
}
```

### getRuleKey(sourceCard, targetCard)
获取连接规则的关键字。

```javascript
const key = CardContract.getRuleKey(
    textCard,
    aiDrawCard
);

// 返回格式：'text→ai-image'
// 或 'agent→agent'
```

## 连接规则引擎

参见 `ConnectionRules.js`，契约系统与规则引擎协同工作：

### 规则注册

```javascript
ConnectionRules.register('text→ai-image', {
    onConnect: (source, target, port) => {
        // 禁用目标卡片的输入框
        target.elements.promptInput?.setAttribute('disabled', 'true');
    },
    onDisconnect: (source, target, port) => {
        // 启用目标卡片的输入框
        target.elements.promptInput?.removeAttribute('disabled');
    }
});
```

### 规则触发时机

| 钩子 | 触发时机 | 典型用途 |
|------|---------|---------|
| `onConnect` | 连接建立时 | 初始化状态、禁用控件 |
| `onDisconnect` | 连接断开时 | 恢复状态、启用控件 |
| `onDataChanged` | 数据变化时 | 级联更新、预览刷新 |
| `onRunCompleted` | 运行完成时 | 通知下游、触发后续 |

## 使用示例

### 定义新卡片的契约

```javascript
class MyCard extends BaseCard {
    getType() {
        return 'my-card';
    }

    static getContract() {
        return {
            outputs: [
                {
                    name: 'result',
                    type: 'text',
                    notifyOn: 'onRun'
                },
                {
                    name: 'preview',
                    type: 'image'
                }
            ],
            inputs: [
                {
                    name: 'data',
                    type: 'text',
                    multiple: true,
                    receivePolicy: 'append'
                }
            ]
        };
    }

    getOutput(outputName) {
        if (outputName === 'result') {
            return this.processedResult;
        }
        if (outputName === 'preview') {
            return this.previewImage;
        }
        return null;
    }

    onReceive(type, data, source) {
        if (type === 'text') {
            // 根据 receivePolicy 自动处理
            this._appendData(data);
        }
    }
}
```

### 手动检查兼容性

```javascript
// 在 UI 层连接前检查
const canConnect = CardContract.checkCompatibility(
    sourceCard,
    targetCard,
    targetPort
);

if (canConnect.compatible) {
    ConnectionManager.createConnection(sourcePort, targetPort);
} else {
    showToast(`无法连接：${canConnect.reason}`);
}
```

## 卡片契约汇总

| 卡片 | 输出 | 输入 | 通知时机 |
|------|------|------|---------|
| TextCard | `text` | 无 | 立即 |
| ImageInputCard | `image` | 无 | 立即 |
| AIDrawCard | `image` | `text`, `image` | 运行完成 |
| AgentCard | `text` | `text`, `image` | 运行完成 |
| PreviewCard | `image` | `image` | 立即 |
| DrawingBoardCard | `image` | `image` | 应用后 |
| CompareCard | 无 | `image` × 2 | 无输出 |

## 注意事项

1. **契约必须在静态方法中声明**：这样可以在不实例化卡片的情况下获取契约
2. **类型名称必须一致**：source 的输出类型必须匹配 target 的输入类型
3. **multiple 为 true 时允许多连接**：否则只保留最后一个连接
4. **notifyOn 控制通知时机**：用于防止过早通知不完整数据
5. **规则引擎增强契约**：契约定义了"能不能连"，规则定义了"连接后怎么做"
