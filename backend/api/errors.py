# backend/api/errors.py
"""
统一错误码定义
所有 API 错误使用 AppError 子类抛出，由路由入口统一捕获并转换为字典返回
"""

import sys


class AppError(Exception):
    """应用层错误基类"""

    def __init__(self, code: int, message: str):
        self.code    = code
        self.message = message
        super().__init__(message)

    def to_dict(self) -> dict:
        return {
            "success":     False,
            "error_code": self.code,
            "message":    self.message,
            "error":      self.message
        }


# ── 客户端错误 4xx ──
class APIKeyError(AppError):
    """401 - API 密钥无效或已过期"""
    def __init__(self, message="API 密钥无效或已过期"):
        super().__init__(401, message)


class QuotaExceededError(AppError):
    """402 - 额度不足"""
    def __init__(self, message="额度不足，请检查账户余额"):
        super().__init__(402, message)


class ModelNotSupportedError(AppError):
    """422 - 模型不支持此操作"""
    def __init__(self, model_id: str = ""):
        msg = f"当前模型不支持此操作"
        if model_id:
            msg = f"模型 {model_id} 不支持此操作"
        super().__init__(422, msg)


class RateLimitError(AppError):
    """429 - 请求过于频繁"""
    def __init__(self, message="请求过于频繁，请稍后再试"):
        super().__init__(429, message)


# ── 服务端错误 5xx ──
class UpstreamError(AppError):
    """上游服务错误（50x），可指定具体状态码"""
    def __init__(self, code: int = 503, message="服务暂时不可用"):
        super().__init__(code, message)


class UpstreamTimeoutError(UpstreamError):
    """504 - 上游服务响应超时"""
    def __init__(self, message="请求超时，请检查网络后重试"):
        super().__init__(504, message)


class BadGatewayError(UpstreamError):
    """502 - AI 服务返回了无效响应"""
    def __init__(self, message="AI 服务返回了无效响应，请稍后重试"):
        super().__init__(502, message)


class ServiceUnavailableError(UpstreamError):
    """503 - AI 服务暂时不可用"""
    def __init__(self, message="AI 服务暂时不可用，请稍后重试"):
        super().__init__(503, message)


# ── 通用错误 ──
class ValidationError(AppError):
    """400 - 参数校验失败"""
    def __init__(self, message: str):
        super().__init__(400, message)


class NotFoundError(AppError):
    """404 - 资源不存在"""
    def __init__(self, message: str = "资源不存在"):
        super().__init__(404, message)


class UnknownError(AppError):
    """500 - 未处理的未知异常"""
    def __init__(self, message="发生了未知错误，请重试"):
        super().__init__(500, message)
