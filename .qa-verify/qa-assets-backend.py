# QA 独立验证 · 后端资产索引持久化（AC-5 + 损坏容错）
# 作者：Edward (QA)。运行：.venv/Scripts/python.exe .qa-verify/qa-assets-backend.py
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.api.project_api import ProjectAPI  # noqa: E402

passed = 0
failed = 0


def check(cond, msg):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ✓ {msg}")
    else:
        failed += 1
        print(f"  ✗ {msg}")


def main():
    tmp = tempfile.mkdtemp(prefix="qa-assets-")
    proj = os.path.join(tmp, "demo.icproj")
    api = ProjectAPI()

    print("▶ 1. 无路径 → no_path")
    r = api.save_assets([{"key": "abc"}])
    check(r.get("status") == "error" and r.get("message") == "no_path", "save_assets 无路径 → no_path")
    r = api.load_assets()
    check(r.get("status") == "empty", "load_assets 无路径 → empty")

    print("▶ 2. save_assets → 原子写 <项目名>.assets.json")
    api.current_project_path = proj
    records = [
        {"key": "deadbeef", "nodeId": "n1", "adopted": True, "locked": True,
         "tags": ["绣球"], "category": "成图", "updatedAt": 123},
        {"key": "cafebabe", "nodeId": "n2", "adopted": False, "locked": False,
         "tags": [], "category": "成图", "updatedAt": 124},
    ]
    r = api.save_assets(records)
    check(r.get("status") == "success", "save_assets success")
    assets_path = proj[:-len(".icproj")] + ".assets.json"
    check(os.path.exists(assets_path), f"<项目名>.assets.json 落盘存在（{os.path.basename(assets_path)}）")
    with open(assets_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    check(isinstance(data.get("records"), list) and len(data["records"]) == 2, "落盘 records 结构正确")
    check(data["records"][0]["adopted"] is True and data["records"][0]["tags"] == ["绣球"], "落盘内容与提交一致")

    print("▶ 3. load_assets 往返（AC-5 跨会话恢复）")
    r = api.load_assets()
    check(r.get("status") == "success", "load_assets success")
    check(len(r["records"]) == 2, "往返 2 条")
    check(r["records"][1]["key"] == "cafebabe", "往返 key 一致")

    print("▶ 4. 文件缺失 → empty（旧项目迁移策略）")
    os.remove(assets_path)
    r = api.load_assets()
    check(r.get("status") == "empty", "文件删除后 → empty（全未采纳/未锁定）")

    print("▶ 5. 损坏容错：非法 JSON → empty 回退空索引")
    with open(assets_path, "w", encoding="utf-8") as f:
        f.write("{ 这不是合法 JSON !!!")
    r = api.load_assets()
    check(r.get("status") == "empty", "损坏 JSON → status=empty（容错回退空索引）")

    print("▶ 6. 结构容错：records 非列表 → 空列表")
    with open(assets_path, "w", encoding="utf-8") as f:
        json.dump({"records": "not-a-list"}, f)
    r = api.load_assets()
    check(r.get("status") == "success" and r.get("records") == [], "records 非列表 → 空列表")

    print("▶ 7. 与 history.jsonl 职责分离（PRD 五.1）")
    api.current_project_path = proj
    api.append_history({"kind": "image", "nodeId": "n1", "prompt": "p"})
    with open(proj[:-len(".icproj")] + ".history.jsonl", "r", encoding="utf-8") as f:
        hline = f.readline().strip()
    check("adopted" not in hline, "history.jsonl 不含采纳字段（职责分离）")
    with open(assets_path, "r", encoding="utf-8") as f:
        adata = json.load(f)
    check("prompt" not in json.dumps(adata), "assets.json 不含生成流水字段（职责分离）")

    print(f"\n══════════════════════════════════")
    print(f"后端资产索引：通过 {passed} 项，失败 {failed} 项")
    if failed > 0:
        sys.exit(1)
    print("BACKEND-ASSETS PASS")


if __name__ == "__main__":
    main()
