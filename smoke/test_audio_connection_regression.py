"""Audio generation regression: resolved connection reaches the HTTP request path.

Run: python smoke/test_audio_connection_regression.py
"""
import os
import sys
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.api.audio_api import AudioAPI
from backend.api.model_rules import MODEL_TYPE_AUDIO


class _FakeUnified:
    def __init__(self):
        self.connection_calls = []

    def _resolve_audio_model(self, _model):
        return (
            {'id': 'provider_test', 'name': 'Test Provider', 'use_proxy': True},
            {'id': 'key_test'},
            SimpleNamespace(id='test-music', type=MODEL_TYPE_AUDIO,
                            api_format=SimpleNamespace(value='openai_audio')),
        )

    def _get_connection(self, provider, key, model_type, model_id):
        self.connection_calls.append((provider['id'], key['id'], model_type, model_id))
        return {'api_url': 'https://audio.example.test/v1', 'api_key': 'test-key'}

    @staticmethod
    def _get_api_origin(url):
        return 'https://audio.example.test'


class _FakeResponse:
    status_code = 200
    url = 'https://audio.example.test/v1/audio/generations'

    @staticmethod
    def json():
        return {'audio': 'data:audio/mpeg;base64,VEVTVA==', 'id': 'audio-task-1'}


def main():
    unified = _FakeUnified()
    audio = AudioAPI(unified)
    captured = {}

    def fake_post(url, headers=None, json=None, timeout=None, proxies=None):
        captured.update(url=url, headers=headers, json=json, timeout=timeout, proxies=proxies)
        return _FakeResponse()

    with mock.patch('backend.api.audio_api.requests.post', side_effect=fake_post), \
         mock.patch.object(audio, '_materialize_audio', return_value={'success': True}) as materialize:
        result = audio.generate_audio('make a short cue', {'model': 'provider_test:key_test:test-music'})

    assert result == {'success': True}
    assert unified.connection_calls == [('provider_test', 'key_test', MODEL_TYPE_AUDIO, 'test-music')]
    assert captured['url'] == 'https://audio.example.test/v1/audio/generations'
    assert captured['headers']['Authorization'] == 'Bearer test-key'
    assert captured['json'] == {'model': 'test-music', 'prompt': 'make a short cue'}
    materialize.assert_called_once()
    print('PASS - resolved connection reaches the audio HTTP request path')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
