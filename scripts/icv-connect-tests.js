// ICV v1 手动连线功能边界测试（工程师新增，配合 P0 增量需求）
// 覆盖：连自己拒绝 / 重复连拒绝 / 产品图作下游拒绝 / 正常连线 /
//       插入步骤后 edges 正确断开重连 / 新节点默认参数 / 参考图自动取上游
//
// 用法：先 npx tsc -p tsconfig.smoke.json 编译到 G:/tmp/icv-test，再 node scripts/icv-connect-tests.js

/* eslint-disable no-console */
const path = require('path');

// ── 浏览器全局桩（与 QA 脚本一致）──
global.window = {};
global.document = {
  getElementById: () => null,
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

const { flowState } = load('v1/state/flow-state.js');
const { createDefaultProject } = load('v1/templates.js');
const { nodeRegistry } = load('v1/nodes/node-registry.js');
load('v1/nodes/product-image.js');
load('v1/nodes/style-transfer.js');

let pass = 0, fail = 0;
const assert = (cond, msg) => {
  if (!cond) { fail++; console.error('✗ FAIL:', msg); }
  else { pass++; console.log('✓ PASS:', msg); }
};

const ctx = {
  getUpstreams: id => flowState.getUpstreams(id),
  getDownstreams: id => flowState.getDownstreams(id),
  getImageModels: async () => [{ id: 'p:m', name: 'M' }],
};

function setup() {
  flowState.clear();
  const a = flowState.addNode('product-image', 0, 0);
  const b = flowState.addNode('style-transfer', 400, 0);
  const c = flowState.addNode('style-transfer', 800, 0);
  flowState.setNodeImage(a.id, 'data:image/png;base64,REF', 3 / 4);
  flowState.updateNode(a.id, { status: 'done' });
  return { a, b, c };
}

// ═══════ 1. 连自己拒绝 ═══════
{
  const { b } = setup();
  const res = flowState.connect(b.id, b.id);
  assert(res.ok === false && /不能连接自己/.test(res.error || ''), '连自己 → 拒绝并提示（canConnect/connect）');
  assert(flowState.canConnect(b.id, b.id) === '不能连接自己', 'canConnect 连自己返回原因');
}

// ═══════ 2. 重复连线拒绝 ═══════
{
  const { a, b } = setup();
  assert(flowState.connect(a.id, b.id).ok === true, '首次连 a→b 成功');
  const res2 = flowState.connect(a.id, b.id);
  assert(res2.ok === false && /已有相同连线/.test(res2.error || ''), '重复连 a→b → 拒绝');
  assert(flowState.edges.filter(e => e.from === a.id && e.to === b.id).length === 1, 'edges 无重复项');
}

// ═══════ 3. 产品图作下游拒绝 ═══════
{
  const { a, b } = setup();
  const res = flowState.connect(b.id, a.id);
  assert(res.ok === false && /产品图是起点/.test(res.error || ''), '产品图作下游 → 拒绝并提示');
  assert(flowState.canConnect(b.id, a.id) === '产品图是起点，不能作为下游', 'canConnect 产品图作下游返回原因');
  assert(flowState.edges.length === 0, '拒绝后不产生边');
}

// ═══════ 4. 正常连线 + 拓扑语义 ═══════
{
  const { a, b, c } = setup();
  assert(flowState.connect(a.id, b.id).ok === true, 'a→b 正常连线成功');
  assert(flowState.connect(b.id, c.id).ok === true, 'b→c 正常连线成功');
  assert(flowState.getUpstreams(b.id).map(n => n.id).includes(a.id), 'b 的上游含 a');
  assert(flowState.getDownstreams(a.id).map(n => n.id).includes(b.id), 'a 的下游含 b');
}

// ═══════ 5. 插入步骤：edges 正确断开重连 ═══════
{
  const { a, b } = setup();
  const e1 = flowState.addEdge(a.id, b.id);
  assert(!!e1, '前置：a→b 存在');
  const inserted = flowState.insertStep(e1.id);
  assert(!!inserted, 'insertStep 返回新节点');
  assert(inserted.type === 'style-transfer', '新节点类型 style-transfer');
  assert(inserted.status === 'idle', '新节点 status=idle');
  assert(inserted.params.aspectRatio === '3:4' && inserted.params.count === 1, '新节点参数用注册表默认值');
  assert(flowState.edges.length === 2, '原连线断开 → 2 条新边');
  const hasA2New = flowState.edges.some(e => e.from === a.id && e.to === inserted.id);
  const hasNew2B = flowState.edges.some(e => e.from === inserted.id && e.to === b.id);
  assert(hasA2New && hasNew2B, '重连正确：原 from → 新节点 → 原 to');
  assert(!flowState.edges.some(e => e.id === e1.id), '原连线已删除');
  // 原上游是产品图 → 新节点参考图自动取上游（buildOptions）
  const opts = nodeRegistry.get('style-transfer').buildOptions(inserted, ctx);
  assert(Array.isArray(opts.referenceImages) && opts.referenceImages.length === 1
    && opts.referenceImages[0] === 'data:image/png;base64,REF', '新节点参考图自动取原上游产品图');
  // 新节点位置在连线中点附近
  const midExpectX = (a.x + 260 + b.x) / 2;
  assert(Math.abs(inserted.x + 130 - midExpectX) < 2, '新节点中心位于连线中点（x）');
}

// ═══════ 6. 插入步骤：缺失边/异常防御 ═══════
{
  setup();
  assert(flowState.insertStep('ghost-edge') === null, '不存在的边 insertStep → null');
  flowState.clear();
  const s1 = flowState.addNode('style-transfer', 0, 0);
  const p1 = flowState.addNode('product-image', 400, 0);
  const bad = flowState.addEdge(s1.id, p1.id); // 手工构造异常边（产品图作下游）
  assert(!!bad, '前置：异常边已构造');
  assert(flowState.insertStep(bad.id) === null, '产品图作下游的异常边 → insertStep 拒绝');
}

// ═══════ 7. 持久化兼容：手动边随项目保存/恢复 ═══════
{
  const { persistence } = load('v1/persistence.js');
  const { a, b, c } = setup();
  flowState.connect(a.id, b.id);
  flowState.connect(b.id, c.id);
  const json = JSON.stringify(persistence.collect());
  flowState.clear();
  assert(persistence.restore(JSON.parse(json)) === true, '含手动边的项目 restore 成功');
  assert(flowState.edges.length === 2, '手动边随项目往返保留');
}

console.log(`\n手动连线边界测试结束：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail > 0 ? 1 : 0;
