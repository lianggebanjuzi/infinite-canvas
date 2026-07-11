/**
 * pywebview.api 运行时注入类型声明
 * 所有方法由 Python 后端 InfiniteCanvasAPI 提供
 */

// ─── 通用类型 ───
export interface APIResult<T = unknown> {
  status?: string;
  success?: boolean;
  message?: string;
  error?: string;
  error_code?: number;
  result?: T;
}

export interface ProviderData {
  id: string;
  name: string;
  type: string;
  short_name: string;
  enabled: boolean;
  api_key?: string;
  api_url?: string;
  use_proxy?: boolean;
  models?: ModelData[];
}

export interface ModelData {
  id: string;
  name: string;
  category?: string;
  type?: string;
  enabled?: boolean;
}

export interface TaskResult {
  status: string;
  result?: unknown;
}

export interface ImageGenResult {
  url?: string;
  base64?: string;
}

export interface ChatResult {
  content?: string;
  reply?: string;
  text?: string;
}

export interface ProjectResult {
  data?: unknown;
  filename?: string;
  filepath?: string;
}

export interface ClipboardData {
  cards?: unknown[];
  connections?: unknown[];
}

export interface PywebviewAPI {
  load_providers(): Promise<{ providers: ProviderData[] }>;
  add_provider(name: string, provider_type: string, short_name?: string): Promise<{ status: string; id?: string }>;
  update_provider(provider_id: string, updates: Record<string, unknown>): Promise<{ status: string }>;
  delete_provider(provider_id: string): Promise<{ status: string }>;
  fetch_models(api_url: string, api_key: string): Promise<{ models?: ModelData[] }>;
  test_api_connection(api_url: string, api_key: string): Promise<{ success: boolean; message: string }>;
  add_chat_model(provider_id: string, model_id: string, model_name: string): Promise<{ status: string }>;
  remove_model(provider_id: string, model_id: string): Promise<{ status: string }>;
  generate_image(prompt: string, config?: Record<string, unknown>): Promise<{ task_id: string }>;
  generate_image_async(prompt: string, config?: Record<string, unknown>): Promise<{ task_id: string }>;
  get_task_result(task_id: string): Promise<TaskResult>;
  unified_generate_image(prompt: string, options?: Record<string, unknown>): Promise<{ task_id: string }>;
  unified_generate_image_sync(prompt: string, options?: Record<string, unknown>): Promise<ImageGenResult>;
  unified_get_task_result(task_id: string): Promise<TaskResult>;
  agent_chat(meta_prompt: string, user_input: string, config?: Record<string, unknown>): Promise<ChatResult>;
  unified_chat(messages: Array<{ role: string; content: string }>, options?: Record<string, unknown>): Promise<ChatResult>;
  unified_chat_v2(user_input: string, options?: Record<string, unknown>): Promise<ChatResult>;
  save_image_to_local(image_data: unknown, filename?: string): Promise<{ path?: string }>;
  save_image_as(image_data: unknown, filename?: string): Promise<{ path?: string }>;
  load_local_image(file_path: string): Promise<{ base64?: string }>;
  outpaint(
    image_base64: string, direction: string, ratio: string, prompt: string,
    provider_id: string, model_id?: string, resolution?: string, user_mask?: unknown
  ): Promise<{ url?: string }>;
  copy_to_clipboard(canvas_data: unknown): Promise<{ status: string }>;
  paste_from_clipboard(): Promise<ClipboardData>;
  save_project(data: unknown, path?: string): Promise<{ status: string }>;
  save_project_as(data: unknown): Promise<ProjectResult>;
  open_project_dialog(): Promise<ProjectResult>;
  load_project(file_path: string): Promise<{ data?: unknown }>;
  get_current_project_path(): Promise<{ path?: string }>;
  load_settings(): Promise<Record<string, unknown>>;
  save_settings(settings: Record<string, unknown>): Promise<{ status: string }>;
  select_folder(): Promise<{ path?: string }>;
  load_prompts_library(): Promise<Record<string, unknown>>;
  save_prompts_library(data: unknown): Promise<{ status: string }>;
}

declare global {
  interface Window {
    pywebview: {
      api: PywebviewAPI;
    };
  }
}
