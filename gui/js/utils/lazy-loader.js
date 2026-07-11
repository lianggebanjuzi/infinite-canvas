// 图片懒加载工具
const LazyLoader = {
    observer: null,

    init() {
        if ('IntersectionObserver' in window) {
            this.observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        this._loadImage(entry.target);
                    }
                });
            }, {
                rootMargin: '200px'
            });
            
            console.log('[LazyLoader] 初始化完成');
        }
    },

    observe(img) {
        if (this.observer && img.classList.contains('lazy-image')) {
            this.observer.observe(img);
        }
    },

    _loadImage(img) {
        const fullSrc = img.dataset.full;
        if (fullSrc && fullSrc !== img.src) {
            const tempImg = new Image();
            tempImg.onload = () => {
                img.src = fullSrc;
                img.classList.add('loaded');
            };
            tempImg.src = fullSrc;
        }
        this.observer?.unobserve(img);
    }
};

window.LazyLoader = LazyLoader;
