# smoke/test_imageperf.py
"""图片性能优化后端冒烟测试（T01 + T05）。

运行：C:\\Users\\17998\\AppData\\Local\\Programs\\Python\\Python312\\python.exe smoke\\test_imageperf.py
覆盖：
  T01-1 make_thumbnail_data_url：JPEG q85 / 最长边 1024px / 字节量级（几十 KB）/ 失败回退 None
  T01-2 _save_images_to_local 返回结构：thumbnail/thumbnails/original_path(s)/original_url(s)；
        image_url/images 语义切换为缩略图；saved_to_disk 语义
  T01-3 双轨回退：缩略图生成失败 → 前端按 original_path 读取原图（mock 补丁）
  T01-4 http URL 输入：下载转 base64 → 缩略图 + 原图落盘
  T01-5 同步 generate_image 主链路（mock 上游）→ 返回缩略图 + original_path（三条出图路径统一生效）
"""
import base64
import io
import json
import os
import shutil
import sys
import tempfile
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PIL import Image

from backend.api.image_api import make_thumbnail_data_url, make_thumbnail_data_url_from_file
from backend.api.provider_api import ProviderAPI
from backend.api.unified_api import UnifiedAPIRouter


RESULTS = []


def check(name, cond, detail=''):
    RESULTS.append((name, bool(cond), detail))
    print(('PASS' if cond else 'FAIL'), '-', name, ('| ' + detail if detail else ''))


def write_file(path, data):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=4)


def make_png_data_url(w=2000, h=3000):
    """合成一张较大的渐变 PNG（data URL），用于缩略图链路。"""
    grad = Image.linear_gradient('L')  # 256x256 平滑渐变
    img = grad.resize((w, h), Image.Resampling.BILINEAR).convert('RGB')
    buf = io.BytesIO()
    img.save(buf, 'PNG')
    b64 = base64.b64encode(buf.getvalue()).decode('utf-8')
    return f"data:image/png;base64,{b64}", buf.getvalue()


def decode_data_url(data_url):
    header, data = data_url.split(',', 1)
    return header, base64.b64decode(data)


class _FakePostResp:
    """模拟上游 generate_content 成功响应（Gemini 格式）"""
    def __init__(self, image_data_url):
        self.payload = {
            'candidates': [{
                'content': {
                    'parts': [{
                        'inlineData': {
                            'mimeType': 'image/png',
                            'data': image_data_url.split(',', 1)[1],
                        }
                    }]
                }
            }]
        }
        self.status_code = 200
        self.url = 'https://api.ai-media.vip/v1beta/models/x:generateContent'

    def json(self):
        return self.payload

    @property
    def text(self):
        return json.dumps(self.payload)


class _FakeGetResp:
    """模拟下载 http 图片成功响应"""
    def __init__(self, content, content_type='image/png', status_code=200):
        self.content = content
        self.headers = {'Content-Type': content_type}
        self.status_code = status_code


class _FakeTaskResp:
    """模拟异步任务状态响应。"""
    def __init__(self, payload):
        self.payload = payload
        self.status_code = 200
        self.headers = {'Content-Type': 'application/json'}

    def json(self):
        return self.payload


def main():
    root = tempfile.mkdtemp(prefix='icv_imageperf_')
    try:
        providers_file = os.path.join(root, 'providers_data.json')
        providers = {
            'providers': [{
                'id': 'provider_aaa', 'name': 'FluxPort', 'short_name': 'flux',
                'type': 'openai', 'enabled': True, 'api_url': 'https://api.ai-media.vip',
                'use_proxy': True,
                'keys': [{
                    'id': 'key_A', 'name': 'key1', 'api_key': 'sk-A', 'enabled': True,
                    'models': [{
                        'id': 'gemini-3-pro-image-preview', 'name': 'Nano Banana Pro',
                        'type': 'drawing', 'enabled': True,
                    }],
                }],
            }],
        }
        write_file(providers_file, providers)
        ua = UnifiedAPIRouter(ProviderAPI(providers_file))

        # ═════════════ T01-1 缩略图生成函数 ═════════════

        data_url, raw_bytes = make_png_data_url()
        thumb = make_thumbnail_data_url(raw_bytes)
        check('make_thumbnail_data_url 返回 data URL', isinstance(thumb, str) and thumb.startswith('data:image/jpeg;base64,'), str(thumb)[:40] if thumb else 'None')

        if thumb:
            header, thumb_bytes = decode_data_url(thumb)
            check('缩略图为 JPEG 魔数', thumb_bytes[:2] == b'\xff\xd8', str(thumb_bytes[:4]))
            t_img = Image.open(io.BytesIO(thumb_bytes))
            tw, th = t_img.size
            check('缩略图最长边 ≤ 1024', max(tw, th) <= 1024, f'{tw}x{th}')
            check('缩略图最长边 == 1024（2000x3000 → 683x1024）', max(tw, th) == 1024, f'{tw}x{th}')
            check('缩略图字节量级（几十 KB：< 200KB）', len(thumb_bytes) < 200 * 1024, f'{len(thumb_bytes) / 1024:.0f} KB')
            check('缩略图远小于原图', len(thumb_bytes) < len(raw_bytes), f'{len(thumb_bytes)} < {len(raw_bytes)}')
            t_img.close()
        check('缩略图失败返回 None（非法字节）', make_thumbnail_data_url(b'not-an-image') is None, str(make_thumbnail_data_url(b'not-an-image')))

        # 手机照片常以未旋转的像素 + EXIF Orientation=6（顺时针 90°）保存。
        # 缩略图必须把方向烘焙进像素，否则会与浏览器显示的原图方向不一致。
        oriented = Image.new('RGB', (1200, 800), '#4a8a3f')
        exif = Image.Exif()
        exif[274] = 6  # Orientation: Rotate 90° clockwise
        oriented_buf = io.BytesIO()
        oriented.save(oriented_buf, 'JPEG', exif=exif)
        oriented_bytes = oriented_buf.getvalue()
        oriented_thumb = make_thumbnail_data_url(oriented_bytes)
        _, oriented_thumb_bytes = decode_data_url(oriented_thumb)
        with Image.open(io.BytesIO(oriented_thumb_bytes)) as oriented_img:
            check('内存缩略图应用 EXIF 方向（1200×800 + 方向 6 → 683×1024）', oriented_img.size == (683, 1024), str(oriented_img.size))

        oriented_path = os.path.join(root, 'orientation-6.jpg')
        with open(oriented_path, 'wb') as f:
            f.write(oriented_bytes)
        oriented_file_thumb = make_thumbnail_data_url_from_file(oriented_path)
        _, oriented_file_thumb_bytes = decode_data_url(oriented_file_thumb)
        with Image.open(io.BytesIO(oriented_file_thumb_bytes)) as oriented_file_img:
            check('文件缩略图应用 EXIF 方向（导入链路）', oriented_file_img.size == (683, 1024), str(oriented_file_img.size))

        # ═════════════ T01-2 返回结构（多图 + 单图） ═════════════

        save_dir = os.path.join(root, 'saved')
        os.makedirs(save_dir)
        d1, _ = make_png_data_url(1600, 1200)
        d2, _ = make_png_data_url(1200, 1600)

        parsed = {'success': True, 'image_url': d1, 'images': [d1, d2]}
        res = ua._save_images_to_local(parsed, save_dir)

        check('saved_to_disk=True（显式目录）', res.get('saved_to_disk') is True, str(res.get('saved_to_disk')))
        imgs = res.get('images', [])
        check('images 数量保持 2', len(imgs) == 2, str(len(imgs)))
        check('images 全部切换为缩略图 JPEG', all(isinstance(u, str) and u.startswith('data:image/jpeg') for u in imgs), str([u[:30] for u in imgs]))
        thumbs = res.get('thumbnails', [])
        check('thumbnails 与 images 一致', thumbs == imgs, str(len(thumbs)))
        orig_paths = res.get('original_paths', [])
        check('original_paths 数量 2 且均存在', len(orig_paths) == 2 and all(isinstance(p, str) and os.path.exists(p) for p in orig_paths), str(orig_paths))
        check('original_paths 为正斜杠绝对路径', all('/' in p and (p[0].isalpha() and p[1] == ':') for p in orig_paths), str(orig_paths))
        orig_urls = res.get('original_urls', [])
        check('original_urls 为 file:/// 引用', all(isinstance(u, str) and u.startswith('file:///') for u in orig_urls), str(orig_urls))
        check('image_url == images[0]（缩略图）', res.get('image_url') == imgs[0], str(res.get('image_url'))[:30])
        check('thumbnail == thumbnails[0]', res.get('thumbnail') == thumbs[0], str(res.get('thumbnail'))[:30])
        check('original_path == original_paths[0]', res.get('original_path') == orig_paths[0], str(res.get('original_path')))
        check('original_url == original_urls[0]', res.get('original_url') == orig_urls[0], str(res.get('original_url')))

        # 单图（无 images 数组）
        parsed_single = {'success': True, 'image_url': d1}
        res_single = ua._save_images_to_local(parsed_single, save_dir)
        check('单图 image_url 切换为缩略图', res_single.get('image_url', '').startswith('data:image/jpeg'), str(res_single.get('image_url'))[:30])
        check('单图 thumbnail 存在', isinstance(res_single.get('thumbnail'), str) and res_single['thumbnail'] == res_single['image_url'])
        check('单图 original_path 存在', isinstance(res_single.get('original_path'), str) and os.path.exists(res_single['original_path']))

        # ═════════════ T01-3 双轨回退：缩略图失败 → 由 original_path 兜底 ═════════════

        with mock.patch('backend.api.unified_api.make_thumbnail_data_url', return_value=None):
            res_fb = ua._save_images_to_local({'success': True, 'image_url': d1, 'images': [d1, d2]}, save_dir)
        fb_imgs = res_fb.get('images', [])
        check('双轨回退：image 不回传原 base64', fb_imgs == [None, None], str(fb_imgs))
        check('双轨回退：thumbnails 全 None', res_fb.get('thumbnails') == [None, None], str(res_fb.get('thumbnails')))
        check('双轨回退：original_paths 全部存在', all(isinstance(p, str) and os.path.exists(p) for p in res_fb.get('original_paths', [])), str(res_fb.get('original_paths')))
        check('双轨回退：original_urls 为 file:/// 引用', all(isinstance(u, str) and u.startswith('file:///') for u in res_fb.get('original_urls', [])), str(res_fb.get('original_urls')))
        check('双轨回退：image_url 为空，前端按路径加载', res_fb.get('image_url') is None, str(res_fb.get('image_url')))

        # ═════════════ T01-3b fileUri：已落盘原图不再下载/转大 base64 ═════════════

        local_source = os.path.join(save_dir, 'already_downloaded.png')
        with open(local_source, 'wb') as f:
            f.write(raw_bytes)
        local_uri = f"file:///{local_source.replace('\\\\', '/')}"
        with mock.patch('backend.api.unified_api.requests.get') as get_mock:
            res_fileuri = ua._save_images_to_local(
                {'success': True, 'image_url': local_uri, 'images': [local_uri]},
                save_dir,
            )
        check('fileUri：不再次发起 HTTP 下载', not get_mock.called)
        check('fileUri：image_url 为缩略图', (res_fileuri.get('image_url') or '').startswith('data:image/jpeg'), str(res_fileuri.get('image_url'))[:30])
        check('fileUri：复用已落盘原图', os.path.samefile(res_fileuri.get('original_path', ''), local_source), str(res_fileuri.get('original_path')))

        # ═════════════ T01-3c 异步 fileUri：鉴权下载直接落盘，不经原图 base64 ═════════════

        task_response = _FakeTaskResp({
            'status': 'success',
            'candidates': [{'content': {'parts': [{'fileData': {'fileUri': '/protected/result.png'}}]}}],
        })
        auth_capture = []

        def fake_async_get(url, headers=None, stream=False, **_kwargs):
            auth_capture.append((url, (headers or {}).get('Authorization'), stream))
            return _FakeGetResp(raw_bytes) if stream else task_response

        with mock.patch('backend.api.unified_api.requests.get', side_effect=fake_async_get):
            async_raw = ua._poll_async_image_task(
                {'task_id': 'imgtask_test', 'poll_url': '/v1/images/tasks/imgtask_test'},
                'https://api.ai-media.vip',
                {'Authorization': 'Bearer sk-test'},
                None,
            )
        async_is_file_uri = (async_raw.get('image_url') or '').startswith('file:///')
        async_res = ua._save_images_to_local(async_raw, save_dir)
        check('异步 fileUri：下载带 Authorization', any(auth == 'Bearer sk-test' and stream for _, auth, stream in auth_capture), str(auth_capture))
        check('异步 fileUri：原图以 file URI 传递，不含 base64', async_is_file_uri, str(async_raw.get('original_path')))
        check('异步 fileUri：前端结果为缩略图', (async_res.get('image_url') or '').startswith('data:image/jpeg'), str(async_res.get('image_url'))[:30])

        # ═════════════ T01-4 http URL 输入：下载 → 缩略图 + 原图落盘 ═════════════

        _, raw_png = make_png_data_url(1400, 1400)
        with mock.patch('backend.api.unified_api.requests.get', return_value=_FakeGetResp(raw_png)):
            res_url = ua._save_images_to_local(
                {'success': True, 'image_url': 'http://example.com/a.png', 'images': ['http://example.com/a.png']},
                save_dir,
            )
        url_imgs = res_url.get('images', [])
        check('http 输入：images 切换为缩略图', all(u.startswith('data:image/jpeg') for u in url_imgs), str([u[:30] for u in url_imgs]))
        check('http 输入：original_paths 存在', all(isinstance(p, str) and os.path.exists(p) for p in res_url.get('original_paths', [])), str(res_url.get('original_paths')))
        check('http 输入：saved_to_disk=True', res_url.get('saved_to_disk') is True, str(res_url.get('saved_to_disk')))

        # http 下载失败 → 保持原 URL（沿用旧语义，不阻断）
        with mock.patch('backend.api.unified_api.requests.get', return_value=_FakeGetResp(b'', status_code=404)):
            res_fail_dl = ua._save_images_to_local(
                {'success': True, 'image_url': 'http://example.com/a.png', 'images': ['http://example.com/a.png']},
                save_dir,
            )
        check('http 下载失败：image 保持原 URL', res_fail_dl.get('images', []) == ['http://example.com/a.png'], str(res_fail_dl.get('images')))

        # ═════════════ saved_to_disk=False（未配置保存路径 → tempfile 兜底，原图仍落盘 temp） ═════════════

        ua_nocfg = UnifiedAPIRouter(ProviderAPI(providers_file), settings_api=None)  # settings_api=None → 未配置目录
        res_nocfg = ua_nocfg._save_images_to_local({'success': True, 'image_url': d1, 'images': [d1]})
        check('未配置目录：saved_to_disk=False', res_nocfg.get('saved_to_disk') is False, str(res_nocfg.get('saved_to_disk')))
        check('未配置目录：image_url 仍为缩略图', (res_nocfg.get('image_url') or '').startswith('data:image/jpeg'), str(res_nocfg.get('image_url'))[:30])
        check('未配置目录：original_path 仍存在（tempfile 兜底落盘）',
              isinstance(res_nocfg.get('original_path'), str) and os.path.exists(res_nocfg['original_path']),
              str(res_nocfg.get('original_path')))

        # ═════════════ T01-5 同步 generate_image 主链路统一生效（mock 上游） ═════════════

        d3, raw3 = make_png_data_url(1800, 1800)
        captured = {}
        def fake_post(url, headers=None, json=None, timeout=None, proxies=None, **kw):
            captured['auth'] = (headers or {}).get('Authorization')
            return _FakePostResp(d3)

        with mock.patch('backend.api.unified_api.requests.post', side_effect=fake_post):
            res_gen = ua.generate_image('一只猫', {'model': 'provider_aaa:key_A:gemini-3-pro-image-preview', 'resolution': '1k', 'aspectRatio': '1:1'})
            check('generate_image 成功', res_gen.get('success') is True, f"image_url={str(res_gen.get('image_url'))[:30]}, original_path={res_gen.get('original_path')}")
            check('generate_image image_url 为缩略图（同步路径统一生效）',
                  (res_gen.get('image_url') or '').startswith('data:image/jpeg'), str(res_gen.get('image_url'))[:30])
            check('generate_image thumbnail 存在', isinstance(res_gen.get('thumbnail'), str), str(res_gen.get('thumbnail'))[:30])
            check('generate_image original_path 存在', isinstance(res_gen.get('original_path'), str), str(res_gen.get('original_path')))
            check('generate_image saved_to_disk 存在', isinstance(res_gen.get('saved_to_disk'), bool), str(res_gen.get('saved_to_disk')))
            check('Authorization = Bearer sk-A', captured.get('auth') == 'Bearer sk-A', str(captured.get('auth')))

        # raw3 未用，仅为构造同尺寸断言参考（避免未使用告警）
        void(raw3)

        failed = [r for r in RESULTS if not r[1]]
        print(f'\n总计 {len(RESULTS)} 项，失败 {len(failed)} 项')
        return 1 if failed else 0
    finally:
        shutil.rmtree(root, ignore_errors=True)


def void(_x):
    return None


if __name__ == '__main__':
    sys.exit(main())
