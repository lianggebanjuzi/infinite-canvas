// src/utils/lazy-loader.ts
// 图片懒加载工具（IntersectionObserver）

export const LazyLoader = {
    observer: null as IntersectionObserver | null,

    init(): void {
        if ('IntersectionObserver' in window) {
            this.observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        this._loadImage(entry.target as HTMLImageElement);
                    }
                });
            }, { rootMargin: '200px' });

            console.log('[LazyLoader] 初始化完成');
        }
    },

    observe(img: HTMLImageElement): void {
        if (this.observer && img.classList.contains('lazy-image')) {
            this.observer.observe(img);
        }
    },

    _loadImage(img: HTMLImageElement): void {
        const fullSrc = img.dataset['full'] as string | undefined;
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

(window as unknown as { LazyLoader: typeof LazyLoader }).LazyLoader = LazyLoader;
