# CardFactory 和 CardEventBus（卡片工厂与事件总线）

## 文件路径
- `gui\js\cards\CardFactory.js`
- `gui\js\cards\CardEventBus.js`

---

## Part 1: CardFactory（卡片工厂）

### 功能概述
CardFactory 是卡片的统一创建、销毁和管理入口。它负责实例化各种类型的卡片，维护卡片注册表，并提供查询和管理功能。

### 核心职责

```
┌────────────────────────────────────────────────────┐
│                  CardFactory                        │
├────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐  ┌──────────┐         │
│  │ TextCard │  │AIDrawCard│  │AgentCard │  ...   │
│  └──────────┘  └──────────┘  └──────────┘         │
│                                                    │
│  ┌─────────────────────────────────────────────┐  │
│  │ 卡片注册表 (type → constructor 映射)          │  │
│  └─────────────────────────────────────────────┘  │
│                                                    │
│  ┌─────────────────────────────────────────────┐  │
│  │ 实例管理 (cardId → instance 映射)             │  │
│  └─────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────┘
```

### 注册机制

```javascript
// 内部维护的注册表
const _registry = {
    'text': TextCard,
    'image': ImageInputCard,
    'ai-image': AIDrawCard,
    'agent': AgentCard,
    'preview': PreviewCard,
    'drawing-board': DrawingBoardCard,
    'compare': CompareCard
};
```

### 核心方法

#### create(type, options, saveHistory)
创建新卡片实例。

```javascript
// 基础创建
const card = CardFactory.create('text', {
    x: 100,
    y: 200,
    width: 200,
    height: 120
});

// 完整参数
const card = CardFactory.create('agent', {
    x: 100,
    y: 200,
    width: 460,
    height: 520,
    agentConfig: {
        model: 'gpt-4o',
        metaPrompt: '',
        userInput: ''
    }
}, true); // saveHistory = true
```

#### createAtPos(type)
在右键菜单位置创建卡片。

```javascript
// 获取右键菜单位置
const pos = ContextMenu.getPosition();

// 在该位置创建卡片
const card = CardFactory.createAtPos('ai-image');
```

#### triggerImageUpload(cardId)
触发图片上传对话框。

```javascript
CardFactory.triggerImageUpload('card-123');
// 创建 ImageInputCard 后立即打开文件选择器
```

#### deleteSelected()
删除所有选中的卡片。

```javascript
CardFactory.deleteSelected();
```

#### deselectAll()
取消所有卡片的选中状态。

```javascript
CardFactory.deselectAll();
```

#### getInstance(cardId)
通过 ID 获取卡片实例。

```javascript
const card = CardFactory.getInstance('card-123');
if (card) {
    card.notifyDownstream();
}
```

#### getAllInstances()
获取所有卡片实例。

```javascript
const allCards = CardFactory.getAllInstances();
allCards.forEach(card => {
    console.log(`${card.id}: ${card.getType()}`);
});
```

#### clearAll()
清除并销毁所有卡片。

```javascript
CardFactory.clearAll();
// 通常用于重置画布或新建项目
```

### 静态工具方法

```javascript
// 生成唯一 ID
CardFactory._generateId();  // 返回 'card-' + timestamp + random

// 获取下一个创建位置（瀑布式排列）
CardFactory._getNextPosition();  // 返回 { x, y }

// 从序列化数据恢复卡片
CardFactory.deserialize(data);
```

---

## Part 2: CardEventBus（卡片事件总线）

### 功能概述
CardEventBus 是卡片之间的通信中枢，采用发布-订阅模式。所有卡片通过事件总线进行解耦通信，避免卡片之间的直接依赖。

### 设计模式

```
┌──────────────────────────────────────────────────────────┐
│                      Event Bus                           │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ┌─────────┐         ┌─────────┐         ┌─────────┐   │
│  │ Card A  │ ──emit──│         │──subscribe──│ Card C │   │
│  └─────────┘         │         │         └─────────┘   │
│                      │  Event  │                        │
│  ┌─────────┐         │  Bus    │         ┌─────────┐   │
│  │ Card B  │ ──emit──│         │──subscribe──│ Card D │   │
│  └─────────┘         └─────────┘         └─────────┘   │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### 事件类型

| 事件类型 | 说明 | 典型用途 |
|---------|------|---------|
| `DATA_CHANGED` | 数据变化 | 卡片数据更新后通知 |
| `RUN_STARTED` | 运行开始 | 显示加载状态 |
| `RUN_COMPLETED` | 运行完成 | 更新 UI，通知下游 |
| `CONNECTED` | 连接建立 | 初始化连接状态 |
| `DISCONNECTED` | 连接断开 | 清理连接状态 |

### 事件载荷结构

```javascript
// DATA_CHANGED 事件
{
    type: 'DATA_CHANGED',
    cardId: 'card-123',
    portName: 'default',
    data: '内容...',
    timestamp: 1699999999999
}

// RUN_STARTED 事件
{
    type: 'RUN_STARTED',
    cardId: 'card-123',
    cardType: 'ai-image'
}

// RUN_COMPLETED 事件
{
    type: 'RUN_COMPLETED',
    cardId: 'card-123',
    cardType: 'ai-image',
    output: { ... }
}

// CONNECTED 事件
{
    type: 'CONNECTED',
    sourceCardId: 'card-1',
    targetCardId: 'card-2',
    sourcePort: 'default',
    targetPort: 'prompt'
}

// DISCONNECTED 事件
{
    type: 'DISCONNECTED',
    sourceCardId: 'card-1',
    targetCardId: 'card-2'
}
```

### 核心方法

#### subscribe(eventType, callback, filter)
订阅事件。

```javascript
// 订阅所有 DATA_CHANGED 事件
const unsub1 = CardEventBus.subscribe('DATA_CHANGED', (event) => {
    console.log('数据变化:', event.data);
});

// 订阅特定卡片的事件
const unsub2 = CardEventBus.subscribe('RUN_COMPLETED', (event) => {
    console.log('卡片运行完成:', event.cardId);
}, {
    cardId: 'card-123'  // 只接收来自此卡片的事件
});

// 按类型过滤
const unsub3 = CardEventBus.subscribe('DATA_CHANGED', (event) => {
    console.log('收到图片数据');
}, {
    dataType: 'image'
});
```

#### emit(eventType, payload)
发布事件。

```javascript
// 发布简单事件
CardEventBus.emit('RUN_STARTED', {
    cardId: 'card-123',
    cardType: 'agent'
});

// 发布带数据的复杂事件
CardEventBus.emit('DATA_CHANGED', {
    cardId: 'card-123',
    portName: 'default',
    data: imageData,
    dataType: 'image',
    timestamp: Date.now()
});
```

#### byType(outputType)
返回按输出类型过滤的辅助函数。

```javascript
// 订阅所有 image 类型的数据变化
const unsub = CardEventBus.byType('image').subscribe((event) => {
    console.log('收到图片:', event.data);
});
```

#### byCard(cardId)
返回按卡片 ID 过滤的辅助函数。

```javascript
// 订阅特定卡片的所有事件
const unsub = CardEventBus.byCard('card-123').subscribe((event) => {
    console.log('Card-123 事件:', event.type);
});
```

### 订阅过滤器

```javascript
// 按卡片 ID 过滤
CardEventBus.subscribe('DATA_CHANGED', handler, {
    cardId: 'card-123'
});

// 按输出类型过滤
CardEventBus.subscribe('DATA_CHANGED', handler, {
    dataType: 'text'
});

// 按端口名称过滤
CardEventBus.subscribe('DATA_CHANGED', handler, {
    portName: 'default'
});

// 组合过滤
CardEventBus.subscribe('DATA_CHANGED', handler, {
    cardId: 'card-123',
    dataType: 'image',
    portName: 'preview'
});
```

### 取消订阅

```javascript
// 返回取消函数
const unsubscribe = CardEventBus.subscribe('DATA_CHANGED', handler);

// 取消订阅
unsubscribe();

// 或者批量取消
unsubscribe();  // 直接调用返回的函数
```

---

## 协作流程示例

### 场景：TextCard → AIDrawCard → PreviewCard

```
1. TextCard 用户输入文本
   ↓ CardEventBus.emit('DATA_CHANGED', { cardId, portName, data })
   ↓
2. AIDrawCard 接收数据，填充 prompt
   ↓ CardEventBus.emit('DATA_CHANGED', { ... })
   ↓
3. AIDrawCard 用户点击生成
   ↓ CardEventBus.emit('RUN_STARTED', { ... })
   ↓ 后端处理...
   ↓ CardEventBus.emit('RUN_COMPLETED', { ... })
   ↓
4. AIDrawCard.notifyDownstream()
   ↓ CardEventBus.emit('DATA_CHANGED', { cardId, portName, data: image })
   ↓
5. PreviewCard 接收图片并显示
```

### 代码实现

```javascript
// TextCard.js
onInputChange(value) {
    this.textContent = value;

    // 通过事件总线通知（也可以直接调用）
    CardEventBus.emit('DATA_CHANGED', {
        cardId: this.id,
        portName: 'default',
        data: value,
        dataType: 'text'
    });

    // 同时触发推送
    this.notifyDownstream(this.id);
}

// AIDrawCard.js
// 在某处订阅 TextCard 的变化
CardEventBus.subscribe('DATA_CHANGED', (event) => {
    if (event.portName === 'default' && event.dataType === 'text') {
        this.setPrompt(event.data);
    }
}, { cardId: 'text-card-id' });

// 生成完成后
static generate(cardId) {
    CardEventBus.emit('RUN_STARTED', {
        cardId,
        cardType: 'ai-image'
    });

    // 调用后端 API...

    CardEventBus.emit('RUN_COMPLETED', {
        cardId,
        cardType: 'ai-image',
        output: generatedImage
    });

    // 通知下游
    this.notifyDownstream(cardId);
}
```

---

## 最佳实践

### 1. 使用事件总线解耦

```javascript
// 避免直接调用
// cardB.onReceive(cardA.getOutput('default'));

// 改用事件总线
CardEventBus.emit('DATA_CHANGED', {
    cardId: 'cardA',
    portName: 'default',
    data: cardA.getOutput('default'),
    dataType: 'text'
});
```

### 2. 合理使用过滤器

```javascript
// 精确订阅需要的消息
CardEventBus.subscribe('RUN_COMPLETED', handler, {
    cardId: myId,
    dataType: 'image'
});
```

### 3. 记得取消订阅

```javascript
// 在卡片销毁时取消订阅
destroy() {
    if (this._unsubscribers) {
        this._unsubscribers.forEach(fn => fn());
    }
    super.destroy();
}
```

### 4. 使用静态方法创建

```javascript
// 通过工厂创建，而不是 new
const card = CardFactory.create('agent', { x, y });

// 通过 ID 获取实例
const card = CardFactory.getInstance('card-123');
```

---

## 注意事项

1. **CardFactory 维护单例实例**：不要手动 `new Card()`
2. **CardEventBus 自动管理订阅**：使用返回的取消函数清理
3. **类型注册是预定义的**：添加新卡片需要在工厂注册
4. **事件是同步的**：不保证订阅者的执行顺序
5. **循环事件可能导致死循环**：注意避免 card A → card B → card A 的循环
