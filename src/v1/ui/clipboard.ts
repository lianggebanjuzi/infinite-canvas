// src/v1/ui/clipboard.ts
// 剪贴板复制小工具（Phase 2 提示词页签/资源配方共用）：
// Clipboard API 优先，pywebview 旧内核/非安全上下文无 API 时兜底 execCommand。

/**
 * 复制文本到剪贴板。
 * @returns 是否复制成功（空文本返回 false）
 */
export async function copyText(text: string): Promise<boolean> {
  const value = (text || '').trim();
  if (!value) return false;
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // 权限/安全上下文失败时回退 execCommand
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(ta);
    return copied;
  } catch {
    return false;
  }
}
