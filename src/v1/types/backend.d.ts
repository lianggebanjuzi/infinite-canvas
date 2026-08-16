// src/v1/types/backend.d.ts
// ICV v1 后端调用返回类型（ambient，对应 backend/api/* 的返回结构）

/** 供应商配置（对应 provider_api.load_providers 返回项） */
interface BackendProvider {
  id: string;
  name: string;
  type: string;
  short_name: string;
  enabled: boolean;
  api_key?: string;
  api_url?: string;
  use_proxy?: boolean;
  models?: BackendModel[];
}

/** 模型条目 */
interface BackendModel {
  id: string;
  name: string;
  type?: string;
  enabled?: boolean;
}

/** 供应商列表响应 */
interface BackendProviderList {
  providers: BackendProvider[];
}

/** 异步任务查询结果（unified_get_task_result） */
interface BackendTaskResult {
  status: string;            // pending | done | not_found
  result?: {
    success?: boolean;
    image_url?: string;
    images?: string[];
    error?: string;
    error_code?: number;
    message?: string;
    text?: string;
  };
}

/** 生成任务创建响应（unified_generate_image） */
interface BackendTaskCreate {
  success?: boolean;
  task_id: string;
}

/** 保存/打开项目通用结果 */
interface BackendProjectResult {
  status: string;            // success | need_save_as | cancelled | error
  message?: string;
  path?: string;
  data?: unknown;
}

/** 图片本地保存结果 */
interface BackendSaveImageResult {
  status?: string;
  path?: string;
  url?: string;
  thumbnail?: string;
}

/** 设置项 */
interface BackendSettings {
  image_save_path?: string;
  [key: string]: unknown;
}

/** append_history / load_history 返回 */
interface BackendHistoryResult {
  status: string;            // success | empty | error
  message?: string;
  entries?: HistoryEntry[];
}
