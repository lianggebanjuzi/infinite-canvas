# -*- coding: utf-8 -*-
# smoke/test-trust-layer-backend.py
# QA（严过关/Edward）· 信任层后端测试：原子写 / append_json_line / history.jsonl 落点 / 坏行容错 / .tmp 清理
# 纯标准库，直接 import 后端模块测试（非 pytest）。
# 运行：python smoke/test-trust-layer-backend.py

import json
import os
import sys
import tempfile
import uuid

# 强制 stdout UTF-8：避免 Windows GBK 控制台无法编码 ▶/✓/✗ 导致 UnicodeEncodeError
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from backend.api.utils import atomic_write_json, append_json_line
from backend.api.project_api import ProjectAPI

passed = 0
failed = 0
failures = []


def check(cond, msg):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ✓ {msg}")
    else:
        failed += 1
        failures.append(msg)
        print(f"  ✗ {msg}")


def section(title):
    print(f"\n▶ {title}")


# 临时目录用平台临时区；注意：tempfile.mkdtemp() 创建的目录在此沙箱下被标为不可写，
# 改用 os.makedirs 手工创建唯一目录名（os.makedirs 创建的目录可写）。
tmpdir = os.path.join(tempfile.gettempdir(), "icv-trust-" + uuid.uuid4().hex[:10])
os.makedirs(tmpdir)

# ── 1. atomic_write_json 成功 ──
section("原子写成功：内容正确 + 无 .tmp 残留")
target = os.path.join(tmpdir, "proj.icproj")
data = {"format": "icv", "nodes": [{"id": "n1", "中文": "值"}]}
atomic_write_json(target, data)
check(os.path.exists(target), "目标文件已创建")
with open(target, "r", encoding="utf-8") as f:
    loaded = json.load(f)
check(loaded == data, "JSON 内容一致（含中文）")
check(not os.path.exists(target + ".tmp"), "成功后无 .tmp 残留")

# ── 2. atomic_write_json 异常（os.replace 抛错）→ 原文件不变 + tmp 清理 ──
section("原子写异常：原文件不变 + .tmp 清理")
orig_target = os.path.join(tmpdir, "orig.icproj")
with open(orig_target, "w", encoding="utf-8") as f:
    f.write('{"original": true}')
orig_replace = os.replace


def boom(src, dst):
    raise OSError("simulated replace failure")


os.replace = boom
try:
    raised = False
    try:
        atomic_write_json(orig_target, {"new": True})
    except OSError:
        raised = True
    check(raised, "异常向上抛（OSError）")
    with open(orig_target, "r", encoding="utf-8") as f:
        content = f.read().strip()
    check(content == '{"original": true}', "原文件内容不变")
    check(not os.path.exists(orig_target + ".tmp"), "失败后 .tmp 被清理")
finally:
    os.replace = orig_replace

# ── 3. 写入失败（目录不存在）→ 抛错 + 无 tmp ──
section("写入失败（坏路径）→ 抛错且无残留")
bad_target = os.path.join(tmpdir, "no_such_dir", "x.icproj")
raised = False
try:
    atomic_write_json(bad_target, {"a": 1})
except OSError:
    raised = True
check(raised, "坏路径写入抛 OSError")
check(not os.path.exists(bad_target + ".tmp"), "坏路径无 .tmp 残留")

# ── 4. append_json_line 追加语义 ──
section("append_json_line：追加 + 多行合法 JSON")
hist = os.path.join(tmpdir, "h.jsonl")
append_json_line(hist, {"kind": "image", "nodeId": "a"})
append_json_line(hist, {"kind": "text", "nodeId": "b"})
with open(hist, "r", encoding="utf-8") as f:
    lines = [ln for ln in f.read().split("\n") if ln.strip()]
check(len(lines) == 2, f"两行（实际 {len(lines)}）")
check(json.loads(lines[0])["nodeId"] == "a", "第一行合法 JSON")
check(json.loads(lines[1])["nodeId"] == "b", "第二行合法 JSON")

# ── 5. _history_path 落点集中 ──
section("_history_path 落点集中（.icproj 同目录兄弟文件）")
api = ProjectAPI()
api.current_project_path = os.path.join(tmpdir, "myproj.icproj")
check(api._history_path() == os.path.join(tmpdir, "myproj.history.jsonl"), "同目录 <名>.history.jsonl")
api.current_project_path = None
check(api._history_path() is None, "无路径返回 None")

# ── 6. append_history / load_history 往返 + 坏行容错 ──
section("append_history + load_history 往返 + 坏行容错")
api2 = ProjectAPI()
api2.current_project_path = os.path.join(tmpdir, "p2.icproj")
check(api2.append_history({"kind": "image", "nodeId": "x1"}).get("status") == "success", "append_history success")
check(api2.append_history({"kind": "text", "nodeId": "x2"}).get("status") == "success", "append_history 第二条")
hp = api2._history_path()
with open(hp, "a", encoding="utf-8") as f:
    f.write("{bad json line\n")
    f.write("\n")  # 空行
r = api2.load_history()
check(r.get("status") == "success", "load_history success")
entries = r.get("entries", [])
check(len(entries) == 2, f"坏行与空行被跳过（实际 {len(entries)} 条）")
check(entries[0].get("nodeId") == "x1" and entries[1].get("nodeId") == "x2", "合法行顺序保留")

# 无路径
api3 = ProjectAPI()
r = api3.append_history({"kind": "image"})
check(r.get("status") == "error" and r.get("message") == "no_path", "无路径 append_history → no_path")
check(api3.load_history().get("status") == "empty", "无路径 load_history → empty")

# 文件不存在
api4 = ProjectAPI()
api4.current_project_path = os.path.join(tmpdir, "nofile.icproj")
check(api4.load_history().get("status") == "empty", "文件不存在 → empty")

# ── 7. cleanup_orphan_tmp_files ──
section("cleanup_orphan_tmp_files：只删 .icproj.tmp 孤儿")
clean_dir = os.path.join(tmpdir, "clean")
os.makedirs(clean_dir)
orphan = os.path.join(clean_dir, "x.icproj.tmp")
with open(orphan, "w", encoding="utf-8") as f:
    f.write("orphan")
keep_icproj = os.path.join(clean_dir, "keep.icproj")
with open(keep_icproj, "w", encoding="utf-8") as f:
    f.write("keep")
keep_history = os.path.join(clean_dir, "keep.history.jsonl")
with open(keep_history, "w", encoding="utf-8") as f:
    f.write("keep")
api5 = ProjectAPI()
api5.current_project_path = keep_icproj
api5.cleanup_orphan_tmp_files()
check(not os.path.exists(orphan), ".icproj.tmp 孤儿被清理")
check(os.path.exists(keep_icproj), ".icproj 不被误删")
check(os.path.exists(keep_history), ".history.jsonl 不被误删")

print("\n══════════════════════════════════")
print(f"后端信任层：通过 {passed} 项，失败 {failed} 项")
if failed:
    print("失败明细：")
    for f in failures:
        print(f"- {f}")
    sys.exit(1)
print("BACKEND TRUST PASS")
