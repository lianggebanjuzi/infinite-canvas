# backend/api/provider_api.py
"""
供应商管理 API
"""
from backend.api.errors import (
    AppError, UpstreamError, UpstreamTimeoutError, UnknownError
)
from backend.api.gemini_compat import resolve_chat_api_base
from backend.api.model_rules import (
    DRAWING_MODEL_RULES,
    MODEL_TYPE_DRAWING,
    MODEL_TYPE_CHAT,
    MODEL_TYPE_VIDEO,
    MODEL_TYPE_AUDIO,
    detect_model_type,
    validate_capability_schema,
    normalize_capability_schema,
    build_custom_adapter_preview,
)
from backend.api.utils import atomic_write_json
import json
import os
import uuid
import requests


def _match_drawing_model(model_id: str):
    """
    尝试匹配模型 ID 是否为已知绘图模型（显示名规则，来自公共模块 model_rules）
    返回显示名称，匹配不到返回 None
    """
    lower = model_id.lower().strip()
    for keyword, display_name in DRAWING_MODEL_RULES:
        if keyword.lower() in lower:
            return display_name
    return None


class ProviderAPI:

    def __init__(self, providers_file, schemas_file=None):
        self.providers_file = providers_file
        # 4.3-D：用户能力 schema 存储（capability_schemas.json，随设置备份、不含 Key）
        if schemas_file:
            self.schemas_file = schemas_file
        else:
            self.schemas_file = os.path.join(
                os.path.dirname(os.path.abspath(providers_file)), 'capability_schemas.json'
            )

    # ─────────────────────────────────────────
    # 多 Key 结构：读时归一化 + 写时新结构
    # 内存/落盘统一 keys[]：{id, name, api_key, enabled, models[]}
    # 旧文件顶层 api_key/models 读时迁移进 keys[0]，落盘剥离（一次性物理迁移，无冗余双写）
    # ─────────────────────────────────────────
    def _ensure_keys(self, provider):
        """确保 provider 有 keys 数组（至少一个空 key1），供兼容写入口使用"""
        if not provider.get('keys'):
            provider['keys'] = [{
                'id':      f"key_{uuid.uuid4().hex[:8]}",
                'name':    'key1',
                'api_key': '',
                'enabled': True,
                'models':  [],
                'channels': {
                    'chat': {'enabled': False, 'api_url': '', 'api_key': ''},
                    'drawing': {'enabled': False, 'api_url': '', 'api_key': ''},
                    'video': {'enabled': False, 'api_url': '', 'api_key': ''},
                    'audio': {'enabled': False, 'api_url': '', 'api_key': ''},
                },
            }]

    def _next_key_name(self, provider, used_names=None):
        """返回 provider 内最小空号 keyN（key1/key2…，删除后复用）"""
        used = set(used_names or [])
        for k in provider.get('keys') or []:
            if isinstance(k, dict) and k.get('name'):
                used.add(k['name'])
        n = 1
        while f"key{n}" in used:
            n += 1
        return f"key{n}"

    def _normalize_keys(self, provider):
        """补全 provider 内 keys 数组的字段，并把旧共享连接迁移为按能力连接。"""
        keys = provider.get('keys')
        if not isinstance(keys, list):
            keys = []
            provider['keys'] = keys
        used_names = set()
        for k in keys:
            if not isinstance(k, dict):
                continue
            if not k.get('id'):
                k['id'] = f"key_{uuid.uuid4().hex[:8]}"
            if not k.get('name'):
                k['name'] = self._next_key_name(provider, used_names)
            used_names.add(k['name'])
            if 'api_key' not in k:
                k['api_key'] = ''
            if 'enabled' not in k:
                k['enabled'] = True
            if 'models' not in k or not isinstance(k.get('models'), list):
                k['models'] = []
            # 旧配置的 URL 在 provider、Key 在 key 上。读到旧数据时把它们复制到
            # 三种能力中，保证升级后不需要用户重新填写，也不改变原有请求路由。
            channels = k.get('channels')
            if not isinstance(channels, dict):
                channels = {}
                k['channels'] = channels
            legacy_urls = {
                'chat': (provider.get('text_api_url') or provider.get('api_url') or '').strip(),
                'drawing': (provider.get('api_url') or '').strip(),
                'video': (provider.get('api_url') or '').strip(),
            }
            for kind, legacy_url in legacy_urls.items():
                value = channels.get(kind)
                if not isinstance(value, dict):
                    value = {}
                    channels[kind] = value
                if 'enabled' not in value:
                    value['enabled'] = True
                if 'api_url' not in value:
                    value['api_url'] = legacy_url
                if 'api_key' not in value:
                    value['api_key'] = k.get('api_key') or ''

    def _normalize_provider(self, provider):
        """把单个 provider 归一化为 keys 结构（读时迁移，内存始终新结构）"""
        if not isinstance(provider, dict):
            return
        # 旧结构（顶层 api_key/models 且无 keys）→ 迁移为 keys[0]
        if not provider.get('keys'):
            provider['keys'] = [{
                'id':      f"key_{uuid.uuid4().hex[:8]}",
                'name':    provider.get('short_name') or '默认',
                'api_key': provider.get('api_key') or '',
                'enabled': provider.get('enabled', True),
                'models':  provider.get('models') or [],
            }]
        self._normalize_keys(provider)
        # 新结构：三类模型各有独立全局 Key。旧 key.api_key 已在 _normalize_keys
        # 中迁入每个 Key 的按能力 channels；这里不能再把它反向复制为全部类型的
        # provider 全局 Key，否则图像请求会隐式借用对话 Key，破坏类型隔离。
        global_keys = provider.get('global_keys')
        if not isinstance(global_keys, dict):
            global_keys = {}
            provider['global_keys'] = global_keys
        for kind in ('chat', 'drawing', 'video', 'audio'):
            global_keys.setdefault(kind, '')

    def _apply_provider_updates(self, provider, updates):
        """合并 updates 到 provider；顶层 api_key/models 兼容落到 keys[0]（不产生顶层冗余）"""
        if not isinstance(updates, dict):
            return
        for field, value in updates.items():
            if field == 'keys':
                # 整组替换 keys（前端 key 卡片结构变更走这里）
                provider['keys'] = value
            elif field == 'api_key':
                # 兼容旧前端/旧脚本：顶层 api_key → keys[0].api_key
                self._ensure_keys(provider)
                provider['keys'][0]['api_key'] = value
            elif field == 'models':
                # 兼容旧前端/旧脚本：顶层 models → keys[0].models
                self._ensure_keys(provider)
                provider['keys'][0]['models'] = value
            else:
                provider[field] = value
        # keys 变化后统一补全字段
        self._normalize_keys(provider)

    def load_providers(self):
        """加载所有供应商（读时归一化：旧 api_key/models → keys[0]，补全 key 字段）"""
        print("正在加载供应商列表...")
        try:
            if not os.path.exists(self.providers_file):
                return {"providers": []}
            with open(self.providers_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
            providers = data.get('providers', [])
            for p in providers:
                self._normalize_provider(p)
            data['providers'] = providers
            return data
        except Exception as e:
            print(f"加载供应商失败: {e}")
            return {"providers": []}

    def save_providers(self, providers_data):
        """保存供应商数据（写盘前剥离顶层 api_key/models，落盘始终新结构）"""
        print("正在保存供应商数据...")
        try:
            providers = providers_data.get('providers', [])
            for p in providers:
                if isinstance(p, dict):
                    p.pop('api_key', None)
                    p.pop('models', None)
            with open(self.providers_file, 'w', encoding='utf-8') as f:
                json.dump(providers_data, f, ensure_ascii=False, indent=4)
            return {"status": "success", "message": "保存成功"}
        except Exception as e:
            print(f"保存供应商失败: {e}")
            return {"status": "error", "message": str(e)}

    def add_provider(self, name, provider_type, short_name=''):
        """添加新供应商（初始 keys: [空 key1]，保持旧 UX）"""
        print(f"正在添加供应商: {name} ({provider_type})")
        try:
            data      = self.load_providers()
            providers = data.get('providers', [])

            provider_id  = f"provider_{uuid.uuid4().hex[:8]}"
            new_provider = {
                'id':         provider_id,
                'name':       name,
                'short_name': short_name or name[:6],
                'type':       provider_type,
                'enabled':    True,
                'api_url':    '',
                'global_keys': {'chat': '', 'drawing': '', 'video': '', 'audio': ''},
                'use_proxy':  False,
                'keys':       [{
                    'id':      f"key_{uuid.uuid4().hex[:8]}",
                    'name':    'key1',
                    'api_key': '',
                    'enabled': True,
                'models':  [],
                'channels': {
                    'chat': {'enabled': False, 'api_url': '', 'api_key': ''},
                    'drawing': {'enabled': False, 'api_url': '', 'api_key': ''},
                    'video': {'enabled': False, 'api_url': '', 'api_key': ''},
                    'audio': {'enabled': False, 'api_url': '', 'api_key': ''},
                },
            }],
            }

            providers.append(new_provider)
            result = self.save_providers({'providers': providers})

            if result['status'] == 'success':
                return {
                    "status":      "success",
                    "provider_id": provider_id,
                    "provider":    new_provider
                }
            return result

        except Exception as e:
            print(f"添加供应商失败: {e}")
            return {"status": "error", "message": str(e)}

    def update_provider(self, provider_id, updates):
        """更新供应商信息（兼容：updates.api_key/models（无 keys 时）→ keys[0]；updates.keys → 整组替换）"""
        print(f"正在更新供应商: {provider_id}")
        try:
            data      = self.load_providers()
            providers = data.get('providers', [])
            for provider in providers:
                if provider['id'] == provider_id:
                    self._apply_provider_updates(provider, updates)
                    break
            return self.save_providers({'providers': providers})
        except Exception as e:
            print(f"更新供应商失败: {e}")
            return {"status": "error", "message": str(e)}

    def delete_provider(self, provider_id):
        """删除供应商"""
        print(f"正在删除供应商: {provider_id}")
        try:
            data      = self.load_providers()
            providers = [p for p in data.get('providers', [])
                         if p['id'] != provider_id]
            return self.save_providers({'providers': providers})
        except Exception as e:
            print(f"删除供应商失败: {e}")
            return {"status": "error", "message": str(e)}

    # ─────────────────────────────────────────
    # Key CRUD（多 Key 支持）
    # ─────────────────────────────────────────
    def add_key(self, provider_id, key_name=''):
        """给指定供应商新增一个 Key（name 默认 keyN：provider 内最小空号，删除后复用）"""
        print(f"[ProviderAPI] 添加 Key: {provider_id}")
        try:
            data      = self.load_providers()
            providers = data.get('providers', [])

            target = next((p for p in providers if p['id'] == provider_id), None)
            if not target:
                return {"status": "error", "message": "供应商不存在"}

            self._ensure_keys(target)
            self._normalize_keys(target)
            requested_name = (key_name or '').strip()
            if requested_name and any(
                str(k.get('name') or '').strip().casefold() == requested_name.casefold()
                for k in target['keys']
            ):
                return {"status": "error", "message": f"密钥名称「{requested_name}」已存在，请使用不同名称"}
            new_key = {
                'id':      f"key_{uuid.uuid4().hex[:8]}",
                'name':    requested_name or self._next_key_name(target),
                'api_key': '',
                'enabled': True,
                'models':  [],
                'channels': {
                    'chat': {'enabled': False, 'api_url': '', 'api_key': ''},
                    'drawing': {'enabled': False, 'api_url': '', 'api_key': ''},
                    'video': {'enabled': False, 'api_url': '', 'api_key': ''},
                    'audio': {'enabled': False, 'api_url': '', 'api_key': ''},
                },
            }
            target['keys'].append(new_key)

            result = self.save_providers({'providers': providers})
            if result['status'] == 'success':
                return {
                    "status": "success",
                    "key_id": new_key['id'],
                    "key":    new_key,
                    "keys":   target['keys'],
                }
            return result

        except Exception as e:
            print(f"[ProviderAPI] 添加 Key 失败: {e}")
            return {"status": "error", "message": str(e)}

    def delete_key(self, provider_id, key_id):
        """删除指定供应商下的某个 Key（含其 models）"""
        print(f"[ProviderAPI] 删除 Key: {key_id} from {provider_id}")
        try:
            data      = self.load_providers()
            providers = data.get('providers', [])

            target = next((p for p in providers if p['id'] == provider_id), None)
            if not target:
                return {"status": "error", "message": "供应商不存在"}

            keys   = target.get('keys') or []
            before = len(keys)
            target['keys'] = [k for k in keys if k.get('id') != key_id]
            if len(target['keys']) == before:
                return {"status": "error", "message": "Key 不存在"}

            result = self.save_providers({'providers': providers})
            if result['status'] == 'success':
                return {"status": "success", "keys": target['keys']}
            return result

        except Exception as e:
            print(f"[ProviderAPI] 删除 Key 失败: {e}")
            return {"status": "error", "message": str(e)}

    def update_key(self, provider_id, key_id, updates):
        """更新指定供应商下某个 Key（updates: name/api_key/enabled/models 等）"""
        print(f"[ProviderAPI] 更新 Key: {key_id} from {provider_id}")
        try:
            data      = self.load_providers()
            providers = data.get('providers', [])

            target = next((p for p in providers if p['id'] == provider_id), None)
            if not target:
                return {"status": "error", "message": "供应商不存在"}

            key = next((k for k in (target.get('keys') or []) if k.get('id') == key_id), None)
            if not key:
                return {"status": "error", "message": "Key 不存在"}
            if not isinstance(updates, dict):
                return {"status": "error", "message": "更新参数错误"}

            if 'name' in updates:
                new_name = str(updates['name'] or '').strip()
                if not new_name:
                    return {"status": "error", "message": "密钥名称不能为空"}
                if any(
                    k.get('id') != key_id and
                    str(k.get('name') or '').strip().casefold() == new_name.casefold()
                    for k in (target.get('keys') or [])
                ):
                    return {"status": "error", "message": f"密钥名称「{new_name}」已存在，请使用不同名称"}
                updates = {**updates, 'name': new_name}

            for field, value in updates.items():
                if field == 'id':
                    continue
                key[field] = value

            self._normalize_keys(target)
            result = self.save_providers({'providers': providers})
            if result['status'] == 'success':
                return {"status": "success", "key": key, "keys": target['keys']}
            return result

        except Exception as e:
            print(f"[ProviderAPI] 更新 Key 失败: {e}")
            return {"status": "error", "message": str(e)}

    def fetch_models(self, api_url, api_key):
        """
        拉取模型列表（url + key 独立拉取，逻辑不变；前端按 key 调用后写入对应 keys[i].models）

        同时收集绘图模型、对话模型与视频模型：
        - 绘图模型：按显示名去重（带 -2k/-4k 后缀的直接过滤，由前端分辨率选择器控制）
        - 对话模型：按模型 ID 去重（对话模型通常 ID 唯一，保留全部，一个不漏）
        - 视频模型：按模型 ID 去重（type:'video'，FluxPort 视频任务协议）
        FluxPort 供应商的模型列表必须走语言域（api.uselg.top）：媒体域 api.ai-media.vip
        拉不到 chat/video 模型，故先用 resolve_chat_api_base 做域名归一（非 FluxPort 原样返回）。
        每个模型带正确的 type 字段（'drawing' / 'chat' / 'video'），分类规则复用公共模块 model_rules。
        """
        print(f"正在从 {api_url} 拉取模型列表...")
        try:
            base_url = resolve_chat_api_base(api_url).rstrip('/')
            if not base_url.endswith('/v1'):
                base_url = base_url + '/v1'
            models_url = f"{base_url}/models"

            headers = {
                'Authorization': f'Bearer {api_key}',
                'Content-Type':  'application/json'
            }
            response = requests.get(models_url, headers=headers, timeout=10)

            if response.status_code == 200:
                data = response.json()

                # 第一步：按类型收集全部模型（不去重）
                all_drawing = []
                all_chat    = []
                all_video   = []
                all_audio   = []
                seen_ids    = set()

                if 'data' in data:
                    for model in data['data']:
                        model_id = model.get('id', '')
                        if not model_id:
                            continue
                        if model_id in seen_ids:
                            print(f"跳过重复 ID: {model_id}")
                            continue
                        seen_ids.add(model_id)

                        m_type = detect_model_type(model_id)

                        if m_type == MODEL_TYPE_DRAWING:
                            display_name = _match_drawing_model(model_id) or model_id
                            all_drawing.append({
                                'id':      model_id,
                                'name':    display_name,
                                'type':    MODEL_TYPE_DRAWING,
                                'enabled': True
                            })
                            print(f"匹配到绘图模型: {model_id} -> {display_name}")
                        elif m_type == MODEL_TYPE_VIDEO:
                            all_video.append({
                                'id':      model_id,
                                'name':    model_id,
                                'type':    MODEL_TYPE_VIDEO,
                                'enabled': True
                            })
                            print(f"匹配到视频模型: {model_id}")
                        elif m_type == MODEL_TYPE_AUDIO:
                            all_audio.append({
                                'id':      model_id,
                                'name':    model_id,
                                'type':    MODEL_TYPE_AUDIO,
                                'enabled': True
                            })
                            print(f"匹配到音频模型: {model_id}")
                        else:
                            # 对话模型没有显示名规则，name 直接用模型 ID（前端可再加工）
                            all_chat.append({
                                'id':      model_id,
                                'name':    model_id,
                                'type':    MODEL_TYPE_CHAT,
                                'enabled': True
                            })
                            print(f"匹配到对话模型: {model_id}")

                # 第二步：绘图模型按显示名去重，每个名称只保留第一个
                # 带 -2k / -4k 后缀的直接过滤掉，不进入最终列表
                seen_names     = {}
                deduped_drawing = []

                for model in all_drawing:
                    mid  = model['id']
                    name = model['name']

                    # 过滤掉带分辨率后缀的模型，前端通过分辨率选择器控制
                    if (mid.endswith('-2k') or mid.endswith('-4k') or
                            mid.endswith('-2K') or mid.endswith('-4K')):
                        print(f"过滤后缀模型: {mid} (由前端分辨率选择器控制)")
                        continue

                    if name not in seen_names:
                        seen_names[name] = True
                        deduped_drawing.append(model)
                        print(f"保留代表模型: {mid} 作为 [{name}]")
                    else:
                        print(f"去重跳过: {mid} (已有 [{name}] 的代表)")

                # 对话/视频/音频模型按 ID 去重已在第一步完成，无需再处理
                print(f"共 {len(deduped_drawing)} 个绘图模型、{len(all_chat)} 个对话模型、"
                      f"{len(all_video)} 个视频模型、{len(all_audio)} 个音频模型")
                return {
                    "status": "success",
                    "models": deduped_drawing + all_chat + all_video + all_audio
                }
            else:
                error_msg = f"HTTP {response.status_code}: {response.text}"
                print(f"拉取失败: {error_msg}")
                return {"status": "error", "message": error_msg}

        except requests.exceptions.Timeout:
            raise UpstreamTimeoutError("请求超时，请检查网络连接")
        except requests.exceptions.ConnectionError:
            raise UpstreamError(503, "无法连接到 API 服务器")
        except Exception as e:
            print(f"拉取模型失败: {e}")
            raise UnknownError(str(e))

    def test_api_connection(self, api_url, api_key):
        """测试 API 连接（按 key 独立执行，逻辑不变；模型列表走语言域归一，与 fetch_models 一致）"""
        print(f"正在测试 API 连接: {api_url}")
        try:
            base_url = resolve_chat_api_base(api_url).rstrip('/')
            if not base_url.endswith('/v1'):
                base_url = base_url + '/v1'
            models_url = f"{base_url}/models"

            headers = {
                'Authorization': f'Bearer {api_key}',
                'Content-Type':  'application/json'
            }
            response = requests.get(models_url, headers=headers, timeout=10)

            if response.status_code == 200:
                return {"success": True,  "message": "API 连接成功！"}
            else:
                return {"success": False,
                        "message": f"连接失败: HTTP {response.status_code}"}

        except requests.exceptions.Timeout:
            raise UpstreamTimeoutError("连接超时")
        except requests.exceptions.ConnectionError:
            raise UpstreamError(503, "无法连接到服务器")
        except Exception as e:
            raise UpstreamError(503, str(e))

    def _get_model_icon(self, model_id):
        model_id_lower = model_id.lower()
        if 'claude'      in model_id_lower: return '/static/images/icons/claude-color.svg'
        if 'gpt'         in model_id_lower: return '/static/images/icons/openai.svg'
        if 'gemini'      in model_id_lower: return '/static/images/icons/gemini-color.svg'
        if 'nano-banana' in model_id_lower: return '/static/images/icons/gemini-color.svg'
        return 'default'

    def add_chat_model(self, provider_id, key_id=None, model_id=None, model_name=None):
        """
        手动添加一个对话模型到指定供应商的指定 Key。

        兼容旧签名 add_chat_model(provider_id, model_id, model_name)：
        旧调用第 2/3 个位置参数是 model_id/model_name，新调用第 2 个是 key_id。
        判定依据：key_id 传了但 model_id 没传 → 视为旧式（key_id 实为 model_id）。
        key_id 缺省（None）→ 落到 keys[0]。
        """
        # 兼容旧式位置调用
        if key_id is not None and model_id is None:
            model_id, model_name, key_id = key_id, model_name, None

        if not model_id:
            return {"status": "error", "message": "模型 ID 不能为空"}

        print(f"[ProviderAPI] 手动添加对话模型: {model_id} -> {provider_id}")
        try:
            data      = self.load_providers()
            providers = data.get('providers', [])

            target = next((p for p in providers if p['id'] == provider_id), None)
            if not target:
                return {"status": "error", "message": "供应商不存在"}

            self._ensure_keys(target)
            self._normalize_keys(target)
            key = next((k for k in target['keys'] if k.get('id') == key_id), None) if key_id else None
            if key is None:
                key = target['keys'][0]

            models = key.get('models') or []
            if any(m['id'] == model_id for m in models):
                return {"status": "error", "message": f"模型 {model_id} 已存在"}

            models.append({
                "id":      model_id,
                "name":    model_name or model_id,
                "type":    "chat",
                "enabled": True
            })
            key['models'] = models

            result = self.save_providers({'providers': providers})
            if result['status'] == 'success':
                print(f"[ProviderAPI] 对话模型添加成功: {model_id}")
            return result

        except Exception as e:
            print(f"[ProviderAPI] 添加对话模型失败: {e}")
            return {"status": "error", "message": str(e)}

    def remove_model(self, provider_id, key_id, model_id):
        """删除指定供应商下指定 Key 的某个模型（对话/绘图通用）"""
        print(f"[ProviderAPI] 删除模型: {model_id} from {provider_id}/{key_id}")
        try:
            data      = self.load_providers()
            providers = data.get('providers', [])

            target = next((p for p in providers if p['id'] == provider_id), None)
            if not target:
                return {"status": "error", "message": "供应商不存在"}

            key = next((k for k in (target.get('keys') or []) if k.get('id') == key_id), None)
            if not key:
                return {"status": "error", "message": "Key 不存在"}

            before = len(key.get('models') or [])
            key['models'] = [
                m for m in (key.get('models') or [])
                if m['id'] != model_id
            ]
            after = len(key['models'])

            if before == after:
                return {"status": "error", "message": "模型不存在"}

            return self.save_providers({'providers': providers})

        except Exception as e:
            print(f"[ProviderAPI] 删除模型失败: {e}")
            return {"status": "error", "message": str(e)}

    def _get_model_badges(self, model_id):
        badges         = []
        model_id_lower = model_id.lower()
        if 'vision'    in model_id_lower: badges.append('vision')
        if 'embedding' in model_id_lower: badges.append('embedding')
        return badges

    # ─────────────────────────────────────────
    # 4.3-D 模型能力 schema（capability_* 前缀桥接）
    # 存储到 capability_schemas.json（随设置备份、不含 Key）；内置规则保留，
    # 用户 schema 只允许通过 validate_capability_schema 校验后落盘。
    # ─────────────────────────────────────────

    def load_capability_schemas(self):
        """读取用户能力 schema 列表（读时归一化，非法条目跳过）。"""
        try:
            if not os.path.exists(self.schemas_file):
                return {"status": "success", "schemas": []}
            with open(self.schemas_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
            raw_list = data.get('schemas', []) if isinstance(data, dict) else []
            schemas = []
            for raw in raw_list:
                ok, _errors = validate_capability_schema(raw)
                if ok:
                    schemas.append(normalize_capability_schema(raw))
            return {"status": "success", "schemas": schemas}
        except Exception as e:
            print(f"[ProviderAPI] 加载能力 schema 失败: {e}")
            return {"status": "error", "message": "加载能力 schema 失败", "schemas": []}

    def _write_capability_schemas(self, schemas):
        """原子写 capability_schemas.json；父目录不存在时创建。"""
        directory = os.path.dirname(os.path.abspath(self.schemas_file))
        os.makedirs(directory, exist_ok=True)
        atomic_write_json(self.schemas_file, {"schemas": schemas})

    def save_capability_schema(self, schema):
        """保存/覆盖一个用户能力 schema（按 modelId 精确匹配替换）。校验失败不可保存。"""
        if not isinstance(schema, dict):
            return {"status": "error", "message": "schema 必须是对象"}
        ok, errors = validate_capability_schema(schema)
        if not ok:
            return {"status": "error", "message": "schema 校验失败：\n" + "\n".join(errors)}
        normalized = normalize_capability_schema(schema)
        try:
            current = self.load_capability_schemas().get('schemas', [])
            model_id = normalized.get('modelId', '')
            current = [s for s in current if s.get('modelId') != model_id]
            current.append(normalized)
            self._write_capability_schemas(current)
            print(f"[ProviderAPI] 能力 schema 已保存: {model_id}")
            return {"status": "success", "message": f"模型「{model_id}」能力 schema 已保存"}
        except Exception as e:
            print(f"[ProviderAPI] 保存能力 schema 失败: {e}")
            return {"status": "error", "message": f"保存能力 schema 失败：{e}"}

    def delete_capability_schema(self, model_id):
        """删除一个用户能力 schema（按 modelId 精确匹配）。"""
        if not isinstance(model_id, str) or not model_id.strip():
            return {"status": "error", "message": "modelId 无效"}
        try:
            current = self.load_capability_schemas().get('schemas', [])
            bare = model_id.strip()
            before = len(current)
            current = [s for s in current if s.get('modelId') != bare]
            if len(current) == before:
                return {"status": "error", "message": f"未找到模型「{bare}」的用户 schema"}
            self._write_capability_schemas(current)
            return {"status": "success", "message": f"模型「{bare}」的用户 schema 已删除（回退内置规则）"}
        except Exception as e:
            print(f"[ProviderAPI] 删除能力 schema 失败: {e}")
            return {"status": "error", "message": f"删除能力 schema 失败：{e}"}

    def test_custom_adapter(self, model_id, options=None):
        """
        custom-declarative 受限测试：
        - mode='connection'（默认）：仅发送「测试连接/模型列表」请求（GET /models，无媒体费用）；
        - mode='preview'：返回请求结构预览（URL path/字段映射/状态字段/结果字段白名单），不发网络请求；
        - mode='generate'：当前不支持。custom-declarative 尚未接入执行器，
          绝不能把预览误报为可运行生成。
        """
        options = options or {}
        mode = options.get('mode') or 'connection'
        bare = (model_id or '').split(':')[-1].strip()
        schemas = self.load_capability_schemas().get('schemas', [])
        spec = next((s for s in schemas if s.get('modelId') == bare), None)
        if not spec:
            return {"status": "error", "message": f"未找到模型「{bare}」的能力 schema，请先保存 schema"}
        if spec.get('requestAdapter') != 'custom-declarative':
            return {"status": "error", "message": "仅 custom-declarative adapter 支持受限测试"}

        if mode == 'preview':
            return {"status": "success", "mode": "preview", "preview": build_custom_adapter_preview(spec)}

        if mode == 'generate':
            return {
                "status": "error",
                "mode": "generate",
                "message": "custom-declarative 当前仅支持请求预览和连接测试，尚未接入实际生成。",
                "preview": build_custom_adapter_preview(spec),
            }

        # connection：仅发送「测试连接/模型列表」请求（无媒体费用）
        resolved = self._resolve_route_connection(model_id)
        if resolved is None:
            return {"status": "error", "mode": "connection",
                    "message": "无法解析模型路由，请确认该模型已添加到供应商模型列表并配置 Key"}
        _provider, _key, _model, api_url, api_key, _kind = resolved
        try:
            base_url = resolve_chat_api_base(api_url).rstrip('/')
            if not base_url.endswith('/v1'):
                base_url = base_url + '/v1'
            models_url = f"{base_url}/models"
            headers = {
                'Authorization': f'Bearer {api_key}',
                'Content-Type':  'application/json'
            }
            response = requests.get(models_url, headers=headers, timeout=10)
            if response.status_code == 200:
                data = response.json()
                count = len(data.get('data', [])) if isinstance(data, dict) else 0
                return {"status": "success", "mode": "connection",
                        "message": f"连接成功，模型列表 {count} 项（未发起媒体生成）", "model_count": count}
            return {"status": "error", "mode": "connection",
                    "message": f"连接失败: HTTP {response.status_code}"}
        except requests.exceptions.Timeout:
            return {"status": "error", "mode": "connection", "message": "连接超时"}
        except requests.exceptions.ConnectionError:
            return {"status": "error", "mode": "connection", "message": "无法连接到服务器"}
        except Exception as e:
            print(f"[ProviderAPI] custom adapter 连接测试异常: {e}")
            return {"status": "error", "mode": "connection", "message": f"连接测试失败：{e}"}

    def _resolve_route_connection(self, model_id):
        """
        解析模型路由（provider:key:model / provider:model / 裸 model）为连接信息。
        返回 (provider, key, model, api_url, api_key, kind)；无法唯一解析返回 None。
        解析逻辑与前端 isModelReady 对齐：模型专用 Key → 同类全局 Key → 账户通道 Key。
        """
        if not isinstance(model_id, str) or not model_id.strip():
            return None
        parts = model_id.split(':')
        data = self.load_providers()
        providers = data.get('providers', [])

        provider = key = model = None
        if len(parts) >= 3:
            provider_id, key_id, mid = parts[0], parts[1], ':'.join(parts[2:])
            provider = next((p for p in providers if p.get('id') == provider_id), None)
            if not provider:
                return None
            key = next((k for k in (provider.get('keys') or []) if k.get('id') == key_id), None)
            if not key:
                return None
            model = next((m for m in (key.get('models') or []) if m.get('id') == mid), None)
            if not model:
                return None
        elif len(parts) == 2:
            provider_id, mid = parts
            provider = next((p for p in providers if p.get('id') == provider_id), None)
            if not provider:
                return None
            key = next((k for k in (provider.get('keys') or []) if k.get('enabled') is not False), None)
            if key is None:
                key = (provider.get('keys') or [None])[0]
            if key is None:
                return None
            model = next((m for m in (key.get('models') or []) if m.get('id') == mid), None)
            if not model:
                return None
        else:
            mid = parts[0]
            found = None
            for p in providers:
                for k in (p.get('keys') or []):
                    for m in (k.get('models') or []):
                        if m.get('id') == mid:
                            if found is not None:
                                return None  # 有歧义，不猜
                            found = (p, k, m)
            if found is None:
                return None
            provider, key, model = found

        kind = model.get('type') or detect_model_type(model.get('id') or '')
        if kind == MODEL_TYPE_CHAT:
            api_url = (provider.get('text_api_url') or provider.get('api_url') or '').strip()
        else:
            api_url = (provider.get('api_url') or '').strip()
        channel = (key.get('channels') or {}).get(kind) or {}
        channel_key = channel.get('api_key') if channel.get('enabled') is not False else ''
        api_key = (
            model.get('api_key')
            or (provider.get('global_keys') or {}).get(kind)
            or channel_key
            or ''
        ).strip()
        if not api_url or not api_key:
            return None
        return provider, key, model, api_url, api_key, kind
