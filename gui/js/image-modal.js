/**
 * 图片查看器模块
 * 负责全屏查看 Agent/AI 绘图卡片的图片
 * 支持 ESC 关闭、滚轮缩放
 */
window.ImageModal = {
    open(imgSrc) {
        const modal = document.getElementById('image-modal');
        const modalImg = document.getElementById('modal-image');
        modal.style.display = 'flex';
        setTimeout(() => modal.classList.add('active'), 10);
        modalImg.src = imgSrc;
    },
    close() {
        const modal = document.getElementById('image-modal');
        modal.classList.remove('active');
        modal.style.display = 'none';
        document.getElementById('modal-image').src = '';
    }
};
