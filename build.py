# build.py
"""
Infinite Canvas 一键打包脚本
运行方式：python build.py
"""

import os
import sys
import json
import subprocess

INIT_PROVIDERS = {"providers": []}

INIT_SETTINGS = {
    "outputFolder": "",
    "defaultProvider": "",
    "defaultModel": "",
    "theme": "dark"
}

INIT_PROMPTS = {
    "common": [],
    "skill": [],
    "draw": []
}

JSON_FILES = {
    "providers_data.json":  INIT_PROVIDERS,
    "settings.json":        INIT_SETTINGS,
    "prompts_library.json": INIT_PROMPTS,
}


def read_json(path):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None


def write_json(path, data):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=4)


def main():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(base_dir)
    
    # 设置输出编码
    if sys.platform == 'win32':
        sys.stdout.reconfigure(encoding='utf-8')

    print("=" * 50)
    print("  Infinite Canvas 一键打包工具")
    print("=" * 50)

    print("\n[1/3] 备份当前数据文件...")
    backups = {}
    for filename in JSON_FILES:
        path     = os.path.join(base_dir, filename)
        original = read_json(path)
        backups[filename] = original
        if original is not None:
            print(f"  ✓ 已备份 {filename}")
        else:
            print(f"  - {filename} 不存在，跳过备份")

    print("\n[2/3] 写入初始化数据...")
    for filename, init_data in JSON_FILES.items():
        path = os.path.join(base_dir, filename)
        write_json(path, init_data)
        print(f"  ✓ 已重置 {filename}")

    print("\n[3/3] 开始打包（预计需要 1~5 分钟）...")
    print("-" * 50)

    result = subprocess.run(
        [sys.executable, '-m', 'PyInstaller', 'InfiniteCanvas.spec'],
        cwd=base_dir
    )

    print("-" * 50)

    print("\n正在恢复原始数据文件...")
    for filename, original_data in backups.items():
        path = os.path.join(base_dir, filename)
        if original_data is not None:
            write_json(path, original_data)
            print(f"  ✓ 已恢复 {filename}")
        else:
            print(f"  - {filename} 原本不存在，跳过恢复")

    print()
    if result.returncode == 0:
        exe_path = os.path.join(base_dir, 'dist', 'InfiniteCanvas.exe')
        print("=" * 50)
        print("  🎉 打包成功！")
        print(f"  📦 输出路径：{exe_path}")
        print("=" * 50)
    else:
        print("=" * 50)
        print("  ❌ 打包失败，请查看上方错误信息")
        print("=" * 50)


if __name__ == '__main__':
    main()