// ICV v1 QA 独立复核：everHadNodes 语义闭环（严过关 / Edward 独立编写，不复用工程师测试结构）
// 目标：验证 "创建模板→删空→再删空" 与 "首启" 对比，确认引导卡只在首次启动空画布出现；
//       补充工程师测试未直接覆盖的 persistence.restore() 0 节点项目路径。
//
// 用法：先 npx tsc -p tsconfig.smoke.json 编译 src/v1 到 G:/tmp/icv-test，再 node scripts/icv-qa-everhadnodes-test.js

/* eslint-disable no-console */
const path = require('path');

// ── 浏览器全局桩（独立编写，与既有脚本同构但自建元素桩） ──
global.window = {};

function makeClassListEl() {
  const el = { _classes: new Set() };
  el.classList = {
    add(c) { el._classes.add(c); },
    remove(c) { el._classes.delete(c); },
    toggle(c, force) {
      if (force === undefined) {
        if (el._classes.has(c)) { el._classes.delete(c); return false; }
        el._classes.add(c); return true;
      }
      if (force) el._classes.add(c); else el._classes.delete(c);
      return force;
    },
  };
  return el;
}

const emptyEl = makeClassListEl();

global.document = {
  getElementById: id => (id === 'empty-state' ? emptyEl : null),
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, setAttribute() {}, removeAttribute() {} }),
  createElementNS: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, appendChild() {}, remove() {} }),
  addEventListener: () => {},
  documentElement: { setAttribute() {}, getAttribute: () => 'light' },
  body: { appendChild() {} },
};
global.localStorage = {
  _s: {},
  getItem(k) { return this._s[k] ?? null; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; },
};
global.Image = class { set src(v) { this._src = v; } get src() { return this._src; } };
global.confirm = () => true;
global.requestAnimationFrame = cb => setTimeout(cb, 0);

const base = 'G:/tmp/icv-test';
const load = m => require(path.join(base, m));

const { flowState, FlowState } = load('v1/state/flow-state.js');
const { emptyState } = load('v1/ui/empty-state.js');
const { createDefaultProject } = load('v1/templates.js');
const { persistence } = load('v1/persistence.js');
load('v1/nodes/product-image.js');
load('v1/nodes/style-transfer.js');

let pass = 0, fail = 0;
const assert = (cond, msg) => {
  if (!cond) { fail++; console.error('✗ FAIL:', msg); }
  else { pass++; console.log('✓ PASS:', msg); }
};
const cardShown = () => emptyEl._classes.has('show');

function resetToFirstLaunch() {
  flowState.nodes = [];
  flowState.edges = [];
  flowState.selectedIds.clear();
  flowState.everHadNodes = false;
}

emptyState.init();

// ═══════ 1. 首启基线：空画布 + everHadNodes=false → 引导卡显示 ═══════
{
  resetToFirstLaunch();
  emptyState._sync();
  assert(cardShown(), '首启空画布 → 引导卡显示');
  assert(flowState.everHadNodes === false, '首启 everHadNodes=false（语义锚点）');
}

// ═══════ 2. 创建默认模板 → 删空 → 再删空 → 始终不弹卡 ═══════
{
  resetToFirstLaunch();
  flowState.replaceAll(createDefaultProject());
  assert(flowState.everHadNodes === true, '创建模板 → everHadNodes=true');

  // 第一次删空（真实节点逐个删除）
  flowState.nodes.map(n => n.id).forEach(id => flowState.removeNode(id));
  emptyState._sync();
  assert(flowState.nodes.length === 0, '第一次删空后 nodes.length=0');
  assert(!cardShown(), '创建模板后第一次删空 → 不弹卡');

  // 再删空：画布已空、无选中时再次按 Delete（removeNode 无效 id 早退路径）
  const before = flowState.everHadNodes;
  flowState.removeNode('nonexistent-id');
  flowState.notify();
  assert(flowState.everHadNodes === before, '空画布再次删除（无效 id）→ everHadNodes 不被改写');
  assert(!cardShown(), '再删空（重复 Delete）→ 仍不弹卡');
}

// ═══════ 3. 关键回归：首启 addNode → 删空 → 再 addNode → 再删空（多次往返） ═══════
{
  resetToFirstLaunch();
  emptyState._sync();
  assert(cardShown(), '前置：首启引导卡显示');

  for (let round = 0; round < 2; round++) {
    const n = flowState.addNode('product-image', 10, 10);
    emptyState._sync();
    assert(!cardShown(), `往返 ${round + 1}: 有节点时引导卡隐藏`);
    flowState.removeNode(n.id);
    emptyState._sync();
    assert(!cardShown(), `往返 ${round + 1}: 删空后引导卡保持隐藏（everHadNodes=true）`);
  }
  assert(flowState.everHadNodes === true, '多次往返后 everHadNodes 单调保持 true（语义闭环）');
}

// ═══════ 4. persistence.restore() 打开 0 节点空项目 → 不弹卡（restore 实际路径） ═══════
{
  resetToFirstLaunch();
  const emptyProjJson = JSON.stringify({
    format: 'icv',
    version: '3.0',
    projectName: '空项目',
    canvas: { scale: 1, panX: 60, panY: 40 },
    nodes: [],
    edges: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  assert(persistence.restore(JSON.parse(emptyProjJson)) === true, 'restore 打开 0 节点空项目成功');
  assert(flowState.nodes.length === 0, '空项目 restore 后 nodes.length=0');
  assert(flowState.everHadNodes === true, 'restore 空项目 → replaceAll 置 everHadNodes=true');
  emptyState._sync();
  assert(!cardShown(), '打开空项目后 → 不弹首启引导卡（已非首启）');
}

// ═══════ 5. clear() 语义：主动清空不重置 everHadNodes（与"新建模板"口径一致） ═══════
{
  resetToFirstLaunch();
  flowState.addNode('product-image', 0, 0);
  flowState.clear();
  emptyState._sync();
  assert(flowState.nodes.length === 0, 'clear 后 nodes.length=0');
  assert(flowState.everHadNodes === true, 'clear 不重置 everHadNodes（用户已用过画布）');
  assert(!cardShown(), 'clear 清空后 → 不弹引导卡');
}

// ═══════ 6. 独立实例状态级：新实例=false；addNode/replaceAll=true；删空不变 ═══════
{
  const fs = new FlowState();
  assert(fs.everHadNodes === false, '新 FlowState 实例 everHadNodes=false');
  fs.addNode('product-image', 0, 0);
  const n = fs.nodes[0];
  fs.removeNode(n.id);
  assert(fs.nodes.length === 0 && fs.everHadNodes === true, '独立实例 addNode→删空 后 everHadNodes=true');
  const emptyProj = createDefaultProject();
  emptyProj.nodes = [];
  fs.replaceAll(emptyProj);
  assert(fs.nodes.length === 0 && fs.everHadNodes === true, '独立实例 replaceAll(空项目) → everHadNodes=true');
}

console.log(`\nQA 独立复核（everHadNodes 语义闭环）结束：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail > 0 ? 1 : 0;
