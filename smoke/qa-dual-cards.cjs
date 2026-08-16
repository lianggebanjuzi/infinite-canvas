// smoke/qa-dual-cards.cjs
// QA 独立回归（双卡模型 3.4）：验证 image-result 类型移除后的引擎/连线/清理语义
//   验证点：
//     E1: 文生图（无参考图）count=1 → 第 1 张写回源节点自身 imageUrl，不建子节点、不新增连线
//     E2: 文生图 count=2 → 第 1 张按 index=0（非完成顺序）写回自身，第 2 张建新 image-gen 子节点并自动连线
//     E3: 图生图（有参考图）→ 每张建新 image-gen 产出节点；源旧 imageUrl 入历史后清空；
//         params 继承上游且 modelType 强制 draw；refImages 保持 []；自动连线
//     E4: removeChildren 安全策略——纯引擎产出（仅 parent 入边）被删除（重跑顶掉）
//     E5: removeChildren 安全策略——手动改造/连线的产出节点保留并标 stale（其下游也标 stale）
//     E6: canConnect(text-gen → image-gen) 返回 null（可连线）；image-gen → text-gen 被拒绝
//     E7: 文生图全失败 → fail + 旧图保留（不清空）
//
// 运行：
//   node node_modules/typescript/bin/tsc -p tsconfig.smoke.json --outDir D:/tmp/icv-test
//   node smoke/qa-dual-cards.cjs

'use strict';

// ───────────────────────── DOM/浏览器桩（沿用项目既有 smoke 约定） ─────────────────────────
const stubEl = (over = {}) => ({
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  style: {},
  dataset: {},
  innerHTML: '',
  textContent: '',
  value: '',
  disabled: false,
  addEventListener() {},
  appendChild() {},
  remove() {},
  setAttribute() {},
  removeAttribute() {},
  querySelector() { return null; },
  querySelectorAll() { return []; },
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
  ...over,
});

global.window = { addEventListener() {}, innerWidth: 1280, innerHeight: 800 };
global.pywebview = { api: {} };
global.document = {
  getElementById: () => null,
  createElement: () => stubEl(),
  createElementNS: () => stubEl(),
  addEventListener() {},
  body: stubEl(),
  querySelector() { return null; },
  querySelectorAll() { return []; },
  activeElement: null,
};
global.localStorage = (() => {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
})();
// Image 自动触发 onload（loadImageRatio 依赖）：naturalWidth/naturalHeight 提供 ratio=0.75
global.Image = class {
  naturalWidth = 3;
  naturalHeight = 4;
  set src(_v) { setTimeout(() => { if (this.onload) this.onload(); }, 0); }
};

const BASE = 'D:/tmp/icv-test/v1';

// ───────────────────────── 断言工具 ─────────────────────────
let passed = 0;
let failed = 0;
const failures = [];
function check(cond, msg) {
  if (cond) { passed += 1; console.log(`  ✓ ${msg}`); }
  else { failed += 1; failures.push(msg); console.error(`  ✗ ${msg}`); }
}
async function section(title, fn) {
  console.log(`\n▶ ${title}`);
  try { await fn(); } catch (e) { failed += 1; failures.push(`${title}: ${e.message}`); console.error(`  ✗ 异常: ${e.message}\n${e.stack}`); }
}

// ───────────────────────── 加载被测模块 ─────────────────────────
const { nodeRegistry } = require(`${BASE}/nodes/node-registry.js`);
require(`${BASE}/nodes/image-gen.js`);
require(`${BASE}/nodes/text-gen.js`);
const { flowState } = require(`${BASE}/state/flow-state.js`);
const { persistence } = require(`${BASE}/persistence.js`);
const { runEngine } = require(`${BASE}/engine/run-engine.js`);
const apiMod = require(`${BASE}/api.js`);
const pollerMod = require(`${BASE}/engine/poller.js`);

// ───────────────────────── 测试辅助 ─────────────────────────
function reset() {
  flowState.nodes = [];
  flowState.edges = [];
  flowState.selectedIds = new Set();
}

function mkImageGen(over = {}) {
  return flowState.addNode('image-gen', 0, 0, {
    params: { prompt: '一只猫', model: 'd:m', aspectRatio: '3:4', resolution: '2k', count: 1 },
    ...over,
  });
}

/**
 * 桩生成链路：plan[i] 对应第 i 个 worker（按 index 顺序创建任务，与 worker index 对齐）。
 * 每项 { url, delayMs?, fail? }——delayMs 模拟完成时序（验证按 index=0 写回而非完成顺序）；fail=true 返回失败。
 * 返回 { restore }：恢复原 Backend.generateImage / pollTask。
 */
function stubGenerate(plan) {
  let callIndex = 0;
  const origGenerate = apiMod.Backend.generateImage;
  const origPoll = pollerMod.pollTask;
  apiMod.Backend.generateImage = async () => ({ task_id: 'task-' + (callIndex++) });
  pollerMod.pollTask = async (taskId) => {
    const idx = Number(String(taskId).split('-')[1]);
    const item = plan[idx];
    if (item && item.delayMs) await new Promise(r => setTimeout(r, item.delayMs));
    if (!item) return { success: false, error: 'plan 缺失' };
    if (item.fail) return { success: false, error: item.error || '生成失败' };
    return { success: true, imageUrl: item.url };
  };
  return {
    restore: () => {
      apiMod.Backend.generateImage = origGenerate;
      pollerMod.pollTask = origPoll;
    },
  };
}

// ───────────────────────── 用例 ─────────────────────────
async function main() {
  await section('E1: 文生图（无参考图）count=1 → 第 1 张写回自身 imageUrl，不建子节点', async () => {
    reset();
    const stub = stubGenerate([{ url: 'data:image/png;base64,OUT1' }]);
    const gen = mkImageGen();
    await runEngine.run(gen.id);
    stub.restore();
    const n = flowState.getNode(gen.id);
    check(n && n.status === 'done', '文生图成功 → done');
    check(n && n.imageUrl === 'data:image/png;base64,OUT1', '第 1 张写回源节点自身 imageUrl');
    check(flowState.nodes.filter(x => x.parentId === gen.id && x.id !== gen.id).length === 0, 'count=1 文生图不建子节点');
    check(flowState.edges.filter(e => e.from === gen.id).length === 0, '不新增连线');
  });

  await section('E2: 文生图 count=2 → 第 1 张（index=0，非完成顺序）写回自身，第 2 张建新 image-gen 节点', async () => {
    reset();
    // worker 1 先完成（无延迟），worker 0 后完成（30ms）→ 验证按 index=0 写回而非完成顺序
    const stub = stubGenerate([
      { url: 'data:image/png;base64,WRITEBACK', delayMs: 30 },
      { url: 'data:image/png;base64,NODE2', delayMs: 0 },
    ]);
    const gen = mkImageGen({ params: { prompt: '一只猫', model: 'd:m', aspectRatio: '3:4', resolution: '2k', count: 2 } });
    await runEngine.run(gen.id);
    stub.restore();
    const n = flowState.getNode(gen.id);
    check(n && n.status === 'done', '文生图 count=2 成功 → done');
    check(n && n.imageUrl === 'data:image/png;base64,WRITEBACK', '第 1 张按 index=0 写回自身（非完成顺序）');
    const children = flowState.nodes.filter(x => x.parentId === gen.id && x.id !== gen.id);
    check(children.length === 1, '第 2 张建一个新 image-gen 子节点');
    const child = children[0];
    check(child && child.type === 'image-gen' && child.status === 'done', '子节点为 image-gen 且 done');
    check(child && child.imageUrl === 'data:image/png;base64,NODE2', '子节点 imageUrl = 第 2 张');
    check(child && child.parentId === gen.id, '子节点 parentId = 源节点');
    check(!!child && flowState.edges.some(e => e.from === gen.id && e.to === child.id), '子节点自动连线（源→子）');
  });

  await section('E3: 图生图（有参考图）→ 每张建新 image-gen 产出节点；源旧图入历史后清空；params 继承', async () => {
    reset();
    const stub = stubGenerate([
      { url: 'data:image/png;base64,OUT1' },
      { url: 'data:image/png;base64,OUT2' },
    ]);
    const gen = mkImageGen({
      params: { prompt: '换背景', model: 'd:m', aspectRatio: '3:4', resolution: '2k', count: 2 },
      imageUrl: 'data:image/png;base64,OLD',
      refImages: ['data:image/png;base64,REF'],
    });
    await runEngine.run(gen.id);
    stub.restore();
    const n = flowState.getNode(gen.id);
    check(n && n.status === 'done', '图生图成功 → done');
    check(n && n.imageUrl === null, '图生图成功 → 源节点旧 imageUrl 清空（回参考图占位）');
    const children = flowState.nodes.filter(x => x.parentId === gen.id && x.id !== gen.id);
    check(children.length === 2, '图生图 count=2 → 建 2 个新 image-gen 产出节点');
    check(children.every(c => c.type === 'image-gen' && c.status === 'done' && !!c.imageUrl), '产出节点均为 image-gen 且 done 且有图');
    check(children.every(c => c.params.prompt === '换背景' && c.params.model === 'd:m' && c.params.count === 2), '产出节点 params 继承上游');
    check(children.every(c => c.params.modelType === 'draw'), '产出节点 modelType 强制 draw（不继承反推态）');
    check(children.every(c => (c.refImages || []).length === 0), '产出节点 refImages 保持 []（参考图自动派生）');
    check(children.every(c => flowState.edges.some(e => e.from === gen.id && e.to === c.id)), '每个产出节点自动连线（源→子）');
  });

  await section('E4: removeChildren 安全策略——纯引擎产出（仅 parent 入边）被删除', () => {
    reset();
    const gen = mkImageGen();
    const child = flowState.addNode('image-gen', 400, 0, { parentId: gen.id, imageUrl: 'data:image/png;base64,C1', status: 'done' });
    flowState.addEdge(gen.id, child.id, { suppressStale: true }); // 仅引擎原边
    flowState.removeChildren(gen.id);
    check(flowState.getNode(child.id) === undefined, '纯引擎产出子节点被删除（重跑顶掉）');
  });

  await section('E5: removeChildren 安全策略——手动改造/连线的产出节点保留并标 stale（下游也标 stale）', () => {
    reset();
    const gen = mkImageGen();
    const child = flowState.addNode('image-gen', 400, 0, { parentId: gen.id, imageUrl: 'data:image/png;base64,C1', status: 'done' });
    const manualUpstream = flowState.addNode('image-gen', 800, 0, { imageUrl: 'data:image/png;base64,M' });
    const downstream = flowState.addNode('image-gen', 800, 300, { imageUrl: 'data:image/png;base64,D', status: 'done' });
    flowState.addEdge(gen.id, child.id, { suppressStale: true });            // 引擎原边
    flowState.addEdge(manualUpstream.id, child.id, { suppressStale: true }); // 手动加的入边 → 非纯引擎产出
    flowState.addEdge(child.id, downstream.id, { suppressStale: true });     // 手动出边

    flowState.removeChildren(gen.id);
    check(flowState.getNode(child.id) !== undefined, '手动改造的产出节点被保留');
    check(flowState.getNode(child.id).status === 'stale', '保留的产出节点标 stale');
    check(flowState.getNode(downstream.id).status === 'stale', '其下游也标 stale');
  });

  await section('E6: canConnect(text-gen → image-gen) 返回 null；image-gen → text-gen 被拒绝', () => {
    reset();
    const tg = flowState.addNode('text-gen', 0, 0);
    const ig = flowState.addNode('image-gen', 300, 0);
    check(flowState.canConnect(tg.id, ig.id) === null, 'text-gen → image-gen 可连线（返回 null）');
    check(flowState.canConnect(ig.id, tg.id) !== null, 'image-gen → text-gen 被拒绝（文本节点不能作为输入）');
  });

  await section('E7: 文生图全失败 → fail + 旧图保留（不清空）', async () => {
    reset();
    const stub = stubGenerate([{ fail: true }]);
    const gen = mkImageGen({ imageUrl: 'data:image/png;base64,OLD' });
    await runEngine.run(gen.id);
    stub.restore();
    const n = flowState.getNode(gen.id);
    check(n && n.status === 'fail', '全失败 → fail');
    check(n && n.imageUrl === 'data:image/png;base64,OLD', '全失败旧图保留（不清空）');
  });

  await section('E8: 双卡模型 persistence 往返（产出节点 parentId 保留 + version 3.4）', () => {
    reset();
    const gen = mkImageGen({ params: { prompt: '一只猫', model: 'd:m', aspectRatio: '3:4', resolution: '2k', count: 1 } });
    flowState.addNode('image-gen', 400, 0, { parentId: gen.id, imageUrl: 'data:image/png;base64,C1', status: 'done', title: '生成结果' });
    const collected = persistence.collect();
    check(collected.version === '3.4', 'collect().version === 3.4');
    const produced = collected.nodes.find(n => n.parentId === gen.id);
    check(!!produced && produced.type === 'image-gen', 'collect 中产出节点为 image-gen');
    check(!!produced && produced.imageUrl === 'data:image/png;base64,C1', 'collect 保留产出节点 imageUrl');
    check(persistence.restore(JSON.parse(JSON.stringify(collected))) === true, 'restore 3.4 成功');
    check(flowState.getNode(gen.id).parentId === null, '手建源节点 parentId 恒 null');
  });

  console.log(`\n──────────────────────────────`);
  console.log(`结果: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('失败项:');
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log('QA 双卡模型验证通过 ✅');
}

main().catch(e => { console.error('测试执行异常:', e); process.exit(2); });
