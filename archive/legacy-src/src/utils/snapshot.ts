// src/utils/snapshot.ts
// 快照工具：收集快照时 base64 占位、恢复时还原

export const SnapshotUtils = {

    sanitizeContent(content: string): string {
        if (content?.startsWith('data:image')) {
            return '__base64_pending__';
        }
        return content;
    },

    restoreContent(content: string): string {
        if (content === '__base64_pending__') {
            return '';
        }
        return content || '';
    }
};

(window as unknown as { SnapshotUtils: typeof SnapshotUtils }).SnapshotUtils = SnapshotUtils;
