// src/cards/agent-api.ts
// AgentCard 的纯静态函数层（已与 this 解耦）
// 原样照搬 7 个静态方法，零行为变化；主类通过 `static xxx = exportedFn` 重新导出
// 内部调用方无需修改，外部通过 AgentCard.xxx 调用也保持不变

import type { AgentCard } from './agent-card';

// 用于访问 AgentCard 上的 protected 字段（_chatModels / _running / agentConfig 等）
// 跟 ai-draw-api.ts 的 _maskStore cast 模式一致：单点 unknown cast，不动 base 类型设计
type AgentInternals = {
  _chatModels: Array<{ id: string; name: string; providerName: string }>;
  _running: boolean;
};

declare const API: {
  loadProviders(): Promise<{ providers: ProviderList }>;
  loadLocalImage(src: string): Promise<{ data_url?: string }>;
  agentChatV2(input: string, options: Record<string, unknown>): Promise<{ success: boolean; text?: string; error?: string }>;
};
interface ProviderList extends Array<ProviderItem> {}
interface ProviderItem { id: string; short_name?: string; name: string; enabled?: boolean; models?: ModelList }
interface ModelList extends Array<ModelItem> {}
interface ModelItem { id: string; name: string; type: string; enabled?: boolean }

declare const CardFactory: {
  getInstance(cardId: string): AgentCard | null;
  create(type: string, options: unknown, saveHistory: boolean): { id: string };
};

declare const PromptLibrary: { open(event: unknown, category: string, cb: (item: { content: string }) => void): void };
declare const Toast: { show(msg: string, dur?: number): void };
declare const Dom: { create(tag: string, attrs?: Record<string, string>, text?: string): HTMLElement };

// ─────────────────────────────────────────
// 工具
// ─────────────────────────────────────────

export function _isDisplayableImageSrc(src: string): boolean {
  if (!src || typeof src !== 'string') return false;
  const s = src.trim();
  return s.startsWith('data:image') || s.startsWith('file://') ||
         s.startsWith('http://') || s.startsWith('https://') || s.startsWith('blob:');
}

export async function _compressImage(dataUrl: string, maxSize = 1024, quality = 0.85): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxSize || height > maxSize) {
        if (width >= height) {
          height = Math.round(height * maxSize / width);
          width = maxSize;
        } else {
          width = Math.round(width * maxSize / height);
          height = maxSize;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d')!.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

export async function _getChatModels(): Promise<Array<{ id: string; name: string; providerName: string }>> {
  try {
    const result = await API.loadProviders();
    const providers = result.providers || [];
    const models: Array<{ id: string; name: string; providerName: string }> = [];

    providers.forEach((p: { id: string; short_name?: string; name: string; enabled?: boolean; models?: Array<{ id: string; name: string; type: string; enabled?: boolean }> }) => {
      if (!p.enabled) return;
      const displayName = p.short_name || p.name.slice(0, 6);
      (p.models || [])
        .filter((m: { type: string; enabled?: boolean }) => m.type === 'chat' && m.enabled !== false)
        .forEach((m: { id: string; name: string }) => {
          models.push({ id: `${p.id}:${m.id}`, name: m.name || m.id, providerName: displayName });
        });
    });
    return models;
  } catch (e) {
    console.error('[AgentCard] 获取模型失败:', e);
    return [];
  }
}

// ─────────────────────────────────────────
// 模型菜单 / 提示库 / 复制 / 运行
// ─────────────────────────────────────────

export async function _showModelMenu(event: MouseEvent, cardId: string): Promise<void> {
  event.stopPropagation();
  event.preventDefault();
  document.querySelector('.param-menu')?.remove();

  const btn = event.currentTarget as HTMLElement;
  const rect = btn.getBoundingClientRect();

  const card = CardFactory.getInstance(cardId) as (AgentCard & AgentInternals) | null;
  if (!card) return;

  card._chatModels = await _getChatModels();

  const menu = Dom.create('div', { className: 'param-menu agent-model-menu' });
  menu.style.left = rect.left + 'px';
  menu.style.top = (rect.bottom + 5) + 'px';
  menu.style.minWidth = Math.max(rect.width, 220) + 'px';

  if (card._chatModels.length === 0) {
    menu.appendChild(Dom.create('div', { className: 'param-menu-item', style: 'opacity:.72;cursor:default;' }, '暂无对话模型，请先到设置添加'));
  } else {
    card._chatModels.forEach(item => {
      const row = Dom.create('div', { className: 'param-menu-item' }, `${item.providerName} · ${item.name}`);
      if (item.id === card.agentConfig.model) row.classList.add('selected');
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        card._setModel(item.id, item.name);
        menu.remove();
      });
      menu.appendChild(row);
    });
  }

  document.body.appendChild(menu);

  const menuRect = menu.getBoundingClientRect();
  if (menuRect.right > window.innerWidth - 12) {
    menu.style.left = Math.max(12, window.innerWidth - menuRect.width - 12) + 'px';
  }

  setTimeout(() => {
    const close = () => { menu.remove(); document.removeEventListener('click', close); };
    document.addEventListener('click', close);
  }, 0);
}

export function _openLib(event: MouseEvent, cardId: string, category: string): void {
  const card = CardFactory.getInstance(cardId);
  if (!card) return;

  PromptLibrary.open(event, category, (item) => {
    const selector = category === 'skill' ? '.agent-meta-prompt' : '.agent-user-input';
    const textarea = card.element?.querySelector(selector) as HTMLTextAreaElement | null;
    if (!textarea) return;

    const sep = textarea.value ? '\n' : '';
    textarea.value += sep + item.content;

    if (category === 'skill') card.agentConfig.metaPrompt = textarea.value;
    else card.agentConfig.userInput = textarea.value;
  });
}

export function _copyOutput(cardId: string): void {
  const card = CardFactory.getInstance(cardId);
  if (!card) return;
  const text = card.agentConfig.output;
  if (!text) { Toast.show('暂无输出内容'); return; }
  navigator.clipboard.writeText(text).then(() => Toast.show('已复制')).catch(() => Toast.show('复制失败'));
}

export async function _run(cardId: string): Promise<void> {
  const card = CardFactory.getInstance(cardId) as (AgentCard & AgentInternals) | null;
  if (!card) return;

  if (card._running) {
    card._setLoading(false);
    card._setOutput(card.agentConfig.output || '');
    return;
  }

  if (!card.agentConfig.model) { Toast.show('请先选择模型'); return; }

  const upstreamContent = card._getUpstreamContent();
  const upstreamText = upstreamContent.texts.join('\n\n');
  const rawImages = upstreamContent.images;

  const localInput = (card.element?.querySelector('.agent-user-input') as HTMLTextAreaElement | null)?.value?.trim() || '';

  let finalUserInput = localInput;
  if (upstreamText) finalUserInput = localInput ? `${localInput}\n\n${upstreamText}` : upstreamText;

  if (!finalUserInput && rawImages.length === 0) {
    Toast.show('请输入用户需求或连接图片/文本卡片'); return;
  }
  if (!finalUserInput && rawImages.length > 0) finalUserInput = '请描述这张图片';

  const metaPrompt = (card.element?.querySelector('.agent-meta-prompt') as HTMLTextAreaElement | null)?.value?.trim() || '';
  card._setLoading(true);

  try {
    let resolvedImages: (string | null)[] = [];
    if (rawImages.length > 0) {
      resolvedImages = await Promise.all(
        rawImages.map(async (src) => {
          if (src.startsWith('file://')) {
            try {
              const res = await API.loadLocalImage(src);
              return (res && res.data_url) ? res.data_url : src;
            } catch { return null; }
          }
          return src;
        })
      );
    }
    const filteredImages = resolvedImages.filter((src): src is string => src !== null);

    const compressedImages = filteredImages.length > 0
      ? await Promise.all(filteredImages.map(src => _compressImage(src)))
      : [];

    const result = await API.agentChatV2(finalUserInput, {
      metaPrompt,
      model: card.agentConfig.model || undefined,
      images: compressedImages.length > 0 ? compressedImages : undefined
    });

    if (result.success) card._setOutput(result.text || '');
    else { Toast.show('执行失败: ' + result.error); card._setOutput(''); }
  } catch (e) {
    Toast.show('执行失败');
    console.error('[AgentCard] run error:', e);
    card._setOutput('');
  } finally {
    card._setLoading(false);
  }
}