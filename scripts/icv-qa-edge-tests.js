// ICV v1 QA 独立边界测试（QA 自建，验证工程师冒烟测试未覆盖的路径）
// 覆盖：run() 真实调用链 / 分段执行拒绝 / 失败路径不自动切供应商 / options 组装 /
//       间接脏标记传播（3 级链+分支）/ persistence 图片往返 / 模板结构复验
//
// 用法：先 npx tsc -p tsconfig.smoke.json 编译 src/v1 到 /tmp/icv-test，再 node scripts/icv-qa-edge-tests.js

/* eslint-disable no-console */
const path = require('path');

// ── 浏览器全局桩（与冒烟脚本一致）──
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
const { selection } = load('v1/state/selection.js');
const { createDefaultProject } = load('v1/templates.js');
const { persistence } = load('v1/persistence.js');
const { nodeRegistry } = load('v1/nodes/node-registry.js');
const { runEngine } = load('v1/engine/run-engine.js');
const api = load('v1/api.js'); // 需要 Backend 对象引用以打桩
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

// 便捷构造：product 图 + style（连好线）
function setupDefault() {
  const proj = createDefaultProject();
  flowState.replaceAll(proj);
  const [p, s] = flowState.nodes;
  flowState.setNodeImage(p.id, 'data:image/png;base64,PRODUCT', 3 / 4);
  flowState.updateNode(p.id, { status: 'done' });
  flowState.updateNodeParams(s.id, { prompt: '改成北欧风', model: 'provA:modelX', aspectRatio: '1:1', resolution: '4k', count: 2 });
  return { p, s };
}

(async () => {
  // ═══════ 1. 间接脏标记传播（3 级链 A→B→C） ═══════
  {
    flowState.clear();
    const a = flowState.addNode('product-image', 0, 0);
    const b = flowState.addNode('style-transfer', 300, 0);
    const c = flowState.addNode('style-transfer', 600, 0);
    flowState.addEdge(a.id, b.id);
    flowState.addEdge(b.id, c.id);
    flowState.setNodeImage(a.id, 'data:image/png;base64,A', 3 / 4);
    flowState.updateNode(a.id, { status: 'done' });
    flowState.updateNode(b.id, { status: 'done' });
    flowState.updateNode(c.id, { status: 'done' });
    dirty.markUpstreamChanged(a.id);
    assert(flowState.getNode(b.id).status === 'stale', '间接传播：改 A → B stale');
    assert(flowState.getNode(c.id).status === 'stale', '间接传播：改 A → 孙节点 C stale');
  }

  // ═══════ 2. 分支传播（A→B, A→C） ═══════
  {
    flowState.clear();
    const a = flowState.addNode('product-image', 0, 0);
    const b = flowState.addNode('style-transfer', 300, 0);
    const c = flowState.addNode('style-transfer', 300, 300);
    flowState.addEdge(a.id, b.id);
    flowState.addEdge(a.id, c.id);
    flowState.setNodeImage(a.id, 'data:image/png;base64,A', 3 / 4);
    flowState.updateNode(a.id, { status: 'done' });
    dirty.markUpstreamChanged(a.id);
    assert(flowState.getNode(b.id).status === 'stale' && flowState.getNode(c.id).status === 'stale', '分支传播：改 A → B、C 同时 stale');
  }

  // ═══════ 3. 模板复验 ═══════
  {
    const proj = createDefaultProject();
    assert(proj.nodes.length === 2 && proj.edges.length === 1, 'createDefault 产 2 节点 1 连线');
    assert(proj.nodes.every(n => n.ratio === 3 / 4), '模板节点 ratio=3/4');
    assert(proj.nodes.find(n => n.type === 'style-transfer').params.count === 1, '模板 count 默认 1');
  }

  // ═══════ 4. 分段执行：上游未就绪 → 拒绝（不调 backend） ═══════
  {
    const calls = stubBackend({ taskId: 't1' });
    const proj = createDefaultProject();
    flowState.replaceAll(proj);
    const [, s] = flowState.nodes; // 上游无图、idle
    flowState.updateNodeParams(s.id, { prompt: 'x', model: 'p:m' });
    await runEngine.run(s.id);
    assert(flowState.getNode(s.id).status === 'idle', '上游无图 idle → run 被拒绝且状态不变');
    assert(calls.generate.length === 0, '上游未就绪 → 未调用 backend 生成');
  }

  // ═══════ 5. run() 成功路径：options 组装正确 + 回写 done + imageUrl ═══════
  {
    const calls = stubBackend({ taskId: 't-ok' });
    const { p, s } = setupDefault();
    await runEngine.run(s.id);
    const after = flowState.getNode(s.id);
    assert(after.status === 'done', 'run 成功 → status=done');
    assert(after.imageUrl === 'file:///ok.png', 'run 成功 → imageUrl 回写');
    assert(after.lastRunAt !== null, 'run 成功 → lastRunAt 记录');
    assert(calls.generate.length === 1, 'run 成功 → 调用 generateImage 1 次');
    const { prompt, options } = calls.generate[0];
    assert(prompt === '改成北欧风', `options prompt 透传正确（got: ${prompt}）`);
    assert(options.model === 'provA:modelX', 'options.model 正确透传');
    assert(options.aspectRatio === '1:1', 'options.aspectRatio 正确透传');
    assert(options.resolution === '4k', 'options.resolution 正确透传');
    assert(options.count === 2, 'options.count 正确透传');
    assert(Array.isArray(options.referenceImages) && options.referenceImages.length === 1
      && options.referenceImages[0] === 'data:image/png;base64,PRODUCT', 'options.referenceImages 含上游图');
  }

  // ═══════ 6. run() 成功 → 下游标 stale（若有下游） ═══════
  {
    stubBackend({ taskId: 't-ok2' });
    flowState.clear();
    const a = flowState.addNode('product-image', 0, 0);
    const b = flowState.addNode('style-transfer', 300, 0);
    const c = flowState.addNode('style-transfer', 600, 0);
    flowState.addEdge(a.id, b.id);
    flowState.addEdge(b.id, c.id);
    flowState.setNodeImage(a.id, 'data:image/png;base64,A', 3 / 4);
    flowState.updateNode(a.id, { status: 'done' });
    flowState.updateNodeParams(b.id, { prompt: 'p', model: 'm:x' });
    flowState.updateNodeParams(c.id, { prompt: 'p', model: 'm:x' });
    flowState.updateNode(c.id, { status: 'done' });
    await runEngine.run(b.id);
    assert(flowState.getNode(b.id).status === 'done', 'run B 成功 → B done');
    assert(flowState.getNode(c.id).status === 'stale', 'run B 成功 → 下游 C 被标 stale');
  }

  // ═══════ 7. 失败路径：fail + error，不自动切供应商 ═══════
  {
    stubBackend({
      taskId: 't-fail',
      result: { status: 'done', result: { success: false, error_code: 402, message: '余额不足，请充值' } },
    });
    const { s } = setupDefault();
    await runEngine.run(s.id);
    const after = flowState.getNode(s.id);
    assert(after.status === 'fail', '生成失败 → status=fail');
    assert((after.error || '').includes('余额不足'), `失败原因写入 error（got: ${after.error}）`);
    assert(after.params.model === 'provA:modelX', '失败后 model 不变（不自动切供应商）');
    assert(after.imageUrl === null, '失败后 imageUrl 保持 null');
  }

  // ═══════ 8. 失败路径：任务创建异常（抛错）→ fail ═══════
  {
    stubBackend({ generateError: '网络中断' });
    const { s } = setupDefault();
    await runEngine.run(s.id);
    const after = flowState.getNode(s.id);
    assert(after.status === 'fail' && (after.error || '').includes('网络中断'), 'backend 抛错 → fail + error 原因');
  }

  // ═══════ 9. 并发保护：运行中再触发被忽略 ═══════
  {
    let resolveGen;
    const calls = stubBackend({ taskId: 't-slow' });
    api.Backend.generateImage = (prompt, options) => {
      calls.generate.push({ prompt, options });
      return new Promise(res => { resolveGen = res; });
    };
    const { s } = setupDefault();
    const p1 = runEngine.run(s.id);
    // 此时 status 已同步置 run
    assert(flowState.getNode(s.id).status === 'run', 'run 开始时 status=run');
    await runEngine.run(s.id); // 第二次触发 → 应被忽略
    assert(calls.generate.length === 1, '运行中再次 run → 不重复调 backend');
    resolveGen({ task_id: 't-slow' });
    await p1;
    assert(flowState.getNode(s.id).status === 'done', '慢任务完成后正常 done');
  }

  // ═══════ 10. 输入节点 run：有图 → 直接 done，不调 backend ═══════
  {
    const calls = stubBackend({ taskId: 't-x' });
    const proj = createDefaultProject();
    flowState.replaceAll(proj);
    const [p] = flowState.nodes;
    flowState.setNodeImage(p.id, 'data:image/png;base64,IN', 3 / 4);
    await runEngine.run(p.id);
    assert(flowState.getNode(p.id).status === 'done', '输入节点有图 → run 直接 done');
    assert(calls.generate.length === 0, '输入节点 run 不调 backend 生成');
  }

  // ═══════ 11. persistence：图片 base64 往返无损 ═══════
  {
    flowState.clear();
    const a = flowState.addNode('product-image', 10, 20);
    const b = flowState.addNode('style-transfer', 300, 20);
    flowState.addEdge(a.id, b.id);
    flowState.setNodeImage(a.id, 'data:image/png;base64,LONGIMAGE===', 1 / 1);
    flowState.updateNode(a.id, { status: 'done', title: '主图' });
    flowState.updateNodeParams(b.id, { prompt: 'p2', model: 'm:2', aspectRatio: '16:9', resolution: '1k', count: 4 });
    flowState.updateNode(b.id, { status: 'fail', error: '测试错误', lastRunAt: 12345 });
    const collected = persistence.collect();
    const json = JSON.stringify(collected);
    assert(json.includes('data:image/png;base64,LONGIMAGE==='), 'collect 含 base64 图片');
    flowState.clear();
    assert(persistence.restore(JSON.parse(json)) === true, 'restore 成功');
    const a2 = flowState.nodes.find(n => n.type === 'product-image');
    const b2 = flowState.nodes.find(n => n.type === 'style-transfer');
    assert(a2.imageUrl === 'data:image/png;base64,LONGIMAGE===', '图片 base64 往返无损');
    assert(a2.ratio === 1 && b2.ratio === 3 / 4, 'ratio 往返保留');
    assert(b2.status === 'fail' && b2.error === '测试错误' && b2.lastRunAt === 12345, 'status/error/lastRunAt 往返保留');
    assert(b2.params.aspectRatio === '16:9' && b2.params.count === 4, 'params 往返无损');
    assert(flowState.dirty === false, 'restore 后 dirty=false');
  }

  // ═══════ 12. A9：旧版 format 拒绝 ═══════
  {
    const before = flowState.nodes.length;
    assert(persistence.restore({ format: 'v2', version: '2.0', nodes: [] }) === false, 'A9：format!==icv 拒绝');
    assert(persistence.restore(null) === false, 'null 项目拒绝');
    assert(persistence.restore({ format: 'icv', nodes: 'bad' }) === false, 'nodes 非数组拒绝');
    assert(flowState.nodes.length === before, 'restore 拒绝后状态不被污染');
  }

  // ═══════ 13. restore 过滤非法节点/连线 ═══════
  {
    const ok = persistence.restore({
      format: 'icv', version: '3.0',
      nodes: [
        { id: 'n1', type: 'product-image', x: 1, y: 2, status: 'done' },
        { id: 'n2', type: 'style-transfer', x: 3, y: 4, status: 'bogus' }, // 非法 status
        { id: 'n3', type: 'unknown-type', x: 5, y: 6 },                     // 未知类型
        { id: 42, type: 'product-image' },                                  // id 非字符串
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2' },
        { id: 'e2', from: 'n1', to: 'ghost' }, // 悬挂边
      ],
    });
    assert(ok === true, 'restore 合法项目成功');
    assert(flowState.nodes.length === 2, '非法类型/非法 id 节点被过滤（剩 2）');
    assert(flowState.nodes.find(n => n.id === 'n2').status === 'idle', '非法 status 回退 idle');
    assert(flowState.edges.length === 1 && flowState.edges[0].id === 'e1', '悬挂边被过滤');
  }

  // ═══════ 14. buildOptions：上游无图 → referenceImages=[]（canRun 已挡但组装不崩） ═══════
  {
    flowState.clear();
    const a = flowState.addNode('product-image', 0, 0);
    const b = flowState.addNode('style-transfer', 300, 0);
    flowState.addEdge(a.id, b.id);
    flowState.updateNodeParams(b.id, { prompt: 'p', model: 'm:x' });
    const opts = nodeRegistry.get('style-transfer').buildOptions(flowState.getNode(b.id), ctx);
    assert(Array.isArray(opts.referenceImages) && opts.referenceImages.length === 0, '上游无图 → referenceImages 空数组不崩');
    const check = nodeRegistry.get('style-transfer').canRun(flowState.getNode(b.id), ctx);
    assert(typeof check === 'string' && check.includes('尚未选择'), '上游无图 → canRun 返回原因');
  }

  // ═══════ 15. 选中管理：运行选中语义（单选=当前卡） ═══════
  {
    selection.clear();
    const proj = createDefaultProject();
    flowState.replaceAll(proj);
    const [p, s] = flowState.nodes;
    selection.select(s.id);
    assert(selection.single()?.id === s.id, '单选 single 返回 style 节点');
    selection.select(p.id, true);
    assert(selection.size === 2 && selection.single() === null, '多选 single=null（A5 语义）');
    selection.clear();
    assert(selection.size === 0, '清空选中');
  }

  console.log(`\nQA 边界测试结束：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail > 0 ? 1 : 0;
})().catch(e => { console.error('测试执行异常:', e); process.exitCode = 2; });
