"""4.1-C 画布 .icbundle 导出/导入。

与 .icbackup（个人整包备份）是两种文件：
  - .icbundle：单项目/选中节点子集的便携包，ZIP = manifest.json + project.icproj + assets/<sha>.<ext> + thumbs/<sha>.webp；
  - 不包含任何 API Key / Authorization / 完整代理 URL。

安全契约（与 backup_api 一致）：
  - 不信任 ZIP 内任何文件名：路径穿越 / 绝对路径 / 大小 / 重复文件 / MIME 全部校验；
  - 先在临时目录完整校验，全部通过后才写入真实文件；任何失败自动清理，不留半份项目。
"""

import hashlib
import json
import mimetypes
import os
import shutil
import tempfile
import time
import zipfile

from tkinter import filedialog

from backend.api.utils import atomic_write_json, get_tk_root

MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
MAX_FILE_BYTES = 512 * 1024 * 1024
MAX_FILES = 10000
KEY_WORDS = ('api_key', 'apikey', 'authorization', 'token', 'secret', 'password')
BUNDLE_SCHEMA_VERSION = 1
APP_VERSION = '2.1.0'

# 允许打包的资产扩展名（按 MIME 白名单，避免把 settings/providers 等敏感文件塞进包）
ALLOWED_ASSET_EXTS = {
    '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg',
    '.mp4', '.webm', '.mov', '.mkv',
    '.mp3', '.wav', '.ogg', '.m4a',
}


def _safe_name(name):
    """ZIP 条目名校验：正斜杠归一、非绝对路径、无 .. 穿越、无盘符。"""
    normalized = name.replace('\\', '/')
    return bool(
        normalized
        and not normalized.startswith('/')
        and '..' not in normalized.split('/')
        and ':' not in normalized
    )


def _hash_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _without_secrets(value):
    if isinstance(value, dict):
        return {key: _without_secrets(item) for key, item in value.items() if not any(word in str(key).lower() for word in KEY_WORDS)}
    if isinstance(value, list):
        return [_without_secrets(item) for item in value]
    return value


class BundleAPI:
    def __init__(self, app_dir, project_api, settings_api):
        self.app_dir = app_dir
        self.project_api = project_api
        self.settings_api = settings_api

    # ─────────────────────────────────────────
    # 导出
    # ─────────────────────────────────────────

    def export_bundle(self, options=None):
        """导出 .icbundle。

        options: {
          mode: 'project' | 'selection',
          destination?: str,          # 缺省弹保存对话框
          projectData: {...},         # 前端 persistence.collect() 产物（唯一事实源）
          exportedNodeIds?: string[], # selection 模式：导出选中节点（前端已剪枝）
          projectName?: string,
        }
        返回: {status:'success', path, manifest:{...}} | {status:'cancelled'} | {status:'error', message}
        """
        options = options or {}
        try:
            mode = 'selection' if options.get('mode') == 'selection' else 'project'
            project_data = options.get('projectData')
            if not isinstance(project_data, dict):
                return {'status': 'error', 'message': '缺少项目数据，无法导出'}
            project_data = _without_secrets(project_data)  # 防御：包内永不出现密钥字段

            destination = options.get('destination') if isinstance(options.get('destination'), str) else ''
            if not destination:
                root = get_tk_root()
                default_name = 'canvas.icbundle'
                destination = filedialog.asksaveasfilename(
                    title='导出画布资源包',
                    initialdir=os.path.expanduser('~'),
                    initialfile=default_name,
                    defaultextension='.icbundle',
                    filetypes=[('Infinite Canvas Bundle', '*.icbundle')],
                )
                root.destroy()
            if not destination:
                return {'status': 'cancelled'}
            if not destination.lower().endswith('.icbundle'):
                destination += '.icbundle'

            project_name = options.get('projectName')
            if not isinstance(project_name, str) or not project_name:
                project_name = str(project_data.get('projectName') or '未命名项目')

            media_paths = self._collect_media_paths(project_data)
            # 按扩展名白名单过滤（同时天然排除 settings/providers 等 JSON 文件）
            media_paths = {p for p in media_paths if os.path.splitext(p)[1].lower() in ALLOWED_ASSET_EXTS}

            project_payload = json.dumps(project_data, ensure_ascii=False, indent=2).encode('utf-8')
            manifest = {
                'schemaVersion': BUNDLE_SCHEMA_VERSION,
                'format': 'icbundle',
                'appVersion': APP_VERSION,
                'mode': mode,
                'createdAt': int(time.time() * 1000),
                'projectName': project_name,
                'project': {
                    'path': 'project.icproj',
                    'sha256': hashlib.sha256(project_payload).hexdigest(),
                    'size': len(project_payload),
                },
                'assets': [],
                'thumbs': [],
                'nodeCount': len(project_data.get('nodes') or []) if isinstance(project_data.get('nodes'), list) else 0,
                'edgeCount': len(project_data.get('edges') or []) if isinstance(project_data.get('edges'), list) else 0,
                'exportedNodeIds': [str(i) for i in (options.get('exportedNodeIds') or [])] if mode == 'selection' else [],
            }

            directory = os.path.dirname(os.path.abspath(destination))
            os.makedirs(directory, exist_ok=True)
            temp_path = destination + '.tmp'
            try:
                with zipfile.ZipFile(temp_path, 'w', compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
                    archive.writestr('project.icproj', project_payload)
                    seen_assets = set()
                    seen_thumbs = set()
                    for path in sorted(media_paths):
                        ext = os.path.splitext(path)[1].lower()[:12] or '.bin'
                        digest = _hash_file(path)
                        name = f'assets/{digest}{ext}'
                        if name not in seen_assets:
                            seen_assets.add(name)
                            archive.write(path, name)
                            manifest['assets'].append({'path': name, 'sha256': digest, 'size': os.path.getsize(path), 'sourcePath': path})
                        thumb_name = f'thumbs/{digest}.webp'
                        if thumb_name not in seen_thumbs:
                            thumb_name, thumb_sha, thumb_size = self._write_thumbnail(archive, path, thumb_name)
                            seen_thumbs.add(thumb_name)
                            if thumb_sha:
                                manifest['thumbs'].append({'path': thumb_name, 'sha256': thumb_sha, 'size': thumb_size, 'sourcePath': path})
                    archive.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
                os.replace(temp_path, destination)
            except Exception:
                if os.path.exists(temp_path):
                    try:
                        os.remove(temp_path)
                    except OSError:
                        pass
                raise
            return {
                'status': 'success',
                'path': destination,
                'manifest': {
                    'mode': mode,
                    'projectName': project_name,
                    'assets': len(manifest['assets']),
                    'thumbs': len(manifest['thumbs']),
                    'nodeCount': manifest['nodeCount'],
                },
            }
        except Exception as exc:
            print(f'导出资源包失败: {exc}')
            return {'status': 'error', 'message': '导出资源包失败'}

    def _write_thumbnail(self, archive, source_path, thumb_name):
        """为图片生成 webp 缩略图并写入 ZIP；非图片/失败时返回 None 占位（manifest 不追加）。"""
        try:
            from PIL import Image
            ext = os.path.splitext(source_path)[1].lower()
            if ext not in ('.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'):
                return thumb_name, None, 0
            import io
            with Image.open(source_path) as im:
                im.thumbnail((512, 512))
                buf = io.BytesIO()
                im.convert('RGB').save(buf, 'WEBP', quality=82)
                payload = buf.getvalue()
            archive.writestr(thumb_name, payload)
            return thumb_name, hashlib.sha256(payload).hexdigest(), len(payload)
        except Exception as exc:
            print(f'生成缩略图失败（跳过）: {exc}')
            return thumb_name, None, 0

    @staticmethod
    def _collect_media_paths(value):
        """递归收集项目 JSON 中的本地媒体绝对路径（path/originalPath/coverPath/localPath/thumbnail 等）。"""
        found = set()

        def visit(item):
            if isinstance(item, dict):
                for key, child in item.items():
                    if key.lower() in ('path', 'originalpath', 'coverpath', 'localpath', 'thumbnail', 'originalurl') and isinstance(child, str):
                        if child.startswith('file://'):
                            absolute = child[len('file://'):]
                        else:
                            absolute = child
                        absolute = os.path.abspath(absolute)
                        if os.path.isfile(absolute):
                            found.add(absolute)
                    visit(child)
            elif isinstance(item, list):
                for child in item:
                    visit(child)

        visit(value)
        return found

    # ─────────────────────────────────────────
    # 导入
    # ─────────────────────────────────────────

    def import_bundle(self, options=None):
        """导入 .icbundle。

        options: {
          path?: str,             # 缺省弹打开对话框
          strategy: 'new_project' | 'insert_canvas',
          target_dir?: str,       # new_project 模式保存目录（缺省弹对话框）
        }
        返回:
          new_project   → {status:'success', projectPath, message}
          insert_canvas → {status:'success', data:{...project}, assets:[...], message}  （前端合并进当前画布）
          失败 → {status:'error', message}（当前数据未被改写）
        """
        options = options or {}
        # 本次导入新建的资产（用于取消/失败时回滚）；导入前已存在的去重资产绝不进清单
        created_assets = []
        # 目标项目是否已成功原子写盘：写成功后不再回滚资产（它们已被新项目引用）
        project_written = False
        try:
            source = options.get('path') if isinstance(options.get('path'), str) else ''
            if not source:
                root = get_tk_root()
                source = filedialog.askopenfilename(
                    title='导入 Infinite Canvas 资源包',
                    initialdir=os.path.expanduser('~'),
                    filetypes=[('Infinite Canvas Bundle', '*.icbundle')],
                )
                root.destroy()
            if not source:
                return {'status': 'cancelled'}
            strategy = options.get('strategy') if options.get('strategy') in ('new_project', 'insert_canvas') else 'new_project'

            with tempfile.TemporaryDirectory(prefix='icbundle-') as staging:
                manifest = self._validate_and_extract(source, staging)
                project_doc = self._read_json(os.path.join(staging, 'project.icproj'), {})
                if not isinstance(project_doc, dict):
                    return {'status': 'error', 'message': '资源包内项目数据损坏'}

                # 资源落到图片保存目录（未配置 → fallback 临时目录）；映射 sourcePath → destPath 供路径重写
                assets_dir = self._assets_dir()
                os.makedirs(assets_dir, exist_ok=True)
                mapping = {}
                copied = []
                for item in manifest['assets']:
                    staged = os.path.join(staging, item['path'])
                    ext = os.path.splitext(item['path'])[1]
                    dest = os.path.join(assets_dir, item['sha256'] + ext)
                    if not os.path.exists(dest):
                        self._atomic_copy(staged, dest)
                        created_assets.append(dest)  # 仅本次实际新建的文件进回滚清单（去重命中不进）
                    copied.append(dest)
                    mapping[item.get('sourcePath', '')] = dest
                project_doc = self._rewrite_paths(project_doc, mapping)

                if strategy == 'insert_canvas':
                    # 仅选中节点包允许插入当前画布；返回数据由前端合并（不写项目文件，原子性由前端撤销栈保证）
                    if manifest.get('mode') != 'selection':
                        self._remove_created_assets(created_assets)
                        return {'status': 'error', 'message': '该资源包不是「选中节点」包，不能插入当前画布'}
                    return {
                        'status': 'success',
                        'strategy': 'insert_canvas',
                        'data': project_doc,
                        'assets': copied,
                        'message': '已解析资源包，可插入当前画布',
                    }

                # new_project：先落全部资源（幂等，按 sha 命名），最后原子写项目文件 → 失败不留半份项目
                target_path = self._choose_new_project_path(project_doc, options)
                if target_path is None:
                    self._remove_created_assets(created_assets)
                    return {'status': 'cancelled'}
                atomic_write_json(target_path, project_doc)
                project_written = True
                self.project_api.current_project_path = target_path
                return {
                    'status': 'success',
                    'strategy': 'new_project',
                    'projectPath': target_path,
                    'message': '已导入为新建项目',
                }
        except Exception as exc:
            # 任意异常路径（含目标项目写入失败）：删除本次新建资产；项目已写盘成功则不回滚
            if not project_written:
                self._remove_created_assets(created_assets)
            print(f'导入资源包失败: {exc}')
            return {'status': 'error', 'message': '资源包无效或导入失败；当前数据未被改写'}

    def _validate_and_extract(self, source, staging):
        if not os.path.isfile(source) or os.path.getsize(source) > MAX_ARCHIVE_BYTES:
            raise ValueError('invalid size')
        with zipfile.ZipFile(source, 'r') as archive:
            infos = archive.infolist()
            if len(infos) > MAX_FILES:
                raise ValueError('too many files')
            for info in infos:
                if not _safe_name(info.filename) or info.file_size > MAX_FILE_BYTES:
                    raise ValueError('unsafe archive')
            total = sum(info.file_size for info in infos)
            if total > MAX_ARCHIVE_BYTES:
                raise ValueError('archive too large')

            names = archive.namelist()
            if 'manifest.json' not in names or 'project.icproj' not in names:
                raise ValueError('missing manifest or project')
            manifest = json.loads(archive.read('manifest.json').decode('utf-8'))
            if not isinstance(manifest, dict) or manifest.get('schemaVersion') != BUNDLE_SCHEMA_VERSION:
                raise ValueError('bad manifest')
            if not isinstance(manifest.get('project'), dict) or not isinstance(manifest.get('assets'), list):
                raise ValueError('bad manifest fields')

            project_item = manifest['project']
            if not _safe_name(project_item.get('path', '')) or project_item.get('path') != 'project.icproj':
                raise ValueError('bad project path')
            project_payload = archive.read('project.icproj')
            if hashlib.sha256(project_payload).hexdigest() != project_item.get('sha256'):
                raise ValueError('bad project hash')
            project_doc = json.loads(project_payload.decode('utf-8'))
            if not isinstance(project_doc, dict) or project_doc.get('format') != 'icv':
                raise ValueError('bad project json')

            # 去重：同一 bundle 路径只允许出现一次；同一 sha 只允许一个文件（防重复/碰撞）
            seen_paths = set()
            seen_shas = set()
            for item in manifest['assets']:
                if not isinstance(item, dict) or not _safe_name(item.get('path', '')) or not item['path'].startswith('assets/'):
                    raise ValueError('bad asset entry')
                if item['path'] in seen_paths:
                    raise ValueError('duplicate asset path')
                if item.get('sha256') in seen_shas:
                    raise ValueError('duplicate asset sha')
                seen_paths.add(item['path'])
                seen_shas.add(item.get('sha256'))
                payload = archive.read(item['path'])
                if len(payload) != item.get('size') or hashlib.sha256(payload).hexdigest() != item.get('sha256'):
                    raise ValueError('bad asset hash')
                guessed = mimetypes.guess_type(item['path'])[0]
                if not guessed or not guessed.startswith(('image/', 'video/', 'audio/')):
                    raise ValueError('unknown media type')
                if not self._mime_matches_extension(item['path'], guessed):
                    raise ValueError('mime mismatch')

            for item in manifest.get('thumbs') or []:
                if not isinstance(item, dict) or not _safe_name(item.get('path', '')) or not item['path'].startswith('thumbs/'):
                    raise ValueError('bad thumb entry')
                if item.get('sha256'):
                    payload = archive.read(item['path'])
                    if hashlib.sha256(payload).hexdigest() != item.get('sha256'):
                        raise ValueError('bad thumb hash')

            archive.extractall(staging)
        return manifest

    @staticmethod
    def _mime_matches_extension(path, mime):
        """扩展名与 MIME 主类型一致性校验（image/* 不能伪装成 .mp4 等）。"""
        ext = os.path.splitext(path)[1].lower()
        primary = mime.split('/')[0]
        ext_map = {
            '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image',
            '.gif': 'image', '.bmp': 'image', '.svg': 'image',
            '.mp4': 'video', '.webm': 'video', '.mov': 'video', '.mkv': 'video',
            '.mp3': 'audio', '.wav': 'audio', '.ogg': 'audio', '.m4a': 'audio',
        }
        return ext_map.get(ext) == primary

    def _assets_dir(self):
        """导入资源落点：优先用户配置的图片保存目录，未配置时用临时目录（会话内可用）。"""
        try:
            settings = self.settings_api.load_settings() or {}
            path = (settings.get('image_save_path') or '').strip()
            if path:
                return os.path.abspath(path)
        except Exception:
            pass
        return os.path.join(tempfile.gettempdir(), 'infinite_canvas_imports')

    def _choose_new_project_path(self, project_doc, options):
        """为「新建项目」模式挑选保存路径：优先 options.target_dir + 文件名，缺省弹对话框。"""
        name = str(project_doc.get('projectName') or '未命名项目').strip() or '未命名项目'
        default_name = name.replace('\\', '/').rsplit('/', 1)[-1].replace(':', '') or '未命名项目'
        if not default_name.lower().endswith('.icproj'):
            default_name += '.icproj'
        target_dir = options.get('target_dir') if isinstance(options.get('target_dir'), str) and options.get('target_dir') else ''
        if target_dir:
            os.makedirs(target_dir, exist_ok=True)
            candidate = os.path.join(target_dir, default_name)
            if os.path.exists(candidate):
                candidate = self._copy_name(candidate)
            return candidate
        root = get_tk_root()
        destination = filedialog.asksaveasfilename(
            title='导入为新建项目',
            initialdir=os.path.expanduser('~'),
            initialfile=default_name,
            defaultextension='.icproj',
            filetypes=[('Infinite Canvas Project', '*.icproj')],
        )
        root.destroy()
        if not destination:
            return None
        if not destination.lower().endswith('.icproj'):
            destination += '.icproj'
        return destination

    @staticmethod
    def _copy_name(path):
        stem, ext = os.path.splitext(path)
        index = 1
        candidate = f'{stem} (imported {index}){ext}'
        while os.path.exists(candidate):
            index += 1
            candidate = f'{stem} (imported {index}){ext}'
        return candidate

    @staticmethod
    def _read_json(path, fallback):
        try:
            with open(path, 'r', encoding='utf-8') as handle:
                return json.load(handle)
        except Exception:
            return fallback

    @staticmethod
    def _remove_created_assets(created_assets):
        """删除本次导入新建的资产文件；清理失败仅记录日志，不掩盖原始错误。

        只删除 created_assets 中记录的文件（导入过程中实际新建）；导入前已存在的去重资产
        不在清单内，绝不删除。
        """
        for path in created_assets or []:
            try:
                if os.path.isfile(path):
                    os.remove(path)
            except OSError as exc:
                print(f'清理导入残留资产失败（忽略）: {path}: {exc}')

    @staticmethod
    def _atomic_copy(source, destination):
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        temp = destination + '.tmp'
        try:
            shutil.copyfile(source, temp)
            os.replace(temp, destination)
        except Exception:
            # 与 atomic_write_json 一致：失败清理 .tmp，不留半份文件
            if os.path.exists(temp):
                try:
                    os.remove(temp)
                except OSError:
                    pass
            raise

    @staticmethod
    def _rewrite_paths(value, mapping):
        if isinstance(value, dict):
            return {key: BundleAPI._rewrite_paths(mapping.get(item, item) if isinstance(item, str) else item, mapping) for key, item in value.items()}
        if isinstance(value, list):
            return [BundleAPI._rewrite_paths(item, mapping) for item in value]
        return value
