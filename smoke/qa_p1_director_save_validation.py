# QA smoke: director 保存接口校验（P1 复验）
# 覆盖：director_save_project / director_save_project_as 保存前校验
#   - 合法 path + format === 'icdirector' → success 且落盘
#   - 非法扩展名（非 .icdirector）→ error 且未创建文件
#   - 非法格式（format 非 icdirector / data 非对象）→ error 且未创建文件
#   - 保存被拒后既有文件内容不被覆盖
# 纯标准库，临时目录自包含，可重复运行。
# 运行：python smoke/qa_p1_director_save_validation.py

import json
import os
import sys
import tempfile

# 强制 stdout UTF-8：避免 Windows GBK 控制台编码问题
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.director_api import DirectorAPI


class FakeSettings:
    def __init__(self):
        self.recent = []

    def load_settings(self):
        return {}

    def touch_recent_project(self, path, name=""):
        self.recent.append({"path": path, "name": name})
        return {"status": "success"}

    def load_recent_projects(self):
        return {"status": "success", "projects": self.recent}

    def remove_recent_project(self, path):
        self.recent = [r for r in self.recent if r["path"] != path]
        return {"status": "success"}


class FakeAppApi:
    def __init__(self):
        self.settings = FakeSettings()


def make_project(name="p1"):
    return {
        "format": "icdirector",
        "version": 1,
        "id": "00000000-0000-4000-8000-000000000001",
        "name": name,
        "scene": [],
        "cameras": [],
        "activeCameraId": "",
        "references": [],
        "lighting": {},
        "timeline": {"duration": 10, "fps": 24, "keyframes": []},
        "assets": [],
    }


def file_absent(path):
    """目标文件及其 .tmp 临时文件都不存在（校验失败不得创建/覆盖）。"""
    return not os.path.exists(path) and not os.path.exists(path + ".tmp")


def main():
    results = []
    tmp = tempfile.mkdtemp(prefix="qa_p1_save_")
    api = DirectorAPI(app_api=FakeAppApi())

    # 1) 合法保存成功：.icdirector 扩展名 + format === icdirector
    good = os.path.join(tmp, "good.icdirector")
    r = api.director_save_project(good, make_project("good"))
    ok = r["status"] == "success" and os.path.isfile(good)
    if ok:
        with open(good, "r", encoding="utf-8") as f:
            ok = json.load(f).get("format") == "icdirector"
    results.append(("VALID_SAVE_SUCCESS", ok, r))

    # 2) 非法扩展名被拒且未创建文件（动态复现：not-a-director.json 曾被成功写入）
    bad_ext = os.path.join(tmp, "not-a-director.json")
    r2 = api.director_save_project(bad_ext, make_project("bad_ext"))
    ok2 = r2["status"] == "error" and file_absent(bad_ext)
    results.append(("BAD_EXTENSION_REJECTED_NO_FILE", ok2, r2))

    # 3a) format 非 icdirector 被拒且未创建文件
    bad_fmt = os.path.join(tmp, "bad-format.icdirector")
    r3 = api.director_save_project(bad_fmt, {"format": "icproj", "version": "3.4"})
    ok3 = r3["status"] == "error" and file_absent(bad_fmt)
    results.append(("BAD_FORMAT_REJECTED_NO_FILE", ok3, r3))

    # 3b) data 非对象被拒且未创建文件
    bad_data = os.path.join(tmp, "bad-data.icdirector")
    r4 = api.director_save_project(bad_data, ["not", "a", "dict"])
    ok4 = r4["status"] == "error" and file_absent(bad_data)
    results.append(("NON_OBJECT_DATA_REJECTED_NO_FILE", ok4, r4))

    # 4) 既有文件不被覆盖：合法扩展名路径已存在非 icdirector 内容，再次保存非法数据 → 原内容不变
    existing = os.path.join(tmp, "existing.icdirector")
    original_content = '{"format": "icproj", "version": "3.4", "keep": true}'
    with open(existing, "w", encoding="utf-8") as f:
        f.write(original_content)
    r5 = api.director_save_project(existing, {"format": "icproj", "version": "9.9"})
    ok5 = r5["status"] == "error"
    with open(existing, "r", encoding="utf-8") as f:
        ok5 = ok5 and f.read() == original_content
    results.append(("EXISTING_ICDIRECTOR_NOT_OVERWRITTEN", ok5, r5))

    # 5) 非法扩展名且该路径已有文件 → 拒绝且不覆盖
    existing_json = os.path.join(tmp, "existing.json")
    json_content = '{"keep": true}'
    with open(existing_json, "w", encoding="utf-8") as f:
        f.write(json_content)
    r6 = api.director_save_project(existing_json, make_project("nope"))
    ok6 = r6["status"] == "error"
    with open(existing_json, "r", encoding="utf-8") as f:
        ok6 = ok6 and f.read() == json_content
    results.append(("EXISTING_JSON_NOT_OVERWRITTEN", ok6, r6))

    # 6) director_save_project_as 非法数据 → 弹窗前直接拒绝（不触发 GUI，不落盘）
    r7 = api.director_save_project_as({"format": "icproj"})
    ok7 = r7["status"] == "error"
    results.append(("SAVE_AS_BAD_DATA_REJECTED_BEFORE_DIALOG", ok7, r7))

    failed = [name for name, ok, _ in results if not ok]
    for name, ok, r in results:
        print(f"[{'OK' if ok else 'FAIL'}] {name} | {r}")
    print("DIRECTOR_SAVE_VALIDATION_SMOKE:", "ALL PASS" if not failed else f"FAILED {failed}")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
