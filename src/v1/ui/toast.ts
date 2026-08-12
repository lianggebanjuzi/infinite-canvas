// src/v1/ui/toast.ts
// 轻量 Toast：复用原型 .toast-hint 元素（底部居中，暖园艺风）
// 共享约定第 6 条：不出现文字日志 —— Toast 仅用于明确的操作反馈

let timer: ReturnType<typeof setTimeout> | null = null;

/** 显示操作反馈（ok=true 绿色对勾，false 红色感叹） */
export function showToast(message: string, ok = true): void {
  const el = document.getElementById('toast') as HTMLElement | null;
  if (!el) return;

  el.classList.toggle('err', !ok);
  el.innerHTML = (ok
    ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
    : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>')
    + `<span>${escapeHtml(message)}</span>`;

  el.classList.add('show');
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => el.classList.remove('show'), 2600);
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
