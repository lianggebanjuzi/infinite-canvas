// src/independent/project-manager.ts
// 项目管理器：新建 / 保存 / 另存为 / 打开

import { API } from '../utils/api';

declare const Toast: { show(message: string, duration?: number): void };
declare const HistorySidebar: { clear(): void };
declare const Storage: {
    collectCanvasData(): Record<string, unknown>;
    restoreCanvasData(data: Record<string, unknown>): void;
};

export const ProjectManager = {
    async save(): Promise<void> {
        const data = Storage.collectCanvasData();
        const result = await API.saveProject(data) as { status: string; message?: string; path?: string };
        if (result.status === 'need_save_as') {
            this.saveAs();
        } else if (result.status === 'success') {
            this.updateTitle(result.path);
            HistorySidebar.clear();
            Toast.show('保存成功');
        } else {
            Toast.show('保存失败: ' + result.message);
        }
    },

    async saveAs(): Promise<void> {
        const data = Storage.collectCanvasData();
        const result = await API.saveProjectAs(data) as { status: string; message?: string; path?: string };
        if (result.status === 'success') {
            this.updateTitle(result.path);
            HistorySidebar.clear();
            Toast.show('保存成功');
        } else if (result.status !== 'cancelled') {
            Toast.show('保存失败: ' + result.message);
        }
    },

    async open(): Promise<void> {
        const result = await API.openProject() as { status: string; message?: string; path?: string; data?: Record<string, unknown> };
        if (result.status === 'success') {
            Storage.restoreCanvasData(result.data!);
            this.updateTitle(result.path);
            Toast.show('项目已打开');
        } else if (result.status !== 'cancelled') {
            Toast.show('打开失败: ' + result.message);
        }
    },

    new(): void {
        if (!confirm('确定要新建项目吗？未保存的更改将丢失。')) return;
        Storage.restoreCanvasData({ cards: [], connections: [], canvas: {}, projectName: '未命名项目' });
        const input = document.getElementById('project-name-input') as HTMLInputElement | null;
        if (input) input.value = '未命名项目';
        Toast.show('新建项目');
    },

    updateTitle(path?: string): void {
        const input = document.getElementById('project-name-input') as HTMLInputElement | null;
        if (!input) return;
        if (path) {
            const name = path.split(/[/\\]/).pop();
            input.value = name ? name.replace(/\.icproj$/, '') : '未命名项目';
        } else {
            input.value = '未命名项目';
        }
    }
};

(window as unknown as Record<string, unknown>).ProjectManager = ProjectManager;
