// 扩图共用工具：目标尺寸、固定提示和默认/已调整位置的底图合成。
// 画布节点重跑也使用这里，避免只有弹窗路径才能正确扩图。

export const RATIO_CANVAS: Record<string, { w: number; h: number }> = {
  '1:1': { w: 4096, h: 4096 },
  '3:4': { w: 3072, h: 4096 },
  '4:3': { w: 4096, h: 3072 },
  '16:9': { w: 4096, h: 2304 },
  '9:16': { w: 2304, h: 4096 },
};

export const OUTPAINT_PROMPT_PREFIX = '白色区域是待补全区域，扩展为协调背景，保留原图内容与比例';

export interface OutpaintPlacement {
  posX: number;
  posY: number;
  scale: number;
}

export function getOutpaintCanvas(ratio: string): { w: number; h: number } {
  return RATIO_CANVAS[ratio] || RATIO_CANVAS['1:1'];
}

/** 默认让原图完整、居中地置于目标画布内，保留四周给模型补全。 */
export function defaultOutpaintPlacement(img: HTMLImageElement, ratio: string): OutpaintPlacement {
  const { w, h } = getOutpaintCanvas(ratio);
  const scale = Math.min((h * 0.8) / img.naturalHeight, w / img.naturalWidth);
  return { posX: 0, posY: 0, scale: Math.max(0.01, scale) };
}

export function loadOutpaintImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const img = new Image();
    let settled = false;
    const finish = (value: HTMLImageElement | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 15000);
    img.onload = () => finish(img);
    img.onerror = () => finish(null);
    img.src = src;
  });
}

/** 将原图与白色待补全区合成 PNG；失败（例如跨域 canvas）返回 null。 */
export function composeOutpaintDataUrl(
  img: HTMLImageElement,
  ratio: string,
  placement?: Partial<OutpaintPlacement>,
): string | null {
  const { w, h } = getOutpaintCanvas(ratio);
  const fallback = defaultOutpaintPlacement(img, ratio);
  const scale = typeof placement?.scale === 'number' && placement.scale > 0 ? placement.scale : fallback.scale;
  const posX = typeof placement?.posX === 'number' ? placement.posX : 0;
  const posY = typeof placement?.posY === 'number' ? placement.posY : 0;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  ctx.drawImage(img, w / 2 + posX - dw / 2, h / 2 + posY - dh / 2, dw, dh);
  try {
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}
