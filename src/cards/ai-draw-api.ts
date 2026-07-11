// src/cards/ai-draw-api.ts
// AIDrawCard 的纯静态函数层（已与 this 解耦）
// 原样照搬 8 个静态方法，零行为变化；主类通过 `static xxx = exportedFn` 重新导出
// 内部调用方无需修改，GroupExecutor.ts 等外部通过 AIDrawCard.generate 调用也保持不变

import type { AIDrawCard } from './ai-draw-card';
import * as status from './ai-draw-status';

declare const API: {
  loadProviders(): Promise<{ providers: ProviderList }>;
  generateImageV2(prompt: string, options?: Record<string, unknown>): Promise<{ task_id: string }>;
  getTaskResult(taskId: string): Promise<{ status: string; result?: { success?: boolean; image_url?: string; error?: string } }>;
};
interface ProviderList extends Array<ProviderItem> {}
interface ProviderItem { id: string; short_name?: string; name: string; enabled?: boolean; models?: ModelList }
interface ModelList extends Array<ModelItem> {}
interface ModelItem { id: string; name: string; type: string; enabled?: boolean }

declare const DataSource: {
  getUpstreamText(cardId: string): Array<{ data: unknown; sourceCardId: string }>;
  getUpstreamImage(cardId: string): Array<{ data: unknown; sourceCardId: string }>;
  hasUpstreamOfType(cardId: string, type: string): boolean;
  getUpstreamTextMerged(cardId: string): string;
  getDownstreamPreviews(cardId: string): Array<{ id: string }>;
  getDownstreamImageCards(cardId: string): Array<{ id: string; setImage?(url: string): void }>;
};

declare const AppState: {
  ai: unknown;
};

declare const Toast: { show(msg: string, dur?: number): void };

declare const CardEventBus: {
  EventTypes: { RUN_COMPLETED: string; DATA_CHANGED: string };
  emit(type: string, payload: unknown): void;
};

declare const HistorySidebar: { addImage(url: string, meta?: unknown): void };

declare const ConnectionManager: {
  updateCardConnections(id: string): void;
  create(startId: string, endId: string, saveHistory: boolean): unknown;
};

declare const CardFactory: {
  create(type: string, options: unknown, saveHistory: boolean): { id: string };
  getInstance(id: string): unknown;
};

// ─────────────────────────────────────────
// 工具：图片 / 错误图 / 模型 / 端口
// ─────────────────────────────────────────

export async function _mergeImageAndMask(imageBase64: string, maskBase64: string): Promise<string> {
  return new Promise(resolve => {
    const img = new Image();
    const maskImg = new Image();
    let loaded = 0;

    const onBothLoaded = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      ctx.drawImage(maskImg, 0, 0);
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/png'));
    };

    img.onload = () => { loaded++; if (loaded === 2) onBothLoaded(); };
    maskImg.onload = () => { loaded++; if (loaded === 2) onBothLoaded(); };
    img.src = imageBase64;
    maskImg.src = maskBase64;
  });
}

export function _toBase64(src: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (src.startsWith('data:')) { resolve(src); return; }
    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      canvas.getContext('2d')!.drawImage(img, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = src;
  });
}

export function _generateErrorImage(errorMessage: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  let icon = '⚠';
  let iconColor = '#ef4444';
  let title = '生成失败';
  let bgColor = '#1a1a2e';
  let detail = errorMessage || '未知错误';

  const msg = (errorMessage || '').toLowerCase();
  if (msg.includes('timeout') || msg.includes('超时')) {
    icon = '⏰'; iconColor = '#f59e0b'; title = '请求超时'; detail = '服务器响应超时，请稍后重试';
  } else if (msg.includes('429') || msg.includes('rate limit') || msg.includes('频率') || msg.includes('频')) {
    icon = '🚫'; iconColor = '#a855f7'; title = '请求过于频繁'; detail = '已触发限频，请稍等片刻';
  } else if (msg.includes('401') || msg.includes('api key') || msg.includes('密钥') || msg.includes('unauthorized')) {
    icon = '🔑'; iconColor = '#ef4444'; title = 'API 密钥无效'; detail = '请检查 API Key 是否正确';
  } else if (msg.includes('500') || msg.includes('server') || msg.includes('服务')) {
    icon = '🛠'; iconColor = '#ef4444'; title = '服务器错误'; detail = '服务端发生错误，请稍后重试';
  } else if (msg.includes('insufficient') || msg.includes('balance') || msg.includes('余') || msg.includes('quota')) {
    icon = '💳'; iconColor = '#f59e0b'; title = '账户余额不足'; detail = '请前往供应商平台充值';
  }

  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, 512, 512);

  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 512; i += 32) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 512); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(512, i); ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(256, 160, 70, 0, Math.PI * 2);
  ctx.strokeStyle = iconColor;
  ctx.lineWidth = 4;
  ctx.stroke();

  ctx.font = '52px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(icon, 256, 178);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 30px sans-serif';
  ctx.fillText(title, 256, 278);

  ctx.fillStyle = '#9ca3af';
  ctx.font = '18px sans-serif';
  const maxWidth = 420;
  const lineHeight = 30;
  const lines: string[] = [];
  let current = '';
  for (const char of detail) {
    const test = current + char;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current); current = char;
    } else { current = test; }
  }
  if (current) lines.push(current);
  lines.slice(0, 3).forEach((line, i) => ctx.fillText(line, 256, 325 + i * lineHeight));

  ctx.fillStyle = 'rgba(255,255,255,0.2)';
  ctx.font = '14px sans-serif';
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
  ctx.fillText(timeStr, 256, 480);

  return canvas.toDataURL('image/png');
}

export async function _getImageModels(): Promise<Array<{ id: string; name: string }>> {
  try {
    const result = await API.loadProviders();
    const providers = result.providers || [];
    const models: Array<{ id: string; name: string }> = [];

    providers.forEach((p: { id: string; short_name?: string; name: string; enabled?: boolean; models?: Array<{ id: string; name: string; type: string; enabled?: boolean }> }) => {
      if (!p.enabled) return;
      const displayName = p.short_name || p.name.slice(0, 6);
      (p.models || [])
        .filter((m: { enabled?: boolean; type: string }) => m.enabled !== false && m.type === 'drawing')
        .forEach((m: { id: string; name: string }) => {
          models.push({ id: `${p.id}:${m.id}`, name: `${displayName} - ${m.name}` });
        });
    });

    return models.length ? models : [{ id: '', name: '未找到绘图模型，请先在设置中配置' }];
  } catch {
    return [{ id: '', name: '加载失败' }];
  }
}

export function _getConnectedPreviews(cardId: string): Array<{ id: string }> {
  return DataSource.getDownstreamPreviews(cardId);
}

export function _getConnectedImageInputCards(cardId: string): Array<{ id: string }> {
  return DataSource.getDownstreamImageCards(cardId);
}

// ─────────────────────────────────────────
// 参数选择菜单（依赖 CardFactory.getInstance 取 AIDrawCard 实例）
// ─────────────────────────────────────────

export async function _showParamMenu(event: MouseEvent, cardId: string, paramType: string): Promise<void> {
  event.stopPropagation();
  document.querySelector('.param-menu')?.remove();

  const btn = event.currentTarget as HTMLElement;
  const rect = btn.getBoundingClientRect();

  const card = CardFactory.getInstance(cardId) as AIDrawCard | null;
  if (!card) return;

  let items: Array<{ id: string; name: string } | string> = [];

  switch (paramType) {
    case 'model':
      items = await _getImageModels();
      break;
    case 'aspectRatio':
      items = ['Auto','1:1','16:9','9:16','4:3','3:4','21:9','3:2','2:3'];
      break;
    case 'resolution':
      items = ['1k','2k','4k'];
      break;
    case 'count':
      items = ['1','2','4','9'];
      break;
  }

  const menu = document.createElement('div');
  menu.className = 'param-menu';
  menu.style.left = rect.left + 'px';
  menu.style.top = (rect.bottom + 5) + 'px';

  const menuWidth = 160;
  if (rect.left + menuWidth > window.innerWidth - 12) {
    menu.style.left = (window.innerWidth - menuWidth - 12) + 'px';
  }

  items.forEach(item => {
    const isObj = typeof item === 'object';
    const displayText = isObj ? (item as { name: string }).name : item;
    const value = isObj ? (item as { id: string }).id : item;

    const menuItem = document.createElement('div');
    menuItem.className = 'param-menu-item';
    menuItem.textContent = displayText;

    if (paramType === 'model' && value === card.config.model) {
      menuItem.classList.add('selected');
    }

    menuItem.addEventListener('click', (e) => {
      e.stopPropagation();
      let rawValue = String(value);
      if (rawValue.endsWith(')')) rawValue = rawValue.slice(0, -1);
      card.updateParam(paramType, rawValue, displayText);
      menu.remove();
    });

    menu.appendChild(menuItem);
  });

  document.body.appendChild(menu);

  setTimeout(() => {
    const close = () => { menu.remove(); document.removeEventListener('click', close); };
    document.addEventListener('click', close);
  }, 0);
}

// ─────────────────────────────────────────
// 主入口：generate
// ─────────────────────────────────────────

export async function generate(cardId: string): Promise<void> {
  const card = CardFactory.getInstance(cardId) as AIDrawCard | null;
  if (!card) return;

  const el = card.element;
  if (!el) return;

  const aiState = AppState.ai as unknown as { generatingCards: Map<string, { aborted: boolean }> };

  if (aiState.generatingCards.has(cardId)) {
    aiState.generatingCards.get(cardId)!.aborted = true;
    aiState.generatingCards.delete(cardId);
    status.updateGenerateButton(el, false);
    status.clearGeneratingStatus(el);
    return;
  }

  let prompt = (card.element?.querySelector('.ai-image-prompt') as HTMLTextAreaElement | null)?.value?.trim() || '';
  if (card._hasUpstreamText()) {
    prompt = DataSource.getUpstreamTextMerged(cardId);
  }

  if (!prompt) { Toast.show('请输入提示'); return; }
  if (!card.config.model) { Toast.show('请先选择模型'); return; }

  const refImageWrappers = card._getRefImages();
  const refImages: string[] = [];

  for (const { src, cardId: srcCardId } of refImageWrappers) {
    const maskSrc = (card as unknown as { _maskStore: Map<string, string> })._maskStore.get(srcCardId) || null;
    try {
      let base64 = await _toBase64(src);
      if (maskSrc) {
        base64 = await _mergeImageAndMask(base64, maskSrc);
      }
      refImages.push(base64);
    } catch {
      console.warn('[AIDrawCard] 参考图转换失败，跳过', srcCardId);
    }
  }

  if (refImages.length) {
    card.config.referenceImages = refImages;
    delete ((card.config as unknown as Record<string, unknown>)['referenceMasks']);
  } else {
    delete card.config.referenceImages;
    delete ((card.config as unknown as Record<string, unknown>)['referenceMasks']);
  }

  const count = card.config.count || 1;

  aiState.generatingCards.set(cardId, { aborted: false });
  status.updateGenerateButton(el, true);
  status.showGeneratingStatus(el, count);

  let previewCards = DataSource.getDownstreamPreviews(cardId);
  if (previewCards.length === 0) {
    const cardLeft = parseFloat(el.style.left);
    const cardTop = parseFloat(el.style.top);
    const cardWidth = parseFloat(el.style.width);

    for (let i = 0; i < count; i++) {
      const newCard = CardFactory.create('preview', {
        x: cardLeft + cardWidth + 50,
        y: cardTop + i * 320
      }, false) as { id: string };
      ConnectionManager.create(cardId, newCard.id, false);
    }
    previewCards = DataSource.getDownstreamPreviews(cardId);
  }

  const generatedImages: (string | undefined)[] = [];
  const lockedCards = new Set<string>();

  try {
    const state = aiState.generatingCards.get(cardId)!;

    const taskIds = await Promise.all(
      Array.from({ length: count }, async (_, i) => {
        const options = {
          model: card.config.model || undefined,
          resolution: card.config.resolution || '1k',
          aspectRatio: card.config.aspectRatio || 'Auto',
          topP: card.config.topP,
          referenceImages: card.config.referenceImages || []
        };
        const res = await API.generateImageV2(prompt, options);
        if (!res || !res.task_id) throw new Error(`任务[${i}] task_id 为空，动失败`);
        return res.task_id;
      })
    );

    const pollTask = (taskId: string, _index: number): Promise<{ success: boolean; error?: string } | null> =>
      new Promise(resolve => {
        if (!taskId) { resolve({ success: false, error: 'task_id 无效' }); return; }

        const poll = async () => {
          if (state.aborted) { resolve(null); return; }
          try {
            const res = await API.getTaskResult(taskId);
            if (!res || res.status === 'not_found') {
              resolve({ success: false, error: '任务结果已过期，请重新生成' }); return;
            }
            if (res.status === 'pending') {
              setTimeout(poll, 2000);
            } else if (res.status === 'done') {
              resolve(res.result as { success: boolean; error?: string });
            } else {
              resolve({ success: false, error: `未知任务状态: ${res.status}` });
            }
          } catch (e) {
            resolve({ success: false, error: (e as Error).message });
          }
        };

        poll();
      });

    const promises = taskIds.map((taskId, i) =>
      pollTask(taskId, i).then(result => ({ i, result }))
    );

    for (const promise of promises) {
      if (state.aborted) break;
      const { i, result } = await promise;

      const pc = previewCards[i];
      const previewInstance = CardFactory.getInstance(pc?.id) as { _renderImage?(src: string): void } | null;

      if (!result) {
        if (previewInstance && !lockedCards.has(pc.id)) {
          previewInstance._renderImage?.(_generateErrorImage('任务结果获取失败'));
        }
        continue;
      }

      if (result.success && (result as { image_url?: string }).image_url) {
        const imgUrl = (result as unknown as { image_url: string }).image_url;
        if (pc) lockedCards.add(pc.id);
        generatedImages[i] = imgUrl;

        const meta = {
          resolution: card.config.resolution || '1k',
          aspectRatio: card.config.aspectRatio || 'Auto',
          generatedAt: Date.now()
        };

        previewInstance?._renderImage?.(imgUrl);

        if (i === 0) {
          DataSource.getDownstreamImageCards(cardId).forEach(imgCard => {
            const instance = CardFactory.getInstance(imgCard.id);
            (instance as { setImage?(url: string): void } | null)?.setImage?.(imgUrl);
          });
        }

        HistorySidebar.addImage(imgUrl, meta);
        status.updateGeneratingStatus(el, generatedImages.filter(Boolean).length, count);
      } else {
        if (previewInstance && !lockedCards.has(pc.id)) {
          const errMsg = (result as { error?: string }).error === 'only_text'
            ? 'AI 仅返回了文本，未生成图片'
            : (result as { error?: string }).error || '生成失败';
          previewInstance._renderImage?.(_generateErrorImage(errMsg));
        }
      }
    }

    const successCount = generatedImages.filter(Boolean).length;
    if (!state.aborted && successCount === 0) {
      Toast.show('生成失败：AI 未返回有效图片');
    }

    if (generatedImages.length) {
      card.config.generatedImages = generatedImages.filter(Boolean) as string[];
    }

  } catch (error) {
    if ((error as Error).message !== '用户取消生成') {
      Toast.show('生成失败: ' + (error as Error).message);
      const errorImage = _generateErrorImage((error as Error).message);
      previewCards.forEach(pc => {
        if (lockedCards.has(pc.id)) return;
        const instance = CardFactory.getInstance(pc.id);
        (instance as { _renderImage?(src: string): void } | null)?._renderImage?.(errorImage);
      });
    }
  } finally {
    const wasAborted = aiState.generatingCards.get(cardId)?.aborted ?? true;
    aiState.generatingCards.delete(cardId);
    status.updateGenerateButton(el, false);
    status.clearGeneratingStatus(el);

    if (!wasAborted && generatedImages.length > 0) {
      if (CardEventBus && CardEventBus.EventTypes) {
        CardEventBus.emit(CardEventBus.EventTypes.RUN_COMPLETED, {
          cardId,
          type: 'image',
          data: generatedImages[0] || null,
        });
      }
    }
  }
}