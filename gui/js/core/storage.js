// js/core/storage.js
const Storage = {

    collectCanvasData() {
        const input = document.getElementById('project-name-input');
        const projectName = input?.value?.trim() || '未命名项目';

        const snapshot = SnapshotCollector.collect({
            sanitizeBase64: false,  // 项目保存：保留 base64
            includeCanvas: true
        });

        return {
            version:      '2.0',
            projectName,
            ...snapshot
        };
    },

    restoreCanvasData(data) {
        const input = document.getElementById('project-name-input');
        const savedProjectName = data.projectName;
        const savedCanvas = data.canvas;

        SnapshotCollector.restore(data, {
            restoreBase64: true,
            clearCanvas: true,
            onComplete: () => {
                if (input && savedProjectName) {
                    input.value = savedProjectName;
                } else if (input) {
                    input.value = '未命名项目';
                }

                History.clear();
                if (window.CmdManager) CmdManager.clear();
            }
        });
    }
};

window.Storage = Storage;
