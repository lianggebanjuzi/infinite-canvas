// src/state/card-state.ts
// 卡片激活、多选、上传目标等状态
export const cardState = {
    activeCardId: null as string | null,
    targetUploadCardId: null as string | null,
    multiSelected: [] as HTMLElement[]
};
