// src/state/app-state.ts
// AppState 聚合对象（独立文件，避免循环 import）
// 每个子状态模块只负责初始化自己的那部分，聚合在这里完成

import { canvasState } from './canvas-state';
import { cardState } from './card-state';
import { connectionState } from './connection-state';
import { groupState } from './group-state';
import { providersState } from './providers-state';
import {
    selectionState,
    laserState,
    historyState,
    aiState,
    performanceState
} from './ui-state';

export const AppState = {
    canvas: canvasState,
    cards: cardState,
    connections: connectionState,
    groups: groupState,
    providers: providersState,
    selection: selectionState,
    laser: laserState,
    history: historyState,
    ai: aiState,
    performance: performanceState,
};

// 桥接到 window，保持与旧 JS 代码的兼容性
(window as unknown as { AppState: typeof AppState }).AppState = AppState;
