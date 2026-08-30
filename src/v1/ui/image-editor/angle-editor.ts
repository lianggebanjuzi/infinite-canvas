// 4.1-B 多角度 / 视角变化编辑器。
// 对一张源图加上明确视角预设/自定义文字，调用支持图片参考的模型生成一张新视角图片。
// 不是自动转 3D：前端必须提示「生成式变化，不保证几何完全一致」；
// 结果 trace 写入预设、完整实际 prompt、源图 fingerprint、模型与任务 id（由 image-edit-engine 承担）。

import { Backend, localImageFileUrl } from '../../api';
import { flowState } from '../../state/flow-state';
import { selection } from '../../state/selection';
import { imageEditEngine } from '../../engine/image-edit-engine';
import { getImageEditCapabilities } from '../../nodes/model-config';
import { showToast } from '../toast';

interface AnglePreset {
  id: string;
  label: string;
  prefix: string; // 结构化提示前缀（原创文案）
}

const ANGLE_PRESETS: AnglePreset[] = [
  { id: 'front', label: '正面', prefix: '将画面主体改为正面视角，主体正对镜头，保持服装、环境与主体一致' },
  { id: 'left45', label: '左 45°', prefix: '将画面主体改为左侧 45 度视角，主体朝向画面左前方，保持服装、环境与主体一致' },
  { id: 'right45', label: '右 45°', prefix: '将画面主体改为右侧 45 度视角，主体朝向画面右前方，保持服装、环境与主体一致' },
  { id: 'side', label: '侧面', prefix: '将画面主体改为正侧面视角，主体侧对镜头，保持服装、环境与主体一致' },
  { id: 'top', label: '俯视', prefix: '将画面主体改为俯视视角，镜头从主体上方垂直向下拍摄，保持服装、环境与主体一致' },
  { id: 'bottom', label: '仰视', prefix: '将画面主体改为仰视视角，镜头从主体下方朝上拍摄，保持服装、环境与主体一致' },
  { id: 'back', label: '背面', prefix: '将画面主体改为背面视角，主体背对镜头，保持服装、环境与主体一致' },
];

class AngleEditor {
  private overlay: HTMLElement | null = null;
  private nodeId = '';
  private presetId = 'front';
  private running = false;
  private currentTaskNodeId = '';

  private descInput: HTMLTextAreaElement | null = null;
  private modelLabel: HTMLElement | null = null;
  private confirmBtn: HTMLButtonElement | null = null;
  private source: HTMLImageElement | null = null;
  /** 自定义说明（跨控件重渲染保留；失败重试时不清空） */
  private custom = '';

  init(): void {
    // 懒创建 overlay
  }

  /** 打开多角度编辑器；模型不支持图片参考时拒绝并提示（入口本应已按能力门控隐藏）。 */
  async open(nodeId: string): Promise<void> {
    const node = flowState.getNode(nodeId);
    if (!node || node.type !== 'image-gen') return;
    const fallback = node.imageUrl || flowState.getReferenceImages(nodeId)[0];
    if (!fallback) { showToast('该节点没有可用图片', false); return; }
    const caps = getImageEditCapabilities((node.params as unknown as StyleTransferParams).model || '');
    if (!caps.imageReference) { showToast('当前模型不支持图片参考，无法生成多角度', false); return; }
    this.nodeId = nodeId;
    this.presetId = 'front';
    this.running = false;
    this.currentTaskNodeId = '';
    this.source = null;
    this.custom = String((node.params as unknown as StyleTransferParams).prompt || '');
    try {
      const src = await this.loadSource(node, fallback);
      await this.loadImage(src);
    } catch {
      showToast('原图加载失败，无法编辑', false);
      return;
    }
    this.render();
  }

  close(): void {
    if (this.running && this.currentTaskNodeId) {
      imageEditEngine.cancel(this.currentTaskNodeId); // 关闭 = 取消本地等待；远端任务不会被重复提交
    }
    this.overlay?.remove();
    this.overlay = null;
    this.nodeId = '';
    this.running = false;
    this.currentTaskNodeId = '';
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
      const img = new Image();
      img.onload = () => { this.source = img; resolve(); };
      img.onerror = () => reject(new Error('image load failed'));
      img.src = src;
    });
  }

  private render(): void {
    this.close();
    const overlay = document.createElement('div');
    overlay.className = 'overlay image-editor-overlay angle-editor-overlay';
    overlay.innerHTML = `
      <section class="image-editor-panel angle-editor-panel" role="dialog" aria-modal="true" aria-label="多角度生成">
        <header class="image-editor-head">
          <div><h2>多角度 / 视角变化</h2><p>基于源图生成新视角。生成式变化，不保证几何完全一致。</p></div>
          <button data-ae="close" title="关闭">×</button>
        </header>
        <div class="image-editor-body">
          <div class="angle-editor-stage" id="ae-stage"></div>
          <aside class="image-editor-controls angle-editor-controls" id="ae-controls"></aside>
        </div>
        <footer class="mask-editor-foot">
          <button class="btn-ghost" data-ae="cancel">取消</button>
          <button class="btn-primary" data-ae="confirm">生成新视角</button>
        </footer>
      </section>`;
    document.body.appendChild(overlay);
    this.overlay = overlay;
    overlay.addEventListener('click', e => this.onClick(e as MouseEvent));
    this.renderControls();
    this.renderStage();
  }

  private renderControls(): void {
    const controls = this.overlay?.querySelector('#ae-controls');
    if (!controls) return;
    const presetButtons = ANGLE_PRESETS.map(p =>
      `<button type="button" data-ae-preset="${p.id}" class="${p.id === this.presetId ? 'active' : ''}">${p.label}</button>`,
    ).join('');
    controls.innerHTML = `
      <label>视角预设</label>
      <div class="ie-presets">${presetButtons}</div>
      <label>自定义说明（可选）</label>
      <textarea id="ae-desc" rows="3" placeholder="补充保持主体、服装、环境一致的说明，例如：保持人物服装与背景环境完全一致" spellcheck="false">${escapeAttr(this.custom)}</textarea>
      <div class="ae-model" id="ae-model"></div>
      <p class="ie-hint">生成式变化：同一源图在不同视角下不保证几何完全一致，请以结果为准。</p>`;
    this.descInput = controls.querySelector('#ae-desc') as HTMLTextAreaElement | null;
    this.modelLabel = controls.querySelector('#ae-model') as HTMLElement | null;
    this.confirmBtn = this.overlay?.querySelector('[data-ae="confirm"]') as HTMLButtonElement | null;
    this.descInput?.addEventListener('input', () => { this.custom = this.descInput?.value || ''; });
    const node = this.nodeId ? flowState.getNode(this.nodeId) : null;
    if (this.modelLabel && node) {
      const modelId = String((node.params as unknown as StyleTransferParams).model || '');
      this.modelLabel.textContent = `模型：${this.shortModel(modelId)}`;
    }
  }

  private renderStage(): void {
    const stage = this.overlay?.querySelector('#ae-stage');
    if (!stage || !this.source) return;
    stage.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'angle-editor-img';
    const maxW = Math.max(240, (stage as HTMLElement).clientWidth - 16);
    const maxH = Math.max(220, (stage as HTMLElement).clientHeight - 16);
    const k = Math.min(1, maxW / this.source.naturalWidth, maxH / this.source.naturalHeight);
    wrap.style.width = `${Math.round(this.source.naturalWidth * k)}px`;
    wrap.style.height = `${Math.round(this.source.naturalHeight * k)}px`;
    wrap.style.backgroundImage = `url('${this.source.src.replace(/'/g, "\\'")}')`;
    wrap.style.backgroundSize = 'cover';
    wrap.textContent = '源图（新视角以此为准）';
    stage.appendChild(wrap);
  }

  private onClick(e: MouseEvent): void {
    const target = (e.target as Element).closest('[data-ae], [data-ae-preset]') as HTMLElement | null;
    if (!target) { if (e.target === this.overlay) this.close(); return; }
    const action = target.dataset.ae;
    if (action === 'close' || action === 'cancel') { this.close(); return; }
    if (action === 'confirm') { void this.submit(); return; }
    if (target.dataset.aePreset) {
      this.presetId = target.dataset.aePreset;
      this.renderControls();
    }
  }

  private async submit(): Promise<void> {
    if (this.running) return;
    const node = flowState.getNode(this.nodeId);
    if (!node) return;
    const preset = ANGLE_PRESETS.find(p => p.id === this.presetId) || ANGLE_PRESETS[0];
    const custom = (this.descInput?.value || this.custom || '').trim();
    this.custom = custom;
    // 完整 prompt = 预设结构化前缀 + 自定义说明（追加在后，保持可追溯）
    const fullPrompt = custom ? `${preset.prefix}。${custom}` : preset.prefix;
    const model = String((node.params as unknown as StyleTransferParams).model || '');
    const caps = getImageEditCapabilities(model);
    if (!caps.imageReference) { showToast('当前模型不支持图片参考，无法生成多角度', false); return; }

    if (this.confirmBtn) {
      this.confirmBtn.disabled = true;
      this.confirmBtn.textContent = '提交中…';
    }
    this.running = true;
    try {
      const result = await imageEditEngine.start({
        kind: 'angle',
        sourceId: this.nodeId,
        prompt: fullPrompt,
        model,
        angle: { preset: preset.label, instruction: custom },
        onNodeCreated: nodeId => { this.currentTaskNodeId = nodeId; },
      });
      if (result.ok) {
        this.running = false;
        this.overlay?.remove();
        this.overlay = null;
        if (result.nodeId) selection.select(result.nodeId);
        showToast('新视角已生成');
      } else if (result.cancelled) {
        this.running = false;
      } else {
        this.running = false;
        showToast(result.error || '多角度生成失败，请调整后重试', false);
      }
    } finally {
      if (this.confirmBtn) {
        this.confirmBtn.disabled = false;
        this.confirmBtn.textContent = '生成新视角';
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

export const angleEditor = new AngleEditor();
