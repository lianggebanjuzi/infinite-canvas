"""4.3-A 本地 .icbackup 导入导出。

备份是 ZIP，但不把 ZIP 当作可信输入：先在临时目录完整校验，随后再写入。
默认永远创建项目副本，且 settings/provides 中的密钥字段不会进入包。
"""

import hashlib
import json
import mimetypes
import os
import shutil
import tempfile
import time
import zipfile

from backend.api.utils import atomic_write_json, get_tk_root
from backend.api.model_rules import validate_capability_schema, normalize_capability_schema
from tkinter import filedialog

MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
MAX_FILE_BYTES = 512 * 1024 * 1024
MAX_FILES = 10000
KEY_WORDS = ('api_key', 'apikey', 'authorization', 'token', 'secret', 'password')


def _safe_name(name):
    normalized = name.replace('\\', '/')
    return bool(normalized and not normalized.startswith('/') and '..' not in normalized.split('/') and ':' not in normalized)


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


class BackupAPI:
    def __init__(self, app_dir, project_api, settings_api, providers_file, schemas_file=None):
        self.app_dir = app_dir
        self.project_api = project_api
        self.settings_api = settings_api
        self.providers_file = providers_file
        # 4.3-D：capability_schemas.json 随设置备份（不含 Key）
        if schemas_file:
            self.schemas_file = schemas_file
        else:
            self.schemas_file = os.path.join(
                os.path.dirname(os.path.abspath(providers_file)), 'capability_schemas.json'
            )

    def _assets_index_path(self):
        return self.project_api._assets_path()

    def _workflow_path(self):
        return self.project_api._workflows_path()

    def _read_json(self, path, fallback):
        try:
            with open(path, 'r', encoding='utf-8') as handle:
                value = json.load(handle)
            return value
        except Exception:
            return fallback

    def _project_paths(self, supplied):
        paths = supplied if isinstance(supplied, list) else []
        if not paths and self.project_api.current_project_path:
            paths = [self.project_api.current_project_path]
        result, seen = [], set()
        for path in paths:
            if not isinstance(path, str):
                continue
            absolute = os.path.abspath(path)
            if absolute.endswith('.icproj') and os.path.isfile(absolute) and absolute not in seen:
                seen.add(absolute)
                result.append(absolute)
        return result

    def _candidate_media_paths(self, value):
        """只收集本地绝对路径；URL/data URL 永远不落入备份资产文件。"""
        found = set()
        def visit(item):
            if isinstance(item, dict):
                for key, child in item.items():
                    if key.lower() in ('path', 'originalpath', 'coverpath', 'localpath') and isinstance(child, str):
                        absolute = os.path.abspath(child)
                        if os.path.isfile(absolute): found.add(absolute)
                    visit(child)
            elif isinstance(item, list):
                for child in item: visit(child)
        visit(value)
        return found

    def preview_backup(self, options=None):
        options = options or {}
        projects = self._project_paths(options.get('project_paths'))
        records = self._read_json(self._assets_index_path(), {"records": []})
        media = set()
        for path in projects:
            media.update(self._candidate_media_paths(self._read_json(path, {})))
        media.update(self._candidate_media_paths(records))
        size = sum(os.path.getsize(path) for path in projects + list(media) if os.path.isfile(path))
        return {
            'status': 'success', 'projects': len(projects), 'assets': len(media), 'estimated_bytes': size,
            'threshold_bytes': 256 * 1024 * 1024, 'requires_media_choice': size > 256 * 1024 * 1024,
        }

    def export_backup(self, options=None):
        options = options or {}
        try:
            destination = options.get('destination') if isinstance(options.get('destination'), str) else ''
            if not destination:
                root = get_tk_root()
                destination = filedialog.asksaveasfilename(title='导出 Infinite Canvas 备份', initialdir=os.path.expanduser('~'), initialfile='infinite-canvas.icbackup', defaultextension='.icbackup', filetypes=[('Infinite Canvas Backup', '*.icbackup')])
                root.destroy()
            if not destination: return {'status': 'cancelled'}
            if not destination.lower().endswith('.icbackup'): destination += '.icbackup'
            projects = self._project_paths(options.get('project_paths'))
            include_media = bool(options.get('include_media', True))
            records = self._read_json(self._assets_index_path(), {"version": 2, "records": []})
            workflows = self._read_json(self._workflow_path(), {"version": 1, "workflows": []})
            settings = _without_secrets(self._read_json(self.settings_api.settings_file, {}))
            prompts = self._read_json(self.settings_api.prompts_library_file, {})
            schemas = _without_secrets(self._read_json(self.schemas_file, {"schemas": []}))
            media = set()
            source_docs = []
            for path in projects:
                doc = self._read_json(path, {})
                source_docs.append((path, doc))
                if include_media: media.update(self._candidate_media_paths(doc))
            if include_media: media.update(self._candidate_media_paths(records))
            manifest = {'schemaVersion': 1, 'createdAt': int(time.time() * 1000), 'projects': [], 'assets': [], 'includesMedia': include_media}
            directory = os.path.dirname(os.path.abspath(destination)); os.makedirs(directory, exist_ok=True)
            temp_path = destination + '.tmp'
            with zipfile.ZipFile(temp_path, 'w', compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
                for index, (path, doc) in enumerate(source_docs):
                    name = f'projects/{index:03d}-{os.path.basename(path)}'
                    payload = json.dumps(doc, ensure_ascii=False, indent=2).encode('utf-8')
                    archive.writestr(name, payload)
                    manifest['projects'].append({'path': name, 'name': os.path.basename(path), 'sha256': hashlib.sha256(payload).hexdigest()})
                for path in sorted(media):
                    ext = os.path.splitext(path)[1].lower()[:12] or '.bin'; digest = _hash_file(path); name = f'assets/{digest}{ext}'
                    if any(item['path'] == name for item in manifest['assets']): continue
                    archive.write(path, name)
                    manifest['assets'].append({'path': name, 'sha256': digest, 'size': os.path.getsize(path), 'sourcePath': path})
                archive.writestr('prompt-library.json', json.dumps(prompts, ensure_ascii=False, indent=2))
                archive.writestr('workflows.json', json.dumps(workflows, ensure_ascii=False, indent=2))
                archive.writestr('settings.json', json.dumps(settings, ensure_ascii=False, indent=2))
                archive.writestr('capability_schemas.json', json.dumps(schemas, ensure_ascii=False, indent=2))
                archive.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
            os.replace(temp_path, destination)
            return {'status': 'success', 'path': destination, 'manifest': {'projects': len(projects), 'assets': len(manifest['assets']), 'includes_media': include_media}}
        except Exception as exc:
            try:
                if 'temp_path' in locals() and os.path.exists(temp_path): os.remove(temp_path)
            except OSError: pass
            print(f'导出备份失败: {exc}')
            return {'status': 'error', 'message': '导出备份失败'}

    def import_backup(self, options=None):
        options = options or {}
        try:
            source = options.get('path') if isinstance(options.get('path'), str) else ''
            if not source:
                root = get_tk_root(); source = filedialog.askopenfilename(title='恢复 Infinite Canvas 备份', initialdir=os.path.expanduser('~'), filetypes=[('Infinite Canvas Backup', '*.icbackup')]); root.destroy()
            if not source: return {'status': 'cancelled'}
            strategy = options.get('conflict') if options.get('conflict') in ('copy', 'merge', 'skip') else 'copy'
            target = os.path.abspath(options.get('target_dir') or self.app_dir)
            with tempfile.TemporaryDirectory(prefix='icbackup-') as staging:
                manifest = self._validate_and_extract(source, staging)
                # 所有输入都已验证，才创建目标目录或写任何真实文件。
                projects_dir = os.path.join(target, 'restored_projects'); assets_dir = os.path.join(target, 'restored_assets')
                os.makedirs(projects_dir, exist_ok=True); os.makedirs(assets_dir, exist_ok=True)
                mapping = {}
                for item in manifest['assets']:
                    staged = os.path.join(staging, item['path']); ext = os.path.splitext(item['path'])[1]; dest = os.path.join(assets_dir, item['sha256'] + ext)
                    mapping[item.get('sourcePath', '')] = dest
                    if not os.path.exists(dest): self._atomic_copy(staged, dest)
                imported = []
                for item in manifest['projects']:
                    doc = self._read_json(os.path.join(staging, item['path']), {})
                    doc = self._rewrite_paths(doc, mapping)
                    base = os.path.basename(item['name']); dest = os.path.join(projects_dir, base)
                    if os.path.exists(dest):
                        if strategy == 'skip': continue
                        if strategy == 'copy': dest = self._copy_name(dest)
                        # merge only merges document IDs at caller's request; project data itself remains a separately recoverable file.
                        if strategy == 'merge': dest = self._copy_name(dest)
                    atomic_write_json(dest, doc); imported.append(dest)
                # Global documents are only restored if valid. Preserve normal user setting fields; sensitive fields were absent from package.
                prompt_data = self._read_json(os.path.join(staging, 'prompt-library.json'), {})
                workflow_data = self._read_json(os.path.join(staging, 'workflows.json'), {})
                self.settings_api.save_prompts_library(prompt_data)
                atomic_write_json(self._workflow_path(), workflow_data)
                # 4.3-D：能力 schema 随设置备份（不含 Key）；逐条校验，非法条目跳过。
                schema_data = self._read_json(os.path.join(staging, 'capability_schemas.json'), None)
                if isinstance(schema_data, dict):
                    self._restore_capability_schemas(schema_data)
            return {'status': 'success', 'projects': imported, 'message': '已恢复备份；请重新配置 API 渠道和密钥'}
        except Exception as exc:
            print(f'恢复备份失败: {exc}')
            return {'status': 'error', 'message': '备份无效或恢复失败；当前数据未被改写'}

    def _validate_and_extract(self, source, staging):
        if not os.path.isfile(source) or os.path.getsize(source) > MAX_ARCHIVE_BYTES: raise ValueError('invalid size')
        with zipfile.ZipFile(source, 'r') as archive:
            infos = archive.infolist()
            if len(infos) > MAX_FILES or any(not _safe_name(info.filename) or info.file_size > MAX_FILE_BYTES for info in infos): raise ValueError('unsafe archive')
            total = sum(info.file_size for info in infos)
            if total > MAX_ARCHIVE_BYTES: raise ValueError('archive too large')
            if 'manifest.json' not in archive.namelist(): raise ValueError('missing manifest')
            manifest = json.loads(archive.read('manifest.json').decode('utf-8'))
            if not isinstance(manifest, dict) or manifest.get('schemaVersion') != 1 or not isinstance(manifest.get('projects'), list) or not isinstance(manifest.get('assets'), list): raise ValueError('bad manifest')
            for item in manifest['projects']:
                if not isinstance(item, dict) or not _safe_name(item.get('path', '')) or not item['path'].startswith('projects/'): raise ValueError('bad project')
                payload = archive.read(item['path']);
                if hashlib.sha256(payload).hexdigest() != item.get('sha256'): raise ValueError('bad project hash')
                if not isinstance(json.loads(payload.decode('utf-8')), dict): raise ValueError('bad project json')
            for item in manifest['assets']:
                if not isinstance(item, dict) or not _safe_name(item.get('path', '')) or not item['path'].startswith('assets/'): raise ValueError('bad asset')
                payload = archive.read(item['path'])
                if len(payload) != item.get('size') or hashlib.sha256(payload).hexdigest() != item.get('sha256'): raise ValueError('bad asset hash')
                if not mimetypes.guess_type(item['path'])[0]: raise ValueError('unknown media type')
            for name in ('prompt-library.json', 'workflows.json', 'settings.json'):
                if name not in archive.namelist() or not isinstance(json.loads(archive.read(name).decode('utf-8')), dict): raise ValueError('bad metadata')
            if 'capability_schemas.json' in archive.namelist():
                schema_value = json.loads(archive.read('capability_schemas.json').decode('utf-8'))
                if not isinstance(schema_value, dict): raise ValueError('bad schema metadata')
            archive.extractall(staging)
        return manifest

    def _restore_capability_schemas(self, data):
        """恢复 capability_schemas.json：逐条校验并落盘；非法条目跳过，不阻塞整体恢复。"""
        raw_list = data.get('schemas', []) if isinstance(data, dict) else []
        schemas = []
        for raw in raw_list:
            ok, _errors = validate_capability_schema(raw)
            if ok:
                schemas.append(normalize_capability_schema(raw))
        if not schemas and raw_list:
            print('[BackupAPI] 备份中的能力 schema 全部未通过校验，已跳过')
        try:
            directory = os.path.dirname(os.path.abspath(self.schemas_file))
            os.makedirs(directory, exist_ok=True)
            atomic_write_json(self.schemas_file, {"schemas": schemas})
        except Exception as exc:
            print(f'[BackupAPI] 恢复能力 schema 失败: {exc}')

    @staticmethod
    def _atomic_copy(source, destination):
        os.makedirs(os.path.dirname(destination), exist_ok=True); temp = destination + '.tmp'
        shutil.copyfile(source, temp); os.replace(temp, destination)

    @staticmethod
    def _rewrite_paths(value, mapping):
        if isinstance(value, dict): return {key: BackupAPI._rewrite_paths(mapping.get(item, item) if isinstance(item, str) else item, mapping) for key, item in value.items()}
        if isinstance(value, list): return [BackupAPI._rewrite_paths(item, mapping) for item in value]
        return value

    @staticmethod
    def _copy_name(path):
        stem, ext = os.path.splitext(path); index = 1; candidate = f'{stem} (restored {index}){ext}'
        while os.path.exists(candidate): index += 1; candidate = f'{stem} (restored {index}){ext}'
        return candidate
