// src/state/connection-state.ts
// 连线列表、拖拽状态等连接相关状态
export const connectionState = {
    list: [] as Array<{
        id: string;
        start: string;
        end: string;
        endPort?: string | null;
        element?: SVGPathElement;
        isGroupPin?: boolean;
        groupId?: string;
        pinDirection?: string;
        pinId?: string;
    }>,
    isConnecting: false,
    tempLine: null as SVGPathElement | null,
    startPort: null as { cardId: string; portRole: string; x: number; y: number } | null,
    pendingConnection: null as {
        cardId: string;
        portRole: string;
        x: number;
        y: number;
        startPortInfo?: { x: number; y: number; cardId: string; portRole: string };
    } | null
};
