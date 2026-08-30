# QA smoke: check_recent_project_path（P2-1 复验）
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.api.settings_api import SettingsAPI


class FakeAppDir:
    def __init__(self):
        self.tmp = tempfile.mkdtemp(prefix="qa_p2_1_")

    def settings_file(self):
        return os.path.join(self.tmp, "settings.json")

    def prompts_library_file(self):
        return os.path.join(self.tmp, "prompt_library.json")


def main():
    results = []
    app_dir = FakeAppDir()
    api = SettingsAPI(app_dir.settings_file(), app_dir.prompts_library_file())

    tmp = tempfile.mkdtemp(prefix="qa_p2_1_path_")
    real = os.path.join(tmp, "real.icproj")
    open(real, "wb").write(b"{}")

    # 1) 存在 → exists True（只读，不改写文件）
    before = os.path.getmtime(real)
    r = api.check_recent_project_path(real)
    after = os.path.getmtime(real)
    ok = r["status"] == "success" and r["exists"] is True and before == after
    results.append(("EXISTS_TRUE_READONLY", ok, r))

    # 2) 不存在 → exists False
    r2 = api.check_recent_project_path(os.path.join(tmp, "missing.icproj"))
    ok2 = r2["status"] == "success" and r2["exists"] is False
    results.append(("MISSING_FALSE", ok2, r2))

    # 3) 空/非法输入 → 按不存在处理（不抛异常）
    r3 = api.check_recent_project_path("")
    ok3 = r3["status"] == "success" and r3["exists"] is False
    results.append(("EMPTY_AS_NOT_EXISTS", ok3, r3))

    r4 = api.check_recent_project_path(None)
    ok4 = r4["status"] == "success" and r4["exists"] is False
    results.append(("NONE_AS_NOT_EXISTS", ok4, r4))

    # 4) 相对路径 → abspath 归一后仍判存在（只读）
    cwd = os.getcwd()
    os.chdir(tmp)
    try:
        r5 = api.check_recent_project_path("real.icproj")
        ok5 = r5["status"] == "success" and r5["exists"] is True
    finally:
        os.chdir(cwd)
    results.append(("RELATIVE_NORMALIZED", ok5, r5))

    failed = [name for name, ok, _ in results if not ok]
    for name, ok, r in results:
        print(f"[{'OK' if ok else 'FAIL'}] {name} | {r}")
    print("CHECK_RECENT_PATH_SMOKE:", "ALL PASS" if not failed else f"FAILED {failed}")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
