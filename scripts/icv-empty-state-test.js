// ICV v1 空态引导卡判断条件桩测试（BugFix：删空画布后误弹引导卡）
// 语义：引导卡仅在"首次启动且画布从无节点"时显示（flowState.nodes.length===0 && !flowState.everHadNodes）；
//      用户主动删空（addNode/replaceAll 之后 everHadNodes=true）保持干净空白。
//
// 用法：先 npx tsc -p tsconfig.smoke.json 编译 src/v1 到 G:/tmp/icv-test，再 node scripts/icv-empty-state-test.js

/* eslint-disable no-console */
const path = require('path');

// ── 浏览器全局桩（与既有冒烟/QA 脚本一致）+ 可捕获 class 的空态元素桩 ──
global.window = {};

const emptyEl = {
  _classes: new Set(),
  classList: {
    add(c) { emptyEl._classes.add(c); },
    remove(c) { emptyEl._classes.delete(c); },
    toggle(c, force) {
      if (force === undefined) {
        if (emptyEl._classes.has(c)) { emptyEl._classes.delete(c); return false; }
        emptyEl._classes.add(c); return true;
      }
      if (force) emptyEl._classes.add(c); else emptyEl._classes.delete(c);
      return force;
    },
  },
};

global.document = {
  // 只让空态元素命中；其余（按钮等）返回 null → init 里 addEventListener 走 ?. 跳过
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

// 重置单例到"首启"态：无节点且从未有过节点
function resetToFirstLaunch() {
  flowState.nodes = [];
  flowState.edges = [];
  flowState.selectedIds.clear();
  flowState.everHadNodes = false;
}

emptyState.init();

// ═══════ 1. 首启空画布 → 引导卡显示（A1 回归） ═══════
{
  resetToFirstLaunch();
  emptyState._sync();
  assert(cardShown(), '首启空画布 → 引导卡显示');
  assert(flowState.everHadNodes === false, '首启 everHadNodes=false');
}

// ═══════ 2. 拖入图片新建（addNode）→ 删空 → 不弹卡 ═══════
{
  resetToFirstLaunch();
  const n = flowState.addNode('product-image', 0, 0);
  assert(flowState.everHadNodes === true, 'addNode → everHadNodes=true');
  flowState.removeNode(n.id);
  emptyState._sync();
  assert(flowState.nodes.length === 0, '删空后 nodes.length=0');
  assert(!cardShown(), '拖入图片新建后删空 → 不弹引导卡');
}

// ═══════ 3. 创建默认模板（replaceAll）→ 删空 → 不弹卡 ═══════
{
  resetToFirstLaunch();
  flowState.replaceAll(createDefaultProject());
  assert(flowState.everHadNodes === true, '创建模板 replaceAll → everHadNodes=true');
  const ids = flowState.nodes.map(n => n.id);
  ids.forEach(id => flowState.removeNode(id));
  emptyState._sync();
  assert(flowState.nodes.length === 0, '模板节点全部删除后 nodes.length=0');
  assert(!cardShown(), '创建模板后删空 → 不弹引导卡');
}

// ═══════ 4. 打开已存项目（persistence.restore）→ 删空 → 不弹卡 ═══════
{
  // 先构造一份"已存项目"并保存为 JSON 往返
  flowState.replaceAll(createDefaultProject());
  const saved = persistence.collect();
  const json = JSON.stringify(saved);
  resetToFirstLaunch();
  assert(persistence.restore(JSON.parse(json)) === true, 'restore 打开已存项目成功');
  assert(flowState.everHadNodes === true, '打开项目 replaceAll → everHadNodes=true');
  const ids = flowState.nodes.map(n => n.id);
  ids.forEach(id => flowState.removeNode(id));
  emptyState._sync();
  assert(flowState.nodes.length === 0, '打开项目后删空 nodes.length=0');
  assert(!cardShown(), '打开已存项目后删空 → 不弹引导卡');
}

// ═══════ 5. 打开"0 节点"空项目 → 不弹卡（用户已非首启） ═══════
{
  resetToFirstLaunch();
  const emptyProj = createDefaultProject();
  emptyProj.nodes = [];
  emptyProj.edges = [];
  flowState.replaceAll(emptyProj);
  assert(flowState.everHadNodes === true, '打开空项目 replaceAll → everHadNodes=true');
  emptyState._sync();
  assert(flowState.nodes.length === 0, '空项目 nodes.length=0');
  assert(!cardShown(), '打开空项目（0 节点）→ 不弹引导卡');
}

// ═══════ 6. 订阅通知路径：notify 触发 _sync 且条件正确 ═══════
{
  resetToFirstLaunch();
  flowState.notify();
  assert(cardShown(), '首启 notify 后引导卡显示（订阅路径生效）');
  flowState.addNode('product-image', 0, 0);
  const n = flowState.nodes[0];
  flowState.removeNode(n.id);
  flowState.notify();
  assert(!cardShown(), 'addNode 后删空 notify → 不弹引导卡（订阅路径生效）');
}

// ═══════ 7. FlowState 状态级语义（独立实例，不依赖 DOM） ═══════
{
  const fs = new FlowState();
  assert(fs.everHadNodes === false, '新 FlowState 初始 everHadNodes=false');
  fs.addNode('product-image', 0, 0);
  assert(fs.everHadNodes === true, '独立实例 addNode → everHadNodes=true');
  const n = fs.nodes[0];
  fs.removeNode(n.id);
  assert(fs.nodes.length === 0 && fs.everHadNodes === true, '独立实例删空后 everHadNodes 仍为 true（不弹卡依据）');
  fs.replaceAll(createDefaultProject());
  assert(fs.everHadNodes === true, '独立实例 replaceAll → everHadNodes=true');
}

console.log(`\n空态引导测试结束：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail > 0 ? 1 : 0;
