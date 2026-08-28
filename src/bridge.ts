// src/bridge.ts — ICV v1 模块桥接
// 将 v1 核心单例暴露到 window.ICV，便于调试与旧模式兼容
// 旧卡片/分组等模块不再桥接（已从 import 链移除，文件保留）

import { flowState } from './v1/state/flow-state';
import { selection } from './v1/state/selection';
import { dirty } from './v1/state/dirty';
import { nodeRegistry } from './v1/nodes/node-registry';
import { runEngine } from './v1/engine/run-engine';
import { persistence } from './v1/persistence';
import { Backend } from './v1/api';
import { showToast } from './v1/ui/toast';
import { assetStore } from './v1/asset-store';
import { comparePanel } from './v1/ui/compare-panel';

const w = window as unknown as Record<string, unknown>;

w.ICV = {
  flowState,
  selection,
  dirty,
  nodeRegistry,
  runEngine,
  persistence,
  Backend,
  showToast,
  assetStore,
  comparePanel,
};
