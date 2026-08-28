// 4.1-A 本地图片编辑：裁剪和网格切图。只使用浏览器 Canvas + 项目资源落盘，不调用供应商。

import { Backend, localImageFileUrl } from '../../api';
import { flowState } from '../../state/flow-state';
import { selection } from '../../state/selection';
import { flowHistory } from '../../state/history';
import { CARD_W, imageCardHeight } from '../../canvas/canvas-view';
import { showToast } from '../toast';

type Mode = 'crop' | 'split';
type Crop = { x: number; y: number; width: number; height: number };

class ImageEditor {
  private overlay: HTMLElement | null = null;
  private nodeId = '';
  private source = new Image();
  private sourceUrl = '';
  private crop: Crop = { x: .08, y: .08, width: .84, height: .84 };
  private rotation = 0;
  private ratio = 'free';
  private mode: Mode = 'crop';
  private split = { rows: 2, cols: 2, gutter: 0 };

  init(): void {
    // Lazy-created so the static app shell stays compatible with old project files.
  }

  async openCrop(nodeId: string): Promise<void> {
    await this.open(nodeId, 'crop');
  }

  async openSplit(nodeId: string): Promise<void> {
    await this.open(nodeId, 'split');
  }

  close(): void {
    this.overlay?.remove();
    this.overlay = null;
    this.nodeId = '';
  }

  private async open(nodeId: string, mode: Mode): Promise<void> {
    const node = flowState.getNode(nodeId);
    if (!node || node.type !== 'image-gen') return;
    const fallback = node.imageUrl || flowState.getReferenceImages(nodeId)[0];
    if (!fallback) { showToast('该节点没有可编辑的图片', false); return; }
    this.nodeId = nodeId;
    this.mode = mode;
    this.rotation = 0;
    this.ratio = 'free';
    this.crop = { x: .08, y: .08, width: .84, height: .84 };
    this.split = { rows: 2, cols: 2, gutter: 0 };
    try {
      this.sourceUrl = await this.loadSource(node, fallback);
      await this.loadImage(this.sourceUrl);
      // 老节点只有可访问 URL 时，先把源文件落到项目图片目录；派生结果永远不以临时 URL 为唯一来源。
      if (!node.imageOrigin?.path) {
        const persisted = await Backend.prepareImportedImage(this.sourceUrl, `edit-source-${Date.now()}.png`);
        if (persisted.status === 'success' && persisted.path) {
          flowState.updateNode(node.id, {
            imageUrl: persisted.thumbnail_data_url || node.imageUrl,
            imageOrigin: { path: persisted.path, url: persisted.url },
            imageWidth: this.source.naturalWidth,
            imageHeight: this.source.naturalHeight,
          });
          this.sourceUrl = localImageFileUrl(persisted.path, persisted.url);
          await this.loadImage(this.sourceUrl);
        }
      }
      this.render();
    } catch {
      showToast('原图加载失败，无法编辑', false);
    }
  }

  private async loadSource(node: FlowNode, fallback: string): Promise<string> {
    if (!node.imageOrigin?.path) return fallback;
    // pywebview 可直接访问原始文件时避免往返 base64；失败时兼容原桥接读取。
    const direct = localImageFileUrl(node.imageOrigin.path, node.imageOrigin.url);
    try {
      await this.loadImage(direct);
      return direct;
    } catch {
      const result = await Backend.loadLocalImage(node.imageOrigin.path);
      return result.status === 'success' && result.data_url ? result.data_url : fallback;
    }
  }

  private loadImage(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.source = new Image();
      this.source.onload = () => resolve();
      this.source.onerror = () => reject(new Error('image load failed'));
      this.source.src = src;
    });
  }

  private render(): void {
    this.close();
    const overlay = document.createElement('div');
    overlay.className = 'overlay image-editor-overlay';
    overlay.innerHTML = `
      <section class="image-editor-panel" role="dialog" aria-modal="true" aria-label="${this.mode === 'crop' ? '裁剪图片' : '切图'}">
        <header class="image-editor-head"><div><h2>${this.mode === 'crop' ? '裁剪图片' : '图片切图'}</h2><p>本地处理，不会调用生成模型</p></div><button data-ie="close" title="关闭">×</button></header>
        <div class="image-editor-body">
          <div class="image-editor-stage"><div class="image-editor-image-wrap" id="ie-image-wrap"><img id="ie-image" src="${escapeUrl(this.sourceUrl)}" alt="待编辑图片"><div id="ie-crop-frame" class="ie-crop-frame" hidden></div><div id="ie-grid" class="ie-grid" hidden></div></div></div>
          <aside class="image-editor-controls" id="ie-controls"></aside>
        </div>
        <footer><button class="btn-ghost" data-ie="cancel">取消</button><button class="btn-primary" data-ie="confirm">${this.mode === 'crop' ? '生成裁剪结果' : '生成切图结果'}</button></footer>
      </section>`;
    document.body.appendChild(overlay);
    this.overlay = overlay;
    overlay.addEventListener('click', e => this.onClick(e as MouseEvent));
    this.renderControls();
    requestAnimationFrame(() => this.renderStage());
  }

  private renderControls(): void {
    const controls = this.overlay?.querySelector('#ie-controls');
    if (!controls) return;
    if (this.mode === 'crop') {
      controls.innerHTML = `
        <label>比例</label><div class="ie-presets">${['free', '1:1', '3:4', '4:3', '16:9', '9:16'].map(v => `<button class="${this.ratio === v ? 'active' : ''}" data-ie-ratio="${v}">${v === 'free' ? '自由' : v}</button>`).join('')}</div>
        <label>旋转</label><div class="ie-row"><button data-ie="rotate">顺时针 90°</button><button data-ie="reset">重置</button></div>
        <p class="ie-hint">拖动裁剪框移动；拖右下角调节大小。</p>`;
    } else {
      const presets = [[2,2,'2×2'], [3,3,'3×3'], [1,2,'横向 2'], [1,3,'横向 3'], [1,4,'横向 4'], [2,1,'纵向 2'], [3,1,'纵向 3'], [4,1,'纵向 4']];
      controls.innerHTML = `
        <label>网格</label><div class="ie-presets">${presets.map(([r,c,label]) => `<button class="${this.split.rows === r && this.split.cols === c ? 'active' : ''}" data-ie-grid="${r},${c}">${label}</button>`).join('')}</div>
        <label class="ie-check"><input type="checkbox" data-ie="gutter" ${this.split.gutter ? 'checked' : ''}> 保留边缘余量</label>
        <p class="ie-hint">按从左到右、从上到下创建独立图片结果。</p>`;
    }
  }

  private renderStage(): void {
    const image = this.overlay?.querySelector('#ie-image') as HTMLImageElement | null;
    const wrap = this.overlay?.querySelector('#ie-image-wrap') as HTMLElement | null;
    if (!image || !wrap) return;
    image.style.transform = `rotate(${this.rotation}deg)`;
    image.style.maxWidth = this.rotation % 180 ? '72%' : '100%';
    const cropFrame = this.overlay?.querySelector('#ie-crop-frame') as HTMLElement | null;
    const grid = this.overlay?.querySelector('#ie-grid') as HTMLElement | null;
    if (this.mode === 'crop' && cropFrame) {
      cropFrame.hidden = false;
      if (grid) grid.hidden = true;
      cropFrame.style.left = `${this.crop.x * 100}%`;
      cropFrame.style.top = `${this.crop.y * 100}%`;
      cropFrame.style.width = `${this.crop.width * 100}%`;
      cropFrame.style.height = `${this.crop.height * 100}%`;
      this.bindCropDrag(cropFrame, wrap);
    } else if (grid) {
      grid.hidden = false;
      if (cropFrame) cropFrame.hidden = true;
      grid.style.setProperty('--ie-cols', String(this.split.cols));
      grid.style.setProperty('--ie-rows', String(this.split.rows));
      grid.innerHTML = Array.from({ length: this.split.rows * this.split.cols }, () => '<span></span>').join('');
    }
  }

  private bindCropDrag(frame: HTMLElement, wrap: HTMLElement): void {
    let drag: { startX: number; startY: number; crop: Crop; resize: boolean } | null = null;
    frame.onmousedown = e => {
      const rect = frame.getBoundingClientRect();
      drag = { startX: e.clientX, startY: e.clientY, crop: { ...this.crop }, resize: e.clientX > rect.right - 22 && e.clientY > rect.bottom - 22 };
      e.preventDefault(); e.stopPropagation();
    };
    window.onmousemove = e => {
      if (!drag) return;
      const r = wrap.getBoundingClientRect();
      const dx = (e.clientX - drag.startX) / r.width;
      const dy = (e.clientY - drag.startY) / r.height;
      if (drag.resize) {
        this.crop.width = Math.min(1 - drag.crop.x, Math.max(.08, drag.crop.width + dx));
        this.crop.height = Math.min(1 - drag.crop.y, Math.max(.08, drag.crop.height + dy));
        this.applyRatio();
      } else {
        this.crop.x = Math.min(1 - drag.crop.width, Math.max(0, drag.crop.x + dx));
        this.crop.y = Math.min(1 - drag.crop.height, Math.max(0, drag.crop.y + dy));
      }
      this.renderStage();
    };
    window.onmouseup = () => { drag = null; window.onmousemove = null; window.onmouseup = null; };
  }

  private onClick(e: MouseEvent): void {
    const target = (e.target as Element).closest('[data-ie], [data-ie-ratio], [data-ie-grid]') as HTMLElement | null;
    if (!target) { if (e.target === this.overlay) this.close(); return; }
    const action = target.dataset.ie;
    if (action === 'close' || action === 'cancel') { this.close(); return; }
    if (action === 'rotate') { this.rotation = (this.rotation + 90) % 360; this.renderStage(); return; }
    if (action === 'reset') { this.rotation = 0; this.ratio = 'free'; this.crop = { x:.08, y:.08, width:.84, height:.84 }; this.renderControls(); this.renderStage(); return; }
    if (action === 'gutter') { this.split.gutter = (target as HTMLInputElement).checked ? 8 : 0; return; }
    if (action === 'confirm') { void this.confirm(); return; }
    if (target.dataset.ieRatio) { this.ratio = target.dataset.ieRatio; this.applyRatio(); this.renderControls(); this.renderStage(); return; }
    if (target.dataset.ieGrid) { const [rows, cols] = target.dataset.ieGrid.split(',').map(Number); this.split = { ...this.split, rows, cols }; this.renderControls(); this.renderStage(); }
  }

  private applyRatio(): void {
    if (this.ratio === 'free') return;
    const [rw, rh] = this.ratio.split(':').map(Number);
    const imageRatio = this.rotatedSize().width / this.rotatedSize().height;
    const target = rw / rh;
    if (target > imageRatio) this.crop.height = Math.min(1 - this.crop.y, this.crop.width / target * imageRatio);
    else this.crop.width = Math.min(1 - this.crop.x, this.crop.height * target / imageRatio);
    this.crop.width = Math.max(.08, this.crop.width); this.crop.height = Math.max(.08, this.crop.height);
  }

  private rotatedSize(): { width: number; height: number } {
    return this.rotation % 180 ? { width: this.source.naturalHeight, height: this.source.naturalWidth } : { width: this.source.naturalWidth, height: this.source.naturalHeight };
  }

  private rotatedCanvas(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    const swapped = this.rotation % 180 !== 0;
    c.width = swapped ? this.source.naturalHeight : this.source.naturalWidth;
    c.height = swapped ? this.source.naturalWidth : this.source.naturalHeight;
    const ctx = c.getContext('2d')!;
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(this.rotation * Math.PI / 180);
    ctx.drawImage(this.source, -this.source.naturalWidth / 2, -this.source.naturalHeight / 2);
    return c;
  }

  private async confirm(): Promise<void> {
    const node = flowState.getNode(this.nodeId);
    if (!node) return;
    const button = this.overlay?.querySelector('[data-ie="confirm"]') as HTMLButtonElement | null;
    if (button) { button.disabled = true; button.textContent = '正在保存…'; }
    try {
      if (this.mode === 'crop') await this.saveCrop(node);
      else await this.saveSplit(node);
      this.close();
    } catch {
      showToast('本地图片保存失败；原图未被修改', false);
      if (button) { button.disabled = false; button.textContent = this.mode === 'crop' ? '生成裁剪结果' : '生成切图结果'; }
    }
  }

  private async persistCanvas(canvas: HTMLCanvasElement, name: string): Promise<{ url: string; origin: ImageOrigin | null; width: number; height: number }> {
    const saved = await Backend.prepareImportedImage(canvas.toDataURL('image/png'), name);
    if (saved.status !== 'success' || !saved.thumbnail_data_url) throw new Error(saved.message || 'save failed');
    return { url: saved.thumbnail_data_url, origin: saved.path ? { path: saved.path, url: saved.url } : null, width: canvas.width, height: canvas.height };
  }

  private addDerived(source: FlowNode, saved: { url: string; origin: ImageOrigin | null; width: number; height: number }, title: string, trace: GenerationTrace, x: number, y: number): FlowNode {
    const ratio = saved.width / saved.height || 4 / 3;
    const result = flowState.addNode('image-gen', x, y, {
      title, ratio, imageUrl: saved.url, imageOrigin: saved.origin, imageWidth: saved.width, imageHeight: saved.height,
      status: 'done', parentId: source.id, trace, params: { ...source.params }, imageAspectLocked: true,
    });
    flowState.addEdge(source.id, result.id, { suppressStale: true });
    const entry = {
      kind: 'image', nodeId: result.id, imageUrl: saved.url, thumbnail: saved.url,
      originalPath: saved.origin?.path, originalUrl: saved.origin?.url,
      prompt: '', model: 'local-canvas', aspectRatio: trace.aspectRatio, resolution: 'local', count: 1,
      refImageHashes: [], refImageUrls: trace.refImageUrls, seed: null, createdAt: trace.createdAt,
      parentId: source.id, outputType: 'image-edit', imageWidth: saved.width, imageHeight: saved.height,
    };
    void Backend.appendHistory(entry);
    window.dispatchEvent(new CustomEvent('icv:local-image-history', { detail: { src: saved.url, nodeId: result.id, trace, origin: saved.origin, width: saved.width, height: saved.height } }));
    return result;
  }

  private async saveCrop(source: FlowNode): Promise<void> {
    const original = this.rotatedCanvas();
    const x = Math.round(this.crop.x * original.width), y = Math.round(this.crop.y * original.height);
    const w = Math.max(1, Math.round(this.crop.width * original.width)), h = Math.max(1, Math.round(this.crop.height * original.height));
    const output = document.createElement('canvas'); output.width = Math.min(w, original.width - x); output.height = Math.min(h, original.height - y);
    output.getContext('2d')!.drawImage(original, x, y, output.width, output.height, 0, 0, output.width, output.height);
    const saved = await this.persistCanvas(output, `crop-${Date.now()}.png`);
    flowHistory.record();
    const trace: GenerationTrace = { prompt: '', model: 'local-canvas', aspectRatio: `${output.width}:${output.height}`, resolution: 'local', count: 1, refImageHashes: [], refImageUrls: source.imageUrl ? [source.imageUrl] : [], createdAt: Date.now(), parentId: source.id, outputType: 'image-edit', editKind: 'crop', sourceNodeId: source.id, crop: { x, y, width: output.width, height: output.height, rotation: this.rotation }, imageWidth: output.width, imageHeight: output.height };
    const result = this.addDerived(source, saved, '裁剪结果', trace, source.x + (source.w ?? CARD_W) + 48, source.y);
    selection.select(result.id);
    showToast('已生成裁剪结果');
  }

  private async saveSplit(source: FlowNode): Promise<void> {
    const original = this.rotatedCanvas();
    const { rows, cols, gutter } = this.split;
    const cellW = Math.floor((original.width - gutter * (cols - 1)) / cols), cellH = Math.floor((original.height - gutter * (rows - 1)) / rows);
    if (cellW < 1 || cellH < 1) throw new Error('grid too small');
    flowHistory.record();
    const created: FlowNode[] = [];
    for (let row = 0; row < rows; row += 1) for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col;
      const output = document.createElement('canvas'); output.width = cellW; output.height = cellH;
      output.getContext('2d')!.drawImage(original, col * (cellW + gutter), row * (cellH + gutter), cellW, cellH, 0, 0, cellW, cellH);
      const saved = await this.persistCanvas(output, `split-${Date.now()}-${String(index + 1).padStart(2, '0')}.png`);
      const trace: GenerationTrace = { prompt: '', model: 'local-canvas', aspectRatio: `${cellW}:${cellH}`, resolution: 'local', count: 1, refImageHashes: [], refImageUrls: source.imageUrl ? [source.imageUrl] : [], createdAt: Date.now(), parentId: source.id, outputType: 'image-edit', editKind: 'split', sourceNodeId: source.id, split: { rows, cols, index, row, column: col, gutter }, imageWidth: cellW, imageHeight: cellH };
      created.push(this.addDerived(source, saved, `切图 ${index + 1}/${rows * cols}`, trace, source.x + (source.w ?? CARD_W) + 48 + col * (CARD_W + 36), source.y + row * (imageCardHeight(cellW / cellH) + 36)));
    }
    if (created[0]) selection.select(created[0].id);
    showToast(`已生成 ${created.length} 个切图结果`);
  }
}

function escapeUrl(value: string): string { return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }

export const imageEditor = new ImageEditor();
