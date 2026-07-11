# backend/api/provider_api.py
"""
供应商管理 API
"""
from backend.api.errors import (
    AppError, UpstreamError, UpstreamTimeoutError, UnknownError
)
import json
import os
import uuid
import requests

# ─────────────────────────────────────────
# 绘图模型识别规则
# 格式：匹配关键词（模型 ID 包含此字符串）-> 显示名称
# 大小写不敏感，从上到下优先匹配第一条
# ─────────────────────────────────────────
DRAWING_MODEL_RULES = [
    # Nano Banana Pro
    ('gemini-3-pro-image-preview', 'Nano Banana Pro'),
    # Nano Banana 2
    ('gemini-3.1-flash-image-preview', 'Nano Banana 2'),
]


def _match_drawing_model(model_id: str):
    """
    尝试匹配模型 ID 是否为已知绘图模型
    返回显示名称，匹配不到返回 None
    """
    lower = model_id.lower().strip()
    for keyword, display_name in DRAWING_MODEL_RULES:
        if keyword.lower() in lower:
            return display_name
    return None


class ProviderAPI:

    def __init__(self, providers_file):
        self.providers_file = providers_file

    def load_providers(self):
        """加载所有供应商"""
        print("正在加载供应商列表...")
        try:
            if not os.path.exists(self.providers_file):
                return {"providers": []}
            with open(self.providers_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
            return data
        except Exception as e:
            print(f"加载供应商失败: {e}")
            return {"providers": []}

    def save_providers(self, providers_data):
        """保存供应商数据"""
        print("正在保存供应商数据...")
        try:
            with open(self.providers_file, 'w', encoding='utf-8') as f:
                json.dump(providers_data, f, ensure_ascii=False, indent=4)
            return {"status": "success", "message": "保存成功"}
        except Exception as e:
            print(f"保存供应商失败: {e}")
            return {"status": "error", "message": str(e)}

    def add_provider(self, name, provider_type, short_name=''):
        """添加新供应商"""
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
                'api_key':    '',
                'api_url':    '',
                'models':     []
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
        """更新供应商信息"""
        print(f"正在更新供应商: {provider_id}")
        try:
            data      = self.load_providers()
            providers = data.get('providers', [])
            for provider in providers:
                if provider['id'] == provider_id:
                    provider.update(updates)
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

    def fetch_models(self, api_url, api_key):
        """
        拉取模型列表
        只保留能匹配到绘图规则的模型，按显示名称去重
        每个显示名称只保留第一个匹配到的模型 ID 作为代表
        """
        print(f"正在从 {api_url} 拉取模型列表...")
        try:
            base_url = api_url.rstrip('/')
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

                # 第一步：匹配所有绘图模型（全部收集，不去重）
                all_matched = []
                seen_ids    = set()

                if 'data' in data:
                    for model in data['data']:
                        model_id     = model.get('id', '')
                        display_name = _match_drawing_model(model_id)

                        if display_name is None:
                            continue
                        if model_id in seen_ids:
                            print(f"跳过重复 ID: {model_id}")
                            continue

                        seen_ids.add(model_id)
                        all_matched.append({
                            'id':      model_id,
                            'name':    display_name,
                            'type':    'drawing',
                            'enabled': True
                        })
                        print(f"匹配到: {model_id} -> {display_name}")

                # 第二步：按显示名去重，每个名称只保留第一个
                # 带 -2k / -4k 后缀的直接过滤掉，不进入最终列表
                seen_names     = {}
                deduped_models = []

                for model in all_matched:
                    mid  = model['id']
                    name = model['name']

                    # 过滤掉带分辨率后缀的模型，前端通过分辨率选择器控制
                    if (mid.endswith('-2k') or mid.endswith('-4k') or
                            mid.endswith('-2K') or mid.endswith('-4K')):
                        print(f"过滤后缀模型: {mid} (由前端分辨率选择器控制)")
                        continue

                    if name not in seen_names:
                        seen_names[name] = True
                        deduped_models.append(model)
                        print(f"保留代表模型: {mid} 作为 [{name}]")
                    else:
                        print(f"去重跳过: {mid} (已有 [{name}] 的代表)")

                print(f"去重后共 {len(deduped_models)} 个绘图模型")
                return {
                    "status": "success",
                    "models": deduped_models
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
        """测试 API 连接"""
        print(f"正在测试 API 连接: {api_url}")
        try:
            base_url = api_url.rstrip('/')
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

    def add_chat_model(self, provider_id, model_id, model_name):
        """手动添加一个对话模型到指定供应商"""
        print(f"[ProviderAPI] 手动添加对话模型: {model_id} -> {provider_id}")
        try:
            data      = self.load_providers()
            providers = data.get('providers', [])

            target = next((p for p in providers if p['id'] == provider_id), None)
            if not target:
                return {"status": "error", "message": "供应商不存在"}

            models = target.get('models', [])

            if any(m['id'] == model_id for m in models):
                return {"status": "error", "message": f"模型 {model_id} 已存在"}

            models.append({
                "id":      model_id,
                "name":    model_name or model_id,
                "type":    "chat",
                "enabled": True
            })
            target['models'] = models

            result = self.save_providers({'providers': providers})
            if result['status'] == 'success':
                print(f"[ProviderAPI] 对话模型添加成功: {model_id}")
            return result

        except Exception as e:
            print(f"[ProviderAPI] 添加对话模型失败: {e}")
            return {"status": "error", "message": str(e)}

    def remove_model(self, provider_id, model_id):
        """删除指定供应商下的某个模型（对话/绘图通用）"""
        print(f"[ProviderAPI] 删除模型: {model_id} from {provider_id}")
        try:
            data      = self.load_providers()
            providers = data.get('providers', [])

            target = next((p for p in providers if p['id'] == provider_id), None)
            if not target:
                return {"status": "error", "message": "供应商不存在"}

            before = len(target.get('models', []))
            target['models'] = [
                m for m in target.get('models', [])
                if m['id'] != model_id
            ]
            after = len(target['models'])

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
