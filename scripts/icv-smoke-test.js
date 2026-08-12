// ICV v1 数据层冒烟测试（Node 环境，无 DOM）
// 覆盖 T02 验收：模板结构 / 脏标记传播 / 改自己不标 stale / save-open 往返 / 引擎校验

/* eslint-disable no-console */
const path = require('path');

// ── 浏览器全局桩 ──
global.window = {};
global.document = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} }),
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

const base = '/tmp/icv-test';
const assert = (cond, msg) => {
  if (!cond) { console.error('✗ FAIL:', msg); process.exitCode = 1; }
  else { console.log('✓ PASS:', msg); }
};

function load(mod) { return require(path.join(base, mod)); }

const { flowState } = load('v1/state/flow-state.js');
const { dirty } = load('v1/state/dirty.js');
const { selection } = load('v1/state/selection.js');
const { createDefaultProject } = load('v1/templates.js');
const { persistence } = load('v1/persistence.js');
const { nodeRegistry } = load('v1/nodes/node-registry.js');
const { runEngine } = load('v1/engine/run-engine.js');
load('v1/nodes/product-image.js');
load('v1/nodes/style-transfer.js');

// ── 1. 模板结构 ──
const proj = createDefaultProject();
assert(proj.nodes.length === 2, '模板 nodes=2');
assert(proj.edges.length === 1, '模板 edges=1');
assert(proj.format === 'icv' && proj.version === '3.0', '模板 format=icv version=3.0');
assert(proj.nodes[0].type === 'product-image' && proj.nodes[1].type === 'style-transfer', '模板节点类型正确');
assert(proj.edges[0].from === proj.nodes[0].id && proj.edges[0].to === proj.nodes[1].id, '模板连线 product→style');
assert(proj.nodes[1].params.aspectRatio === '3:4' && proj.nodes[1].params.count === 1, '模板 style 默认参数存在');

// ── 2. 脏标记传播 ──
flowState.replaceAll(proj);
const [p, s] = flowState.nodes;
assert(s.status === 'idle', '初始 style 状态 idle');
flowState.setNodeImage(p.id, 'data:image/png;base64,xxx', 3 / 4);
flowState.updateNode(p.id, { status: 'done' });
dirty.markUpstreamChanged(p.id);
assert(flowState.getNode(s.id)?.status === 'stale', '上游换图 → 下游 stale');
assert(flowState.getNode(p.id)?.status === 'done', '上游自身状态不被覆盖');

// 改自己 → 不标 stale
const s2 = flowState.getNode(s.id);
s2.status = 'done';
flowState.updateNodeParams(s.id, { prompt: '新指令' });
assert(flowState.getNode(s.id)?.status === 'done', '改自己 → 不标 stale');

// 运行中不被覆盖
flowState.updateNode(s.id, { status: 'run' });
dirty.markUpstreamChanged(p.id);
assert(flowState.getNode(s.id)?.status === 'run', '运行中不被上游变更覆盖');

// fail → stale（允许重跑）
flowState.updateNode(s.id, { status: 'fail', error: 'x' });
dirty.markUpstreamChanged(p.id);
assert(flowState.getNode(s.id)?.status === 'stale', 'fail 节点被上游变更 → stale（允许重跑）');

// ── 3. 节点注册 ──
assert(nodeRegistry.has('product-image') && nodeRegistry.has('style-transfer'), 'registry 注册 2 种节点');
const ctx = {
  getUpstreams: id => flowState.getUpstreams(id),
  getDownstreams: id => flowState.getDownstreams(id),
  getImageModels: async () => [{ id: 'p:m', name: 'M' }],
};
flowState.replaceAll(proj);
const [p3, s3] = flowState.nodes;
flowState.setNodeImage(p3.id, 'data:image/png;base64,yyy', 3 / 4);
flowState.updateNode(p3.id, { status: 'done' });
flowState.updateNodeParams(s3.id, { prompt: 'hello', model: 'p:m' });
assert(nodeRegistry.get('style-transfer').canRun(flowState.getNode(s3.id), ctx) === true, 'style canRun=true（有图+prompt+model）');
flowState.updateNodeParams(s3.id, { model: '' });
assert(typeof nodeRegistry.get('style-transfer').canRun(flowState.getNode(s3.id), ctx) === 'string', 'style canRun=原因（无模型）');
const opts = nodeRegistry.get('style-transfer').buildOptions(flowState.getNode(s3.id), ctx);
assert(opts.referenceImages && opts.referenceImages.length === 1 && opts.referenceImages[0].startsWith('data:image'), 'buildOptions 带 referenceImages=上游图');

// ── 4. save/open 往返无损 ──
flowState.replaceAll(proj);
flowState.updateNodeParams(s3.id, { prompt: '往返测试', model: 'p:m', aspectRatio: '1:1', resolution: '4k', count: 2 });
const collected = persistence.collect();
const json = JSON.stringify(collected);
assert(json.includes('"format":"icv"') && json.includes('"version":"3.0"'), 'collect 输出 icv/3.0 结构');
assert(persistence.restore(JSON.parse(json)) === true, 'restore 校验通过');
const sAfter = flowState.nodes.find(n => n.type === 'style-transfer');
assert(sAfter.params.prompt === '往返测试' && sAfter.params.count === 2, 'save/open 往返无损（params 保留）');
assert(flowState.dirty === false, 'restore 后 dirty=false');

// A9：旧版项目拒绝
assert(persistence.restore({ format: 'v2', nodes: [] }) === false, '旧版 format 拒绝（A9）');
assert(persistence.restore({ format: 'icv', nodes: 'bad' }) === false, '非法 nodes 拒绝');

// ── 5. 引擎拓扑排序（runAll 顺序）──
const sorted = runEngine._topoSort([s3.id, p3.id]);
assert(sorted[0] === p3.id && sorted[1] === s3.id, '拓扑排序 product 在 style 之前');

// ── 6. 多选选中管理 ──
selection.select(p3.id);
selection.select(s3.id, true);
assert(selection.size === 2, '多选 size=2');
assert(selection.single() === null, '多选时 single()=null');
selection.select(p3.id);
assert(selection.size === 1 && selection.single()?.id === p3.id, '单选 single() 正确');

console.log('\n冒烟测试结束。');
