// src/independent/image-modal.ts
// 图片查看器：全屏查看图片，支持 ESC 关闭

export const ImageModal = {
    open(imgSrc: string): void {
        const modal = document.getElementById('image-modal') as HTMLElement;
        const modalImg = document.getElementById('modal-image') as HTMLImageElement;
        if (!modal || !modalImg) return;
        modal.style.display = 'flex';
        setTimeout(() => modal.classList.add('active'), 10);
        modalImg.src = imgSrc;
    },

    close(): void {
        const modal = document.getElementById('image-modal') as HTMLElement;
        if (!modal) return;
        modal.classList.remove('active');
        modal.style.display = 'none';
        const modalImg = document.getElementById('modal-image') as HTMLImageElement;
        if (modalImg) modalImg.src = '';
    }
};

(window as unknown as Record<string, unknown>).ImageModal = ImageModal;
