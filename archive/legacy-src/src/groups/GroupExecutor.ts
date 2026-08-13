// src/groups/GroupExecutor.ts

/**
 * 组执行引擎
 * 支持同层卡片按依赖顺序执行，不同层之间串行等待，层间可暂停/继续/停止
 *
 * 层内执行策略：
 * - 卡片按拓扑依赖顺序排列，保证"数据生产者先于消费者执行"
 * - 没有依赖的卡片并行执行，有依赖的串行等待
 * - 若同层内 A→B，则 A 一定在 B 之前执行，B 执行时可读到 A 的有效数据
 */

import { AppState } from '../state/app-state';
import type { Group } from './GroupManager';

// ── 全局声明 ──

declare const GroupManager: {
    getGroup(groupId: string): Group | null;
    getGroupCardIds?(groupId: string): string[] | undefined;
};

declare const GroupRenderer: {
    getGroupElement(groupId: string): HTMLElement | null;
    updateExecutionUI(groupId: string, opts?: Record<string, unknown>): void;
};

declare const CardFactory: {
    getInstance(id: string): CardInstance | null;
};

declare const Toast: {
    show(msg: string, dur?: number): void;
};

declare const AgentCard: {
    run(cardId: string): Promise<void>;
};

declare const AIDrawCard: {
    generate(cardId: string): Promise<void>;
};

// ── 接口 ──

interface CardInstance {
    id: string;
    getType(): string;
    bypass: boolean;
    run?(): void;
    notifyDownstream?(source?: string): void;
    [key: string]: unknown;
}

interface ExecutionState {
    paused: boolean;
    stopRequested: boolean;
    continueSignal: { resolve(): void } | null;
    currentLevelIdx: number;
}

// ─────────────────────────────────────────

export const GroupExecutor = {

    // 运行状态（按 groupId 隔离）
    _states: new Map<string, ExecutionState>(),

    /**
     * 执行整个组
     * @param groupId
     */
    async executeGroup(groupId: string): Promise<void> {
        const group = GroupManager.getGroup(groupId);
        if (!group || group.cardIds.length === 0) {
            if ((window as any).Toast) Toast.show('组内没有卡片');
            return;
        }

        const runnableCards = group.cardIds
            .map(id => CardFactory.getInstance(id))
            .filter((c): c is CardInstance => !!c && !c.bypass);

        if (runnableCards.length === 0) {
            if ((window as any).Toast) Toast.show('所有卡片均已绕过，无可执行项');
            return;
        }

        const levels = this._topologicalLevels(runnableCards, group);
        if (!levels) {
            if ((window as any).Toast) Toast.show('卡片存在循环依赖，无法执行');
            return;
        }

        // 初始化状态
        const state: ExecutionState = {
            paused:          false,
            stopRequested:   false,
            continueSignal:  null,
            currentLevelIdx: -1,
        };
        this._states.set(groupId, state);

        const groupEl = GroupRenderer.getGroupElement(groupId);
        if (groupEl) groupEl.classList.add('executing');
        GroupRenderer.updateExecutionUI(groupId, { phase: 'running', levels, state });

        for (let i = 0; i < levels.length; i++) {
            if (state.stopRequested) break;

            state.currentLevelIdx = i;
            const levelIds = levels[i];

            // 更新 UI 显示当前层
            GroupRenderer.updateExecutionUI(groupId, {
                phase: 'running',
                levels,
                state,
                levelInfo: `第 ${i + 1}/${levels.length} 层（共 ${levelIds.length} 张卡片）`
            });

            // 层内按依赖顺序执行（由 _executeLevelInOrder 保证）
            await this._executeLevelInOrder(levelIds, state, groupId);

            // 任何层跑完后立即检查暂停/停止状态，立刻刷新 UI
            if (state.stopRequested) break;

            if (state.paused && i < levels.length - 1) {
                GroupRenderer.updateExecutionUI(groupId, { phase: 'paused', level: i, total: levels.length, state });
                // 阻塞等待，直到用户点继续或停止
                await new Promise<void>(resolve => {
                    state.continueSignal = { resolve };
                });
                state.continueSignal = null;
                if (state.stopRequested) break;
                GroupRenderer.updateExecutionUI(groupId, { phase: 'running', levels, state });
            }
        }

        this._states.delete(groupId);
        if (groupEl) groupEl.classList.remove('executing');
        GroupRenderer.updateExecutionUI(groupId, { phase: 'idle' });

        if ((window as any).Toast) {
            Toast.show(state.stopRequested ? '组已停止' : '组执行完成');
        }
    },

    /** 暂停（仅在层间生效） */
    pauseGroup(groupId: string): void {
        const state = this._states.get(groupId);
        if (state && !state.paused) {
            state.paused = true;
        }
    },

    /** 强制停止整个组的运行 */
    stopGroup(groupId: string): void {
        const state = this._states.get(groupId);
        if (state && !state.stopRequested) {
            state.stopRequested = true;
            // 若正好卡在暂停等待，立即解除阻塞
            if (state.continueSignal) {
                state.continueSignal.resolve();
            }
        }
        // 停止所有 AI 卡的进行中请求
        AppState.ai.generatingCards.forEach((genState: any, cardId: string) => {
            if (GroupManager.getGroupCardIds?.(groupId)?.includes(cardId)) {
                genState.aborted = true;
            }
        });
    },

    /** 查询指定组当前是否正在运行 */
    isRunning(groupId: string): boolean {
        return this._states.has(groupId);
    },

    /** 查询指定组当前是否暂停 */
    isPaused(groupId: string): boolean {
        const state = this._states.get(groupId);
        return state ? state.paused : false;
    },

    // ─────────────────────────────────────────
    // 单卡执行
    // ─────────────────────────────────────────
    async _executeCard(instance: CardInstance): Promise<void> {
        const cardId   = instance.id;
        const cardType = instance.getType();

        switch (cardType) {
            case 'agent':     return AgentCard.run(cardId);
            case 'ai-image': return AIDrawCard.generate(cardId);
            default:
                return instance.notifyDownstream?.('run');
        }
    },

    _setCardExecuting(cardId: string, on: boolean): void {
        const el = document.getElementById(cardId);
        if (!el) return;
        el.classList.toggle('executing', on);
        el.classList.remove('executed', 'exec-error');
    },

    _setCardExecuted(cardId: string): void {
        const el = document.getElementById(cardId);
        if (!el) return;
        el.classList.remove('executing', 'exec-error');
        el.classList.add('executed');
        setTimeout(() => el.classList.remove('executed'), 1800);
    },

    _setCardError(cardId: string): void {
        const el = document.getElementById(cardId);
        if (!el) return;
        el.classList.remove('executing', 'executed');
        el.classList.add('exec-error');
    },

    // ─────────────────────────────────────────
    // 层内执行：按依赖顺序保证"数据生产者先于消费者执行"
    // ─────────────────────────────────────────

    /**
     * 判断某张卡片在当前层中的所有上游依赖是否也都落在同一层。
     * 如果是，则需要等上游先执行完再读数据。
     * @param cardId - 待检查的卡片 ID
     * @param levelIds - 当前层的所有卡片 ID
     * @param completedIds - 当前层内已执行完毕的卡片 ID
     * @returns true = 全部上游同层且都已完成
     */
    _allUpstreamReadyInLevel(cardId: string, levelIds: string[], completedIds: Set<string>): boolean {
        const levelSet = new Set(levelIds);
        const connections = AppState.connections.list
            .filter(c => c.end === cardId && levelSet.has(c.start));
        if (connections.length === 0) return true;
        return connections.every(c => completedIds.has(c.start));
    },

    /**
     * 判断某张卡片是否有上游（检查同层内是否有连线指向它）
     * @param cardId
     * @param levelIds
     */
    _hasUpstreamInLevel(cardId: string, levelIds: string[]): boolean {
        const levelSet = new Set(levelIds);
        return AppState.connections.list.some(
            c => c.end === cardId && levelSet.has(c.start)
        );
    },

    /**
     * 当前层的无上游卡片集合（可并行执行的最早批次）
     * @param levelIds
     */
    _seedLevelBatch(levelIds: string[]): string[] {
        return levelIds.filter(id => !this._hasUpstreamInLevel(id, levelIds));
    },

    /**
     * 层内拓扑排序执行
     * 核心规则：
     * 1. 先找出所有没有上游的卡片（可立即执行）
     * 2. 每轮并行执行当前批次
     * 3. 每批完成后，把以本批为唯一剩余前置的卡片加入下一批
     * 4. 循环直到本层全部执行完毕
     *
     * 这样保证：若 A→B（同一层内），则 A 一定先于 B 执行，
     * B 执行时一定能读到 A 产生的有效数据。
     *
     * @param levelIds - 当前层的卡片 ID 列表
     * @param state - 执行状态（stopRequested 等）
     * @param groupId
     */
    async _executeLevelInOrder(levelIds: string[], state: ExecutionState, groupId: string): Promise<void> {
        const remaining = new Set(levelIds);
        const completed = new Set<string>();

        // 种子批次：没有上游依赖的卡片立即执行
        let batch = levelIds.filter(id => !this._hasUpstreamInLevel(id, levelIds));

        while (batch.length > 0) {
            if (state.stopRequested) return;

            // 标记本批卡片为执行中
            batch.forEach(id => this._setCardExecuting(id, true));

            // 并行执行本批（所有卡片互不依赖）
            try {
                const instances = batch
                    .map(id => CardFactory.getInstance(id))
                    .filter((c): c is CardInstance => !!c);
                await Promise.all(instances.map(inst => this._executeCard(inst)));
                batch.forEach(id => this._setCardExecuted(id));
            } catch (err) {
                console.error('[GroupExecutor] 层执行异常:', err);
                batch.forEach(id => this._setCardError(id));
                return;
            } finally {
                batch.forEach(id => {
                    this._setCardExecuting(id, false);
                    remaining.delete(id);
                    completed.add(id);
                });
            }

            if (state.stopRequested) return;

            // 找出下一批：上游全部在 completed 中的卡片
            batch = [];
            remaining.forEach(id => {
                if (this._allUpstreamReadyInLevel(id, levelIds, completed)) {
                    batch.push(id);
                }
            });
        }

        // 检查是否有循环（remaining 不为空表示图有环）
        if (remaining.size > 0) {
            console.error('[GroupExecutor] 层内存在循环依赖:', [...remaining]);
            remaining.forEach(id => this._setCardError(id));
            if ((window as any).Toast) Toast.show('层内存在循环依赖');
        }
    },

    // ─────────────────────────────────────────
    // Kahn 拓扑分层
    // ─────────────────────────────────────────
    _topologicalLevels(cards: CardInstance[], group: Group): string[][] | null {
        const cardIdSet = new Set(cards.map(c => c.id));
        const graph    = new Map<string, string[]>();
        const inDegree = new Map<string, number>();

        cards.forEach(c => {
            graph.set(c.id, []);
            inDegree.set(c.id, 0);
        });

        AppState.connections.list.forEach(({ start, end }) => {
            if (!cardIdSet.has(start) || !cardIdSet.has(end)) return;
            graph.get(start)!.push(end);
            inDegree.set(end, (inDegree.get(end) || 0) + 1);
        });

        const levels: string[][] = [];
        while (true) {
            const batch: string[] = [];
            for (const [id, degree] of inDegree) {
                if (degree === 0) batch.push(id);
            }
            if (!batch.length) break;
            levels.push(batch);
            batch.forEach(id => inDegree.delete(id));
            batch.forEach(id => {
                for (const nxt of (graph.get(id) || [])) {
                    const d = (inDegree.get(nxt) || 1) - 1;
                    inDegree.set(nxt, d);
                }
            });
        }

        return inDegree.size > 0 ? null : levels;
    }
};

(window as unknown as Record<string, unknown>).GroupExecutor = GroupExecutor;
