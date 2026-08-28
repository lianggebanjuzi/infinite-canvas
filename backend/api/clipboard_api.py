# backend/api/clipboard_api.py
"""
剪贴板操作 API
使用应用内存储替代系统剪贴板，避免 pywebview 环境下的兼容性问题
"""

import json


class ClipboardAPI:
    """剪贴板操作类"""

    def __init__(self):
        self._internal_clipboard = None

    def write_to_clipboard(self, canvas_data):
        try:
            card_count = len(canvas_data.get('cards', []))
            conn_count = len(canvas_data.get('connections', []))

            self._internal_clipboard = json.loads(
                json.dumps(canvas_data, ensure_ascii=False)
            )

            print(f"[Clipboard] 已复制 {card_count} 个卡片和 {conn_count} 个连接")
            return {"status": "success", "message": f"已复制 {card_count} 个元素"}

        except Exception as e:
            print(f"[Clipboard] 写入失败: {e}")
            return {"status": "error", "message": str(e)}

    def read_from_clipboard(self):
        try:
            if self._internal_clipboard is None:
                return {"status": "error", "message": "剪贴板为空"}

            canvas_data = self._internal_clipboard

            if not isinstance(canvas_data, dict):
                return {"status": "error", "message": "剪贴板数据格式错误"}

            if 'cards' not in canvas_data or 'connections' not in canvas_data:
                return {"status": "error", "message": "剪贴板数据缺少必要字段"}

            card_count = len(canvas_data.get('cards', []))
            conn_count = len(canvas_data.get('connections', []))
            print(f"[Clipboard] 读取 {card_count} 个卡片和 {conn_count} 个连接")

            return {
                "status":  "success",
                "data":    canvas_data,
                "message": f"读取到 {card_count} 个元素"
            }

        except Exception as e:
            print(f"[Clipboard] 读取失败: {e}")
            return {"status": "error", "message": str(e)}
