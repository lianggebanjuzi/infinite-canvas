"""Schema runtime-gate regression checks (no network or API key required).

Run: python smoke/test_schema_runtime_gate.py
"""
import base64
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.api.errors import AppError
from backend.api.image_api import ImageAPI
from backend.api.provider_api import ProviderAPI
from backend.api.unified_api import UnifiedAPIRouter
from backend.api.video_api import VideoAPI


def write_json(path, data):
    with open(path, 'w', encoding='utf-8') as stream:
        json.dump(data, stream, ensure_ascii=False)


def expect_custom_adapter_rejected(callable_):
    try:
        callable_()
    except AppError as error:
        assert error.code == 422, error.message
        assert 'custom-declarative' in error.message, error.message
        return
    raise AssertionError('custom-declarative request unexpectedly reached a generator')


class _Settings:
    def __init__(self, save_path):
        self.save_path = save_path

    def load_settings(self):
        return {'image_save_path': self.save_path}


def main():
    root = tempfile.mkdtemp(prefix='icv_schema_gate_')
    providers_path = os.path.join(root, 'providers.json')
    schemas_path = os.path.join(root, 'capability_schemas.json')
    write_json(providers_path, {
        'providers': [{
            'id': 'provider_test', 'name': 'Test Provider', 'enabled': True,
            'api_url': 'https://example.invalid/v1',
            'global_keys': {'drawing': 'test-key', 'video': 'test-key', 'audio': 'test-key', 'chat': 'test-key'},
            'keys': [{
                'id': 'key_test', 'name': 'key1', 'enabled': True,
                'models': [
                    {'id': 'custom-image', 'type': 'drawing', 'enabled': True},
                    {'id': 'custom-video', 'type': 'video', 'enabled': True},
                ],
            }],
        }],
    })
    write_json(schemas_path, {'schemas': [
        {
            'modelId': 'custom-image', 'kinds': ['drawing'],
            'requestAdapter': 'custom-declarative',
            'adapter': {'urlPath': '/v1/images/generations', 'fieldMapping': {'prompt': 'prompt', 'model': 'model'}},
        },
        {
            'modelId': 'custom-video', 'kinds': ['video'],
            'requestAdapter': 'custom-declarative',
            'adapter': {'urlPath': '/v1/videos', 'fieldMapping': {'prompt': 'prompt', 'model': 'model'}},
        },
    ]})

    provider_api = ProviderAPI(providers_path, schemas_file=schemas_path)
    router = UnifiedAPIRouter(provider_api)
    expect_custom_adapter_rejected(
        lambda: router.generate_image('test', {'model': 'provider_test:key_test:custom-image'})
    )
    expect_custom_adapter_rejected(
        lambda: VideoAPI(router).generate_video('test', {'model': 'provider_test:key_test:custom-video'})
    )
    preview_only = provider_api.test_custom_adapter('custom-image', {'mode': 'generate', 'confirm_cost': True})
    assert preview_only['status'] == 'error', preview_only

    source_video = os.path.join(root, 'source.mp4')
    with open(source_video, 'wb') as stream:
        stream.write(b'not-a-real-video')
    media_result = ImageAPI(_Settings(root)).prepare_imported_media({
        'kind': 'video', 'sourcePath': source_video, 'filename': 'source.mp4',
    })
    assert media_result['status'] == 'success', media_result
    assert media_result['mime_type'] == 'video/mp4', media_result
    assert media_result['size_bytes'] == len(b'not-a-real-video'), media_result

    # WebView/浏览器通常不暴露 File.path；重新定位必须通过 data URL 落盘，不能退化为 file.name。
    data_bytes = b'video-selected-via-browser'
    data_url_result = ImageAPI(_Settings(root)).prepare_imported_media({
        'kind': 'video',
        'dataUrl': 'data:video/mp4;base64,' + base64.b64encode(data_bytes).decode('ascii'),
        'filename': 'relocated.mp4',
    })
    assert data_url_result['status'] == 'success', data_url_result
    assert data_url_result['path'] and os.path.isabs(data_url_result['path']), data_url_result
    with open(data_url_result['path'], 'rb') as stream:
        assert stream.read() == data_bytes

    print('PASS - custom-declarative is blocked before network generation')
    print('PASS - imported MP4 uses video metadata and MIME type')
    print('PASS - browser data URL media import is persisted to an absolute path')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
