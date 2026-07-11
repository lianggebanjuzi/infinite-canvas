# DrawingBoardCard（画板卡片）

## 文件路径
`gui\js\cards\DrawingBoardCard.js`

## 功能概述
DrawingBoardCard 是一个功能完整的绘画卡片，提供专业级的绘图能力。它支持多图层管理、多种绘画工具、缩放平移操作，以及完整的本地撤销/重做功能。用户可以导入外部图片作为图层，进行叠加编辑后导出为 PNG 图片。

## 核心特性

- **多图层管理**：创建、删除、切换图层
- **多种绘画工具**：画笔、橡皮擦、选择、文字
- **画笔设置**：大小、硬度、颜色、透明度
- **缩放平移**：滚轮缩放、中键平移
- **本地撤销/重做**：完全独立于全局历史
- **图片导入**：接收外部图片作为图层
- **画布尺寸调整**：可设置画布大小

## 卡片信息

| 属性 | 值 |
|------|-----|
| 卡片类型标识 | `drawing-board` |
| 默认尺寸 | 800px × 600px |
| 最小尺寸 | 400px × 300px |
| 继承自 | BaseCard |
| 本地撤销/重做 | 支持 |

## 契约声明

```javascript
static getContract() {
    return {
        outputs: [{ name: 'default', type: 'image', notifyOn: 'onApply' }],
        inputs: [{ name: 'image', type: 'image', multiple: true, receivePolicy: 'append' }]
    };
}
```

| 端口类型 | 端口名称 | 数据类型 | 接收策略 | 说明 |
|---------|---------|---------|---------|------|
| 输出 | `default` | `image` | - | 导出图片（仅在应用后通知） |
| 输入 | `image` | `image` | append | 接收图片作为图层 |

---

## 内部类结构

DrawingBoardCard 由多个内部类组成，各司其职：

```
DrawingBoardCard
├── DrawingBoardToolManager (工具管理)
├── DrawingBoardLayerManager (图层管理)
├── DrawingBoardViewController (视图控制)
├── DrawingBoardHistoryManager (历史管理)
├── DrawingBoardRenderer (渲染器)
└── DrawingBoardInputHandler (输入处理)
```

---

## DrawingBoardToolManager（工具管理器）

### 工具类型

| 工具 | 说明 | 快捷键 |
|------|------|--------|
| `pan` | 平移画布 | H / 空格+拖拽 |
| `select` | 选择和移动 | V |
| `brush` | 画笔绘制 | B |
| `eraser` | 橡皮擦 | E |
| `text` | 文字输入 | T |

### 画笔设置

| 属性 | 类型 | 说明 |
|------|------|------|
| `size` | number | 画笔大小 (1-100) |
| `hardness` | number | 边缘硬度 (0-100) |
| `color` | string | 颜色 (如 #FF5733) |
| `opacity` | number | 透明度 (0-100) |

### 橡皮擦设置

| 属性 | 类型 | 说明 |
|------|------|------|
| `size` | number | 橡皮擦大小 (1-100) |

### 文字设置

| 属性 | 类型 | 说明 |
|------|------|------|
| `fontSize` | number | 字体大小 |
| `color` | string | 文字颜色 |
| `fontFamily` | string | 字体系列 |

### 核心方法

```javascript
setTool(toolName)           // 切换工具
updateBrushSetting(prop, value)  // 更新画笔属性
updateEraserSetting(prop, value) // 更新橡皮擦属性
updateTextSetting(prop, value)   // 更新文字属性
```

---

## DrawingBoardLayerManager（图层管理器）

### 核心属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `layers` | array | 图层列表 |
| `activeLayerIndex` | number | 当前激活图层索引 |
| `imageLayerData` | array | 图片图层数据 |

### 核心方法

```javascript
createLayer()                // 创建新图层
deleteLayer(index)          // 删除图层
toggleVisibility(index)    // 切换图层可见性
toggleLock(index)           // 切换图层锁定
swapLayers(fromIndex, toIndex)  // 交换图层顺序
setOpacity(index, opacity)   // 设置图层透明度
setImageLayers(imageArray)   // 设置图片图层
getImage()                   // 导出合并后的图片
preloadImages()             // 预加载图片资源
```

### 图层数据结构

```javascript
{
    id: 'layer-uuid',
    name: 'Layer 1',
    visible: true,
    locked: false,
    opacity: 1.0,
    canvas: OffscreenCanvas   // 图层的画布
}
```

---

## DrawingBoardViewController（视图控制器）

### 缩放控制

| 属性 | 默认值 | 范围 | 说明 |
|------|--------|------|------|
| `zoom` | 1.0 | 0.25 - 4.0 | 当前缩放级别 |
| `panX` | 0 | - | 水平平移量 |
| `panY` | 0 | - | 垂直平移量 |

### 核心方法

```javascript
zoomAtPoint(delta, x, y)     // 以某点为中心缩放
zoomCenter(newZoom)          // 以画布中心缩放
zoomAtMouse(delta, mouseX, mouseY)  // 以鼠标位置缩放
startPan(mouseX, mouseY)     // 开始平移
updatePan(mouseX, mouseY)    // 更新平移
endPan()                     // 结束平移
fitToWindow()                // 自动适应窗口
screenToCanvas(screenX, screenY)  // 屏幕坐标转画布坐标
canvasToScreen(canvasX, canvasY)  // 画布坐标转屏幕坐标
```

### 缩放操作

- **滚轮缩放**：以鼠标位置为中心
- **Ctrl+0**：重置为 100%
- **Ctrl++**：放大
- **Ctrl+-**：缩小
- **Ctrl+1**：适应窗口

---

## DrawingBoardHistoryManager（历史管理器）

### 核心方法

```javascript
save()                       // 保存当前状态
undo()                       // 撤销
redo()                       // 重做
canUndo()                    // 是否可撤销
canRedo()                    // 是否可重做
clear()                      // 清空历史
```

### 特性

- `_justRestored` 标记：阻止撤销时触发上游刷新
- 最大历史记录数：50 条
- 保存整个图层栈的状态

---

## DrawingBoardRenderer（渲染器）

### 核心方法

```javascript
render()                     // 执行完整渲染
requestRender()             // 请求渲染（防抖）
syncDrawingLayerFromLayer()  // 同步绘制图层
getDrawingLayerCtx()        // 获取绘制图层上下文
_drawPath(ctx, path)        // 绘制路径
_drawSelectionHandles(ctx)  // 绘制选择框手柄
```

### 渲染流程

1. 清空画布
2. 绘制所有可见图层
3. 绘制选择框（如有）
4. 显示当前工具指示器

---

## DrawingBoardInputHandler（输入处理器）

### 处理的输入事件

| 事件 | 操作 |
|------|------|
| 鼠标按下 | 开始绘制/选择/平移 |
| 鼠标移动 | 绘制/移动选择 |
| 鼠标释放 | 结束绘制/选择 |
| 滚轮 | 缩放画布 |
| 中键拖拽 | 平移画布 |

### 状态机

```
idle → drawing (按下) → idle (释放)
     → selecting (按下) → idle (释放)
     → panning (中键按下) → idle (中键释放)
```

---

## 卡片属性

| 属性名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `canvasConfig` | object | `{ width: 1024, height: 1024 }` | 画布配置 |
| `_toolManager` | DrawingBoardToolManager | 新实例 | 工具管理器 |
| `_layerManager` | DrawingBoardLayerManager | 新实例 | 图层管理器 |
| `_viewController` | DrawingBoardViewController | 新实例 | 视图控制器 |
| `_historyManager` | DrawingBoardHistoryManager | 新实例 | 历史管理器 |
| `_renderer` | DrawingBoardRenderer | 新实例 | 渲染器 |
| `_inputHandler` | DrawingBoardInputHandler | 新实例 | 输入处理器 |

---

## 核心方法

### getOutput(outputName)
导出画布为 PNG 图片。
```javascript
getOutput(outputName) {
    if (outputName === 'default') {
        return this._layerManager.getImage();
    }
    return null;
}
```

### notifyDownstream(source)
应用后通知下游。
```javascript
notifyDownstream(source) {
    if (source !== 'apply') return;  // 仅在应用时通知
    super.notifyDownstream(this.id);
}
```

### onReceive(type, data, source)
接收上游图片并添加为图层。
```javascript
onReceive(type, data, source) {
    if (type === 'image' && data) {
        this._addImageLayer(data);
    }
}
```

### _addImageLayer(imageData)
添加图片图层。
```javascript
_addImageLayer(imageData) {
    // 创建新的图片图层
    // 加载图片并绘制到图层
    // 自动调整画布尺寸
}
```

### _ensureCanvasFitsImage(layer, img)
自动调整画布尺寸以适应图片。
```javascript
_ensureCanvasFitsImage(layer, img) {
    if (img.width > this.canvasConfig.width) {
        this.canvasConfig.width = img.width;
    }
    if (img.height > this.canvasConfig.height) {
        this.canvasConfig.height = img.height;
    }
}
```

### hasLocalUndo()
返回 true，支持本地撤销/重做。
```javascript
hasLocalUndo() {
    return true;
}
```

### undo() / redo()
本地撤销/重做。
```javascript
undo() {
    this._historyManager.undo();
}

redo() {
    this._historyManager.redo();
}
```

---

## 静态方法

### _addLayer(cardId)
添加新图层。
```javascript
static _addLayer(cardId) {
    const card = CardFactory.getInstance(cardId);
    if (card) {
        card._layerManager.createLayer();
    }
}
```

### apply(cardId)
应用当前状态并通知下游。
```javascript
static apply(cardId) {
    const card = CardFactory.getInstance(cardId);
    if (card) {
        card.saveHistory?.();
        card.notifyDownstream('apply');
    }
}
```

### _showCanvasSizeDialog(cardId)
显示画布尺寸设置对话框。
```javascript
static _showCanvasSizeDialog(cardId) {
    // 弹出对话框设置画布宽度和高度
}
```

---

## 工具栏 UI 结构

```html
<div class="toolbar">
    <!-- 工具选择 -->
    <div class="tool-group">
        <button class="tool-btn" data-tool="pan" title="平移 (H)">
            <span class="icon">✋</span>
        </button>
        <button class="tool-btn" data-tool="select" title="选择 (V)">
            <span class="icon">⬚</span>
        </button>
        <button class="tool-btn" data-tool="brush" title="画笔 (B)">
            <span class="icon">🖌</span>
        </button>
        <button class="tool-btn" data-tool="eraser" title="橡皮擦 (E)">
            <span class="icon">⬜</span>
        </button>
        <button class="tool-btn" data-tool="text" title="文字 (T)">
            <span class="icon">T</span>
        </button>
    </div>

    <!-- 画笔设置 -->
    <div class="brush-settings">
        <input type="range" class="size-slider" min="1" max="100" />
        <input type="color" class="color-picker" />
    </div>

    <!-- 图层 -->
    <div class="layer-panel">
        <div class="layer-list"></div>
        <button class="add-layer-btn">+ 图层</button>
    </div>

    <!-- 操作 -->
    <div class="actions">
        <button class="apply-btn">应用</button>
        <button class="undo-btn">撤销</button>
        <button class="redo-btn">重做</button>
    </div>
</div>
```

---

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| H | 平移工具 |
| V | 选择工具 |
| B | 画笔工具 |
| E | 橡皮擦工具 |
| T | 文字工具 |
| Space + 拖拽 | 临时平移 |
| Ctrl + Z | 撤销 |
| Ctrl + Shift + Z | 重做 |
| Ctrl + S | 应用并导出 |
| Ctrl + 0 | 重置缩放 |
| Ctrl + +/- | 缩放 |
| Delete | 删除选中 |
| ESC | 取消选择 |

---

## 数据流转

```
ImageInputCard 输出 (image) ─→ DrawingBoardCard 输入
AIDrawCard 输出 (image) ─→ DrawingBoardCard 输入
        ↓
        [用户编辑]
        ↓
        [点击应用]
        ↓
DrawingBoardCard 输出 (image) ─→ PreviewCard
        ↓
        └─→ CompareCard
        ↓
        └─→ 其他卡片
```

---

## 使用场景

1. **图片叠加编辑**：导入多张图片进行叠加混合
2. **AI 结果精修**：对 AI 生成的图片进行局部调整
3. **素材合成**：将多个素材合成一张图片
4. **蒙版绘制**：配合遮罩进行局部修改
5. **批注添加**：在图片上添加文字或标记

---

## 注意事项

1. 画布默认尺寸 1024×1024，可根据需要调整
2. 撤销/重做完全在卡片内部进行，不影响全局历史
3. 上游图片会自动添加为新图层
4. 应用后才会通知下游，否则图片可能不完整
5. 支持最多 20 个图层
6. 图片导出格式为 PNG（透明背景）
