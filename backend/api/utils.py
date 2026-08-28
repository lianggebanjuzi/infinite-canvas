# backend/api/utils.py
"""
公共工具函数
"""

import json
import os
from tkinter import Tk


def get_tk_root():
    """创建隐藏的 tkinter 根窗口"""
    root = Tk()
    root.withdraw()
    root.attributes('-topmost', True)
    return root


def atomic_write_json(path, data):
    """原子写 JSON：先写同名 .tmp → flush+fsync → os.replace 原子替换；异常清理 tmp 后抛回。

    任何落盘项目文件必须走本函数，禁止 open(path, 'w') 直写（R1.3）。
    """
    tmp = path + '.tmp'
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=4)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        if os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass
        raise


def append_json_line(path, obj):
    """单行 append 一条 JSON（history.jsonl 用）：顺序写，多行互不破坏（R6.3）。"""
    with open(path, 'a', encoding='utf-8') as f:
        f.write(json.dumps(obj, ensure_ascii=False) + '\n')
        f.flush()
