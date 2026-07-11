// gui/js/cards/CompareCard.js
// 对比卡片：用于对比两张图片，左右并排显示，中间有滑块可以拖动对比
class CompareCard extends BaseCard {

    constructor(options = {}) {
        super({
            width:    '400px',
            height:   '280px',
            minWidth:  300,
            minHeight: 200,
            title:    'Compare',
            ...options
        });
        this.imageA = options.imageA || '';
        this.imageB = options.imageB || '';
        this.sliderPos = 50; // 滑块位置 0-100
    }

    getType() { return 'compare'; }

    // ─────────────────────────────────────────
    // 契约声明
    // ─────────────────────────────────────────
    static getContract() {
        return {
            outputs: [],  // CompareCard 不输出数据
            inputs: [
                {
                    name: 'A',
                    type: 'image',
                    receivePolicy: 'replace'
                },
                {
                    name: 'B',
                    type: 'image',
                    receivePolicy: 'replace'
                }
            ]
        };
    }

    // ─────────────────────────────────────────
    // 根据契约获取输入数据
    // ─────────────────────────────────────────
    getInput(inputName) {
        if (inputName === 'A') return this.imageA;
        if (inputName === 'B') return this.imageB;
        return null;
    }

    /** 重写 createElement：使用统一结构，但只创建输入端口 */
    createElement() {
        const el = super.createElement();
        el.classList.add('compare');

        // 让 card-body 填满剩余空间
        const body = el.querySelector('.card-body');
        body.style.cssText = 'padding:0; display:flex; flex-direction:column;';

        body.innerHTML = this.renderContent();
        this._bindSliderDrag(body);

        // 初始化滑块位置
        this._updateSliderPosition();

        // 为输入端口 A 添加标记类（第一个输入端口是左侧的）
        const portLeft = el.querySelector('.port-left');
        if (portLeft) {
            portLeft.classList.add('port-input-a');
            portLeft.dataset.inputName = 'A';
            portLeft.title = '输入 A（左侧图）';
        }

        // 移除右侧输出端口（对比卡片只有输入）
        const portRight = el.querySelector('.port-right');
        if (portRight) portRight.remove();

        // 添加第二个输入端口 B（对应右侧图）
        const portB = this._createPort('port-left port-input-b', 'input');
        portB.dataset.inputName = 'B';
        portB.title = '输入 B（右侧图）';
        el.appendChild(portB);
        this._bindPortDrag(portB, 'input');

        // 保存端口引用，用于更新显示状态
        this._portLeft = portLeft;
        this._portRight = portB;
        this._updatePortsVisibility();

        return el;
    }

    /** 与 BaseCard 一致：连线后仍显示 A/B 端口，用 port--linked 标记已占用 */
    _updatePortsVisibility() {
        const cardId = this.element?.id;
        if (!cardId) return;

        const connections = AppState.connections.list;
        const hasInputA = connections.some(c => c.end === cardId && c.endPort === 'A');
        const hasInputB = connections.some(c => c.end === cardId && c.endPort === 'B');

        if (this._portLeft) {
            this._portLeft.style.display = '';
            this._portLeft.classList.toggle('port--linked', hasInputA);
        }
        if (this._portRight) {
            this._portRight.style.display = '';
            this._portRight.classList.toggle('port--linked', hasInputB);
        }
    }

    renderContent() {
        return `
            <div class="compare-container">
                <div class="compare-image-a">
                    ${this.imageA ? `<img src="${this.imageA}" alt="A">` : '<div class="compare-placeholder"></div>'}
                </div>
                <div class="compare-image-b">
                    ${this.imageB ? `<img src="${this.imageB}" alt="B">` : '<div class="compare-placeholder"></div>'}
                </div>
                <div class="compare-slider">
                    <div class="compare-slider-line"></div>
                    <div class="compare-slider-handle">
                        <span class="compare-slider-arrow left">◀</span>
                        <span class="compare-slider-arrow right">▶</span>
                    </div>
                </div>
            </div>
        `;
    }

    /** 绑定滑块拖拽事件 */
    _bindSliderDrag(body) {
        const slider = body.querySelector('.compare-slider');
        if (!slider) return;

        let isDragging = false;
        let startX = 0;
        let startPos = 0;
        let rafId = null;
        const container = body.querySelector('.compare-container');

        const onMouseMove = (e) => {
            if (!isDragging) return;
            const scale = AppState.canvas.scale || 1;
            const dx = (e.clientX - startX) / scale;
            const containerWidth = container.offsetWidth;
            let newPos = startPos + (dx / containerWidth) * 100;
            newPos = Math.max(0, Math.min(100, newPos));
            this.sliderPos = newPos;
            if (rafId !== null) return;
            rafId = requestAnimationFrame(() => {
                rafId = null;
                this._updateSliderPosition();
            });
        };

        const onMouseUp = () => {
            if (isDragging) {
                isDragging = false;
                if (rafId !== null) {
                    cancelAnimationFrame(rafId);
                    rafId = null;
                    this._updateSliderPosition();
                }
                // CompareCard 滑块位置变化——记录属性变更
                if (window.CmdManager) {
                    CmdManager.execute(new PropertyChangeCommand(
                        this.id, 'sliderPos', this._currentPos || 0.5, null, '调整对比'
                    ));
                }
            }
        };

        slider.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            isDragging = true;
            startX = e.clientX;
            startPos = this.sliderPos;
            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('mouseup', onMouseUp);
        });

        // 清理事件监听
        this._sliderCleanup = () => {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };
    }

    /** 更新滑块位置 */
    _updateSliderPosition() {
        const body = this.element?.querySelector('.card-body');
        if (!body) return;

        const slider = body.querySelector('.compare-slider');
        const imageA = body.querySelector('.compare-image-a');
        const imageB = body.querySelector('.compare-image-b');

        if (slider) {
            slider.style.left = this.sliderPos + '%';
        }
        if (imageA) {
            imageA.style.clipPath = `inset(0 ${100 - this.sliderPos}% 0 0)`;
        }
        if (imageB) {
            imageB.style.clipPath = `inset(0 0 0 ${this.sliderPos}%)`;
        }
    }

    /** 设置图片 A */
    setImageA(src) {
        this.imageA = src;
        this._refreshContent();
    }

    /** 设置图片 B */
    setImageB(src) {
        this.imageB = src;
        this._refreshContent();
    }

    /** 刷新内容显示 */
    _refreshContent() {
        const body = this.element?.querySelector('.card-body');
        if (!body) return;

        body.innerHTML = this.renderContent();
        this._bindSliderDrag(body);
        this._updateSliderPosition();
    }

    /** 从任意卡片实例获取图片 URL（兼容 ImageInputCard / PreviewCard 等） */
    static _getImageFromCard(card) {
        if (!card) return '';
        // PreviewCard 保存后 content 可能为 file://，在 webview 中无法作为 img 显示
        // 优先用已缓存的 data URL（用于预览显示）
        if (card._displayDataUrl) {
            console.log(`[DEBUG _getImageFromCard] ${card.id} using _displayDataUrl=${card._displayDataUrl.slice(0, 80)}`);
            return card._displayDataUrl;
        }
        // 再尝试 getOutput（兼容各卡片类型）
        if (card.getOutput) {
            const output = card.getOutput();
            if (output) {
                console.log(`[DEBUG _getImageFromCard] ${card.id} using getOutput()=${output.slice(0, 80)}`);
                return output;
            }
        }
        // 最后尝试从 DOM 获取（img 当前显示的 src 可能是 data URL）
        const el = document.getElementById(card.id);
        const img = el?.querySelector('.image-content, .preview-image-wrap img, img');
        const domSrc = img?.src || '';
        console.log(`[DEBUG _getImageFromCard] ${card.id} using DOM img src=${domSrc.slice(0, 80)}`);
        return domSrc;
    }

    /** 获取上游图片数据（按 A/B 端口区分） */
    getUpstreamImages() {
        // 使用 DataSource 按端口获取
        const imageAData = DataSource.getUpstreamImage(this.id, { inputPort: 'A' });
        const imageBData = DataSource.getUpstreamImage(this.id, { inputPort: 'B' });

        console.log(`[DEBUG CompareCard.getUpstreamImages] id=${this.id} imageA=${imageAData.length} imageB=${imageBData.length}`);

        const imageA = imageAData[0]?.data || '';
        const imageB = imageBData[0]?.data || '';

        return { imageA, imageB };
    }

    /** 刷新上游数据（若上游为 file:// 则异步加载为 data URL 后再刷新） */
    refreshUpstream() {
        console.log(`[DEBUG CompareCard.refreshUpstream] id=${this.id}`);
        const { imageA, imageB } = this.getUpstreamImages();

        const needLoad = (url) => url && (url.startsWith('file:///') || url.startsWith('file://'));
        const hasFile = needLoad(imageA) || needLoad(imageB);

        if (!hasFile) {
            this._applyUpstreamImages(imageA, imageB);
            return;
        }

        const loadOne = (url) => {
            if (!url || !needLoad(url)) return Promise.resolve(url);
            return (typeof API !== 'undefined' && API.loadLocalImage)
                ? API.loadLocalImage(url).then(r => (r && r.status === 'success' && r.data_url) ? r.data_url : url)
                : Promise.resolve(url);
        };

        Promise.all([loadOne(imageA), loadOne(imageB)]).then(([a, b]) => {
            this._applyUpstreamImages(a, b);
        }).catch(() => {
            this._applyUpstreamImages(imageA, imageB);
        });
    }

    _applyUpstreamImages(imageA, imageB) {
        console.log(`[DEBUG CompareCard._applyUpstreamImages] id=${this.id} imageA=${imageA?.slice(0, 80)} imageB=${imageB?.slice(0, 80)}`);
        let changed = false;
        if (this.imageA !== imageA) {
            this.imageA = imageA;
            changed = true;
            console.log(`[DEBUG CompareCard] ✓ imageA CHANGED → ${imageA?.slice(0, 80)}`);
        }
        if (this.imageB !== imageB) {
            this.imageB = imageB;
            changed = true;
            console.log(`[DEBUG CompareCard] ✓ imageB CHANGED → ${imageB?.slice(0, 80)}`);
        }
        if (changed) {
            console.log(`[DEBUG CompareCard] Calling _refreshContent()`);
            this._refreshContent();
        } else {
            console.log(`[DEBUG CompareCard] ⚠ imageA and imageB UNCHANGED (no refresh)`);
        }
    }

    /**
     * 通用接收方法：接收上游推送的图片
     * @param {string} type - 数据类型
     * @param {*} data - 数据内容
     * @param {string} source - 来源
     */
    onReceive(type, data, source = 'upstream') {
        console.log(`[DEBUG CompareCard.onReceive] id=${this.id} type=${type} data=${data?.slice(0, 80)} source=${source}`);
        if (type !== 'image' || !data) return;

        // 根据当前已设置的槽位决定放入 A 还是 B
        if (!this.imageA) {
            this.setImageA(data);
        } else if (!this.imageB) {
            this.setImageB(data);
        } else {
            // 两个槽位都已满，替换 A（最新优先）
            this.setImageA(data);
        }
    }

    serialize() {
        const base = super.serialize();
        return {
            ...base,
            imageA:    this.imageA || '',
            imageB:    this.imageB || '',
            sliderPos: this.sliderPos
        };
    }

    destroy() {
        if (this._sliderCleanup) {
            this._sliderCleanup();
        }
        super.destroy();
    }
}

window.CompareCard = CompareCard;
