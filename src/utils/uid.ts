// src/utils/uid.ts
// 全局 ID 递增计数器（避免 Date.now() 毫秒碰撞）

let _idCounter = Date.now() % 1e6;

export function uid(prefix = 'id'): string {
    return `${prefix}-${++_idCounter}-${Math.random().toString(36).slice(2, 9)}`;
}

// 桥接到 window，供未迁移模块通过全局变量调用
(window as unknown as Record<string, unknown>).uid = uid;
