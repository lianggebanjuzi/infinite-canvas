"""构建独立的 TypeScript 迁移测试版，不覆盖正式版程序。"""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "dist" / "InfiniteCanvas-TS-Test.exe"


def run(command: list[str]) -> None:
    result = subprocess.run(command, cwd=ROOT, check=False)
    if result.returncode != 0:
        raise SystemExit(result.returncode)


def main() -> None:
    if sys.platform == "win32":
        sys.stdout.reconfigure(encoding="utf-8")

    npm = "npm.cmd" if os.name == "nt" else "npm"

    print("[1/3] 验证迁移边界...")
    run([npm, "run", "verify:migration"])

    print("[2/3] 构建 TypeScript 前端...")
    run([npm, "run", "build"])

    print("[3/3] 打包独立测试版 EXE...")
    run([
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "InfiniteCanvasTSTest.spec",
    ])

    if not OUTPUT.exists():
        raise SystemExit(f"打包完成但未找到输出文件：{OUTPUT}")

    print(f"测试版已生成：{OUTPUT}")
    print("正式版 dist/InfiniteCanvas.exe 未被修改。")


if __name__ == "__main__":
    main()
