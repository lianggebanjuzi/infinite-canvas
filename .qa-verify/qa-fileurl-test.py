# -*- coding: utf-8 -*-
"""pywebview file:// 直读验证 v3 —— 单窗口 + readyState 轮询（抗事件丢失）"""
import json
import os
import sys
import threading
import time

sys.stdout.reconfigure(line_buffering=True)

TEST_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '_filetest')
os.makedirs(TEST_DIR, exist_ok=True)
JPG_PATH = os.path.join(TEST_DIR, 'test.jpg')
JPG_FILE_URL = 'file:///' + JPG_PATH.replace('\\', '/')
HTML_HTTP = os.path.join(TEST_DIR, 'page_http.html')
HTML_FILE = os.path.join(TEST_DIR, 'page_file.html')

JS_CHECK = r"""(function () {
    function state(id) {
        var el = document.getElementById(id);
        if (!el) return { id: id, missing: true };
        return { id: id, w: el.naturalWidth, h: el.naturalHeight, complete: el.complete,
                 broken: (el.complete && el.naturalWidth === 0) };
    }
    var b = document.body;
    return JSON.stringify({ fileImg: state('img_file'), httpImg: state('img_http'),
        origin: location.origin, href: location.href, title: document.title,
        bodyLen: b ? b.innerHTML.length : -1 });
})()"""


def setup():
    from PIL import Image, ImageDraw
    img = Image.new('RGB', (640, 480), (30, 90, 160))
    d = ImageDraw.Draw(img)
    for i in range(0, 640, 8):
        d.line([(i, 0), (0, 480 - i)], fill=(200, 200, 60), width=3)
    img.save(JPG_PATH, 'JPEG', quality=85)
    body = (
        f'<body style="font-family:monospace">'
        f'<img id="img_file" src="{JPG_FILE_URL}" width="200"/>'
        f'<img id="img_http" src="/test.jpg" width="200"/>'
        f'</body>'
    )
    with open(HTML_HTTP, 'w', encoding='utf-8') as f:
        f.write(f'<!DOCTYPE html><html><head><meta charset="utf-8"><title>HTTP</title></head>{body}</html>')
    with open(HTML_FILE, 'w', encoding='utf-8') as f:
        f.write(f'<!DOCTYPE html><html><head><meta charset="utf-8"><title>FILE</title></head>{body}</html>')
    print('[setup] ready', flush=True)


def probe_loop(w, tag, timeout=25):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            st = w.evaluate_js('document.readyState')
            last = f'state={st}'
            if st == 'complete':
                time.sleep(2.0)
                raw = w.evaluate_js(JS_CHECK)
                print(f'[probe:{tag}] raw={raw}', flush=True)
                try:
                    return json.loads(raw)
                except Exception:
                    return {'raw': raw}
        except Exception as e:
            last = f'exc={type(e).__name__}: {e}'
        time.sleep(0.8)
    print(f'[probe:{tag}] TIMEOUT last={last}', flush=True)
    return {'timeout': True, 'last': last}


def main():
    setup()
    import webview
    scenario = os.environ.get('FT_SCENARIO', 'A')
    if scenario == 'A':
        w = webview.create_window('FT-A', url=HTML_HTTP, width=440, height=320)
    else:
        w = webview.create_window('FT-B', url='file:///' + HTML_FILE.replace('\\', '/'), width=440, height=320)
    out = {}

    def run():
        out.update(probe_loop(w, scenario))
        try:
            w.destroy()
        except Exception:
            pass

    webview.start(run)
    print('=== FINAL_RESULT ===', flush=True)
    print(json.dumps(out, ensure_ascii=False, indent=2), flush=True)


if __name__ == '__main__':
    main()
