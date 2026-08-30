// 批注修改：本地仅合成“原图 + 红色批注”参考图，不做对象识别或自动蒙版。
// 远端图片模型同时收到原图和批注图，据此理解用户用画笔/箭头标出的修改位置。

import { Backend, localImageFileUrl } from '../../api';
import { flowState } from '../../state/flow-state';
import { selection } from '../../state/selection';
import { imageEditEngine } from '../../engine/image-edit-engine';
import { getImageEditCapabilities } from '../../nodes/model-config';
import { showToast } from '../toast';

const ANNOTATION_MAX_EDGE = 2048;
const UNDO_LIMIT = 20;
type Tool = 'pen' | 'arrow';
type Point = { x: number; y: number };

class AnnotationEditor {
  private overlay: HTMLElement | null = null;
  private nodeId = '';
  private source = new Image();
  private sourceUrl = '';
  private stage: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private undoStack: ImageData[] = [];
  private redoStack: ImageData[] = [];
  private drawing = false;
  private lastPoint: Point | null = null;
  private arrowStart: Point | null = null;
  private tool: Tool = 'pen';
  private brushSize = 18;
  private prompt = '';
  private hasMarks = false;
  private running = false;
  private currentTaskNodeId = '';

  init(): void {
    // Overlay is created lazily.
  }

  async open(nodeId: string): Promise<void> {
    const node = flowState.getNode(nodeId);
    if (!node || node.type !== 'image-gen') return;
    const fallback = node.imageUrl || flowState.getReferenceImages(nodeId)[0];
    if (!fallback) { showToast('该节点没有可批注的图片', false); return; }
    const model = this.modelFor(node);
    if (!getImageEditCapabilities(model).imageReference) {
      showToast('当前模型不支持图片参考，无法使用批注修改', false);
      return;
    }

    this.close();
    this.nodeId = nodeId;
    this.prompt = String((node.params as unknown as StyleTransferParams).prompt || '');
    this.tool = 'pen';
    this.brushSize = 18;
    this.undoStack = [];
    this.redoStack = [];
    this.hasMarks = false;
    try {
      this.sourceUrl = await this.loadSource(node, fallback);
      await this.loadImage(this.sourceUrl);
      // 参考图可能只有临时 URL。编辑前先落盘，之后图片编辑引擎可稳定读取原图。
      if (!node.imageOrigin?.path) {
        const persisted = await Backend.prepareImportedImage(this.sourceUrl, `annotation-source-${Date.now()}.png`);
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
      showToast('原图加载失败，无法批注', false);
    }
  }

  close(): void {
    if (this.running && this.currentTaskNodeId) imageEditEngine.cancel(this.currentTaskNodeId);
    this.removeOverlay();
    this.nodeId = '';
    this.running = false;
    this.currentTaskNodeId = '';
    this.drawing = false;
    this.lastPoint = null;
    this.arrowStart = null;
  }

  private removeOverlay(): void {
    this.overlay?.remove();
    this.overlay = null;
    this.stage = null;
    this.ctx = null;
  }

  private modelFor(node: FlowNode): string {
    return String((node.params as unknown as StyleTransferParams).model || flowState.getModelDefault('drawing') || '');
  }

  private async loadSource(node: FlowNode, fallback: string): Promise<string> {
    if (!node.imageOrigin?.path) return fallback;
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
    const scale = Math.min(1, ANNOTATION_MAX_EDGE / Math.max(this.source.naturalWidth, this.source.naturalHeight));
    const width = Math.max(1, Math.round(this.source.naturalWidth * scale));
    const height = Math.max(1, Math.round(this.source.naturalHeight * scale));
    const overlay = document.createElement('div');
    overlay.className = 'overlay image-editor-overlay annotation-editor-overlay';
    overlay.innerHTML = `
      <section class="image-editor-panel annotation-editor-panel" role="dialog" aria-modal="true" aria-label="批注修改">
        <header class="image-editor-head">
          <div><h2>批注修改</h2><p>在图上圈选或画箭头，再说明要改什么。批注图会和原图一起发送给远端模型。</p></div>
          <button data-ae="close" title="关闭">×</button>
        </header>
        <div class="image-editor-body">
          <div class="annotation-editor-stage-wrap"><canvas id="ae-stage" width="${width}" height="${height}"></canvas></div>
          <aside class="image-editor-controls annotation-editor-controls">
            <label>标注工具</label>
            <div class="ie-row"><button type="button" data-ae="pen" class="active">画笔</button><button type="button" data-ae="arrow">箭头</button></div>
            <label>笔刷大小 <output id="ae-size-value">${this.brushSize}px</output></label>
            <input id="ae-size" type="range" min="4" max="80" step="2" value="${this.brushSize}">
            <div class="ie-row"><button type="button" data-ae="undo">撤销</button><button type="button" data-ae="redo">重做</button><button type="button" data-ae="clear">清空</button></div>
            <label>修改要求</label>
            <textarea id="ae-prompt" rows="4" placeholder="例如：把箭头指向的杯子替换成透明玻璃杯，保留其他元素" spellcheck="false"></textarea>
            <div class="ae-model" id="ae-model"></div>
            <p class="ie-hint">红色批注只帮助模型理解位置，不会出现在最终结果中。需要像素级准确范围时，请使用“蒙版局部修改”。</p>
          </aside>
        </div>
        <footer><button class="btn-ghost" data-ae="cancel">取消</button><button class="btn-primary" data-ae="confirm">按批注生成</button></footer>
      </section>`;
    document.body.appendChild(overlay);
    this.overlay = overlay;
    this.stage = overlay.querySelector('#ae-stage') as HTMLCanvasElement;
    this.ctx = this.stage.getContext('2d', { willReadFrequently: true });
    this.redrawBase();
    const promptInput = overlay.querySelector('#ae-prompt') as HTMLTextAreaElement;
    promptInput.value = this.prompt;
    promptInput.addEventListener('input', () => { this.prompt = promptInput.value; });
    const node = flowState.getNode(this.nodeId);
    const modelLabel = overlay.querySelector('#ae-model');
    if (modelLabel && node) modelLabel.textContent = `模型：${this.modelFor(node) || '未选择'}`;
    (overlay.querySelector('#ae-size') as HTMLInputElement).addEventListener('input', event => {
      this.brushSize = Number((event.target as HTMLInputElement).value || 18);
      const output = overlay.querySelector('#ae-size-value');
      if (output) output.textContent = `${this.brushSize}px`;
    });
    overlay.addEventListener('click', event => this.onClick(event as MouseEvent));
    this.bindDrawing();
  }

  private redrawBase(): void {
    if (!this.stage || !this.ctx) return;
    this.ctx.clearRect(0, 0, this.stage.width, this.stage.height);
    this.ctx.drawImage(this.source, 0, 0, this.stage.width, this.stage.height);
  }

  private bindDrawing(): void {
    const stage = this.stage;
    if (!stage) return;
    stage.addEventListener('pointerdown', event => {
      event.preventDefault();
      stage.setPointerCapture(event.pointerId);
      const point = this.pointFrom(event);
      if (!point) return;
      this.pushUndo();
      this.drawing = true;
      this.lastPoint = point;
      this.arrowStart = this.tool === 'arrow' ? point : null;
      if (this.tool === 'pen') this.drawLine(point, point);
    });
    stage.addEventListener('pointermove', event => {
      if (!this.drawing || this.tool !== 'pen' || !this.lastPoint) return;
      const point = this.pointFrom(event);
      if (!point) return;
      this.drawLine(this.lastPoint, point);
      this.lastPoint = point;
    });
    const end = (event: PointerEvent) => {
      if (!this.drawing) return;
      const point = this.pointFrom(event);
      if (this.tool === 'arrow' && this.arrowStart && point) this.drawArrow(this.arrowStart, point);
      this.drawing = false;
      this.lastPoint = null;
      this.arrowStart = null;
      this.hasMarks = true;
      if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
  }

  private pointFrom(event: PointerEvent): Point | null {
    const stage = this.stage;
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.max(0, Math.min(stage.width, (event.clientX - rect.left) * stage.width / rect.width)),
      y: Math.max(0, Math.min(stage.height, (event.clientY - rect.top) * stage.height / rect.height)),
    };
  }

  private drawLine(from: Point, to: Point): void {
    if (!this.ctx) return;
    this.ctx.save();
    this.ctx.strokeStyle = '#ef4444';
    this.ctx.lineWidth = this.brushSize;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.beginPath();
    this.ctx.moveTo(from.x, from.y);
    this.ctx.lineTo(to.x + .01, to.y + .01);
    this.ctx.stroke();
    this.ctx.restore();
  }

  private drawArrow(from: Point, to: Point): void {
    if (!this.ctx) return;
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const head = Math.max(14, this.brushSize * 1.8);
    this.drawLine(from, to);
    this.ctx.save();
    this.ctx.fillStyle = '#ef4444';
    this.ctx.beginPath();
    this.ctx.moveTo(to.x, to.y);
    this.ctx.lineTo(to.x - head * Math.cos(angle - Math.PI / 6), to.y - head * Math.sin(angle - Math.PI / 6));
    this.ctx.lineTo(to.x - head * Math.cos(angle + Math.PI / 6), to.y - head * Math.sin(angle + Math.PI / 6));
    this.ctx.closePath();
    this.ctx.fill();
    this.ctx.restore();
  }

  private pushUndo(): void {
    if (!this.stage || !this.ctx) return;
    this.undoStack.push(this.ctx.getImageData(0, 0, this.stage.width, this.stage.height));
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  private undo(): void {
    if (!this.stage || !this.ctx || this.undoStack.length === 0) return;
    this.redoStack.push(this.ctx.getImageData(0, 0, this.stage.width, this.stage.height));
    this.ctx.putImageData(this.undoStack.pop()!, 0, 0);
    this.hasMarks = this.undoStack.length > 0;
  }

  private redo(): void {
    if (!this.stage || !this.ctx || this.redoStack.length === 0) return;
    this.undoStack.push(this.ctx.getImageData(0, 0, this.stage.width, this.stage.height));
    this.ctx.putImageData(this.redoStack.pop()!, 0, 0);
    this.hasMarks = true;
  }

  private clear(): void {
    this.pushUndo();
    this.redrawBase();
    this.hasMarks = false;
  }

  private onClick(event: MouseEvent): void {
    const target = (event.target as Element).closest<HTMLElement>('[data-ae]');
    if (!target) return;
    const action = target.dataset.ae;
    if (action === 'close' || action === 'cancel') { this.close(); return; }
    if (action === 'pen' || action === 'arrow') {
      this.tool = action;
      this.overlay?.querySelectorAll('[data-ae="pen"], [data-ae="arrow"]').forEach(button => button.classList.toggle('active', (button as HTMLElement).dataset.ae === action));
      return;
    }
    if (action === 'undo') { this.undo(); return; }
    if (action === 'redo') { this.redo(); return; }
    if (action === 'clear') { this.clear(); return; }
    if (action === 'confirm') void this.submit();
  }

  private async submit(): Promise<void> {
    const node = flowState.getNode(this.nodeId);
    if (!node || !this.stage) return;
    const prompt = this.prompt.trim();
    if (!prompt) { showToast('请填写修改要求', false); return; }
    if (!this.hasMarks) { showToast('请先画出需要修改的位置', false); return; }
    const model = this.modelFor(node);
    if (!getImageEditCapabilities(model).imageReference) { showToast('当前模型不支持图片参考，无法使用批注修改', false); return; }
    const button = this.overlay?.querySelector('[data-ae="confirm"]') as HTMLButtonElement | null;
    if (button) { button.disabled = true; button.textContent = '提交中…'; }
    this.running = true;
    try {
      const editPrompt = `第一张图是原图；第二张图是同一张图的红色批注版。严格依据第二张图的红色圈选和箭头，在第一张原图对应位置完成修改。不要在结果中保留任何红色批注、箭头或涂鸦。\n\n用户要求：${prompt}`;
      const result = await imageEditEngine.start({
        kind: 'annotation', sourceId: this.nodeId, prompt: editPrompt, model,
        additionalReferenceImages: [this.stage.toDataURL('image/png')],
        onNodeCreated: nodeId => { this.currentTaskNodeId = nodeId; },
      });
      if (result.ok) {
        this.running = false;
        this.currentTaskNodeId = '';
        this.removeOverlay();
        if (result.nodeId) selection.select(result.nodeId);
      } else if (!result.cancelled) {
        showToast(result.error || '批注修改失败，请调整后重试', false);
      }
    } finally {
      this.running = false;
      if (button) { button.disabled = false; button.textContent = '按批注生成'; }
    }
  }
}

export const annotationEditor = new AnnotationEditor();
