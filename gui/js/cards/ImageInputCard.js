// gui/js/cards/ImageInputCard.js
class ImageInputCard extends BaseCard {

    constructor(options = {}) {
        super({
            width:  '240px',
            height: '200px',
            title:  'Image',
            ...options
        });
        this.content  = options.content  || '';
        this.maskData = options.maskData || null;
    }

    getType() { return 'image'; }

    // ─────────────────────────────────────────
    // 契约声明
    // ─────────────────────────────────────────
    static getContract() {
        return {
            outputs: [{ name: 'default', type: 'image' }],
            inputs: []
        };
    }

    getOutput(outputName = 'default') {
        if (outputName === 'default') {
            return this.content || this._displayDataUrl || null;
        }
        return null;
    }

    /**
     * 判断路径是否为本地文件路径
     */
    _isLocalFile(path) {
        if (!path) return false;
        return (
            path.startsWith('file://') ||
            path.startsWith('file:///') ||
            path.startsWith('/') ||
            /^[A-Za-z]:/.test(path)
        );
    }

    renderContent() {
        if (this.content) {
            return `
                <div class="image-card-wrapper">
                    <img src="${this.content}" class="image-content">
                    ${this.maskData ? `
                        <img src="${this.maskData}"
                             class="image-mask-overlay"
                             draggable="false">
                    ` : ''}
                    <div class="image-hover-toolbar">
                        <button class="img-action-btn img-action-primary" title="下载图片" data-action="download">
                            <i class="fas fa-download"></i>
                            <span>下载</span>
                        </button>
                        <button class="img-action-btn img-action-danger" title="删除图片" data-action="delete">
                            <i class="fas fa-trash-alt"></i>
                            <span>删除</span>
                        </button>
                    </div>
                </div>
            `;
        }
        return `
            <div class="image-placeholder" data-action="upload">
                <i class="fas fa-image"></i>
                <span>点击选择图片</span>
            </div>
        `;
    }

    async setImage(src, keepMask = false) {
        const oldContent  = this.content;
        const oldMaskData = this.maskData;

        this.content = src;

        if (!keepMask) {
            this.maskData = null;
        }

        const body = this.element.querySelector('.card-body');
        body.innerHTML = this.renderContent();

        ConnectionManager.updateCardConnections(this.id);
        this.notifyDownstream();

        if (window.CmdManager && src !== oldContent) {
            CmdManager.execute(new ModifyContentCommand(this.id, src, oldContent));
        }
    }

    onReceive(type, data, source = 'upstream') {
        // ImageInputCard 不从上游接收数据
    }

    refreshMaskDisplay() {
        const body = this.element?.querySelector('.card-body');
        if (!body || !this.content) return;

        const wrapper = body.querySelector('.image-card-wrapper');
        if (!wrapper) return;

        let overlay = wrapper.querySelector('.image-mask-overlay');

        if (this.maskData) {
            if (overlay) {
                overlay.src = this.maskData;
            } else {
                const img     = document.createElement('img');
                img.src       = this.maskData;
                img.className = 'image-mask-overlay';
                img.draggable = false;
                const toolbar = wrapper.querySelector('.image-hover-toolbar');
                wrapper.insertBefore(img, toolbar);
            }
        } else {
            overlay?.remove();
        }
    }

    // ── content 是图片 base64 或本地路径，直接序列化 ──
    serialize() {
        const base = super.serialize();
        return {
            ...base,
            content:  this.content  || '',
            maskData: this.maskData || null
        };
    }

    createElement() {
        const el = super.createElement();
        el.classList.add('image-card');

        const body = el.querySelector('.card-body');
        body.style.cssText = 'padding:0; display:flex; flex-direction:column; overflow:hidden;';

        this._bindCardEvents(el);
        return el;
    }

    _bindCardEvents(el) {
        const body = el.querySelector('.card-body');

        const placeholder = body?.querySelector('[data-action="upload"]');
        placeholder?.addEventListener('click', () => {
            CardFactory.triggerImageUpload(this.id);
        });

        const downloadBtn = body?.querySelector('[data-action="download"]');
        downloadBtn?.addEventListener('click', () => {
            ImageInputCard.downloadAs(this.id);
        });

        const deleteBtn = body?.querySelector('[data-action="delete"]');
        deleteBtn?.addEventListener('click', () => {
            ImageInputCard._deleteImage(this.id);
        });
    }
}

ImageInputCard._deleteImage = function (cardId) {
    const card = CardFactory.getInstance(cardId);
    if (!card) return;

    const oldContent  = card.content;
    const oldMaskData = card.maskData;

    card.content  = '';
    card.maskData = null;

    const body = card.element.querySelector('.card-body');
    body.innerHTML = card.renderContent();

    AppState.connections.list.forEach(c => {
        if (c.start === cardId || c.end === cardId) {
            const otherId = c.start === cardId ? c.end : c.start;
            const other   = CardFactory.getInstance(otherId);
            if (other?.getType?.() === 'ai-image') {
                other.removeRefImage(cardId);
            }
        }
    });

    if (window.CardEventBus && CardEventBus.EventTypes) {
        CardEventBus.emit(CardEventBus.EventTypes.DATA_CHANGED, {
            cardId: cardId,
            type: 'image',
            data: null,
            source: 'manual'
        });
    }

    ConnectionManager.updateCardConnections(cardId);

    if (window.CmdManager && oldContent) {
        CmdManager.execute(new ModifyContentCommand(cardId, '', oldContent));
    }
};

/**
 * 下载图片到指定位置
 * @param {string} cardId - 卡片ID
 */
ImageInputCard.downloadAs = async function (cardId) {
    const card = CardFactory.getInstance(cardId);
    if (!card || !card.content) {
        console.warn('[ImageInputCard] 无法下载：卡片或内容为空');
        return;
    }

    // 获取图片数据
    let imageData = card.content;

    // 如果是本地文件路径，需要先加载为 data URL
    if (card._isLocalFile && card._isLocalFile(card.content)) {
        try {
            const result = await API.loadLocalImage(card.content);
            if (result.status === 'success' && result.data_url) {
                imageData = result.data_url;
            }
        } catch (e) {
            console.warn('[ImageInputCard] 加载本地图片失败:', e);
        }
    }

    try {
        const result = await API.saveImageAs(imageData);
        if (result.status === 'success') {
            Toast.show('图片已保存到: ' + result.path, 3000);
        } else if (result.status === 'cancelled') {
            // 用户取消了操作，不提示
        } else {
            Toast.show('保存失败: ' + (result.message || '未知错误'), 3000);
        }
    } catch (e) {
        Toast.show('保存失败: ' + e, 3000);
    }
};

window.ImageInputCard = ImageInputCard;
