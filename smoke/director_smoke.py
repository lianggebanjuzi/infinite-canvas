# smoke/director_smoke.py
# 导演台（4.4）最小 smoke：后端桥接契约验证 —— 创建对象 → 保存 → 重开 位置/锁定/可见性一致。
# 用法：python smoke/director_smoke.py
# 覆盖：director_save_project / director_load_project / 最近工程 / 资源校验 / 视频落盘 / 回传参数。

import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.director_api import DirectorAPI


class FakeSettings:
    def __init__(self):
        self.settings = {}
        self.recent = []

    def load_settings(self):
        return self.settings

    def touch_recent_project(self, path, name=''):
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

    @property
    def image(self):
        return self


def make_project(name="smoke"):
    return {
        "format": "icdirector",
        "version": 1,
        "id": "00000000-0000-4000-8000-000000000001",
        "name": name,
        "scene": [
            {
                "id": "00000000-0000-4000-8000-000000000002",
                "name": "立方体",
                "kind": "box",
                "position": {"x": 1.5, "y": 0.25, "z": -2.0},
                "rotation": {"x": 0, "y": 30, "z": 0},
                "scale": {"x": 1, "y": 1, "z": 1},
                "visible": False,
                "locked": True,
                "color": "#d8d4c8",
            }
        ],
        "cameras": [
            {
                "id": "00000000-0000-4000-8000-000000000003",
                "name": "主摄像机",
                "position": {"x": 0, "y": 2.2, "z": 6.5},
                "rotation": {"x": -12, "y": 0, "z": 0},
                "target": {"x": 0, "y": 1, "z": 0},
                "fov": 40,
                "aspect": 1.7777777777777777,
                "near": 0.1,
                "far": 1000,
                "visible": True,
                "includeInExport": True,
            }
        ],
        "activeCameraId": "00000000-0000-4000-8000-000000000003",
        "references": [],
        "lighting": {
            "ambientColor": "#f2f0ea",
            "ambientIntensity": 0.55,
            "keyColor": "#fff6e8",
            "keyIntensity": 1.35,
            "keyDirection": {"x": 2.2, "y": 3.4, "z": 1.6},
            "fillColor": "#cfe0ff",
            "fillIntensity": 0.5,
            "fillDirection": {"x": -2.4, "y": 1.2, "z": -1.8},
            "exposure": 1.0,
            "background": "#1e1f24",
        },
        "timeline": {"duration": 10, "fps": 24, "keyframes": []},
        "assets": [],
    }


def main():
    failures = []
    tmp = tempfile.mkdtemp(prefix="director_smoke_")
    api = DirectorAPI(app_api=FakeAppApi())

    # 1) 保存 → 重开：位置/锁定/可见性一致
    project_path = os.path.join(tmp, "smoke.icdirector")
    r = api.director_save_project(project_path, make_project())
    assert r["status"] == "success", r
    assert os.path.exists(project_path), "工程文件未落盘"

    r = api.director_load_project(project_path)
    assert r["status"] == "success", r
    data = r["data"]
    obj = data["scene"][0]
    assert obj["position"] == {"x": 1.5, "y": 0.25, "z": -2.0}, obj["position"]
    assert obj["locked"] is True and obj["visible"] is False, (obj["locked"], obj["visible"])
    assert data["cameras"][0]["fov"] == 40
    assert data["format"] == "icdirector"
    print("[OK] 保存→重开：位置/锁定/可见性一致")

    # 2) 最近工程
    recent = api.director_load_recent()
    assert recent["status"] == "success" and any(p["path"] == project_path for p in recent["projects"]), recent
    api.director_remove_recent(project_path)
    recent = api.director_load_recent()
    assert not any(p["path"] == project_path for p in recent["projects"])
    print("[OK] 最近工程记录 touch/load/remove")

    # 3) 资源校验（缺失文件）
    r = api.director_validate_resource(os.path.join(tmp, "not_exist.png"))
    assert r["status"] == "success" and r["exists"] is False, r
    r = api.director_validate_resource(project_path)
    assert r["status"] == "success" and r["exists"] is True, r
    print("[OK] 资源路径校验（缺失/存在）")

    # 4) 非 icdirector 文件拒绝
    bad_path = os.path.join(tmp, "bad.icdirector")
    with open(bad_path, "w", encoding="utf-8") as f:
        json.dump({"format": "icproj", "version": "3.4"}, f)
    r = api.director_load_project(bad_path)
    assert r["status"] == "error", r
    print("[OK] 拒绝非 icdirector 工程")

    # 5) 视频落盘（小 base64）
    import base64
    tiny = base64.b64encode(b"fakevideodata" * 100).decode("ascii")
    r = api.director_save_video_blob(tiny, "smoke_video.mp4")
    assert r["status"] == "success" and os.path.exists(r["path"]), r
    print("[OK] 视频落盘 director_save_video_blob")

    # 6) 回传参数脱敏转发（无主窗口时应报错但不抛异常）
    r = api.director_return_to_canvas({"kind": "png", "path": "C:/x/y.png", "projectId": "p1", "cameraId": "c1", "time": 3.5})
    assert r["status"] == "error", r  # 主窗口未设置 → 明确错误
    print("[OK] 回传通道：无主窗口时明确报错")

    # 7) GLTF 对话框不可测（GUI），但大小限制路径可测：直接调用底层不弹窗的方法不可行，跳过
    #    改为验证 ping / launch options
    api.set_launch_options({"imagePath": "C:/x.png"})
    assert api.director_get_launch_options()["imagePath"] == "C:/x.png"
    assert api.director_ping()["app"] == "icdirector"
    print("[OK] launch options / ping")

    if failures:
        print("SMOKE FAILED:", failures)
        return 1
    print("DIRECTOR SMOKE: ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
