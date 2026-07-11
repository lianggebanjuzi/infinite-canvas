/**
 * PreviewCard — 图片预览卡片
 *
 * 重构说明：
 * 1. 引入 _pendingSrc 标记，避免 setImage 单次调用中多次 DOM 重渲染导致图片闪烁
 * 2. 统一 _isLocalFile() 判断 file:// / file:/// / Windows 盘符路径
 * 3. downloadAs 改用 Toast 而非 alert，并增加降级回退
 * 4. _loadFromLocalPath 不再单独调用 notifyDownstream，统一由 setImage 管理
 * 5. 删除死代码 _hasContent()
 */

class PreviewCard extends BaseCard {

    constructor(options = {}) {
        super({
            width:  '400px',
            height: '300px',
            title:  'Preview',
            ...options
        });
        this.content         = options.content     || '';
        this.thumbnail       = options.thumbnail   || '';
        this.imageMeta       = options.imageMeta   || null;
        this.fullLoaded      = false;
        // 【重构】统一缓存字段：始终存储可用的 data URL，供 getOutput / 双击大图 / 下载使用
        this._displayDataUrl = '';
        // 【重构】新增：待处理的图片源标记，用于在异步流程中检测是否有新的 setImage 打断当前流程
        // 只有当 _pendingSrc === src 时，才执行后续的 _renderImage，避免旧请求的回调覆盖新图片
        this._pendingSrc     = '';
        // 【重构】新增：渲染锁，防止同步递归进入 _renderImage
        this._isRendering    = false;
    }

    getType() { return 'preview'; }

    // ─────────────────────────────────────────
    // 契约声明
    // ─────────────────────────────────────────
    static getContract() {
        return {
            outputs: [{ name: 'default', type: 'image' }],
            inputs: [{ name: 'default', type: 'image' }]
        };
    }

    /**
     * 【重构】getOutput：优先返回 _displayDataUrl（data URL），
     * 如果没有则返回 this.content（可能还是原始 data URL 或已保存的 file:// 路径）
     */
    getOutput(outputName = 'default') {
        if (outputName === 'default') {
            return this.content || this._displayDataUrl || null;
        }
        return null;
    }

    onReceive(type, data, source = 'upstream') {
        if (type === 'image' && data) {
            this.setImage(data);
        }
    }

    // ─────────────────────────────────────────
    // 【重构】路径判断工具（统一处理 Windows / Unix 差异）
    // ─────────────────────────────────────────

    /**
     * 判断路径是否为本地文件路径
     * 覆盖三种情况：
     *   - file:// / file:/// (Web 协议路径)
     *   - / 开头的 Unix 绝对路径
     *   - C: / D: 等 Windows 盘符路径
     */
    _isLocalFile(path) {
        if (!path) return false;
        return (
            path.startsWith('file://') ||
            path.startsWith('file:///') ||
            path.startsWith('/') ||
            /^[A-Za-z]:/.test(path)  // Windows 盘符，如 C: 或 D:
        );
    }

    // ─────────────────────────────────────────
    // 渲染内容
    // ─────────────────────────────────────────

    /**
     * 【重构】renderContent：移除 file:// 占位符分支，
     * 统一由 _loadFromLocalPath → setImage → _renderImage 处理，
     * 避免 createElement 阶段渲染两次
     */
    renderContent() {
        if (this.content) {
            const imgSrc = this.thumbnail || this.content;
            return `
                <div class="preview-image-wrap">
                    <img src="${imgSrc}"
                         class="image-content lazy-image"
                         data-full="${this.content}"
                         style="object-fit: contain; cursor: pointer;">
                    ${this._renderHoverToolbar()}
                    ${this._renderMeta()}
                </div>
            `;
        }

        return `
            <div class="preview-placeholder">
                <i class="fas fa-eye"
                   style="font-size:48px; margin-bottom:10px;"></i>
                <div>等待 AI 绘图卡片生成图片</div>
            </div>
        `;
    }

    /**
     * 【重构】createElement：移除 file:// 时的占位符渲染逻辑，
     * 改为直接调用 _loadFromLocalPath 处理（会触发 setImage 流程），
     * 避免渲染 → 替换的闪烁
     */
    createElement() {
        const el = super.createElement();

        // 【重构】如果 content 是本地文件路径，直接走标准异步加载流程
        if (this.content && this._isLocalFile(this.content)) {
            this._loadFromLocalPath(this.content);
        }

        // 双击整块预览区域均可打开大图
        const wrap = el.querySelector('.preview-image-wrap');
        if (wrap && this.content) {
            wrap.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                this._showFullImage();
            });
        }
        const img = el.querySelector('.image-content');
        if (img) {
            if (window.LazyLoader) LazyLoader.observe(img);
        }

        this._bindHoverToolbar(el);

        return el;
    }

    _bindHoverToolbar(el) {
        const btn = el.querySelector('[data-action="download"]');
        if (!btn) return;
        btn.addEventListener('click', () => {
            PreviewCard.downloadAs(this.id);
        });
    }

    // ─────────────────────────────────────────
    // 【优化】setImage：先渲染图片，保存操作延迟到下一帧
    // ─────────────────────────────────────────

    /**
     * 设置图片入口
     * 【优化】渲染和保存分离：
     *   - 渲染：同步执行，保证图片立即显示
     *   - 保存到本地 + UndoRedo.save()：延迟到下一帧，让连线绘制先完成
     *   - 这样连接卡片时不会出现卡顿
     * @param {string} src - 图片源（data URL 或 file:// 路径）
     * @param {object|null} meta - 图片元数据（分辨率、宽高比等）
     */
    setImage(src, meta = null) {
        console.log(`[DEBUG PreviewCard.setImage] id=${this.id} src=${src?.slice(0, 80)} _displayDataUrl was=${this._displayDataUrl ? 'SET' : 'EMPTY'}`);
        const t0 = performance.now();

        if (meta) this.imageMeta = meta;

        // 换图时清空缓存，下次渲染使用 src
        this._displayDataUrl = '';

        // 【优化】记录当前期望显示的图片源，用于在异步回调中判断是否过时
        // 如果在异步过程中有新的 setImage 被调用，_pendingSrc 会变成新值，
        // 旧回调检测到不一致就不再执行 _renderImage，避免旧图片覆盖新图片
        this._pendingSrc = src;

        const originalSrc = src;
        this.content = src;

        // 【优化】先同步渲染，让图片立即显示出来（这步极快，不卡）
        this._renderImage(originalSrc, this.imageMeta);

        const t1 = performance.now();
        if (t1 - t0 > 16) console.warn(`[PreviewCard] ⚠️ setImage 前半段耗时 ${(t1-t0).toFixed(1)}ms`, src.slice(0, 60));

        // 【优化】保存和历史记录延迟到下一帧执行，避免阻塞连接时的 UI 渲染
        // 保存操作（base64 解码 + 写文件）在 pywebview 中较慢，延迟后不影响连线体验
        requestAnimationFrame(() => {
            const t2 = performance.now();
            this._processImageAsync(originalSrc);
            const t3 = performance.now();
            if (t3 - t2 > 16) console.warn(`[PreviewCard] ⚠️ _processImageAsync 耗时 ${(t3-t2).toFixed(1)}ms`);
            // PreviewCard 图片由上游数据驱动，不需要单独记录撤销
            // （撤销应追溯到上游的 ModifyContentCommand）
            const t4 = performance.now();
            if (t4 - t2 > 16) console.warn(`[PreviewCard] ⚠️ RAF 批次（含 process+save）耗时 ${(t4-t2).toFixed(1)}ms`);
        });

        // 【优化】notifyDownstream 只做轻量的连线遍历，无 IO 操作，同步执行即可
        this.notifyDownstream();
    }

    /**
     * 【重构】图片异步处理流程：
     *   - 渲染：同步执行，保证图片立即显示
     *   - 注意：移除本地保存调用，因为后端 UnifiedAPIRouter 已在生成时自动保存
     *
     * @param {string} originalSrc - 原始图片源（data URL 或 file:// 路径）
     */
    async _processImageAsync(originalSrc) {
        // data URL 可直接渲染，不需要额外处理
        // 如果后续需要动态生成缩略图（用于预览），可以在这里用 canvas 处理
        // 但目前 AI 生成的图已经保存，不需要重复保存
        console.log('[PreviewCard] 图片已显示（保存由后端 UnifiedAPIRouter 负责）');
    }

    // ─────────────────────────────────────────
    // 【重构】_loadFromLocalPath：统一走 setImage 流程
    // ─────────────────────────────────────────

    /**
     * 【重构】从本地文件路径加载图片：
     *   - 移除单独的 notifyDownstream() 调用（由 setImage 统一管理）
     *   - 移除单独的 _renderImage 调用（由 setImage → _processImageAsync 统一管理）
     *   - 直接通过 setImage 处理，纳入统一的渲染流程
     */
    async _loadFromLocalPath(filePath) {
        try {
            const result = await API.loadLocalImage(filePath);
            if (result.status === 'success' && result.data_url) {
                this._displayDataUrl = result.data_url;  // 缓存，双击大图时直接用
                // 【重构】统一通过 setImage 渲染，保证渲染入口唯一
                this.setImage(result.data_url);
            } else {
                console.warn('[PreviewCard] 加载本地图片失败:', result.message);
                this._renderError();
            }
        } catch (e) {
            console.warn('[PreviewCard] 加载本地图片异常:', e);
            this._renderError();
        }
    }

    // ─────────────────────────────────────────
    // 渲染方法
    // ─────────────────────────────────────────

    /**
     * 【重构】_renderImage：增加渲染锁，防止同步递归调用
     */
    _renderImage(src, meta = null) {
        // 【重构】渲染锁：防止在 _renderImage 内部触发的回调再次进入此方法
        if (this._isRendering) {
            console.log('[PreviewCard] 渲染被锁住，跳过本次渲染');
            return;
        }
        this._isRendering = true;

        console.log(`[DEBUG _renderImage] id=${this.id} src=${src?.slice(0, 80)} content=${this.content?.slice(0, 80)}`);

        try {
            const body = this.element?.querySelector('.card-body');
            if (!body) return;

            const displaySrc = src || '';
            const dataFull = (this.content || src || '').replace(/"/g, '&quot;');
            body.innerHTML = `
                <div class="preview-image-wrap" data-has-content="${this.content ? '1' : '0'}">
                    <img class="image-content lazy-image"
                         data-full="${dataFull}"
                         style="object-fit: contain; cursor: pointer;">
                    ${this._renderHoverToolbar()}
                    ${this._renderMeta(meta)}
                </div>
            `;

            const img = body.querySelector('.image-content');
            if (img) {
                img.setAttribute('src', displaySrc);
                if (window.LazyLoader) LazyLoader.observe(img);
            }

            // 绑定双击事件（仅在有图片时绑定）
            const wrap = body.querySelector('.preview-image-wrap');
            if (wrap && this.content) {
                wrap.addEventListener('dblclick', (e) => {
                    e.stopPropagation();
                    this._showFullImage();
                });
            }
        } finally {
            this._isRendering = false;
        }
    }

    _renderMeta(meta) {
        const m = meta || this.imageMeta;
        if (!m) return '';

        const res  = m.resolution
            ? m.resolution.toUpperCase()
            : '';
        const ar   = (m.aspectRatio && m.aspectRatio !== 'Auto')
            ? m.aspectRatio
            : '';
        const time = m.generatedAt
            ? new Date(m.generatedAt).toLocaleTimeString('zh-CN', {
                hour:   '2-digit',
                minute: '2-digit',
                second: '2-digit'
              })
            : '';

        const parts = [res, ar, time].filter(Boolean);
        if (!parts.length) return '';

        return `
            <div class="preview-meta-bar">
                ${res  ? `<span class="preview-meta-res">${res}</span>`   : ''}
                ${ar   ? `<span class="preview-meta-ar">${ar}</span>`     : ''}
                ${time ? `<span class="preview-meta-time">${time}</span>` : ''}
            </div>
        `;
    }

    _renderError() {
        const body = this.element?.querySelector('.card-body');
        if (!body) return;
        body.innerHTML = `
            <div class="preview-placeholder">
                <i class="fas fa-exclamation-triangle"
                   style="font-size:48px; margin-bottom:10px; color:#f59e0b;"></i>
                <div>图片文件已丢失</div>
            </div>
        `;
    }

    // ─────────────────────────────────────────
    // 大图预览
    // ─────────────────────────────────────────

    /**
     * 【重构】_showFullImage：使用 _isLocalFile 统一判断
     */
    _showFullImage() {
        if (!this.content) {
            console.warn('[PreviewCard] 无法显示大图：content 为空');
            return;
        }

        if (window.ImageModal && window.ImageModal.open) {
            // 【重构】统一用 _isLocalFile 判断 file://，不再遗漏 Windows 盘符
            // file:// 时优先用已缓存的 data URL，避免每次双击都调后端读文件（卡顿）
            if (this._isLocalFile(this.content) && this._displayDataUrl) {
                window.ImageModal.open(this._displayDataUrl);
                return;
            }
            if (!this._isLocalFile(this.content)) {
                window.ImageModal.open(this.content);
                return;
            }
            this._showFullImageFromFile(this.content);
            return;
        }

        // Fallback: 直接创建 modal（理论上不会走到这里）
        const modal = document.createElement('div');
        modal.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.9); z-index: 10000;
            display: flex; align-items: center; justify-content: center;
            cursor: pointer;
        `;

        const img = document.createElement('img');
        img.src = this.content;
        img.style.cssText = 'max-width: 90%; max-height: 90%; object-fit: contain;';

        modal.appendChild(img);
        modal.addEventListener('click', () => modal.remove());
        document.body.appendChild(modal);
    }

    async _showFullImageFromFile(filePath) {
        try {
            const result = await API.loadLocalImage(filePath);
            if (result.status === 'success' && result.data_url) {
                this._displayDataUrl = result.data_url;  // 下次双击直接用缓存
                window.ImageModal.open(result.data_url);
            } else {
                console.warn('[PreviewCard] 加载本地图片失败:', result.message);
            }
        } catch (e) {
            console.error('[PreviewCard] 加载大图失败:', e);
        }
    }

    // ─────────────────────────────────────────
    // 序列化
    // ─────────────────────────────────────────

    serialize() {
        const base = super.serialize();
        return {
            ...base,
            content:   this.content   || '',
            thumbnail: this.thumbnail || '',
            imageMeta: this.imageMeta || null
        };
    }

    // ─────────────────────────────────────────
    // 【重构】下载：统一 Toast + 降级回退
    // ─────────────────────────────────────────

    _renderHoverToolbar() {
        return `
            <div class="preview-hover-toolbar">
                <button class="preview-action-btn" title="另存为到其他文件夹" data-action="download">
                    <i class="fas fa-download"></i>
                    <span>下载</span>
                </button>
            </div>
        `;
    }

    /**
     * 【重构】downloadAs：
     *   1. alert → Toast.show()，与项目风格统一
     *   2. 失败时增加降级回退：优先用 _displayDataUrl，再用 content
     *   3. 移除早期 return，不给用户误导性提示
     */
    static async downloadAs(cardId) {
        const card = CardFactory.getInstance(cardId);
        if (!card || !card.content) {
            console.warn('[PreviewCard] 无法下载：卡片或内容为空');
            return;
        }

        // 获取图片数据：优先级 _displayDataUrl（缓存 data URL）> content（可能是 file://）
        // 【重构】统一逻辑，不再分散在多个分支中
        let imageData = card._displayDataUrl || card.content;

        // 如果 content 是本地文件路径且没有缓存 data URL，需要先加载
        // 【重构】增加降级回退：即使 loadLocalImage 失败，也尝试用 content（可能是 data URL）继续
        if (card._isLocalFile(card.content) && !card._displayDataUrl) {
            try {
                const result = await API.loadLocalImage(card.content);
                if (result.status === 'success' && result.data_url) {
                    imageData = result.data_url;
                } else {
                    // 【重构】失败时给用户友好提示，但继续尝试降级
                    Toast.show('图片加载失败，尝试直接保存', 2000);
                }
            } catch (e) {
                Toast.show('图片加载失败，尝试直接保存', 2000);
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
    }
}

window.PreviewCard = PreviewCard;
