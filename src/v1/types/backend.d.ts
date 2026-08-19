// src/v1/types/backend.d.ts
// ICV v1 后端调用返回类型（ambient，对应 backend/api/* 的返回结构）

/** Key 条目（对应 provider.keys[]，multi-key：每个 Key 独立模型组） */
interface BackendProviderKey {
  id: string;
  name: string;
  api_key: string;
  enabled: boolean;
  models: BackendModel[];
}

/** 供应商配置（对应 provider_api.load_providers 返回项） */
interface BackendProvider {
  id: string;
  name: string;
  type: string;
  short_name: string;
  enabled: boolean;
  api_url?: string;
  text_api_url?: string;  // 可选：文本对话 URL（留空则与 api_url 共用；对话/拉模型/测连接优先走此 URL）
  use_proxy?: boolean;
  keys?: BackendProviderKey[];   // 新结构（load_providers 归一化后必有）
  api_key?: string;              // legacy：读兼容，新代码不写
  models?: BackendModel[];       // legacy：读兼容，新代码不写
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
    image_url?: string;      // 展示图（新后端=缩略图 data URL；旧后端=原图 base64）
    images?: string[];
    thumbnail?: string;      // 显式缩略图（新后端，= image_url）
    thumbnails?: string[];
    original_path?: string;  // 原图本地绝对路径（查看大图按需加载用；正斜杠）
    original_paths?: string[];
    original_url?: string;   // file:// 引用（信息性，禁止直接渲染）
    original_urls?: string[];
    saved_to_disk?: boolean; // incremental-3：生成图是否写入用户配置目录（tempfile 兜底为 false）
    width?: number;          // 原图真实像素宽（PIL im.size；缩略图不算；旧后端缺失）
    height?: number;         // 原图真实像素高
    widths?: number[];       // 多图：逐图原图宽（对应 images[]；无法解析为 null）
    heights?: number[];      // 多图：逐图原图高
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

/** 视频任务创建响应（unified_generate_video / generate_video_async）——本期仅类型预留，未接 UI */
interface BackendVideoTaskCreate {
  success?: boolean;
  task_id: string; // 本地 uuid（轮询 get_video_task_result 用）
}

/** 视频任务查询结果（unified_get_video_task_result）——本期仅类型预留，未接 UI */
interface BackendVideoTaskResult {
  status: string;            // not_found | pending | queued | processing | in_progress | pending_confirmation | done
  result?: {
    success?: boolean;
    video_url?: string;      // 本地播放地址 file:/// 绝对路径
    video_path?: string;     // 本地绝对路径（正斜杠）
    original_url?: string;   // 远端下载地址（信息性，可能过期）
    saved_to_disk?: boolean; // 未配置保存路径时 false
    task_id?: string;        // 上游任务 id（未来 /content 复用）
    width?: number | null;
    height?: number | null;
    duration?: number | null;
    size_bytes?: number | null;
    error?: string;
    error_code?: number;
    message?: string;
  };
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

/** save_assets / load_assets 返回（可变资产索引：采纳/锁定/tags/category） */
interface BackendAssetsResult {
  status: string;            // success | empty | error
  degraded?: boolean;        // incremental-3：save_assets 降级写入 fallback 目录（未配置图片保存路径）
  message?: string;          // 人话提示（降级/错误时透传，如「请先在设置中配置图片保存路径」）
  records?: ImageAssetRecord[];
}
