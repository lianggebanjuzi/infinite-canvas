// ICV v1 QA 独立复核：image-gen 节点（严过关 / Edward 独立编写，不复用工程师测试结构）
// 场景① 多上游其一无图 → canRun 可用但 referenceImages 不含 null
// 场景② 上游替换图后 buildOptions 取到新图（stale 之外的数据层验证）
// 场景③ image-gen 接下游 → run 后结果图回写 + 下游标 stale + 下游 buildOptions 取到结果图
// 场景④ persistence 往返含 image-gen + 多连线后恢复正确
//
// 用法：先 npx tsc -p tsconfig.smoke.json --outDir G:/tmp/icv-test，再 node scripts/icv-qa-imagegen-test.js

/* eslint-disable no-console */
const path = require('path');

// ── 浏览器全局桩 ──
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
const { persistence } = load('v1/persistence.js');
const { nodeRegistry } = load('v1/nodes/node-registry.js');
const { runEngine } = load('v1/engine/run-engine.js');
const api = load('v1/api.js'); // Backend 引用以打桩
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

/** 打桩 Backend：run 立即 done 并回写指定结果图 */
function stubBackend(imageUrl = 'file:///gen-result.png') {
  api.Backend.generateImage = async () => ({ success: true, task_id: 't-qa' });
  api.Backend.getTaskResult = async () => ({ status: 'done', result: { success: true, image_url: imageUrl } });
}

function mkGen(x, y, params) {
  return flowState.addNode('image-gen', x, y, {
    params: { prompt: '生成一张', model: 'provA:modelX', aspectRatio: '1:1', resolution: '4k', count: 1, ...params },
  });
}
function mkProduct(x, y, img) {
  const p = flowState.addNode('product-image', x, y);
  if (img) { flowState.setNodeImage(p.id, img, 3 / 4); flowState.updateNode(p.id, { status: 'done' }); }
  return p;
}

(async () => {
  // ═══════ ① 多上游其一无图 → canRun 可用但 referenceImages 不含 null ═══════
  {
    flowState.clear();
    const pNoImg = mkProduct(0, 0, null);            // 无图
    const pImg = mkProduct(0, 300, 'data:image/png;base64,ONLY'); // 有图
    const gen = mkGen(500, 0);
    flowState.addEdge(pNoImg.id, gen.id);
    flowState.addEdge(pImg.id, gen.id);
    const def = nodeRegistry.get('image-gen');
    const check = def.canRun(flowState.getNode(gen.id), ctx);
    assert(check === true, '① 多上游（1 有图 1 无图）→ canRun=true');
    const opts = def.buildOptions(flowState.getNode(gen.id), ctx);
    assert(Array.isArray(opts.referenceImages), '① referenceImages 是数组');
    assert(opts.referenceImages.every(r => typeof r === 'string' && r.length > 0), '① referenceImages 无 null/空值');
    assert(opts.referenceImages.length === 1 && opts.referenceImages[0] === 'data:image/png;base64,ONLY', '① 仅 1 张有图 → 数组只含该图');
  }

  // ═══════ ② 上游替换图后 buildOptions 取到新图 ═══════
  {
    flowState.clear();
    const p1 = mkProduct(0, 0, 'data:image/png;base64,OLD');
    const p2 = mkProduct(0, 300, 'data:image/png;base64,OLD2');
    const gen = mkGen(500, 0);
    flowState.addEdge(p1.id, gen.id);
    flowState.addEdge(p2.id, gen.id);
    flowState.setNodeImage(p1.id, 'data:image/png;base64,NEW', 3 / 4);
    const opts = nodeRegistry.get('image-gen').buildOptions(flowState.getNode(gen.id), ctx);
    assert(opts.referenceImages.includes('data:image/png;base64,NEW'), '② 上游换图后 buildOptions 取到新图');
    assert(!opts.referenceImages.includes('data:image/png;base64,OLD'), '② 旧图不再出现在 referenceImages');
    assert(opts.referenceImages.length === 2, '② 两个上游仍各贡献一张（顺序不变）');
  }

  // ═══════ ③ image-gen 接下游 → run 后结果回写 + 下游标 stale + 下游取到结果图 ═══════
  {
    flowState.clear();
    const p = mkProduct(0, 0, 'data:image/png;base64,A');
    const gen = mkGen(400, 0);
    const s = flowState.addNode('style-transfer', 800, 0, { params: { prompt: 'p', model: 'm:x' } });
    assert(flowState.canConnect(gen.id, s.id) === null, '③ image-gen 可接 style-transfer 下游（连线前校验）');
    flowState.addEdge(p.id, gen.id);
    flowState.addEdge(gen.id, s.id);
    flowState.updateNode(s.id, { status: 'idle' });

    stubBackend('file:///gen-result.png');
    await runEngine.run(gen.id);
    const gAfter = flowState.getNode(gen.id);
    assert(gAfter.status === 'done' && gAfter.imageUrl === 'file:///gen-result.png', '③ image-gen run 成功 → 结果图回写');
    const sAfter = flowState.getNode(s.id);
    assert(sAfter.status === 'stale', '③ image-gen 结果更新 → 下游 style-transfer 标 stale');
    const sOpts = nodeRegistry.get('style-transfer').buildOptions(sAfter, ctx);
    assert(sOpts.referenceImages.length === 1 && sOpts.referenceImages[0] === 'file:///gen-result.png', '③ 下游 buildOptions 取到 image-gen 结果图');
  }

  // ═══════ ④ persistence 往返：2 产品图 + image-gen + 下游 + 多连线 → 恢复正确 ═══════
  {
    flowState.clear();
    const p1 = mkProduct(0, 0, 'data:image/png;base64,P1');
    const p2 = mkProduct(0, 300, 'data:image/png;base64,P2');
    const gen = mkGen(500, 0);
    const s = flowState.addNode('style-transfer', 900, 0, { params: { prompt: 'p', model: 'm:x' } });
    flowState.addEdge(p1.id, gen.id);
    flowState.addEdge(p2.id, gen.id);
    flowState.addEdge(gen.id, s.id);
    flowState.updateNode(gen.id, { status: 'done', imageUrl: 'data:image/png;base64,RESULT', lastRunAt: 42 });

    const json = JSON.stringify(persistence.collect());
    flowState.clear();
    assert(persistence.restore(JSON.parse(json)) === true, '④ restore 成功');
    const g = flowState.nodes.find(n => n.type === 'image-gen');
    assert(!!g, '④ image-gen 节点往返保留');
    assert(g.imageUrl === 'data:image/png;base64,RESULT' && g.params.prompt === '生成一张', '④ image-gen 结果图/参数往返保留');
    assert(flowState.nodes.filter(n => n.type === 'product-image').length === 2, '④ 2 个产品图上游保留');
    assert(flowState.nodes.filter(n => n.type === 'style-transfer').length === 1, '④ style-transfer 下游保留');
    assert(flowState.edges.filter(e => e.to === g.id).length === 2, '④ image-gen 2 条入边保留');
    assert(flowState.edges.filter(e => e.from === g.id).length === 1, '④ image-gen 1 条出边保留');
    // 恢复后语义仍成立：image-gen canRun 可用且 referenceImages 仍为 2 张
    const opts = nodeRegistry.get('image-gen').buildOptions(flowState.getNode(g.id), ctx);
    assert(opts.referenceImages.length === 2, '④ 恢复后 buildOptions 仍取 2 张上游图');
  }

  // ═══════ 附：删上游线后 referenceImages 同步收缩（数据层动态性） ═══════
  {
    flowState.clear();
    const p1 = mkProduct(0, 0, 'data:image/png;base64,X1');
    const p2 = mkProduct(0, 300, 'data:image/png;base64,X2');
    const gen = mkGen(500, 0);
    flowState.addEdge(p1.id, gen.id);
    flowState.addEdge(p2.id, gen.id);
    const edge1 = flowState.edges.find(e => e.from === p1.id && e.to === gen.id);
    flowState.removeEdge(edge1.id);
    const opts = nodeRegistry.get('image-gen').buildOptions(flowState.getNode(gen.id), ctx);
    assert(opts.referenceImages.length === 1 && opts.referenceImages[0] === 'data:image/png;base64,X2', '附 删一条上游线 → referenceImages 同步收缩为 1 张');
  }

  console.log(`\nQA 独立复核（image-gen 节点）结束：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail > 0 ? 1 : 0;
})().catch(e => { console.error('测试执行异常:', e); process.exitCode = 2; });
