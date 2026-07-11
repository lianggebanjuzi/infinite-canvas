# ImageInputCard（图片输入卡片）

## 文件路径
`gui\js\cards\ImageInputCard.js`

## 功能概述
ImageInputCard 是一个用于上传和显示图片的卡片，支持点击上传、粘贴图片、拖拽图片等功能。图片可以作为输出传递给其他卡片，如 AI 绘图卡片、预览卡片、对比卡片等。

## 核心特性

- 点击上传图片文件（支持拖拽上传）
- 支持粘贴剪贴板图片
- 自动处理本地文件路径和 base64 图片
- 支持遮罩数据存储
- 图片下载和删除功能

## 卡片信息

| 属性 | 值 |
|------|-----|
| 卡片类型标识 | `image` |
| 默认尺寸 | 240px × 200px |
| 最小尺寸 | 180px × 150px |
| 继承自 | BaseCard |

## 契约声明

```javascript
static getContract() {
    return {
        outputs: [{ name: 'default', type: 'image' }],
        inputs: []
    };
}
```

| 端口类型 | 端口名称 | 数据类型 | 说明 |
|---------|---------|---------|------|
| 输出 | `default` | `image` | 输出图片内容 |
| 输入 | 无 | - | 无输入端口 |

## 核心属性

| 属性名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `content` | string | null | 图片内容（base64 或本地路径） |
| `maskData` | string | null | 遮罩数据 |

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

### setImage(src, keepMask)
设置卡片显示的图片。
```javascript
setImage(src, keepMask = false) {
    this.content = src;
    if (!keepMask) {
        this.maskData = null;
    }
    // 更新显示和遮罩
    this.refreshMaskDisplay();
    this.notifyDownstream(this.id);
}
```

### refreshMaskDisplay()
刷新遮罩显示，处理图片的蒙版效果。
```javascript
refreshMaskDisplay() {
    if (!this.content) return;

    if (this._isLocalFile(this.content)) {
        // 处理本地文件
        const img = new Image();
        img.onload = () => {
            // 显示图片并应用遮罩
        };
        img.src = 'file://' + this.content;
    } else {
        // 处理 base64 图片
    }
}
```

### _isLocalFile(path)
判断给定的路径是否为本地文件路径（非 base64）。
```javascript
_isLocalFile(path) {
    if (!path) return false;
    // base64 以 data: 开头
    if (path.startsWith('data:')) return false;
    // 本地路径包含文件扩展名
    const ext = path.split('.').pop()?.toLowerCase();
    return ext && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext);
}
```

## 静态方法

### _deleteImage(cardId)
删除卡片中的图片。
```javascript
static _deleteImage(cardId) {
    const card = CardFactory.getInstance(cardId);
    if (card) {
        card.content = null;
        card.maskData = null;
        card.notifyDownstream(cardId);
    }
}
```

### downloadAs(cardId)
下载卡片中的图片。
```javascript
static downloadAs(cardId) {
    // 调用后端 API 触发下载
}
```

## 上传交互

### 支持的上传方式

1. **点击上传**：点击卡片中央的上传区域，打开文件选择器
2. **拖拽上传**：将图片文件拖入卡片区域
3. **粘贴上传**：在卡片获得焦点时，按 Ctrl+V 粘贴剪贴板图片

### 支持的图片格式

- PNG
- JPEG / JPG
- GIF
- WebP
- BMP

### 文件大小限制

建议图片大小不超过 10MB，大图片会自动处理。

## 渲染结构

```html
<div class="card-content image-input-card">
    <!-- 无图片时显示上传提示 -->
    <div class="upload-placeholder">
        <span>点击或拖拽上传图片</span>
    </div>

    <!-- 有图片时显示图片 -->
    <div class="image-container">
        <img src="..." alt="Uploaded image" />
        <div class="image-actions">
            <button class="delete-btn">删除</button>
            <button class="download-btn">下载</button>
        </div>
    </div>
</div>
```

## 样式特点

- 卡片中央显示上传/预览区域
- 上传提示图标清晰明确
- 有图片时显示缩略图和操作按钮
- 删除按钮位于图片角落
- 支持图片的轻微放大预览

## 使用场景

1. **参考图输入**：作为 AI 绘图卡片的参考图来源
2. **工作流起点**：导入外部图片进入工作流
3. **对比素材**：为对比卡片提供 A/B 图片
4. **图层素材**：为画板卡片提供图片图层

## 数据流转

```
ImageInputCard 输出 (image)
    ↓
    ├─→ AIDrawCard (作为 reference 参考图)
    ├─→ PreviewCard (显示图片)
    ├─→ CompareCard (作为 A 或 B 图片)
    └─→ DrawingBoardCard (作为图片图层)
```

## 与其他卡片的配合

| 目标卡片 | 连接效果 |
|---------|---------|
| AIDrawCard | 添加为参考图（最多 10 张） |
| PreviewCard | 显示图片内容 |
| CompareCard | 作为 A 端口或 B 端口的图片 |
| DrawingBoardCard | 添加为图片图层 |

## 注意事项

1. 本地图片会自动转换为 file:// 协议路径
2. base64 图片直接存储和传递
3. 图片更改后会立即通知下游
4. 支持遮罩数据，可用于局部编辑场景
5. 删除图片会清空遮罩数据
6. 下载功能依赖后端 API
