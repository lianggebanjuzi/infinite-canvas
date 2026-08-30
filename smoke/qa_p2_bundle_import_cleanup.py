# QA smoke: .icbundle 导入孤立资产清理（P2 复验）
# 覆盖：import_bundle 在取消 / 目标项目写入失败 / 插入模式错误时，
#       删除本次导入新建的资产；导入前已存在的去重资产保留（不被误删）。
# 纯标准库，临时目录自包含，可重复运行；不依赖真实项目文件，不弹 GUI。
# 运行：python smoke/qa_p2_bundle_import_cleanup.py

import hashlib
import json
import os
import sys
import tempfile
import zipfile

# 强制 stdout UTF-8：避免 Windows GBK 控制台编码问题
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import backend.api.bundle_api as bundle_api
from backend.api.bundle_api import BundleAPI

# 伪 PNG 内容（导入只校验扩展名/MIME/哈希/大小，不解析图片内容；内容不同保证 sha 不同）
ASSET_A = b"\x89PNG\r\n\x1a\n" + b"A" * 64
ASSET_B = b"\x89PNG\r\n\x1a\n" + b"B" * 64


class FakeProjectAPI:
    def __init__(self):
        self.current_project_path = None


class FakeSettings:
    def __init__(self, save_path):
        self.save_path = save_path

    def load_settings(self):
        return {"image_save_path": self.save_path}


def build_bundle(dest, assets, mode="project", project_name="P2测试项目"):
    """构造合法 .icbundle：manifest.json + project.icproj + assets/<sha>.png。

    assets: [(payload_bytes, sourcePath), ...]；每个 payload 内容必须唯一（sha 去重校验）。
    """
    project_doc = {
        "format": "icv",
        "version": 1,
        "projectName": project_name,
        "nodes": [{"id": f"n{i}", "assetPath": src} for i, (_, src) in enumerate(assets)],
        "edges": [],
    }
    project_payload = json.dumps(project_doc, ensure_ascii=False).encode("utf-8")
    manifest_assets = []
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("project.icproj", project_payload)
        for payload, src in assets:
            sha = hashlib.sha256(payload).hexdigest()
            name = f"assets/{sha}.png"
            z.writestr(name, payload)
            manifest_assets.append({"path": name, "sha256": sha, "size": len(payload), "sourcePath": src})
        manifest = {
            "schemaVersion": 1,
            "format": "icbundle",
            "appVersion": "2.1.0",
            "mode": mode,
            "createdAt": 1,
            "projectName": project_name,
            "project": {
                "path": "project.icproj",
                "sha256": hashlib.sha256(project_payload).hexdigest(),
                "size": len(project_payload),
            },
            "assets": manifest_assets,
            "thumbs": [],
        }
        z.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
    return [item["sha256"] for item in manifest_assets]


def sha_of(payload):
    return hashlib.sha256(payload).hexdigest()


def asset_path(assets_dir, sha):
    return os.path.join(assets_dir, f"{sha}.png")


def main():
    results = []
    base = tempfile.mkdtemp(prefix="qa_p2_cleanup_")

    # 每个用例独立 assets_dir + bundle + target_dir，互不干扰
    def new_env(tag):
        env_tmp = os.path.join(base, tag)
        os.makedirs(env_tmp, exist_ok=True)
        assets_dir = os.path.join(env_tmp, "assets")
        os.makedirs(assets_dir, exist_ok=True)
        target_dir = os.path.join(env_tmp, "target")
        os.makedirs(target_dir, exist_ok=True)
        bundle_path = os.path.join(env_tmp, "input.icbundle")
        api = BundleAPI(app_dir=env_tmp, project_api=FakeProjectAPI(), settings_api=FakeSettings(assets_dir))
        return api, assets_dir, target_dir, bundle_path

    # ── 1) 取消后新建资产被清理 ──
    api, assets_dir, target_dir, bundle_path = new_env("cancel")
    build_bundle(bundle_path, [(ASSET_A, "C:/src/a.png")])
    original_choose = BundleAPI._choose_new_project_path
    BundleAPI._choose_new_project_path = lambda self, doc, opts: None  # 模拟用户取消路径选择
    try:
        r = api.import_bundle({"path": bundle_path, "strategy": "new_project", "target_dir": target_dir})
    finally:
        BundleAPI._choose_new_project_path = original_choose
    ok = r["status"] == "cancelled" and not os.path.exists(asset_path(assets_dir, sha_of(ASSET_A)))
    results.append(("CANCEL_CLEANS_NEW_ASSETS", ok, r))

    # ── 2) 取消后：去重命中（导入前已存在）的资产被保留，仅新建的被清理 ──
    api, assets_dir, target_dir, bundle_path = new_env("dedup")
    pre_sha = sha_of(ASSET_A)
    pre_file = asset_path(assets_dir, pre_sha)
    with open(pre_file, "wb") as f:  # 导入前已存在的去重资产
        f.write(ASSET_A)
    build_bundle(bundle_path, [(ASSET_A, "C:/src/a.png"), (ASSET_B, "C:/src/b.png")])
    BundleAPI._choose_new_project_path = lambda self, doc, opts: None
    try:
        r = api.import_bundle({"path": bundle_path, "strategy": "new_project", "target_dir": target_dir})
    finally:
        BundleAPI._choose_new_project_path = original_choose
    ok = (
        r["status"] == "cancelled"
        and os.path.exists(pre_file)  # 既有去重资产保留
        and not os.path.exists(asset_path(assets_dir, sha_of(ASSET_B)))  # 新建资产被清理
    )
    results.append(("DEDUP_EXISTING_PRESERVED_ON_CANCEL", ok, r))

    # ── 3) 目标项目写入失败后新建资产被清理 ──
    api, assets_dir, target_dir, bundle_path = new_env("write_fail")
    build_bundle(bundle_path, [(ASSET_A, "C:/src/a.png")])
    original_write = bundle_api.atomic_write_json

    def boom(path, data):
        raise OSError("simulated project write failure")

    bundle_api.atomic_write_json = boom
    try:
        r = api.import_bundle({"path": bundle_path, "strategy": "new_project", "target_dir": target_dir})
    finally:
        bundle_api.atomic_write_json = original_write
    ok = r["status"] == "error" and not os.path.exists(asset_path(assets_dir, sha_of(ASSET_A)))
    results.append(("WRITE_FAILURE_CLEANS_NEW_ASSETS", ok, r))

    # ── 4) 插入模式非法（非 selection 包）→ 错误且新建资产被清理 ──
    api, assets_dir, target_dir, bundle_path = new_env("insert_mode_error")
    build_bundle(bundle_path, [(ASSET_A, "C:/src/a.png")], mode="project")
    r = api.import_bundle({"path": bundle_path, "strategy": "insert_canvas"})
    ok = r["status"] == "error" and not os.path.exists(asset_path(assets_dir, sha_of(ASSET_A)))
    results.append(("INSERT_MODE_ERROR_CLEANS_NEW_ASSETS", ok, r))

    # ── 5) 插入模式成功 → 新建资产保留（作为插入结果返回，不得误删） ──
    api, assets_dir, target_dir, bundle_path = new_env("insert_success")
    build_bundle(bundle_path, [(ASSET_A, "C:/src/a.png")], mode="selection")
    r = api.import_bundle({"path": bundle_path, "strategy": "insert_canvas"})
    ok = (
        r["status"] == "success"
        and os.path.exists(asset_path(assets_dir, sha_of(ASSET_A)))
        and asset_path(assets_dir, sha_of(ASSET_A)) in (r.get("assets") or [])
    )
    results.append(("INSERT_CANVAS_SUCCESS_KEEPS_ASSETS", ok, r))

    # ── 6) 新建项目成功 → 资产与项目文件均保留 ──
    api, assets_dir, target_dir, bundle_path = new_env("new_project_success")
    build_bundle(bundle_path, [(ASSET_A, "C:/src/a.png")], mode="project")
    r = api.import_bundle({"path": bundle_path, "strategy": "new_project", "target_dir": target_dir})
    project_files = [p for p in os.listdir(target_dir) if p.endswith(".icproj")]
    ok = (
        r["status"] == "success"
        and os.path.exists(asset_path(assets_dir, sha_of(ASSET_A)))
        and len(project_files) == 1
    )
    results.append(("NEW_PROJECT_SUCCESS_KEEPS_ASSETS", ok, r))

    failed = [name for name, ok, _ in results if not ok]
    for name, ok, r in results:
        print(f"[{'OK' if ok else 'FAIL'}] {name} | {r}")
    print("BUNDLE_IMPORT_CLEANUP_SMOKE:", "ALL PASS" if not failed else f"FAILED {failed}")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
