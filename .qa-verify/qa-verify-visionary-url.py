# -*- coding: utf-8 -*-
"""
QA 独立验证：visionary.beer 无扩展名图片 URL 提取修复
=====================================================
被验对象（工程师修改，未提交，git diff 可见）：
  1. backend/api/gemini_compat.py  —— URL 提取规则（_is_image_candidate / extract_image_urls_from_text）
  2. backend/api/unified_api.py    —— _guess_image_ext / _download_url_to_base64

本脚本为独立回归测试：不采信工程师自检结论，全部期望值依据 PRD/设计/用户报障日志推导。
运行方式：
  cd "G:/Infinite Canvas/Infinite Canvas 2.0"
  .venv/Scripts/python.exe .qa-verify/qa-verify-visionary-url.py
"""
import ast
import io
import sys
import os
import base64

PROJECT_ROOT = r"G:\Infinite Canvas\Infinite Canvas 2.0"
sys.path.insert(0, PROJECT_ROOT)

from backend.api import gemini_compat as gc
from backend.api import unified_api as ua

# ─────────────────────────────────────────
# 极简测试框架（记录 用例/期望/实际/通过）
# ─────────────────────────────────────────
RESULTS = []
FAILURES = []


def check(name, expected, actual, note=""):
    ok = expected == actual
    RESULTS.append((name, expected, actual, ok, note))
    if not ok:
        FAILURES.append(name)
    return ok


def check_true(name, cond, note=""):
    ok = bool(cond)
    RESULTS.append((name, "True", bool(cond), ok, note))
    if not ok:
        FAILURES.append(name)
    return ok


def check_none(name, actual, note=""):
    ok = actual is None
    RESULTS.append((name, "None", actual, ok, note))
    if not ok:
        FAILURES.append(name)
    return ok


# 真实报障 URL（含 . - _ 的 JWT，验证不被截断）
REAL_URL = ("https://visionary.beer/api/generations/51fc6b8d-0649-4973-8b3e-c1c5def15a2b/image"
            "?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
            "eyJwdXJwb3NlIjoib3BlbmFwaS1nZW5lcmF0aW9uLWltYWdlIn0.abc")

# ─────────────────────────────────────────
# 0. 语法与导入
# ─────────────────────────────────────────
print("== 0. 语法与导入 ==")
for f in ["backend/api/gemini_compat.py", "backend/api/unified_api.py"]:
    p = os.path.join(PROJECT_ROOT, f)
    try:
        with open(p, "r", encoding="utf-8") as fh:
            src = fh.read()
        ast.parse(src)
        compile(src, f, "exec")
        check(f"compile({f})", True, True)
    except Exception as e:
        check(f"compile({f})", True, False, note=repr(e))

# ─────────────────────────────────────────
# 1. 核心正例
# ─────────────────────────────────────────
print("== 1. 核心正例 ==")

# 1a. 真实风格 visionary URL（含 JWT）→ 提取成功且 URL 完整
got = gc.extract_image_urls_from_text(f"图片已生成：{REAL_URL}")
check("1a 真实 visionary URL 提取", [REAL_URL], got)

# 1b. 无查询串的 /image 结尾
u1 = "https://visionary.beer/api/generations/51fc6b8d-0649-4973-8b3e-c1c5def15a2b/image"
got = gc.extract_image_urls_from_text(u1)
check("1b 无查询串 /image", [u1], got)

# 1c. 旧格式带扩展名（不回归）
u2 = "https://cdn.example.com/foo.png?x=1"
got = gc.extract_image_urls_from_text(u2)
check("1c 旧格式 foo.png?x=1", [u2], got)

# 1d. 文本混排，且尾部带「，点击查看。」
text = f"图片已生成：{REAL_URL}，点击查看。"
got = gc.extract_image_urls_from_text(text)
check("1d 混排文本不吞标点", [REAL_URL], got)

# ─────────────────────────────────────────
# 2. 负例（不得误抓）
# ─────────────────────────────────────────
print("== 2. 负例 ==")
check("2a 普通页面", [], gc.extract_image_urls_from_text("https://example.com/page"))
check("2b .css", [], gc.extract_image_urls_from_text("https://example.com/style.css"))
check("2c .js", [], gc.extract_image_urls_from_text("https://example.com/js/app.js"))

# 2d. 路径末段恰为 images 的非图片服务（工程师规则可能命中 → 记录判断，不改代码）
got = gc.extract_image_urls_from_text("https://example.com/images")
check("2d /images 末段(判据:命中则记录过度)", [], got,
      note="OBSERVE: 若命中则属规则 trade-off，记录不修改")

# ─────────────────────────────────────────
# 3. 边界
# ─────────────────────────────────────────
print("== 3. 边界 ==")

# 3a. 多 URL 去重
dup_text = f"第一张：{REAL_URL} 第二张还是：{REAL_URL}"
got = gc.extract_image_urls_from_text(dup_text)
check("3a 多 URL 去重", [REAL_URL], got)

# 3b. 空文本 / 非字符串
check("3b1 空字符串", [], gc.extract_image_urls_from_text(""))
check("3b2 None", [], gc.extract_image_urls_from_text(None))
check("3b3 非字符串(123)", [], gc.extract_image_urls_from_text(123))
check("3b4 纯空白", [], gc.extract_image_urls_from_text("   \n  "))

# 3c. URL 后跟全角标点
for punct in ["。", "，", "；", "：", "！", "？", "）", "】", "》", "」", "』", "…"]:
    got = gc.extract_image_urls_from_text(f"生成完毕 {REAL_URL}{punct} 结束")
    check(f"3c 全角标点 {punct}", [REAL_URL], got)

# 3d. base64url token 字符保留（- _ . =）
u3 = "https://x.com/a/image?token=a_b-c.d"
got = gc.extract_image_urls_from_text(u3)
check("3d base64url token", [u3], got)

u4 = "https://x.com/a/image?token=abc.def="  # 尾随 =（base64 padding）
got = gc.extract_image_urls_from_text(u4)
check("3e 尾随 = 保留", [u4], got)

# 3f. ASCII 尾标点剥离（英文句号）
got = gc.extract_image_urls_from_text("see https://example.com/foo.png.")
check("3f ASCII 句号剥离", ["https://example.com/foo.png"], got)

# 3g. URL 尾为 - / _（base64url 合法字符，不得剥离）
u5 = "https://x.com/api/generations/abc/image?token=abc-"
got = gc.extract_image_urls_from_text(u5)
check("3g 尾 - 保留", [u5], got)
u6 = "https://x.com/api/generations/abc/image?token=abc_"
got = gc.extract_image_urls_from_text(u6)
check("3h 尾 _ 保留", [u6], got)

# 3i. 多个不同 URL 顺序保留
text2 = f"先看 {u1}，再看 {u2}。"
got = gc.extract_image_urls_from_text(text2)
check("3i 多 URL 顺序", [u1, u2], got)

# 3j. generation 单数路径
u7 = "https://x.com/api/generation/123/image?token=t"
got = gc.extract_image_urls_from_text(u7)
check("3j /generation/ 单数", [u7], got)

# 3k. 无 api 前缀的 generations
u8 = "https://x.com/generations/123/image?token=t"
got = gc.extract_image_urls_from_text(u8)
check("3k 无 api 前缀", [u8], got)

# ─────────────────────────────────────────
# 4. 下载链路
# ─────────────────────────────────────────
print("== 4. 下载链路 ==")

# 4a. _guess_image_ext：Content-Type 优先
check("4a1 image/png", "png", ua._guess_image_ext("image/png", b"junk"))
check("4a2 image/jpeg->jpg", "jpg", ua._guess_image_ext("image/jpeg", b"junk"))
check("4a3 image/jpg->jpg", "jpg", ua._guess_image_ext("image/jpg", b"junk"))
check("4a4 image/webp", "webp", ua._guess_image_ext("image/webp", b"junk"))
check("4a5 image/gif", "gif", ua._guess_image_ext("image/gif", b"junk"))
check("4a6 image/bmp", "bmp", ua._guess_image_ext("image/bmp", b"junk"))
check("4a7 image/svg+xml", "svg", ua._guess_image_ext("image/svg+xml", b"junk"))
check("4a8 带 charset", "png", ua._guess_image_ext("image/png; charset=utf-8", b"junk"))

# 4b. _guess_image_ext：PIL 魔数兜底（octet-stream 但内容为 PNG）
buf = io.BytesIO()
from PIL import Image
Image.new("RGB", (4, 4), (255, 0, 0)).save(buf, format="PNG")
png_bytes = buf.getvalue()
check("4b1 octet-stream+PNG魔数", "png", ua._guess_image_ext("application/octet-stream", png_bytes))
buf2 = io.BytesIO()
Image.new("RGB", (4, 4), (0, 255, 0)).save(buf2, format="JPEG")
jpeg_bytes = buf2.getvalue()
check("4b2 octet-stream+JPEG魔数", "jpg", ua._guess_image_ext("application/octet-stream", jpeg_bytes))

# 4c. _guess_image_ext：无法识别 → 默认 png（不抛异常）
check("4c1 缺 Content-Type+垃圾", "png", ua._guess_image_ext(None, b"not an image at all"))
check("4c2 空 Content-Type+垃圾", "png", ua._guess_image_ext("", b"not an image at all"))
check("4c3 空内容", "png", ua._guess_image_ext("application/octet-stream", b""))

# 4d. _parse_image_response：Gemini 结构（文本+URL）→ success 且 images 含 URL
router = ua.UnifiedAPIRouter(provider_api=None)
gemini_mock = {
    "candidates": [{
        "content": {
            "parts": [
                {"text": f"图片已生成：{REAL_URL}，点击查看。"}
            ]
        }
    }]
}
parsed = router._parse_image_response(gemini_mock, ua.ApiFormat.GEMINI_NATIVE)
check_true("4d1 parse success", parsed.get("success") is True)
check("4d2 image_url 完整", REAL_URL, parsed.get("image_url"))
check("4d3 images 含 URL", [REAL_URL], parsed.get("images"))

# 4e. _download_url_to_base64：data: 假 URL → 异常路径不崩溃返回 None
import unittest.mock as mock
with mock.patch.object(ua.requests, "get", side_effect=Exception("boom")):
    r = router._download_url_to_base64("data:image/png;base64,AAAA")
    check_none("4e 下载异常返回 None", r)

# 4f. _download_url_to_base64：HTTP 非 200 → None
class FakeResp:
    status_code = 404
    headers = {}
    content = b""
with mock.patch.object(ua.requests, "get", return_value=FakeResp()):
    r = router._download_url_to_base64("https://example.com/404")
    check_none("4f 非200返回 None", r)

# 4g. _download_url_to_base64：成功路径 → data:image/png;base64,...
class FakeRespOK:
    status_code = 200
    headers = {"Content-Type": "image/png"}
    content = png_bytes
with mock.patch.object(ua.requests, "get", return_value=FakeRespOK()):
    r = router._download_url_to_base64("https://example.com/a.png")
    exp = "data:image/png;base64," + base64.b64encode(png_bytes).decode("utf-8")
    check("4g 成功路径 data URL", exp, r)

# 4h. _download_url_to_base64：octet-stream + PNG 魔数 → data:image/png
class FakeRespOctet:
    status_code = 200
    headers = {"Content-Type": "application/octet-stream"}
    content = png_bytes
with mock.patch.object(ua.requests, "get", return_value=FakeRespOctet()):
    r = router._download_url_to_base64("https://visionary.beer/api/generations/abc/image?token=t")
    check_true("4h octet-stream 魔数兜底 png", r is not None and r.startswith("data:image/png;base64,"))

# ─────────────────────────────────────────
# 汇总
# ─────────────────────────────────────────
print("\n== 结果汇总 ==")
print(f"{'#':>3} {'用例':<38} {'期望':<28} {'实际':<28} {'通过':<4} 说明")
print("-" * 130)
for i, (name, exp, act, ok, note) in enumerate(RESULTS, 1):
    es = str(exp)
    if len(es) > 26:
        es = es[:23] + "..."
    as_ = str(act)
    if len(as_) > 26:
        as_ = as_[:23] + "..."
    print(f"{i:>3} {name:<38} {es:<28} {as_:<28} {'PASS' if ok else 'FAIL':<4} {note}")

total = len(RESULTS)
passed = total - len(FAILURES)
print("-" * 130)
print(f"TOTAL: {total} | PASSED: {passed} | FAILED: {len(FAILURES)}")
if FAILURES:
    print("FAILED CASES:", FAILURES)
    sys.exit(1)
print("ALL PASS")
sys.exit(0)
