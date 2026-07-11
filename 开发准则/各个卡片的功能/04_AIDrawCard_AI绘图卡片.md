# AIDrawCard（AI 绘图卡片）

## 文件路径
`gui\js\cards\AIDrawCard.js`

## 功能概述
AIDrawCard 是调用 AI 生成图片的核心卡片，支持文本提示词生成图片、参考图控制、多图批量生成等功能。用户可以配置模型、宽高比、分辨率等参数，生成后的图片会自动推送给下游卡片。

## 核心特性

- 文本提示词生成图片
- 支持参考图控制（最多 10 张）
- 多图批量生成
- 可配置模型、宽高比、分辨率
- 支持遮罩（Mask）数据存储
- 错误图片生成（生成失败时显示错误提示）

## 卡片信息

| 属性 | 值 |
|------|-----|
| 卡片类型标识 | `ai-image` |
| 默认尺寸 | 500px × 480px |
| 最小尺寸 | 400px × 400px |
| 继承自 | BaseCard |

## 契约声明

```javascript
static getContract() {
    return {
        outputs: [{ name: 'default', type: 'image', notifyOn: 'onRun' }],
        inputs: [
            { name: 'prompt', type: 'text', receivePolicy: 'replace' },
            { name: 'reference', type: 'image', multiple: true, receivePolicy: 'append' }
        ]
    };
}
```

| 端口类型 | 端口名称 | 数据类型 | 接收策略 | 说明 |
|---------|---------|---------|---------|------|
| 输出 | `default` | `image` | - | 生成的图片（仅在运行时通知） |
| 输入 | `prompt` | `text` | replace | 提示词输入 |
| 输入 | `reference` | `image` | append | 参考图输入（支持多张） |

## 核心属性

| 属性名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `prompt` | string | '' | 提示词文本 |
| `aiConfig` | object | `{}` | AI 配置对象 |
| `_maskStore` | Map | new Map() | 遮罩存储 Map |
| `generatedImages` | array | `[]` | 生成的图片数组 |
| `model` | string | '' | 当前选中的模型 ID |
| `aspectRatio` | string | '' | 宽高比 |
| `resolution` | string | '' | 分辨率 |
| `count` | number | 1 | 生成数量 |

### aiConfig 配置对象结构

```javascript
{
    model: 'stable-diffusion-xl-base-1.0',  // 模型 ID
    aspectRatio: '1:1',                      // 宽高比 (1:1, 16:9, 9:16, 4:3, 3:4)
    resolution: '1024x1024',                 // 分辨率
    count: 1,                                // 生成数量
    generatedImages: []                      // 生成的图片数据
}
```

## 核心方法

### getInput(inputName)
根据契约获取输入数据。
```javascript
getInput(inputName) {
    if (inputName === 'prompt') {
        return this.prompt;
    }
    if (inputName === 'reference') {
        return Array.from(this._refImages.values());
    }
    return null;
}
```

### addRefImage(src, sourceCardId)
添加参考图（最多 10 张）。
```javascript
addRefImage(src, sourceCardId) {
    if (this._refImages.size >= 10) return false;
    this._refImages.set(sourceCardId, src);
    this.refreshUpstream();
    return true;
}
```

### removeRefImage(sourceCardId)
移除参考图。
```javascript
removeRefImage(sourceCardId) {
    this._refImages.delete(sourceCardId);
    this.refreshUpstream();
}
```

### updateUpstreamTextHint()
更新上游文本提示，显示连接状态。
```javascript
updateUpstreamTextHint() {
    // 显示上游提示词连接状态
}
```

### updateParam(paramType, value, displayText)
更新参数。
```javascript
updateParam(paramType, value, displayText) {
    // paramType: 'model', 'aspectRatio', 'resolution', 'count'
    this.aiConfig[paramType] = value;
    this._updateParamDisplay(paramType, displayText);
}
```

### refreshUpstream()
刷新上游参考图显示。
```javascript
refreshUpstream() {
    // 更新参考图缩略图区域
}
```

## 静态方法

### showParamMenu(event, cardId, paramType)
显示参数选择菜单。
```javascript
static showParamMenu(event, cardId, paramType) {
    // 显示模型、宽高比、分辨率等选择菜单
}
```

### generate(cardId)
启动图片生成。
```javascript
static generate(cardId) {
    const card = CardFactory.getInstance(cardId);
    if (!card) return;

    // 调用后端 API 生成图片
    // 生成完成后设置生成的图片
}
```

### _getImageModels()
获取可用的绘图模型列表。
```javascript
static _getImageModels() {
    // 返回模型列表 [{ id, name, description }]
}
```

### _generateErrorImage(errorMessage)
生成错误提示图片。
```javascript
static _generateErrorImage(errorMessage) {
    // 返回一个包含错误信息的 base64 图片
}
```

## UI 结构

```html
<div class="card-content ai-draw-card">
    <!-- 提示词区域 -->
    <div class="prompt-section">
        <textarea class="prompt-input" placeholder="描述你想要生成的图片..."></textarea>
        <div class="prompt-source-hint"></div>
    </div>

    <!-- 参数配置区域 -->
    <div class="params-section">
        <div class="param-row">
            <label>模型</label>
            <button class="param-btn" data-param="model">选择模型</button>
        </div>
        <div class="param-row">
            <label>尺寸</label>
            <button class="param-btn" data-param="aspectRatio">1:1</button>
            <button class="param-btn" data-param="resolution">1024×1024</button>
        </div>
        <div class="param-row">
            <label>数量</label>
            <button class="param-btn" data-param="count">1</button>
        </div>
    </div>

    <!-- 参考图区域 -->
    <div class="reference-section">
        <div class="ref-images-grid"></div>
        <div class="upstream-hint"></div>
    </div>

    <!-- 生成按钮 -->
    <button class="generate-btn">Generate</button>

    <!-- 生成结果预览 -->
    <div class="result-preview"></div>
</div>
```

## 样式特点

- 紧凑的参数按钮布局
- 参考图以网格形式显示缩略图
- 生成按钮醒目突出
- 结果预览区域动态显示
- 支持展开/折叠参数面板

## 支持的模型类型

卡片会从后端获取可用的绘图模型列表，常见模型包括：

- Stable Diffusion XL Base
- Stable Diffusion XL Lightning
- SDXL ControlNet
- 其他社区模型

## 支持的宽高比

| 比例 | 说明 |
|------|------|
| `1:1` | 正方形 |
| `16:9` | 宽屏 |
| `9:16` | 竖屏 |
| `4:3` | 标准 4:3 |
| `3:4` | 竖向 4:3 |

## 支持的分辨率

| 分辨率 | 适用场景 |
|--------|---------|
| `512×512` | 快速预览 |
| `768×768` | 平衡质量 |
| `1024×1024` | 高质量输出 |
| `1024×1792` | 竖向人像 |
| `1792×1024` | 横向风景 |

## 生成数量

支持 1-4 张图片批量生成。

## 使用场景

1. **文生图**：使用文本提示词生成图片
2. **图生图**：配合参考图进行风格迁移或内容控制
3. **批量生成**：一次性生成多张变体进行选择
4. **工作流节点**：作为中间节点连接其他卡片

## 数据流转

```
TextCard 输出 (text)
    ↓
    └─→ AIDrawCard 输入 (prompt)
            ↓
            [调用 AI 生成图片]
            ↓
AIDrawCard 输出 (image) ─→ PreviewCard
            ↓
            └─→ DrawingBoardCard
            ↓
            └─→ CompareCard
```

## 与其他卡片的配合

| 来源卡片 | 连接效果 |
|---------|---------|
| TextCard | 自动填充提示词，启用生成按钮 |
| ImageInputCard | 添加为参考图（最多 10 张） |
| PreviewCard | 显示生成的图片 |
| DrawingBoardCard | 添加生成的图片为图层 |
| CompareCard | 对比生成结果 |

## 注意事项

1. 提示词为空时禁用生成按钮
2. 参考图超过 10 张时不再接受新的连接
3. 生成过程中的错误会显示为错误提示图片
4. 生成的图片会缓存在 `generatedImages` 数组中
5. 支持遮罩数据，用于局部重绘等高级功能
6. 模型列表从后端动态获取
