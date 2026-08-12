// ICV v1 image-gen 图片生成节点桩测试（P0：多图拉线生成一张）
// 覆盖：注册 / 多上游 referenceImages 组装（2 张→数组 2 项）/ 单上游可用 /
//       无上游拒绝 / 多上游仅一个有图可用（至少一个语义）/ 上游变更→stale /
//       删上游线→stale / persistence 往返含 image-gen / run 后结果回写 /
//       style-transfer 多上游仍只取首图（回归）
//
// 用法：先 npx tsc -p tsconfig.smoke.json 编译 src/v1 到 G:/tmp/icv-test，再 node scripts/icv-imagegen-tests.js

/* eslint-disable no-console */
const path = require('path');

// ── 浏览器全局桩（与既有测试一致）──
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
const { dirty } = load('v1/state/dirty.js');
const { persistence } = load('v1/persistence.js');
const { nodeRegistry } = load('v1/nodes/node-registry.js');
const { runEngine } = load('v1/engine/run-engine.js');
const api = load('v1/api.js'); // 需要 Backend 对象引用以打桩
load('v1/nodes/product-image.js');
load('v1/nodes/style-transfer.js');
load('v1/nodes/image-gen.js');

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

// 打桩工具：重置 Backend，记录调用
function stubBackend(opts) {
  const calls = { generate: [], getResult: [] };
  api.Backend.generateImage = async (prompt, options) => {
    calls.generate.push({ prompt, options });
    if (opts.generateError) throw new Error(opts.generateError);
    return opts.taskId ? { task_id: opts.taskId } : { success: true, task_id: 't-default' };
  };
  api.Backend.getTaskResult = async taskId => {
    calls.getResult.push(taskId);
    return opts.result || { status: 'done', result: { success: true, image_url: 'file:///ok.png' } };
  };
  return calls;
}

/** 便捷构造：N 个带图产品图 → image-gen */
function setupMultiInput(n) {
  flowState.clear();
  const gen = flowState.addNode('image-gen', 400, 100, {
    params: { prompt: '合成一张', model: 'provA:modelX', aspectRatio: '1:1', resolution: '4k', count: 1 },
  });
  const ups = [];
  for (let i = 0; i < n; i++) {
    const p = flowState.addNode('product-image', i * 200, 0);
    flowState.setNodeImage(p.id, `data:image/png;base64,IMG${i}`, 3 / 4);
    flowState.updateNode(p.id, { status: 'done' });
    flowState.addEdge(p.id, gen.id);
    ups.push(p);
  }
  return { gen, ups };
}

(async () => {
  // ═══════ 1. 注册与多上游 referenceImages 组装 ═══════
  {
    const { gen } = setupMultiInput(2);
    const def = nodeRegistry.get('image-gen');
    assert(def.type === 'image-gen' && def.label === '图片生成', 'image-gen 已注册（label=图片生成）');
    const opts = def.buildOptions(flowState.getNode(gen.id), ctx);
    assert(Array.isArray(opts.referenceImages) && opts.referenceImages.length === 2, '2 张上游 → referenceImages 数组 2 项');
    assert(opts.referenceImages[0] === 'data:image/png;base64,IMG0' && opts.referenceImages[1] === 'data:image/png;base64,IMG1', 'referenceImages 顺序与上游一致');
    assert(opts.model === 'provA:modelX' && opts.aspectRatio === '1:1' && opts.resolution === '4k' && opts.count === 1, 'options 其它参数正确透传');
  }

  // ═══════ 2. 单上游可用 ═══════
  {
    const { gen } = setupMultiInput(1);
    const def = nodeRegistry.get('image-gen');
    assert(def.canRun(flowState.getNode(gen.id), ctx) === true, '单上游有图 → canRun=true');
    const opts = def.buildOptions(flowState.getNode(gen.id), ctx);
    assert(Array.isArray(opts.referenceImages) && opts.referenceImages.length === 1, '单上游 → referenceImages 1 项');
  }

  // ═══════ 3. 无上游拒绝 / 上游无图拒绝 / 无 prompt 拒绝 ═══════
  {
    flowState.clear();
    const gen = flowState.addNode('image-gen', 0, 0, { params: { prompt: 'x', model: 'm:x' } });
    const def = nodeRegistry.get('image-gen');
    const check = def.canRun(flowState.getNode(gen.id), ctx);
    assert(typeof check === 'string' && check.includes('上游'), `无上游 → canRun 拒绝（got: ${check}）`);
    const p = flowState.addNode('product-image', 0, 200);
    flowState.addEdge(p.id, gen.id);
    const check2 = def.canRun(flowState.getNode(gen.id), ctx);
    assert(typeof check2 === 'string', '上游存在但无图 → canRun 拒绝');
    flowState.setNodeImage(p.id, 'data:image/png;base64,X', 3 / 4);
    flowState.updateNodeParams(gen.id, { prompt: '' });
    const check3 = def.canRun(flowState.getNode(gen.id), ctx);
    assert(typeof check3 === 'string' && check3.includes('指令'), '无 prompt → canRun 拒绝');
    flowState.updateNodeParams(gen.id, { prompt: 'x', model: '' });
    const check4 = def.canRun(flowState.getNode(gen.id), ctx);
    assert(typeof check4 === 'string' && check4.includes('模型'), '无模型 → canRun 拒绝');
  }

  // ═══════ 4. 多上游仅一个有图 → 可用（至少一个语义）且只带该图 ═══════
  {
    flowState.clear();
    const p1 = flowState.addNode('product-image', 0, 0); // 无图
    const p2 = flowState.addNode('product-image', 0, 300);
    const gen = flowState.addNode('image-gen', 400, 0, { params: { prompt: 'x', model: 'm:x' } });
    flowState.setNodeImage(p2.id, 'data:image/png;base64,B', 3 / 4);
    flowState.addEdge(p1.id, gen.id);
    flowState.addEdge(p2.id, gen.id);
    const def = nodeRegistry.get('image-gen');
    assert(def.canRun(flowState.getNode(gen.id), ctx) === true, '多上游仅一个有图 → canRun=true（至少一个语义）');
    const opts = def.buildOptions(flowState.getNode(gen.id), ctx);
    assert(opts.referenceImages.length === 1 && opts.referenceImages[0] === 'data:image/png;base64,B', '仅一个有图上游 → referenceImages 只含该图');
  }

  // ═══════ 5. 上游变更 → stale ═══════
  {
    const { gen, ups } = setupMultiInput(2);
    flowState.updateNode(gen.id, { status: 'done' });
    flowState.setNodeImage(ups[0].id, 'data:image/png;base64,NEW', 3 / 4);
    dirty.markUpstreamChanged(ups[0].id);
    assert(flowState.getNode(gen.id).status === 'stale', '上游换图 → image-gen 标 stale');
  }

  // ═══════ 6. 删上游线 → stale ═══════
  {
    const { gen, ups } = setupMultiInput(2);
    flowState.updateNode(gen.id, { status: 'done' });
    const edge = flowState.edges.find(e => e.to === gen.id && e.from === ups[0].id);
    flowState.removeEdge(edge.id);
    assert(flowState.getNode(gen.id).status === 'stale', '删上游线 → image-gen 标 stale');
  }

  // ═══════ 7. persistence 往返含 image-gen 节点 ═══════
  {
    const { gen } = setupMultiInput(2);
    flowState.updateNode(gen.id, { status: 'done', imageUrl: 'file:///result.png', lastRunAt: 123 });
    const collected = persistence.collect();
    const json = JSON.stringify(collected);
    flowState.clear();
    assert(persistence.restore(JSON.parse(json)) === true, 'restore 含 image-gen 项目成功');
    const g = flowState.nodes.find(n => n.type === 'image-gen');
    assert(!!g, 'image-gen 节点往返保留');
    assert(g.imageUrl === 'file:///result.png' && g.params.prompt === '合成一张', 'image-gen 结果图/参数往返保留');
    assert(flowState.nodes.filter(n => n.type === 'product-image').length === 2, '2 个产品图上游往返保留');
    assert(flowState.edges.filter(e => e.to === g.id).length === 2, '2 条入边往返保留');
  }

  // ═══════ 8. run 后结果回写（backend 打桩） ═══════
  {
    const calls = stubBackend({ taskId: 't-gen' });
    const { gen } = setupMultiInput(2);
    await runEngine.run(gen.id);
    const after = flowState.getNode(gen.id);
    assert(after.status === 'done', 'run(image-gen) 成功 → done');
    assert(after.imageUrl === 'file:///ok.png', 'run 成功 → 结果图回写');
    assert(after.lastRunAt !== null, 'run 成功 → lastRunAt 记录');
    assert(calls.generate.length === 1, 'run 调用 backend generateImage 1 次');
    const opts = calls.generate[0].options;
    assert(Array.isArray(opts.referenceImages) && opts.referenceImages.length === 2, 'run 时 referenceImages 含 2 张上游图');
  }

  // ═══════ 9. style-transfer 回归：多上游仍只取首图 ═══════
  {
    flowState.clear();
    const p1 = flowState.addNode('product-image', 0, 0);
    const p2 = flowState.addNode('product-image', 0, 300);
    const s = flowState.addNode('style-transfer', 300, 0, { params: { prompt: 'p', model: 'm:x' } });
    flowState.setNodeImage(p1.id, 'data:image/png;base64,A', 3 / 4);
    flowState.setNodeImage(p2.id, 'data:image/png;base64,B', 3 / 4);
    flowState.addEdge(p1.id, s.id);
    flowState.addEdge(p2.id, s.id);
    const opts = nodeRegistry.get('style-transfer').buildOptions(flowState.getNode(s.id), ctx);
    assert(Array.isArray(opts.referenceImages) && opts.referenceImages.length === 1 && opts.referenceImages[0] === 'data:image/png;base64,A', 'style-transfer 多上游仍只取首图（回归）');
  }

  // ═══════ 10. image-gen 可作下游继续接（链式：product → image-gen → style-transfer） ═══════
  {
    flowState.clear();
    const p = flowState.addNode('product-image', 0, 0);
    flowState.setNodeImage(p.id, 'data:image/png;base64,A', 3 / 4);
    const gen = flowState.addNode('image-gen', 300, 0, { params: { prompt: 'x', model: 'm:x' } });
    const s = flowState.addNode('style-transfer', 600, 0, { params: { prompt: 'p', model: 'm:x' } });
    assert(flowState.canConnect(gen.id, s.id) === null, 'image-gen 可作下游（canConnect 通过）');
    flowState.addEdge(p.id, gen.id);
    flowState.addEdge(gen.id, s.id);
    assert(flowState.getUpstreams(s.id).some(u => u.type === 'image-gen'), 'style-transfer 上游含 image-gen');
    // image-gen 有结果图后，style-transfer 以其为参考（回归：单上游取首图）
    flowState.setNodeImage(gen.id, 'data:image/png;base64,GEN', 3 / 4);
    const opts = nodeRegistry.get('style-transfer').buildOptions(flowState.getNode(s.id), ctx);
    assert(Array.isArray(opts.referenceImages) && opts.referenceImages.length === 1 && opts.referenceImages[0] === 'data:image/png;base64,GEN', 'style-transfer 取 image-gen 结果图作为参考（回归）');
  }

  console.log(`\nimage-gen 测试结束：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail > 0 ? 1 : 0;
})().catch(e => { console.error('测试执行异常:', e); process.exitCode = 2; });
