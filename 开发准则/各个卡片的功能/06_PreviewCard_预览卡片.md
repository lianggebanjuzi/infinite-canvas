# PreviewCard（预览卡片）

## 文件路径
`gui\js\cards\PreviewCard.js`

## 功能概述
PreviewCard 是一个用于显示图片的预览卡片，接收来自其他卡片（如 AI 绘图卡片、图片输入卡片等）的图片数据，并提供大图查看和下载功能。它是工作流中的重要输出节点，用于展示处理结果。

## 核心特性

- 接收并显示图片
- 支持大图全屏查看
- 图片下载功能
- 优化渲染和存储
- 自动识别本地文件和网络图片
- 支持图片元数据显示

## 卡片信息

| 属性 | 值 |
|------|-----|
| 卡片类型标识 | `preview` |
| 默认尺寸 | 400px × 300px |
| 最小尺寸 | 200px × 150px |
| 继承自 | BaseCard |

## 契约声明

```javascript
static getContract() {
    return {
        outputs: [{ name: 'default', type: 'image' }],
        inputs: [{ name: 'default', type: 'image' }]
    };
}
```

| 端口类型 | 端口名称 | 数据类型 | 说明 |
|---------|---------|---------|------|
| 输出 | `default` | `image` | 输出图片内容 |
| 输入 | `default` | `image` | 接收图片输入 |

## 核心属性

| 属性名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `content` | string | null | 图片内容（base64 或 URL） |
| `thumbnail` | string | null | 缩略图（可选） |
| `imageMeta` | object | null | 图片元数据 |
| `_displayDataUrl` | string | null | 缓存的显示用 data URL |
| `_pendingSrc` | string | null | 待处理的图片源 |
| `_isRendering` | boolean | false | 渲染锁，防止重复渲染 |

### imageMeta 元数据结构

```javascript
{
    width: 1024,           // 图片宽度
    height: 1024,          // 图片高度
    aspectRatio: '1:1',   // 宽高比
    size: 1024000,         // 文件大小（字节）
    format: 'png'          // 图片格式
}
```

## 核心方法

### getOutput(outputName)
获取输出端口的图片数据。
```javascript
getOutput(outputName) {
    if (outputName === 'default') {
        return this.content;
    }
    return null;
}
```

### setImage(src, meta)
设置图片（优化渲染和存储）。
```javascript
setImage(src, meta) {
    this._pendingSrc = src;

    if (meta) {
        this.imageMeta = meta;
    }

    this._renderImage(src, meta);
    this.notifyDownstream(this.id);
}
```

### _loadFromLocalPath(filePath)
从本地文件路径加载图片。
```javascript
_loadFromLocalPath(filePath) {
    // 将本地路径转换为 file:// URL
    // 触发 _renderImage 进行渲染
}
```

### _renderImage(src, meta)
渲染图片到卡片中。
```javascript
_renderImage(src, meta) {
    if (this._isRendering) return;
    this._isRendering = true;

    if (src.startsWith('data:') || src.startsWith('http')) {
        // 直接使用 base64 或网络 URL
        this.content = src;
    } else if (this._isLocalFile(src)) {
        // 处理本地文件
        this.content = 'file://' + src;
    }

    this._isRendering = false;
}
```

### _isLocalFile(path)
判断是否为本地文件路径。
```javascript
_isLocalFile(path) {
    if (!path) return false;
    if (path.startsWith('data:')) return false;
    if (path.startsWith('http')) return false;

    const ext = path.split('.').pop()?.toLowerCase();
    return ext && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext);
}
```

### _showFullImage()
显示大图全屏查看。
```javascript
_showFullImage() {
    // 创建全屏预览模态框
    // 显示高清原图
    // 支持 ESC 关闭
}
```

## 静态方法

### downloadAs(cardId)
下载卡片中的图片。
```javascript
static downloadAs(cardId) {
    const card = CardFactory.getInstance(cardId);
    if (card && card.content) {
        // 调用后端 API 触发下载
    }
}
```

## 渲染结构

```html
<div class="card-content preview-card">
    <!-- 图片显示区域 -->
    <div class="preview-container">
        <img class="preview-image" src="..." alt="Preview" />
        <!-- 悬停显示操作按钮 -->
        <div class="preview-overlay">
            <button class="fullscreen-btn">全屏</button>
            <button class="download-btn">下载</button>
        </div>
    </div>

    <!-- 元数据显示 -->
    <div class="image-meta">
        <span class="meta-size">1024 × 1024</span>
        <span class="meta-format">PNG</span>
    </div>
</div>
```

## 样式特点

- 图片自适应卡片尺寸
- 鼠标悬停时显示操作按钮
- 元数据小字显示在底部
- 支持图片居中裁剪或完整显示
- 全屏预览使用模态框

## 大图查看功能

点击卡片或全屏按钮可进入大图查看模式：

- 模态框全屏显示高清图片
- 支持键盘 ESC 关闭
- 图片保持原始比例
- 可以拖拽查看不同区域

## 图片来源识别

卡片会自动识别图片来源类型：

| 来源类型 | 示例 | 处理方式 |
|---------|------|---------|
| Base64 | `data:image/png;base64,...` | 直接使用 |
| 网络 URL | `https://example.com/...` | 直接使用 |
| 本地路径 | `C:\Images\test.png` | 转换为 `file://` URL |

## 使用场景

1. **结果展示**：显示 AI 生成的图片
2. **流程终点**：作为工作流的最终输出节点
3. **中间预览**：在处理过程中查看中间结果
4. **对比参考**：配合对比卡片进行效果对比

## 数据流转

```
ImageInputCard 输出 (image) ─→ PreviewCard 输入
AIDrawCard 输出 (image) ─→ PreviewCard 输入
DrawingBoardCard 输出 (image) ─→ PreviewCard 输入
CompareCard ─×─ 不输出 ─×─

PreviewCard 输出 (image) ─→ 其他卡片继续处理
```

## 与其他卡片的配合

| 来源卡片 | 连接效果 |
|---------|---------|
| ImageInputCard | 显示上传的图片 |
| AIDrawCard | 显示生成的图片 |
| DrawingBoardCard | 显示画板导出的图片 |
| AgentCard | 预览 Agent 生成的图片（如有） |

## 注意事项

1. 接收图片后会自动渲染显示
2. 下载功能依赖后端 API
3. 大图查看模式会加载高清原图
4. 渲染时使用锁机制防止重复操作
5. 本地图片会自动添加 `file://` 协议前缀
6. 支持的图片格式：PNG、JPEG、GIF、WebP、BMP
