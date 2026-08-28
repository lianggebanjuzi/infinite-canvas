# .qa-verify/qa-close-guard-backend.py
"""QA 独立验证（fresh eyes）：关闭未响应修复 — main.py closing 链路（改动 2）。

与工程师自测独立编写，mock webview 验证：
  - win_set_dirty 缓存写入（_cached_dirty / _dirty_reported / 返回值）
  - _on_closing 全部返回路径满足 pywebview closing 契约（bool）：
      ① _closing_forced=True → True（放行，零 evaluate_js）
      ② 未上报回退路径：JS dirty → False + 两次 evaluate_js；JS clean → True（一次查询）；
         evaluate_js 抛异常 → True（异常放行，窗口不会卡死）
      ③ 已上报路径：缓存 dirty → False + 后台线程触发 __icvRequestClose（GUI 线程零 evaluate_js）；
         缓存 clean → True（零 evaluate_js）
  - _request_close_async / _sync_win_icon：后台 daemon 线程 fire-and-forget，不阻塞 GUI 线程、
    异常静默；_on_win_maximized / _on_win_restored 兜底仍置位标志并同步图标

运行：.venv\\Scripts\\python.exe .qa-verify\\qa-close-guard-backend.py
"""
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

RESULTS = []


def check(name, cond, detail=''):
    RESULTS.append((name, bool(cond), detail))
    print(('PASS' if cond else 'FAIL'), '-', name, ('| ' + detail if detail else ''))


# ───────────────────────── mock webview ─────────────────────────
class FakeWindow:
    """记录 evaluate_js 调用；可用 event 等待后台线程调用到达（验证 fire-and-forget 内容）。"""

    def __init__(self):
        self.calls = []
        self.js_result = False
        self.raise_on_evaluate = False
        self.destroyed = False
        self.ev = threading.Event()

    def evaluate_js(self, code):
        if self.raise_on_evaluate:
            raise RuntimeError('js unavailable (window busy)')
        self.calls.append((code, threading.get_ident()))
        self.ev.set()
        return self.js_result

    def destroy(self):
        self.destroyed = True

    def wait_calls(self, n, timeout=2.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if len(self.calls) >= n:
                return True
            time.sleep(0.005)
        return len(self.calls) >= n


class FakeWebview:
    def __init__(self, window):
        self.windows = [window]


def fresh_api():
    """构造 InfiniteCanvasAPI 实例（仅初始化关闭相关字段，不触发后端 API 构造）。"""
    import main
    api = main.InfiniteCanvasAPI.__new__(main.InfiniteCanvasAPI)
    api._win_maximized = False
    api._win_restore_rect = None
    api._closing_forced = False
    api._cached_dirty = True        # 初始保守 True
    api._dirty_reported = False     # 初始未上报
    return api


def codes(fw):
    """提取 evaluate_js 调用代码列表（calls 现为 (code, ident) 元组）。"""
    return [c[0] for c in fw.calls]


def main_test():
    import main

    # ══════════════ S1 win_set_dirty 缓存写入 ══════════════
    print('\n▶ S1: win_set_dirty 缓存写入')
    api = fresh_api()
    check('S1-1 初始 _cached_dirty=True（保守）、_dirty_reported=False',
          api._cached_dirty is True and api._dirty_reported is False,
          f'_cached_dirty={api._cached_dirty} _dirty_reported={api._dirty_reported}')
    r = api.win_set_dirty(True)
    check('S1-2 win_set_dirty(True) → _cached_dirty=True + 已上报 + 返回 True',
          api._cached_dirty is True and api._dirty_reported is True and r is True,
          f'cached={api._cached_dirty} reported={api._dirty_reported} ret={r}')
    r = api.win_set_dirty(False)
    check('S1-3 win_set_dirty(False) → _cached_dirty=False + 已上报 + 返回 True',
          api._cached_dirty is False and api._dirty_reported is True and r is True,
          f'cached={api._cached_dirty} ret={r}')
    # 反复上报保持幂等（不抛异常、标志位正确）
    api.win_set_dirty(True)
    api.win_set_dirty(True)
    check('S1-4 重复上报幂等（不抛异常、仍 True）', api._cached_dirty is True and api._dirty_reported is True)

    # ══════════════ S2 _on_closing ① _closing_forced 放行 ══════════════
    print('\n▶ S2: _closing_forced=True → 放行（零 evaluate_js）')
    fw = FakeWindow()
    main.webview = FakeWebview(fw)
    api = fresh_api()
    api._closing_forced = True
    ret = api._on_closing()
    check('S2-1 返回 True（bool 放行）', ret is True, f'ret={ret!r}')
    check('S2-2 零 evaluate_js 调用', len(fw.calls) == 0, f'calls={fw.calls}')

    # ══════════════ S3 _on_closing ② 未上报回退路径 ══════════════
    print('\n▶ S3: 未上报回退（旧同步查询）')
    # 3.1 JS clean → 放行，一次查询
    fw = FakeWindow()
    fw.js_result = False
    main.webview = FakeWebview(fw)
    api = fresh_api()
    ret = api._on_closing()
    check('S3-1 JS clean → 返回 True（放行）', ret is True, f'ret={ret!r}')
    check('S3-2 仅一次查询 __icvIsDirty', len(codes(fw)) == 1 and '__icvIsDirty' in codes(fw)[0],
          f'calls={fw.calls}')

    # 3.2 JS dirty → 阻止关闭 + 触发 request close（两次 evaluate_js）
    fw = FakeWindow()
    fw.js_result = True
    main.webview = FakeWebview(fw)
    api = fresh_api()
    ret = api._on_closing()
    check('S3-3 JS dirty → 返回 False（阻止关闭）', ret is False, f'ret={ret!r}')
    check('S3-4 两次 evaluate_js：查询 + __icvRequestClose',
          len(codes(fw)) == 2 and '__icvIsDirty' in codes(fw)[0] and '__icvRequestClose' in codes(fw)[1],
          f'calls={fw.calls}')

    # 3.3 evaluate_js 抛异常 → 异常放行（窗口不会卡死）
    fw = FakeWindow()
    fw.raise_on_evaluate = True
    main.webview = FakeWebview(fw)
    api = fresh_api()
    ret = api._on_closing()
    check('S3-5 evaluate_js 异常 → 返回 True（放行，不抛）', ret is True, f'ret={ret!r}')

    # ══════════════ S4 _on_closing ③ 已上报路径 ══════════════
    print('\n▶ S4: 已上报路径（读缓存，零同步 evaluate_js）')
    # 4.1 缓存 dirty → 返回 False + 后台线程触发（GUI 线程不阻塞）
    fw = FakeWindow()
    main.webview = FakeWebview(fw)
    api = fresh_api()
    api.win_set_dirty(True)          # 已上报 + cached=True
    main_ident = threading.get_ident()
    t0 = time.time()
    ret = api._on_closing()
    elapsed = time.time() - t0
    check('S4-1 缓存 dirty → 返回 False（阻止关闭）', ret is False, f'ret={ret!r}')
    # evaluate_js 若已发生，必须来自后台线程（非主线程）——证明 GUI 线程零同步等待
    ok = fw.wait_calls(1, timeout=2.0)
    check('S4-2 evaluate_js 由后台线程调用（GUI 线程不阻塞）',
          ok and all(ident != main_ident for _, ident in fw.calls), f'calls={fw.calls}')
    check('S4-3 返回立即（未同步等待 JS）', elapsed < 0.2, f'elapsed={elapsed:.3f}s')
    # 后台线程随后触发 requestClose
    check('S4-4 后台线程最终调用 __icvRequestClose',
          ok and len(codes(fw)) == 1 and '__icvRequestClose' in codes(fw)[0],
          f'calls={fw.calls}')

    # 4.2 缓存 clean → 返回 True，零 evaluate_js（无线程）
    fw = FakeWindow()
    main.webview = FakeWebview(fw)
    api = fresh_api()
    api.win_set_dirty(False)
    ret = api._on_closing()
    time.sleep(0.15)
    check('S4-5 缓存 clean → 返回 True（放行）', ret is True, f'ret={ret!r}')
    check('S4-6 clean 路径零 evaluate_js（不弹多余确认）', len(codes(fw)) == 0, f'calls={fw.calls}')

    # ══════════════ S5 _request_close_async 后台线程 ══════════════
    print('\n▶ S5: _request_close_async 后台线程 fire-and-forget')
    fw = FakeWindow()
    main.webview = FakeWebview(fw)
    api = fresh_api()
    t0 = time.time()
    api._request_close_async()
    elapsed = time.time() - t0
    check('S5-1 立即返回不阻塞', elapsed < 0.2, f'elapsed={elapsed:.3f}s')
    ok = fw.wait_calls(1, timeout=2.0)
    check('S5-2 后台线程调用 __icvRequestClose',
          ok and '__icvRequestClose' in codes(fw)[0], f'calls={fw.calls}')

    # 异常静默：后台线程 evaluate_js 抛错 → 不崩、不污染
    fw = FakeWindow()
    fw.raise_on_evaluate = True
    main.webview = FakeWebview(fw)
    api = fresh_api()
    api._request_close_async()
    time.sleep(0.15)
    check('S5-3 evaluate_js 异常时后台线程静默（不抛到主线程）', True, '')

    # ══════════════ S6 _sync_win_icon 后台化 ══════════════
    print('\n▶ S6: _sync_win_icon 后台化（不阻塞 GUI 线程）')
    fw = FakeWindow()
    main.webview = FakeWebview(fw)
    api = fresh_api()
    t0 = time.time()
    api._sync_win_icon(True)
    elapsed = time.time() - t0
    check('S6-1 立即返回不阻塞', elapsed < 0.2, f'elapsed={elapsed:.3f}s')
    ok = fw.wait_calls(1, timeout=2.0)
    check('S6-2 后台线程调用 __icvWinMaxState(true)',
          ok and '__icvWinMaxState' in codes(fw)[0] and 'true' in codes(fw)[0],
          f'calls={fw.calls}')

    fw = FakeWindow()
    main.webview = FakeWebview(fw)
    api = fresh_api()
    api._sync_win_icon(False)
    ok = fw.wait_calls(1, timeout=2.0)
    check('S6-3 后台线程调用 __icvWinMaxState(false)',
          ok and 'false' in codes(fw)[0], f'calls={fw.calls}')

    # 异常静默
    fw = FakeWindow()
    fw.raise_on_evaluate = True
    main.webview = FakeWebview(fw)
    api = fresh_api()
    api._sync_win_icon(True)
    time.sleep(0.15)
    check('S6-4 evaluate_js 异常时后台线程静默', True, '')

    # ══════════════ S7 maximized/restored 兜底仍生效 ══════════════
    print('\n▶ S7: _on_win_maximized / _on_win_restored 兜底')
    fw = FakeWindow()
    main.webview = FakeWebview(fw)
    api = fresh_api()
    api._on_win_maximized()
    check('S7-1 maximized → _win_maximized=True', api._win_maximized is True)
    ok = fw.wait_calls(1, timeout=2.0)
    check('S7-2 maximized → 后台同步 __icvWinMaxState(true)',
          ok and 'true' in codes(fw)[0], f'calls={fw.calls}')

    fw = FakeWindow()
    main.webview = FakeWebview(fw)
    api = fresh_api()
    api._win_maximized = True
    api._on_win_restored()
    check('S7-3 restored → _win_maximized=False', api._win_maximized is False)
    ok = fw.wait_calls(1, timeout=2.0)
    check('S7-4 restored → 后台同步 __icvWinMaxState(false)',
          ok and 'false' in codes(fw)[0], f'calls={fw.calls}')

    # ══════════════ S8 返回值类型契约（全部路径 bool） ══════════════
    print('\n▶ S8: closing 事件全部返回路径为 bool')
    fw = FakeWindow()
    main.webview = FakeWebview(fw)
    api = fresh_api()
    api._closing_forced = True
    r1 = api._on_closing()
    api2 = fresh_api()
    fw2 = FakeWindow()
    fw2.js_result = False
    main.webview = FakeWebview(fw2)
    r2 = api2._on_closing()
    api3 = fresh_api()
    api3.win_set_dirty(False)
    fw3 = FakeWindow()
    main.webview = FakeWebview(fw3)
    r3 = api3._on_closing()
    check('S8-1 强制放行 / 回退clean / 已上报clean 均为 bool',
          isinstance(r1, bool) and isinstance(r2, bool) and isinstance(r3, bool),
          f'r1={r1!r} r2={r2!r} r3={r3!r}')

    failed = [r for r in RESULTS if not r[1]]
    print(f'\n总计 {len(RESULTS)} 项，失败 {len(failed)} 项')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main_test())
