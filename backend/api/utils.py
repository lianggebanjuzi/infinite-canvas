# backend/api/utils.py
"""
公共工具函数
"""

from tkinter import Tk


def get_tk_root():
    """创建隐藏的 tkinter 根窗口"""
    root = Tk()
    root.withdraw()
    root.attributes('-topmost', True)
    return root
