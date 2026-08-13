"""
Infinite Canvas - 一键启动器
换电脑/新环境时双击 start.bat（或直接运行本文件）即可：
  1. 自动检测缺失的 Python 依赖（requests / Pillow / pywebview）
  2. 缺失则自动 pip 安装（官方源失败自动切换清华镜像）
  3. 安装完成后自动启动 main.py
"""
import importlib.util
import subprocess
import sys
import os

# 导入名 -> 包名 映射（PIL 的包名是 Pillow，webview 的包名是 pywebview）
REQUIRED = {
    'requests': 'requests',
    'PIL': 'Pillow',
    'webview': 'pywebview',
}

# 安装源：官方源优先，失败切国内镜像
PIP_SOURCES = [
    None,  # 默认官方源
    'https://pypi.tuna.tsinghua.edu.cn/simple',
    'https://mirrors.aliyun.com/pypi/simple/',
]


def check_missing():
    missing = []
    for mod in REQUIRED:
        if importlib.util.find_spec(mod) is None:
            missing.append((mod, REQUIRED[mod]))
    return missing


def install(pkg, source=None):
    cmd = [sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check']
    if source:
        cmd += ['-i', source]
    cmd.append(pkg)
    print(f'  正在安装 {pkg} ...')
    try:
        subprocess.check_call(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True
    except Exception:
        return False


def main():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    print('=' * 46)
    print('  Infinite Canvas 一键启动器')
    print('=' * 46)

    missing = check_missing()
    if missing:
        names = '、'.join(pkg for _, pkg in missing)
        print(f'检测到缺少依赖：{names}')
        print('正在自动安装，首次安装可能需要 1-2 分钟，请稍候...\n')
        ok = True
        for mod, pkg in missing:
            installed = False
            for src in PIP_SOURCES:
                if install(pkg, src):
                    installed = True
                    break
            if not installed:
                print(f'  ✗ {pkg} 安装失败（网络问题？请检查网络后重试）')
                ok = False
        if not ok:
            print('\n依赖未装全，请联网后重新双击 start.bat。')
            input('按回车键退出...')
            sys.exit(1)
        print('\n依赖安装完成 ✓')
    else:
        print('依赖检查通过 ✓')

    print('正在启动 Infinite Canvas ...')
    try:
        subprocess.call([sys.executable, 'main.py'])
    except Exception as e:
        print(f'启动失败：{e}')
        input('按回车键退出...')
        sys.exit(1)


if __name__ == '__main__':
    main()
