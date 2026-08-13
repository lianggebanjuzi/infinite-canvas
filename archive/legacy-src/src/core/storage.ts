// src/core/storage.ts
// 项目文件存储层

import { SnapshotCollector, type SnapshotData } from './snapshot';
import { History } from './history';
import { AppState } from '../state/app-state';

declare const CmdManager: { clear(): void };

export const Storage = {

    collectCanvasData(): Record<string, unknown> {
        const input = document.getElementById('project-name-input') as HTMLInputElement | null;
        const projectName = input?.value?.trim() || '未命名项目';

        const snapshot = SnapshotCollector.collect({
            sanitizeBase64: false,
            includeCanvas: true
        });

        return {
            version: '2.0',
            projectName,
            ...snapshot
        };
    },

    restoreCanvasData(data: Record<string, unknown>): void {
        const input = document.getElementById('project-name-input') as HTMLInputElement | null;
        const savedProjectName = data['projectName'] as string | undefined;
        const savedCanvas = data['canvas'] as { scale: number; panX: number; panY: number } | undefined;

        SnapshotCollector.restore(data as unknown as SnapshotData, {
            restoreBase64: true,
            clearCanvas: true,
            onComplete: () => {
                if (input && savedProjectName) {
                    input.value = savedProjectName;
                } else if (input) {
                    input.value = '未命名项目';
                }

                History.clear();
                CmdManager?.clear();
            }
        });
    }
};

(window as unknown as { Storage: typeof Storage }).Storage = Storage;
