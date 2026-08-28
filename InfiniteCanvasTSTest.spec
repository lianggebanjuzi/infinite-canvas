# -*- mode: python ; coding: utf-8 -*-

# 独立的 TypeScript 迁移测试版配置。
# 只携带 Vite 构建产物，不包含 gui/js 旧版源码，也不覆盖正式版 EXE。

a = Analysis(
    ['main.py'],
    pathex=['.'],
    binaries=[],
    datas=[
        ('gui/dist', 'gui/dist'),
        ('_defaults', '_defaults'),
        ('icon.ico', '.'),
        (r'.venv\Lib\site-packages\certifi\cacert.pem', 'certifi'),
    ],
    hiddenimports=[
        'webview',
        'webview.platforms.winforms',
        'webview.platforms.edgechromium',
        'certifi',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='InfiniteCanvas-TS-Test',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    icon='icon.ico',
)
