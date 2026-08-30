// src/utils/api.ts
// 封装所有对 Python 后端（pywebview.api）的调用

interface APIResponse {
  success: boolean;
  message?: string;
  error_code?: number;
  result?: unknown;
  [key: string]: unknown;
}

const ERROR_MESSAGES: Record<number, string> = {
    401: 'API 密钥无效或已过期，请检查设置',
    402: '额度不足，请检查账户余额',
    422: '当前模型不支持此操作',
    429: '请求过于频繁，请稍后再试',
    500: '发生了未知错误，请重试',
    502: 'AI 服务返回了无效响应，请稍后重试',
    503: 'AI 服务暂时不可用，请稍后重试',
    504: 'AI 服务响应超时，请检查网络后重试'
};

function handleAPIError(response: APIResponse, fallbackMsg = '操作失败，请重试'): unknown {
    if (response && response.success === false) {
        const msg = ERROR_MESSAGES[response.error_code as number]
            || response.message
            || (response as Record<string, unknown>).error as string
            || fallbackMsg;
        Toast.show(msg, 3000);
        return response;
    }
    return response && response.result !== undefined ? response.result : response;
}

declare const Toast: { show(message: string, duration?: number): void };

declare const pywebview: {
  api: {
    load_providers(): Promise<{ providers: unknown[] }>;
    add_provider(name: string, type: string, short_name?: string): Promise<{ status: string; id?: string }>;
    update_provider(provider_id: string, updates: Record<string, unknown>): Promise<{ status: string }>;
    delete_provider(provider_id: string): Promise<{ status: string }>;
    add_key(provider_id: string, key_name?: string): Promise<{ status: string; key_id?: string; key?: unknown; keys?: unknown[]; message?: string }>;
    delete_key(provider_id: string, key_id: string): Promise<{ status: string; keys?: unknown[]; message?: string }>;
    update_key(provider_id: string, key_id: string, updates: Record<string, unknown>): Promise<{ status: string; key?: unknown; keys?: unknown[]; message?: string }>;
    fetch_models(api_url: string, api_key: string): Promise<{ models?: unknown[] }>;
    test_api_connection(api_url: string, api_key: string): Promise<{ success: boolean; message: string }>;
    add_chat_model(provider_id: string, key_id?: string, model_id?: string, model_name?: string): Promise<{ status: string; message?: string }>;
    remove_model(provider_id: string, key_id: string, model_id: string): Promise<{ status: string; message?: string }>;
    generate_image(prompt: string, config?: Record<string, unknown>): Promise<{ task_id: string }>;
    generate_image_async(prompt: string, config?: Record<string, unknown>): Promise<{ task_id: string }>;
    get_task_result(task_id: string): Promise<{ status: string; result?: unknown }>;
    unified_generate_image(prompt: string, options?: Record<string, unknown>): Promise<{ task_id: string }>;
    unified_edit_image(prompt: string, options?: Record<string, unknown>): Promise<{ task_id: string }>;
    unified_generate_image_sync(prompt: string, options?: Record<string, unknown>): Promise<{ url?: string; base64?: string }>;
    unified_get_task_result(task_id: string): Promise<{ status: string; result?: unknown }>;
    unified_generate_video(prompt: string, options?: Record<string, unknown>): Promise<{ task_id: string }>;
    unified_get_video_task_result(task_id: string): Promise<{ status: string; result?: unknown; remote_task_id?: string }>;
    unified_generate_audio(prompt: string, options?: Record<string, unknown>): Promise<{ task_id: string }>;
    unified_get_audio_task_result(task_id: string): Promise<{ status: string; result?: unknown; remote_task_id?: string }>;
    agent_chat(meta_prompt: string, user_input: string, config?: Record<string, unknown>): Promise<{ content?: string; reply?: string; text?: string }>;
    unified_chat(messages: Array<{ role: string; content: string }>, options?: Record<string, unknown>): Promise<{ content?: string; reply?: string; text?: string }>;
    unified_chat_v2(user_input: string, options?: Record<string, unknown>): Promise<{ content?: string; reply?: string; text?: string }>;
    save_image_to_local(image_data: unknown, filename?: string): Promise<{ path?: string }>;
    prepare_imported_image(image_data: string, filename?: string): Promise<{ status: string; path?: string; url?: string; thumbnail_data_url?: string; saved_to_disk?: boolean; message?: string }>;
    prepare_imported_media(options?: Record<string, unknown>): Promise<{ status: string; path?: string; url?: string; duration?: number; mime_type?: string; size_bytes?: number; message?: string }>;
    save_image_as(image_data: unknown, filename?: string): Promise<{ path?: string }>;
    load_local_image(file_path: string): Promise<{ status: string; data_url?: string; message?: string }>;
    delete_temp_file(file_path: string): Promise<{ status: string; message?: string }>;
    outpaint(image_base64: string, direction: string, ratio: string, prompt: string, provider_id: string, model_id?: string, resolution?: string, user_mask?: unknown): Promise<{ url?: string }>;
    copy_to_clipboard(canvas_data: unknown): Promise<{ status: string }>;
    paste_from_clipboard(): Promise<{ cards?: unknown[]; connections?: unknown[] }>;
    save_project(data: unknown, path?: string): Promise<{ status: string }>;
    save_project_as(data: unknown): Promise<{ data?: unknown; filename?: string; filepath?: string }>;
    open_project_dialog(): Promise<{ data?: unknown; filename?: string; filepath?: string }>;
    load_workflows(): Promise<{ status: string; workflows?: unknown[]; message?: string }>;
    save_workflows(workflows: unknown[]): Promise<{ status: string; message?: string }>;
    load_project(file_path: string): Promise<{ data?: unknown }>;
    get_current_project_path(): Promise<{ path?: string }>;
    reveal_project_in_folder(file_path: string): Promise<{ status: string; message?: string }>;
    append_history(entry: unknown): Promise<{ status: string; message?: string }>;
    load_history(): Promise<{ status: string; message?: string; entries?: unknown[] }>;
    save_assets(data: unknown): Promise<{ status: string; message?: string }>;
    load_assets(): Promise<{ status: string; message?: string; records?: unknown[] }>;
    preview_backup(options?: Record<string, unknown>): Promise<{ status: string; projects?: number; assets?: number; estimated_bytes?: number; threshold_bytes?: number; requires_media_choice?: boolean; message?: string }>;
    export_backup(options?: Record<string, unknown>): Promise<{ status: string; path?: string; manifest?: unknown; message?: string }>;
    import_backup(options?: Record<string, unknown>): Promise<{ status: string; projects?: string[]; message?: string }>;
    export_bundle(options?: Record<string, unknown>): Promise<{ status: string; path?: string; manifest?: unknown; message?: string }>;
    import_bundle(options?: Record<string, unknown>): Promise<{ status: string; strategy?: string; projectPath?: string; data?: unknown; assets?: string[]; message?: string }>;
    load_settings(): Promise<Record<string, unknown>>;
    save_settings(settings: Record<string, unknown>): Promise<{ status: string }>;
    select_folder(): Promise<{ path?: string }>;
    load_recent_projects(): Promise<{ status: string; projects?: unknown[]; message?: string }>;
    touch_recent_project(path: string, name?: string, cover_path?: string): Promise<{ status: string; message?: string }>;
    remove_recent_project(path: string): Promise<{ status: string; message?: string }>;
    rename_recent_project(path: string, name: string): Promise<{ status: string; message?: string }>;
    check_recent_project_path(path: string): Promise<{ status: string; exists?: boolean; message?: string }>;
    load_prompts_library(): Promise<Record<string, unknown>>;
    save_prompts_library(data: unknown): Promise<{ status: string }>;
    save_prompt_cover(data_url: string, filename?: string): Promise<{ status: string; path?: string; message?: string }>;
    director_open(options?: Record<string, unknown>): Promise<{ status: string; message?: string }>;
    capability_load_schemas(): Promise<{ status: string; schemas?: unknown[]; message?: string }>;
    capability_save_schema(schema: Record<string, unknown>): Promise<{ status: string; message?: string }>;
    capability_delete_schema(model_id: string): Promise<{ status: string; message?: string }>;
    capability_test_adapter(model_id: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
};

export const API = {
    handleAPIError,
    ERROR_MESSAGES,

    async loadProviders() {
        return await pywebview.api.load_providers();
    },

    async addProvider(name: string, type: string, shortName = '') {
        return await pywebview.api.add_provider(name, type, shortName);
    },

    async addKey(providerId: string, keyName = '') {
        return await pywebview.api.add_key(providerId, keyName);
    },

    async deleteKey(providerId: string, keyId: string) {
        return await pywebview.api.delete_key(providerId, keyId);
    },

    async updateKey(providerId: string, keyId: string, updates: Record<string, unknown>) {
        return await pywebview.api.update_key(providerId, keyId, updates);
    },

    async updateProvider(providerId: string, updates: Record<string, unknown>) {
        return await pywebview.api.update_provider(providerId, updates);
    },

    async deleteProvider(providerId: string) {
        return await pywebview.api.delete_provider(providerId);
    },

    async testConnection(apiUrl: string, apiKey: string) {
        return await pywebview.api.test_api_connection(apiUrl, apiKey);
    },

    async fetchModels(apiUrl: string, apiKey: string) {
        return await pywebview.api.fetch_models(apiUrl, apiKey);
    },

    async addChatModel(providerId: string, keyId: string, modelId: string, modelName: string) {
        return await pywebview.api.add_chat_model(providerId, keyId, modelId, modelName);
    },

    async removeModel(providerId: string, keyId: string, modelId: string) {
        return await pywebview.api.remove_model(providerId, keyId, modelId);
    },

    async generateImageV2(prompt: string, options?: Record<string, unknown>) {
        return await pywebview.api.unified_generate_image(prompt, options);
    },

    async generateImageV2Sync(prompt: string, options?: Record<string, unknown>) {
        return await pywebview.api.unified_generate_image_sync(prompt, options);
    },

    async getTaskResult(taskId: string) {
        return await pywebview.api.get_task_result(taskId);
    },

    async agentChatV2(userInput: string, options?: Record<string, unknown>) {
        return await pywebview.api.unified_chat_v2(userInput, options);
    },

    async unifiedChat(messages: Array<{ role: string; content: string }>, options?: Record<string, unknown>) {
        return await pywebview.api.unified_chat(messages, options);
    },

    async loadPromptsLibrary() {
        return await pywebview.api.load_prompts_library();
    },

    async directorOpen(options?: Record<string, unknown>) {
        return await pywebview.api.director_open(options);
    },

    async savePromptsLibrary(data: unknown) {
        return await pywebview.api.save_prompts_library(data);
    },

    async savePromptCover(dataUrl: string, filename = 'cover') {
        return await pywebview.api.save_prompt_cover(dataUrl, filename);
    },

    async saveImageToLocal(imgUrl: string) {
        return await pywebview.api.save_image_to_local(imgUrl);
    },

    async prepareImportedImage(imageData: string, filename?: string) {
        return await pywebview.api.prepare_imported_image(imageData, filename);
    },

    async prepareImportedMedia(options?: Record<string, unknown>) {
        return await pywebview.api.prepare_imported_media(options);
    },

    async saveImageAs(imageData: unknown, filename?: string) {
        return await pywebview.api.save_image_as(imageData, filename);
    },

    async loadLocalImage(filePath: string) {
        return await pywebview.api.load_local_image(filePath);
    },

    async deleteTempFile(filePath: string) {
        return await pywebview.api.delete_temp_file(filePath);
    },

    async outpaint(imageBase64: string, direction: string, ratio: string, prompt: string, providerId: string, modelId?: string, resolution?: string, maskData?: unknown) {
        return await pywebview.api.outpaint(imageBase64, direction, ratio, prompt, providerId, modelId, resolution, maskData);
    },

    async copyToClipboard(data: unknown) {
        return await pywebview.api.copy_to_clipboard(data);
    },

    async pasteFromClipboard() {
        return await pywebview.api.paste_from_clipboard();
    },

    async saveProject(data: unknown) {
        return await pywebview.api.save_project(data);
    },

    async saveProjectAs(data: unknown) {
        return await pywebview.api.save_project_as(data);
    },

    async openProject() {
        return await pywebview.api.open_project_dialog();
    },

    async loadWorkflows() {
        return await pywebview.api.load_workflows();
    },

    async saveWorkflows(workflows: unknown[]) {
        return await pywebview.api.save_workflows(workflows);
    },

    async loadProject(filePath: string) {
        return await pywebview.api.load_project(filePath);
    },

    async getCurrentProjectPath() {
        return await pywebview.api.get_current_project_path();
    },

    async revealProjectInFolder(filePath: string) { return await pywebview.api.reveal_project_in_folder(filePath); },

    async appendHistory(entry: unknown) {
        return await pywebview.api.append_history(entry);
    },

    async loadHistory() {
        return await pywebview.api.load_history();
    },

    async saveAssets(data: unknown) {
        return await pywebview.api.save_assets(data);
    },

    async loadAssets() {
        return await pywebview.api.load_assets();
    },

    async previewBackup(options?: Record<string, unknown>) { return await pywebview.api.preview_backup(options); },
    async exportBackup(options?: Record<string, unknown>) { return await pywebview.api.export_backup(options); },
    async importBackup(options?: Record<string, unknown>) { return await pywebview.api.import_backup(options); },

    async exportBundle(options?: Record<string, unknown>) { return await pywebview.api.export_bundle(options); },
    async importBundle(options?: Record<string, unknown>) { return await pywebview.api.import_bundle(options); },

    async loadSettings() {
        return await pywebview.api.load_settings();
    },

    async saveSettings(settings: Record<string, unknown>) {
        return await pywebview.api.save_settings(settings);
    },

    async selectFolder() {
        return await pywebview.api.select_folder();
    },

    async loadRecentProjects() { return await pywebview.api.load_recent_projects(); },
    async touchRecentProject(path: string, name = '', coverPath?: string) { return await pywebview.api.touch_recent_project(path, name, coverPath); },
    async removeRecentProject(path: string) { return await pywebview.api.remove_recent_project(path); },
    async renameRecentProject(path: string, name: string) { return await pywebview.api.rename_recent_project(path, name); },
    async checkRecentProjectPath(path: string) { return await pywebview.api.check_recent_project_path(path); },

    async unifiedChatV2(userInput: string, options?: Record<string, unknown>) {
        return await pywebview.api.unified_chat_v2(userInput, options);
    },

    async unifiedGenerateImage(prompt: string, options?: Record<string, unknown>) {
        return await pywebview.api.unified_generate_image(prompt, options);
    },

    async unifiedEditImage(prompt: string, options?: Record<string, unknown>) {
        return await pywebview.api.unified_edit_image(prompt, options);
    },

    async unifiedGenerateImageSync(prompt: string, options?: Record<string, unknown>) {
        return await pywebview.api.unified_generate_image_sync(prompt, options);
    },

    async unifiedGetTaskResult(taskId: string) {
        return await pywebview.api.unified_get_task_result(taskId);
    },

    async unifiedGenerateVideo(prompt: string, options?: Record<string, unknown>) {
        return await pywebview.api.unified_generate_video(prompt, options);
    },

    async unifiedGetVideoTaskResult(taskId: string) {
        return await pywebview.api.unified_get_video_task_result(taskId);
    },

    async unifiedGenerateAudio(prompt: string, options?: Record<string, unknown>) {
        return await pywebview.api.unified_generate_audio(prompt, options);
    },

    async unifiedGetAudioTaskResult(taskId: string) {
        return await pywebview.api.unified_get_audio_task_result(taskId);
    },

    // ── 4.3-D 模型能力 schema（capability_* 前缀） ──
    async loadCapabilitySchemas() {
        return await pywebview.api.capability_load_schemas();
    },

    async saveCapabilitySchema(schema: Record<string, unknown>) {
        return await pywebview.api.capability_save_schema(schema);
    },

    async deleteCapabilitySchema(modelId: string) {
        return await pywebview.api.capability_delete_schema(modelId);
    },

    async testCustomAdapter(modelId: string, options?: Record<string, unknown>) {
        return await pywebview.api.capability_test_adapter(modelId, options);
    }
};

(window as unknown as { API: typeof API }).API = API;
