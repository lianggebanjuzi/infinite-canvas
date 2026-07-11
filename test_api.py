import json
import os

import requests

# 用一张 1x1 像素的透明 PNG 测试
tiny_png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

api_key = os.environ.get("INFINITE_CANVAS_TEST_API_KEY")
if not api_key:
    raise RuntimeError("请先设置环境变量 INFINITE_CANVAS_TEST_API_KEY")

url = os.environ.get(
    "INFINITE_CANVAS_TEST_API_URL",
    "https://value.apiqik.online/v1/chat/completions",
)
headers = {
    "Authorization": f"Bearer {api_key}",
    "Content-Type": "application/json"
}
payload = {
    "model": "gemini-3.1-flash-image-preview",
    "messages": [{
        "role": "user",
        "content": [
            {"type": "image_url", "image_url": {"url": tiny_png}},
            {"type": "text", "text": "画一只猫"}
        ]
    }]
}

r = requests.post(url, headers=headers, json=payload, timeout=120)
print(r.status_code)
data = r.json()
print(json.dumps(data, ensure_ascii=False, indent=2)[:3000])
