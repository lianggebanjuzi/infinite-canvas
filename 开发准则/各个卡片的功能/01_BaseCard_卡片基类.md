# BaseCard（卡片基类）

## 文件路径
`gui\js\cards\BaseCard.js`

## 功能概述
BaseCard 是所有卡片的基类，提供了拖拽、缩放、删除、端口连接、序列化等通用功能。所有自定义卡片都应继承此类或实现相同的接口。

## 核心属性

| 属性名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `id` | string | 自动生成 | 卡片唯一标识符 |
| `x` | number | 指定值 | 卡片左边界坐标 |
| `y` | number | 指定值 | 卡片上边界坐标 |
| `width` | number | 200 | 卡片宽度 |
| `height` | number | 120 | 卡片高度 |
| `minWidth` | number | 100 | 最小宽度限制 |
| `minHeight` | number | 60 | 最小高度限制 |
| `title` | string | '' | 卡片标题 |
| `bg` | string | '#1e1e1e' | 背景颜色 |
| `groupId` | string | null | 所属组 ID |
| `bypass` | boolean | false | 是否绕过组执行 |
| `selected` | boolean | false | 是否被选中 |
| `inputs` | Map | new Map() | 输入端口映射 |
| `outputs` | Map | new Map() | 输出端口映射 |
| `elements` | object | {} | DOM 元素引用 |

## 契约方法（子类必须实现）

### getType()
返回卡片类型标识符，用于工厂创建和契约匹配。
```javascript
getType() {
    return 'your-card-type';
}
```

### static getContract()
返回卡片的输入输出契约声明。
```javascript
static getContract() {
    return {
        outputs: [{ name: 'default', type: 'text' }],
        inputs: [{ name: 'prompt', type: 'text', receivePolicy: 'replace' }]
    };
}
```

### renderContent()
渲染卡片内部内容，返回 HTML 字符串或 DOM 元素。
```javascript
renderContent() {
    return '<div>卡片内容</div>';
}
```

## 核心方法

### createElement()
创建卡片的 DOM 元素，包括标题栏、拖拽手柄、内容区域和端口。

### getOutput(outputName)
获取指定输出端口的数据。
```javascript
getOutput(outputName) {
    return this.outputData[outputName];
}
```

### onReceive(type, data, source)
通用接收方法，处理从上游卡片传来的数据。
- `type`: 数据类型（如 'text', 'image'）
- `data`: 实际数据内容
- `source`: 来源卡片 ID

### onPush(type, data)
通用推送方法，将数据推送给下游卡片。

### notifyDownstream(source)
通知所有下游卡片数据已更新。
```javascript
notifyDownstream(source) {
    this.outputs.forEach((port, portName) => {
        const connections = ConnectionManager.getConnectionsTo(port.id);
        connections.forEach(conn => {
            const targetCard = CardFactory.getInstance(conn.targetCardId);
            if (targetCard) {
                const inputDef = targetCard.constructor.getContract().inputs.find(
                    i => i.name === conn.targetPort
                );
                targetCard.onReceive(inputDef.type, this.getOutput(portName), this.id);
            }
        });
    });
}
```

### serialize()
将卡片数据序列化为 JSON 对象，用于保存。
```javascript
serialize() {
    return {
        id: this.id,
        type: this.getType(),
        x: this.x,
        y: this.y,
        width: this.width,
        height: this.height,
        title: this.title,
        // 子类添加特定数据
    };
}
```

## 生命周期方法

### destroy()
销毁卡片，移除 DOM 元素和所有连接。

### hasLocalUndo() / undo() / redo()
本地撤销/重做接口。子类可覆盖 `hasLocalUndo()` 返回 `true` 来启用本地撤销。

## 拖拽和缩放

卡片支持通过拖拽标题栏移动位置，通过拖拽边框调整大小。缩放时受 `minWidth` 和 `minHeight` 限制。

## 样式结构
```
.card
├── .card-header (标题栏)
│   ├── .card-drag-handle (拖拽手柄)
│   └── .card-title (标题)
├── .card-content (内容区域)
└── .card-ports (端口区域)
    ├── .input-ports (输入端口)
    └── .output-ports (输出端口)
```

## 使用示例

```javascript
class MyCustomCard extends BaseCard {
    constructor(id, x, y, options = {}) {
        super(id, x, y, options);
        this.myData = options.myData || 'default';
    }

    getType() {
        return 'my-custom-card';
    }

    static getContract() {
        return {
            outputs: [{ name: 'result', type: 'text' }],
            inputs: [{ name: 'input', type: 'text' }]
        };
    }

    renderContent() {
        return `<div class="my-card">${this.myData}</div>`;
    }

    getOutput(outputName) {
        if (outputName === 'result') {
            return this.processedData;
        }
        return null;
    }
}
```

## 注意事项

1. 子类必须实现 `getType()` 和 `renderContent()` 方法
2. 建议声明 `static getContract()` 返回输入输出契约
3. 实现 `getOutput()` 方法提供输出数据
4. 复杂操作应使用异步方式避免阻塞 UI
5. 销毁时应清理所有事件监听器和定时器
