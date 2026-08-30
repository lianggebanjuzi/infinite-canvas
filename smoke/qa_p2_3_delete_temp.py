# QA smoke: delete_temp_file 白名单（P2-3 复验）
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.api.image_api import ImageAPI


class FakeSettings:
    def load_settings(self):
        return {"image_save_path": os.path.join(tempfile.gettempdir(), "qa_save_dir")}


def main():
    results = []
    api = ImageAPI(FakeSettings())
    tmp = tempfile.mkdtemp(prefix="qa_delete_")

    # 1) 白名单内（image_save_path）可删
    save_dir = os.path.join(tempfile.gettempdir(), "qa_save_dir")
    os.makedirs(save_dir, exist_ok=True)
    inside = os.path.join(save_dir, "mask-123.png")
    open(inside, "wb").write(b"x")
    r = api.delete_temp_file(inside)
    ok = r["status"] == "success" and not os.path.exists(inside)
    results.append(("INSIDE_ALLOWED_DELETED", ok, r))

    # 2) 白名单外任意路径拒绝（防误删）
    outside = os.path.join(tmp, "important.png")
    open(outside, "wb").write(b"keep")
    r2 = api.delete_temp_file(outside)
    ok2 = r2["status"] == "error" and os.path.exists(outside)
    results.append(("OUTSIDE_REJECTED_KEPT", ok2, r2))

    # 3) 前缀绕过防护：image_save_path 的兄弟目录
    sibling = os.path.join(tempfile.gettempdir(), "qa_save_dir_evil")
    os.makedirs(sibling, exist_ok=True)
    sib_file = os.path.join(sibling, "x.png")
    open(sib_file, "wb").write(b"keep2")
    r3 = api.delete_temp_file(sib_file)
    ok3 = r3["status"] == "error" and os.path.exists(sib_file)
    results.append(("SIBLING_PREFIX_ATTACK_REJECTED", ok3, r3))

    # 4) 会话临时导入目录（infinite_canvas_imports）可删
    imports_dir = os.path.join(tempfile.gettempdir(), "infinite_canvas_imports")
    os.makedirs(imports_dir, exist_ok=True)
    imp = os.path.join(imports_dir, "mask-456.png")
    open(imp, "wb").write(b"y")
    r4 = api.delete_temp_file(imp)
    ok4 = r4["status"] == "success" and not os.path.exists(imp)
    results.append(("IMPORTS_DIR_ALLOWED_DELETED", ok4, r4))

    # 5) 幂等：文件已不存在 → success
    r5 = api.delete_temp_file(inside)
    ok5 = r5["status"] == "success"
    results.append(("IDEMPOTENT_MISSING_OK", ok5, r5))

    # 6) 空路径 → error
    r6 = api.delete_temp_file("")
    ok6 = r6["status"] == "error"
    results.append(("EMPTY_PATH_ERROR", ok6, r6))

    failed = [name for name, ok, _ in results if not ok]
    for name, ok, r in results:
        print(f"[{'OK' if ok else 'FAIL'}] {name} | {r}")
    print("DELETE_TEMP_FILE_SMOKE:", "ALL PASS" if not failed else f"FAILED {failed}")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
