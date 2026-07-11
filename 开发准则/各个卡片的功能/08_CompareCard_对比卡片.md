# CompareCard（对比卡片）

## 文件路径
`gui\js\cards\CompareCard.js`

## 功能概述
CompareCard 是一个用于对比两张图片的卡片，通过可拖动的滑块实现左右分屏对比效果。用户可以直观地比较两张图片的差异，常用于对比 AI 生成结果、编辑前后效果、参数调整变化等场景。

## 核心特性

- 左右分屏对比显示
- 可拖动滑块控制分割比例
- 支持 A/B 两个独立输入端口
- 自动识别图片来源（本地文件、base64、URL）
- 自动调整图片大小一致
- 精美的对比交互体验

## 卡片信息

| 属性 | 值 |
|------|-----|
| 卡片类型标识 | `compare` |
| 默认尺寸 | 400px × 280px |
| 最小尺寸 | 250px × 200px |
| 继承自 | BaseCard |

## 契约声明

```javascript
static getContract() {
    return {
        outputs: [],  // 不输出数据
        inputs: [
            { name: 'A', type: 'image', receivePolicy: 'replace' },
            { name: 'B', type: 'image', receivePolicy: 'replace' }
        ]
    };
}
```

| 端口类型 | 端口名称 | 数据类型 | 接收策略 | 说明 |
|---------|---------|---------|---------|------|
| 输入 | `A` | `image` | replace | A 端口图片 |
| 输入 | `B` | `image` | replace | B 端口图片 |
| 输出 | 无 | - | - | 无输出端口 |

## 核心属性

| 属性名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `imageA` | string | null | A 端口图片 |
| `imageB` | string | null | B 端口图片 |
| `sliderPos` | number | 50 | 滑块位置 (0-100) |
| `_refImageA` | Image | null | A 图片引用 |
| `_refImageB` | Image | null | B 图片引用 |
| `_naturalWidthA` | number | 0 | A 图片原始宽度 |
| `_naturalHeightA` | number | 0 | A 图片原始高度 |
| `_naturalWidthB` | number | 0 | B 图片原始宽度 |
| `_naturalHeightB` | number | 0 | B 图片原始高度 |

## 核心方法

### createElement()
重写以创建特殊的 A/B 双输入端口结构。
```javascript
createElement() {
    // 调用父类创建基础结构
    super.createElement();

    // 移除默认的单一输入端口
    // 添加两个独立的输入端口（A 和 B）
}
```

### _bindSliderDrag()
绑定滑块拖拽事件。
```javascript
_bindSliderDrag() {
    const slider = this.elements.slider;
    let isDragging = false;

    const onMove = (e) => {
        if (!isDragging) return;

        const rect = this.elements.compareContainer.getBoundingClientRect();
        let pos = (e.clientX - rect.left) / rect.width * 100;
        pos = Math.max(0, Math.min(100, pos));

        this.sliderPos = pos;
        this._updateClipPath();
    };

    slider.addEventListener('mousedown', () => isDragging = true);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', () => isDragging = false);
}
```

### _updateClipPath()
更新图片裁剪路径，实现分屏效果。
```javascript
_updateClipPath() {
    if (this.elements.imageA) {
        this.elements.imageA.style.clipPath = `inset(0 ${100 - this.sliderPos}% 0 0)`;
    }
    if (this.elements.slider) {
        this.elements.slider.style.left = `${this.sliderPos}%`;
    }
}
```

### setImageA(src)
设置 A 端口图片。
```javascript
setImageA(src) {
    this.imageA = src;
    this._loadImage(src, 'A');
}
```

### setImageB(src)
设置 B 端口图片。
```javascript
setImageB(src) {
    this.imageB = src;
    this._loadImage(src, 'B');
}
```

### _loadImage(src, slot)
加载图片并处理。
```javascript
_loadImage(src, slot) {
    let imgSrc = src;

    // 处理本地文件路径
    if (!src.startsWith('data:') && !src.startsWith('http')) {
        imgSrc = 'file://' + src;
    }

    const img = new Image();
    img.onload = () => {
        // 保存原始尺寸
        if (slot === 'A') {
            this._refImageA = img;
            this._naturalWidthA = img.naturalWidth;
            this._naturalHeightA = img.naturalHeight;
        } else {
            this._refImageB = img;
            this._naturalWidthB = img.naturalWidth;
            this._naturalHeightB = img.naturalHeight;
        }

        // 调整图片大小一致
        this._adjustImageSizes();
        this._updateDisplay();
    };
    img.src = imgSrc;
}
```

### _adjustImageSizes()
自动调整 A/B 图片大小，使它们一致显示。
```javascript
_adjustImageSizes() {
    // 选择较大的尺寸作为基准
    // 较小的图片进行缩放以匹配
    const targetWidth = Math.max(this._naturalWidthA, this._naturalWidthB);
    const targetHeight = Math.max(this._naturalHeightA, this._naturalHeightB);

    // 应用统一样式
}
```

### refreshUpstream()
刷新上游数据，显示当前连接的图片来源。
```javascript
refreshUpstream() {
    // 更新 UI 显示上游卡片来源
    // 可以显示 "A: 图片1" 和 "B: 图片2" 等提示
}
```

### onUpstreamChanged()
接收上游变化。
```javascript
onUpstreamChanged() {
    this.refreshUpstream();
}
```

### onReceive(type, data, source)
通用接收方法，根据来源自动分配到 A 或 B 端口。
```javascript
onReceive(type, data, source) {
    if (type === 'image') {
        // 根据连接端口自动分配
        // 或者根据来源卡片判断
        if (this._sourceSlotMap[source] === 'A') {
            this.setImageA(data);
        } else if (this._sourceSlotMap[source] === 'B') {
            this.setImageB(data);
        }
    }
}
```

## 静态方法

### _getImageFromCard(card)
从卡片获取图片 URL。
```javascript
static _getImageFromCard(card) {
    if (!card) return null;

    // 尝试从不同卡片类型获取图片
    if (card.getOutput) {
        const output = card.getOutput('default');
        if (output) return output;
    }

    // ImageInputCard
    if (card.content) return card.content;

    // 其他类型卡片...

    return null;
}
```

## 渲染结构

```html
<div class="card-content compare-card">
    <!-- 对比容器 -->
    <div class="compare-container">
        <!-- B 图片（底层，始终完整显示） -->
        <div class="compare-image-wrapper image-b-wrapper">
            <img class="compare-image image-b" src="..." alt="Image B" />
            <span class="image-label label-b">B</span>
        </div>

        <!-- A 图片（顶层，被裁剪） -->
        <div class="compare-image-wrapper image-a-wrapper">
            <img class="compare-image image-a" src="..." alt="Image A" />
            <span class="image-label label-a">A</span>
        </div>

        <!-- 滑块 -->
        <div class="compare-slider">
            <div class="slider-line"></div>
            <div class="slider-handle">
                <span class="slider-icon">◀▶</span>
            </div>
        </div>
    </div>

    <!-- 悬停提示 -->
    <div class="compare-hints">
        <span class="hint-a">拖动滑块对比</span>
    </div>
</div>
```

## 样式特点

- 深色卡片背景
- 大号滑块手柄，便于拖拽
- A/B 标签标识图片来源
- 平滑的滑块过渡动画
- 悬停时显示拖拽提示
- 图片自动居中对齐

## 交互方式

### 滑块拖拽
1. 鼠标悬停到滑块上，指针变为水平拖拽样式
2. 按下鼠标左键开始拖拽
3. 移动鼠标，滑块跟随移动
4. 左侧显示 A 图片，右侧显示 B 图片
5. 松开鼠标完成调整

### 滑块位置
- `sliderPos = 0`：完全显示 A
- `sliderPos = 50`：各显示一半
- `sliderPos = 100`：完全显示 B

### 快捷操作
- **双击滑块**：重置到中间位置 (50%)
- **点击左侧区域**：跳转到对应位置
- **点击右侧区域**：跳转到对应位置

## 使用场景

1. **AI 生成对比**：对比不同模型或参数的生成结果
2. **编辑前后对比**：查看图片编辑前后的变化
3. **风格对比**：对比不同风格的处理效果
4. **参数调整**：对比不同参数设置的效果差异
5. **素材选择**：在多张候选图片中选择最佳

## 典型工作流

```
AIDrawCard (模型A) ─→ CompareCard (A端口)
                            │
AIDrawCard (模型B) ─→ CompareCard (B端口)
                            ↓
                       [用户拖动滑块对比]
```

```
AIDrawCard ─→ DrawingBoardCard ─→ PreviewCard
                                      │
ImageInputCard ───────────────────────────┘
                          ↓
                     CompareCard
                          ↓
                    [查看对比效果]
```

## 与其他卡片的配合

| 来源卡片 | 连接效果 |
|---------|---------|
| ImageInputCard | 手动上传的图片作为对比素材 |
| AIDrawCard | 不同设置/模型生成的结果对比 |
| PreviewCard | 预览其他卡片处理后的结果 |
| DrawingBoardCard | 画板处理前后的效果对比 |
| AgentCard | 分析不同结果的描述对比 |

## 注意事项

1. 对比卡片**没有输出端口**，是工作流的终点
2. 两个输入端口必须手动连接或通过规则自动分配
3. 图片会自动缩放以保持一致大小
4. 滑块位置可以精确到小数点后两位
5. 支持触摸设备上的滑块拖拽
6. 建议连接的 A/B 图片尺寸接近，否则可能产生拉伸
7. 首次连接时滑块默认居中
