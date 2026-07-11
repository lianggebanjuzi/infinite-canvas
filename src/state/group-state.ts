// src/state/group-state.ts
// 组实例列表、激活状态、框选状态
export const groupState = {
    list: [] as Array<{
        id: string;
        name: string;
        cardIds: string[];
        bounds: { x: number; y: number; width: number; height: number };
        colorIndex?: number;
        pinnedInputs?: unknown[];
        pinnedOutputs?: unknown[];
        [key: string]: unknown;
    }>,
    activeGroupId: null as string | null,
    isSelecting: false,
    tempBounds: null as { x: number; y: number; width: number; height: number } | null
};
