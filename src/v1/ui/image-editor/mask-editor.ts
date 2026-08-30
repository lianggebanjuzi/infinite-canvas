// 4.1-B 蒙版局部修改编辑器。
// 交互：笔刷大小 / 橡皮 / 撤销重做 / 半透明蒙版预览（白=允许修改，黑/透明=保留）/ 缩放 / 清空；
// 提交前展示原图+蒙版+提示词+模型；失败时保留蒙版与提示词，可修改后新建重试（绝不重复提交同一远端任务）。
// 蒙版只在提交瞬间生成压缩 PNG dataURL 并落盘本地路径，不长期把大 base64 塞进节点 JSON / trace。

import { Backend, localImageFileUrl } from '../../api';
import { flowState } from '../../state/flow-state';
import { selection } from '../../state/selection';
import { imageEditEngine } from '../../engine/image-edit-engine';
import { getImageEditCapabilities } from '../../nodes/model-config';
import { showToast } from '../toast';

/** 蒙版画布最长边上限（源图过大时按比例缩小；提交时再放大回源图尺寸对齐模型输入） */
const MASK_MAX_EDGE = 4096;
const UNDO_LIMIT = 30;

/** 一次绘制快照（整幅 ImageData；仅笔划开始时压栈，避免撤销栈被每帧撑爆） */
interface MaskSnapshot {
  data: ImageData;
  w: number;
  h: number;
}

class MaskEditor {
  private overlay: HTMLElement | null = null;
  private nodeId = '';
  private source = new Image();
  private sourceUrl = '';
  private sourceW = 0;
  private sourceH = 0;

  /** 蒙版画布（离屏；灰阶，白=允许修改） */
  private mask: HTMLCanvasElement | null = null;
  private maskCtx: CanvasRenderingContext2D | null = null;

  private undoStack: MaskSnapshot[] = [];
  private redoStack: MaskSnapshot[] = [];

  private brushSize = 32;
  private erasing = false;
  private zoom = 1;
  /** 修改提示词（跨控件重渲染保留；失败重试时不清空） */
  private prompt = '';

  /** 提交后任务仍在跑（等待 start() 终态）；此时关闭 = 取消本地等待（远端任务保留记录，不重投） */
  private running = false;
  private currentTaskNodeId = '';

  // ── P2-3 蒙版临时文件延迟清理 ──
  /** 本会话生成过的 mask 文件路径（成功任务除外，它们已在成功时排入 10 分钟延迟清理） */
  private createdMasks: string[] = [];
  /** 成功任务的 mask 文件（任务已完成，结果图独立落盘；trace 仅记录路径信息 → 10 分钟后清理） */
  private succeededMasks = new Set<string>();
  /** 已排入清理的文件（去重，避免同一路径多个定时器） */
  private scheduledMasks = new Set<string>();
  private scheduledMaskTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private painting = false;
  private lastPoint: { x: number; y: number } | null = null;

  // DOM 引用
  private stage: HTMLCanvasElement | null = null;
  private stageCtx: CanvasRenderingContext2D | null = null;
  private promptInput: HTMLTextAreaElement | null = null;
  private modelLabel: HTMLElement | null = null;
  private confirmBtn: HTMLButtonElement | null = null;
  private brushInput: HTMLInputElement | null = null;
  private zoomInput: HTMLInputElement | null = null;

  init(): void {
    // 编辑器 overlay 懒创建，静态壳无需预留 DOM
  }

  /** 打开蒙版编辑器；模型不支持 mask 时拒绝并提示（入口本应已按能力门控隐藏）。 */
  async open(nodeId: string): Promise<void> {
    const node = flowState.getNode(nodeId);
    if (!node || node.type !== 'image-gen') return;
    const fallback = node.imageUrl || flowState.getReferenceImages(nodeId)[0];
    if (!fallback) { showToast('该节点没有可编辑的图片', false); return; }
    const caps = getImageEditCapabilities((node.params as unknown as StyleTransferParams).model || '');
    if (!caps.mask) { showToast('当前模型不支持蒙版局部修改', false); return; }
    this.nodeId = nodeId;
    this.running = false;
    this.currentTaskNodeId = '';
    this.undoStack = [];
    this.redoStack = [];
    this.brushSize = 32;
    this.erasing = false;
    this.zoom = 1;
    this.prompt = String((node.params as unknown as StyleTransferParams).prompt || '');
    this.createdMasks = []; // 新会话从空开始；旧文件已由成功/取消/失败路径排入清理
    try {
      this.sourceUrl = await this.loadSource(node, fallback);
      await this.loadImage(this.sourceUrl);
      if (!node.imageOrigin?.path) {
        const persisted = await Backend.prepareImportedImage(this.sourceUrl, `mask-source-${Date.now()}.png`);
        if (persisted.status === 'success' && persisted.path) {
          flowState.updateNode(node.id, {
            imageUrl: persisted.thumbnail_data_url || node.imageUrl,
            imageOrigin: { path: persisted.path, url: persisted.url },
          });
          this.sourceUrl = localImageFileUrl(persisted.path, persisted.url);
          await this.loadImage(this.sourceUrl);
        }
      }
      this.sourceW = this.source.naturalWidth;
      this.sourceH = this.source.naturalHeight;
      this.initMask();
      this.render();
    } catch {
      showToast('原图加载失败，无法编辑', false);
    }
  }

  close(): void {
    if (this.running && this.currentTaskNodeId) {
      imageEditEngine.cancel(this.currentTaskNodeId); // 关闭 = 取消本地等待；远端任务不会被重复提交
    }
    // P2-3：关闭编辑器 = 取消/放弃 → 本会话「未成功」的蒙版临时文件立即延迟清理
    // （成功任务的 mask 文件已单独排入 10 分钟延迟清理，不受影响）。
    this.createdMasks.forEach(path => {
      if (this.succeededMasks.has(path)) return;
      this.scheduleMaskDelete(path, 1000);
    });
    this.createdMasks = [];
    this.overlay?.remove();
    this.overlay = null;
    this.mask = null;
    this.maskCtx = null;
    this.nodeId = '';
    this.running = false;
    this.currentTaskNodeId = '';
    this.painting = false;
  }

  /**
   * P2-3：把蒙版临时文件排入延迟清理（幂等去重；后端有路径白名单校验）。
   * 成功任务的 mask 在任务完成前绝不删除（trace 引用中），确认成功后才延迟清理。
   */
  private scheduleMaskDelete(path: string | undefined, delayMs: number): void {
    if (!path || this.scheduledMasks.has(path)) return;
    this.scheduledMasks.add(path);
    const timer = setTimeout(() => {
      this.scheduledMaskTimers.delete(path);
      void Backend.deleteTempFile(path).catch(() => {});
    }, delayMs);
    this.scheduledMaskTimers.set(path, timer);
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

  /** 初始化离屏蒙版画布：全黑（保留）；尺寸按源图最长边上限缩放。 */
  private initMask(): void {
    const scale = Math.min(1, MASK_MAX_EDGE / Math.max(this.sourceW, this.sourceH));
    const w = Math.max(1, Math.round(this.sourceW * scale));
    const h = Math.max(1, Math.round(this.sourceH * scale));
    this.mask = document.createElement('canvas');
    this.mask.width = w;
    this.mask.height = h;
    this.maskCtx = this.mask.getContext('2d', { willReadFrequently: true });
    if (this.maskCtx) {
      this.maskCtx.fillStyle = '#000';
      this.maskCtx.fillRect(0, 0, w, h);
    }
  }

  // ───────────────────────── 渲染 ─────────────────────────

  private render(): void {
    // 这里只能替换旧的弹层，不能调用 close()：close 会清空 nodeId 和离屏 mask，
    // 导致刚打开的编辑器失去源图，提交时也无法创建编辑任务。
    this.overlay?.remove();
    this.overlay = null;
    const overlay = document.createElement('div');
    overlay.className = 'overlay image-editor-overlay mask-editor-overlay';
    overlay.innerHTML = `
      <section class="image-editor-panel mask-editor-panel" role="dialog" aria-modal="true" aria-label="蒙版局部修改">
        <header class="image-editor-head">
          <div><h2>蒙版局部修改</h2><p>白色区域=允许修改；黑色/透明=保留。仅会发送白色区域相关的修改请求。</p></div>
          <button data-me="close" title="关闭">×</button>
        </header>
        <div class="image-editor-body">
          <div class="mask-editor-stage-wrap">
            <div class="mask-editor-stage" id="me-stage-wrap" style="transform:scale(var(--me-zoom,1));transform-origin:0 0;">
              <canvas id="me-stage"></canvas>
            </div>
          </div>
          <aside class="image-editor-controls mask-editor-controls" id="me-controls"></aside>
        </div>
        <footer class="mask-editor-foot">
          <button class="btn-ghost" data-me="cancel">取消</button>
          <button class="btn-primary" data-me="confirm">提交生成</button>
        </footer>
      </section>`;
    document.body.appendChild(overlay);
    this.overlay = overlay;
    overlay.addEventListener('click', e => this.onClick(e as MouseEvent));
    this.stage = overlay.querySelector('#me-stage') as HTMLCanvasElement | null;
    this.stageCtx = this.stage?.getContext('2d') ?? null;
    this.promptInput = overlay.querySelector('#me-prompt') as HTMLTextAreaElement | null;
    this.modelLabel = overlay.querySelector('#me-model') as HTMLElement | null;
    this.confirmBtn = overlay.querySelector('[data-me="confirm"]') as HTMLButtonElement | null;
    this.renderControls();
    this.bindPaint();
    requestAnimationFrame(() => this.renderStage());
  }

  private renderControls(): void {
    const controls = this.overlay?.querySelector('#me-controls');
    if (!controls) return;
    controls.innerHTML = `
      <label>笔刷大小 <output id="me-brush-value">${this.brushSize}px</output></label>
      <input type="range" id="me-brush" min="4" max="200" step="2" value="${this.brushSize}">
      <div class="ie-row">
        <button type="button" data-me="brush" class="${!this.erasing ? 'active' : ''}">笔刷</button>
        <button type="button" data-me="eraser" class="${this.erasing ? 'active' : ''}">橡皮</button>
        <button type="button" data-me="undo">撤销</button>
        <button type="button" data-me="redo">重做</button>
        <button type="button" data-me="clear">清空</button>
      </div>
      <label>缩放 <output id="me-zoom-value">${Math.round(this.zoom * 100)}%</output></label>
      <input type="range" id="me-zoom" min="0.5" max="3" step="0.05" value="${this.zoom}">
      <label>修改提示词</label>
      <textarea id="me-prompt" rows="3" placeholder="描述希望改动的区域与效果，例如：把背景替换成浅灰水泥墙，加一盆绿萝" spellcheck="false">${escapeAttr(this.prompt)}</textarea>
      <div class="me-model" id="me-model"></div>
      <p class="ie-hint">提交前可检查右侧原图与蒙版叠加效果；生成失败会保留蒙版和提示词，可修改后重试。</p>`;
    this.brushInput = controls.querySelector('#me-brush') as HTMLInputElement | null;
    this.zoomInput = controls.querySelector('#me-zoom') as HTMLInputElement | null;
    this.promptInput = controls.querySelector('#me-prompt') as HTMLTextAreaElement | null;
    this.modelLabel = controls.querySelector('#me-model') as HTMLElement | null;
    this.promptInput?.addEventListener('input', () => { this.prompt = this.promptInput?.value || ''; });
    this.brushInput?.addEventListener('input', () => {
      this.brushSize = Number(this.brushInput?.value || 32);
      const out = controls.querySelector('#me-brush-value');
      if (out) out.textContent = `${this.brushSize}px`;
    });
    this.zoomInput?.addEventListener('input', () => {
      this.zoom = Number(this.zoomInput?.value || 1);
      const wrap = this.overlay?.querySelector('#me-stage-wrap') as HTMLElement | null;
      if (wrap) wrap.style.setProperty('--me-zoom', String(this.zoom));
      const out = controls.querySelector('#me-zoom-value');
      if (out) out.textContent = `${Math.round(this.zoom * 100)}%`;
      this.renderStage();
    });
    const node = this.nodeId ? flowState.getNode(this.nodeId) : null;
    if (this.modelLabel && node) {
      const modelId = String((node.params as unknown as StyleTransferParams).model || '');
      this.modelLabel.textContent = `模型：${this.shortModel(modelId)}`;
    }
  }

  /** 主显示：源图 + 半透明红色蒙版叠加（红=允许修改区域）。 */
  private renderStage(): void {
    if (!this.stage || !this.stageCtx || !this.mask) return;
    const wrap = this.overlay?.querySelector('#me-stage-wrap') as HTMLElement | null;
    const maxW = Math.max(260, (wrap?.clientWidth || 620) - 16);
    const maxH = Math.max(240, (wrap?.clientHeight || 460) - 16);
    const k = Math.min(maxW / this.sourceW, maxH / this.sourceH);
    const dispW = Math.max(1, Math.round(this.sourceW * k));
    const dispH = Math.max(1, Math.round(this.sourceH * k));
    this.stage.width = dispW;
    this.stage.height = dispH;
    this.stage.style.width = dispW + 'px';
    this.stage.style.height = dispH + 'px';
    const ctx = this.stageCtx;
    ctx.clearRect(0, 0, dispW, dispH);
    ctx.drawImage(this.source, 0, 0, dispW, dispH);
    // 红色半透明覆盖：只保留蒙版不透明（白）区域
    const tint = document.createElement('canvas');
    tint.width = dispW;
    tint.height = dispH;
    const tctx = tint.getContext('2d');
    if (tctx) {
      tctx.fillStyle = 'rgba(232,76,76,0.45)';
      tctx.fillRect(0, 0, dispW, dispH);
      tctx.globalCompositeOperation = 'destination-in';
      tctx.drawImage(this.mask, 0, 0, dispW, dispH);
      ctx.drawImage(tint, 0, 0);
    }
    // 蒙版边缘淡线辅助
    ctx.strokeStyle = 'rgba(232,76,76,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, dispW - 1, dispH - 1);
  }

  // ───────────────────────── 绘制 ─────────────────────────

  private bindPaint(): void {
    const stage = this.stage;
    if (!stage) return;
    const wrap = this.overlay?.querySelector('#me-stage-wrap') as HTMLElement | null;

    stage.addEventListener('pointerdown', (e: PointerEvent) => {
      if (!this.maskCtx || !this.mask) return;
      stage.setPointerCapture?.(e.pointerId);
      this.pushUndo();
      this.painting = true;
      const p = this.toMaskPoint(e, stage);
      if (p === null) return;
      this.lastPoint = p;
      this.paintAt(p.x, p.y);
      this.renderStage();
    });
    window.addEventListener('pointermove', (e: PointerEvent) => {
      if (!this.painting || !this.lastPoint) return;
      const p = this.toMaskPoint(e, stage);
      if (p === null) return;
      this.paintLine(this.lastPoint.x, this.lastPoint.y, p.x, p.y);
      this.lastPoint = p;
      this.renderStage();
    });
    window.addEventListener('pointerup', () => { this.painting = false; this.lastPoint = null; });
    if (wrap) {
      wrap.addEventListener('wheel', (e: WheelEvent) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        this.zoom = Math.min(3, Math.max(0.5, this.zoom * factor));
        wrap.style.setProperty('--me-zoom', String(this.zoom));
        if (this.zoomInput) this.zoomInput.value = String(this.zoom);
        const out = this.overlay?.querySelector('#me-zoom-value');
        if (out) out.textContent = `${Math.round(this.zoom * 100)}%`;
      }, { passive: false });
    }
  }

  /** 屏幕坐标 → 蒙版画布坐标（含缩放与显示缩放换算） */
  private toMaskPoint(e: PointerEvent, stage: HTMLCanvasElement): { x: number; y: number } | null {
    if (!this.mask) return null;
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const mx = ((e.clientX - rect.left) / rect.width) * this.mask.width;
    const my = ((e.clientY - rect.top) / rect.height) * this.mask.height;
    return { x: mx, y: my };
  }

  private paintAt(x: number, y: number): void {
    if (!this.maskCtx || !this.mask) return;
    this.maskCtx.save();
    this.maskCtx.globalCompositeOperation = this.erasing ? 'destination-out' : 'source-over';
    this.maskCtx.fillStyle = this.erasing ? 'rgba(0,0,0,1)' : 'rgba(255,255,255,1)';
    this.maskCtx.beginPath();
    this.maskCtx.arc(x, y, this.brushSize / 2, 0, Math.PI * 2);
    this.maskCtx.fill();
    this.maskCtx.restore();
  }

  private paintLine(x0: number, y0: number, x1: number, y1: number): void {
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(dist / (this.brushSize / 3)));
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      this.paintAt(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
    }
  }

  private pushUndo(): void {
    if (!this.maskCtx || !this.mask) return;
    this.undoStack.push({ data: this.maskCtx.getImageData(0, 0, this.mask.width, this.mask.height), w: this.mask.width, h: this.mask.height });
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  private undo(): void {
    if (!this.maskCtx || !this.mask || this.undoStack.length === 0) return;
    this.redoStack.push({ data: this.maskCtx.getImageData(0, 0, this.mask.width, this.mask.height), w: this.mask.width, h: this.mask.height });
    const snap = this.undoStack.pop()!;
    this.maskCtx.putImageData(snap.data, 0, 0);
    this.renderStage();
  }

  private redo(): void {
    if (!this.maskCtx || !this.mask || this.redoStack.length === 0) return;
    this.undoStack.push({ data: this.maskCtx.getImageData(0, 0, this.mask.width, this.mask.height), w: this.mask.width, h: this.mask.height });
    const snap = this.redoStack.pop()!;
    this.maskCtx.putImageData(snap.data, 0, 0);
    this.renderStage();
  }

  private clearMask(): void {
    if (!this.maskCtx || !this.mask) return;
    this.pushUndo();
    this.maskCtx.fillStyle = '#000';
    this.maskCtx.fillRect(0, 0, this.mask.width, this.mask.height);
    this.renderStage();
  }

  // ───────────────────────── 交互与提交 ─────────────────────────

  private onClick(e: MouseEvent): void {
    const target = (e.target as Element).closest('[data-me]') as HTMLElement | null;
    if (!target) { if (e.target === this.overlay) this.close(); return; }
    const action = target.dataset.me;
    if (action === 'close' || action === 'cancel') { this.close(); return; }
    if (action === 'brush') { this.erasing = false; this.renderControls(); return; }
    if (action === 'eraser') { this.erasing = true; this.renderControls(); return; }
    if (action === 'undo') { this.undo(); return; }
    if (action === 'redo') { this.redo(); return; }
    if (action === 'clear') { this.clearMask(); return; }
    if (action === 'confirm') { void this.submit(); return; }
  }

  /** 是否存在可编辑（白色）像素；全黑蒙版提交无意义。 */
  private hasEditablePixels(): boolean {
    if (!this.maskCtx || !this.mask) return false;
    const data = this.maskCtx.getImageData(0, 0, this.mask.width, this.mask.height).data;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 0) return true;
    }
    return false;
  }

  private async submit(): Promise<void> {
    if (this.running) return;
    const node = flowState.getNode(this.nodeId);
    if (!node || !this.mask || !this.maskCtx) return;
    const prompt = (this.promptInput?.value || this.prompt || '').trim();
    this.prompt = prompt;
    if (!prompt) { showToast('请填写修改提示词', false); return; }
    if (!this.hasEditablePixels()) { showToast('请先用笔刷涂抹要修改的区域（白色）', false); return; }
    const model = String((node.params as unknown as StyleTransferParams).model || '');
    const caps = getImageEditCapabilities(model);
    if (!caps.mask) { showToast('当前模型不支持蒙版局部修改', false); return; }

    // 提交快照：蒙版放大回源图尺寸 → 压缩 PNG dataURL → 落盘本地路径（不长期持有大 base64）
    const fullSize = document.createElement('canvas');
    fullSize.width = this.sourceW;
    fullSize.height = this.sourceH;
    const fctx = fullSize.getContext('2d');
    if (!fctx) { showToast('蒙版合成失败', false); return; }
    fctx.fillStyle = '#000';
    fctx.fillRect(0, 0, this.sourceW, this.sourceH);
    fctx.drawImage(this.mask, 0, 0, this.sourceW, this.sourceH);
    const maskDataUrl = fullSize.toDataURL('image/png');
    let maskPath: string | undefined;
    try {
      const persisted = await Backend.prepareImportedImage(maskDataUrl, `mask-${Date.now()}.png`);
      if (persisted.status === 'success' && persisted.path) {
        maskPath = persisted.path;
        this.createdMasks.push(maskPath);
      }
    } catch {
      // 落盘失败不阻断提交：蒙版仍以一次性 dataURL 发送（不长期保存）
    }

    if (this.confirmBtn) {
      this.confirmBtn.disabled = true;
      this.confirmBtn.textContent = '提交中…';
    }
    this.running = true;
    try {
      const result = await imageEditEngine.start({
        kind: 'mask-edit',
        sourceId: this.nodeId,
        prompt,
        model,
        maskData: maskDataUrl,
        mask: { path: maskPath, width: this.sourceW, height: this.sourceH },
        onNodeCreated: nodeId => { this.currentTaskNodeId = nodeId; },
      });
      if (result.ok) {
        // P2-3：任务已完成（结果图已独立落盘），mask 文件仅在 trace 记路径 → 10 分钟延迟清理
        if (maskPath) this.succeededMasks.add(maskPath);
        this.scheduleMaskDelete(maskPath, 10 * 60 * 1000);
        this.running = false;
        this.overlay?.remove();
        this.overlay = null;
        if (result.nodeId) selection.select(result.nodeId);
        showToast('局部修改完成');
      } else if (result.cancelled) {
        // 用户取消：该 mask 文件不再需要 → 延迟清理（close() 也会兜底）
        this.scheduleMaskDelete(maskPath, 1000);
        this.running = false;
      } else {
        // 失败：保留蒙版与提示词，可修改后重试（重试创建新本地任务）；旧 mask 文件不再需要 → 延迟清理
        this.scheduleMaskDelete(maskPath, 60 * 1000);
        this.running = false;
        showToast(result.error || '局部修改失败，请调整后重试', false);
      }
    } finally {
      if (this.confirmBtn) {
        this.confirmBtn.disabled = false;
        this.confirmBtn.textContent = '提交生成';
      }
    }
  }

  private shortModel(modelId: string): string {
    const bare = modelId.split(':').pop() || modelId;
    return bare || '未选择模型';
  }
}

function escapeAttr(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const maskEditor = new MaskEditor();
