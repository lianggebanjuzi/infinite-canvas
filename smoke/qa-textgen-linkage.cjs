// smoke/qa-textgen-linkage.cjs
// QA 独立回归（Edward）：验证 text-gen 交互增强的联动复用（applyTextToDownstream）与 runTextGen 命令驱动链路
//   验证点：
//     D1: applyTextToDownstream 只覆盖【直接 image-gen 下游】的 params.prompt + 标 stale（不覆盖非 image-gen、不递归）
//     D2: runTextGen 成功路径写 outputText/pushTextHistory/联动/toast 全保留（与历史行为一致）
//     D3: 卡片编辑语义（永远只写 outputText 结果 + 联动下游）
//
// 运行：
//   node node_modules/typescript/bin/tsc -p tsconfig.smoke.json --outDir D:/tmp/icv-test
//   node smoke/qa-textgen-linkage.cjs

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
global.Image = class { set src(_v) {} };

const BASE = 'D:/tmp/icv-test/v1';

// ───────────────────────── 断言工具 ─────────────────────────
let passed = 0;
let failed = 0;
const failures = [];
function check(cond, msg) {
  if (cond) { passed += 1; console.log(`  ✓ ${msg}`); }
  else { failed += 1; failures.push(msg); console.error(`  ✗ ${msg}`); }
}

// ───────────────────────── 加载被测模块 ─────────────────────────
require(`${BASE}/nodes/node-registry.js`);
require(`${BASE}/nodes/image-gen.js`);
require(`${BASE}/nodes/text-gen.js`);
const { flowState } = require(`${BASE}/state/flow-state.js`);
const { runEngine, applyTextToDownstream } = require(`${BASE}/engine/run-engine.js`);
const { Backend } = require(`${BASE}/api.js`);

// 清空状态（同一进程多次用例隔离）
function reset() {
  flowState.nodes = [];
  flowState.edges = [];
  flowState.selectedIds = new Set();
}

async function main() {
  console.log('\n▶ D1: applyTextToDownstream 只覆盖直接 image-gen 下游 + 标 stale');

  {
    reset();
    const t = flowState.addNode('text-gen', 0, 0, { params: { instruction: '反推', model: 'm1' } });
    const gen = flowState.addNode('image-gen', 300, 0, { params: { prompt: '旧提示词', model: 'm2' } });
    const result = flowState.addNode('image-gen', 600, 0, { imageUrl: 'data:image/png;base64,AAAA', status: 'done' });
    const otherText = flowState.addNode('text-gen', 300, 300, { params: { instruction: 'x', model: 'm1' } });
    flowState.addEdge(t.id, gen.id, { suppressStale: true });
    flowState.addEdge(gen.id, result.id, { suppressStale: true }); // 间接下游：只 stale 不覆盖 prompt（间接语义）
    flowState.addEdge(t.id, otherText.id, { suppressStale: true }); // 直接下游但非 image-gen：不应被覆盖

    applyTextToDownstream(t.id, '新文本');

    check(flowState.getNode(gen.id).params.prompt === '新文本', '直接 image-gen 下游 prompt 被覆盖为新文本');
    check(flowState.getNode(gen.id).status === 'stale', '直接 image-gen 下游被标 stale');
    check(flowState.getNode(otherText.id).params.instruction === 'x', '直接下游但非 image-gen → instruction 不被覆盖');
    check(flowState.getNode(otherText.id).status === 'stale', '非 image-gen 直接下游仍会被标 stale（markUpstreamChanged 语义）');
    check(!flowState.getNode(result.id).params.prompt, '间接 image-gen 下游 prompt 不被覆盖（仅一层覆盖）');
    check(flowState.getNode(result.id).status === 'stale', '间接下游被标 stale（脏标记 BFS 传播，与反推成功一致）');
  }

  console.log('\n▶ D1b: 无 image-gen 下游时幂等不崩');

  {
    reset();
    const t = flowState.addNode('text-gen', 0, 0);
    let threw = false;
    try { applyTextToDownstream(t.id, '孤立文本'); } catch (e) { threw = true; }
    check(!threw, '无下游调用不抛异常');
  }

  console.log('\n▶ D2: runTextGen 行为不变（成功路径写 outputText/历史/联动；失败路径不写）');

  {
    reset();
    const orig = Backend.chatV2.bind(Backend);
    let calls = [];
    Backend.chatV2 = async (input, opts) => { calls.push({ input, opts }); return { success: true, text: '反推结果文本' }; };

    const t = flowState.addNode('text-gen', 0, 0);
    flowState.updateNodeParams(t.id, { instruction: '反推这张图的提示词', model: 'p:m' });
    const gen = flowState.addNode('image-gen', 300, 0, { params: { prompt: '旧', model: 'p:g' } });
    flowState.addEdge(t.id, gen.id, { suppressStale: true });
    flowState.addRefImage(t.id, 'data:image/png;base64,REF');

    await runEngine.run(t.id);
    const n = flowState.getNode(t.id);
    check(n && n.outputText === '反推结果文本', 'runTextGen 成功写 outputText');
    check(n && n.status === 'done', 'runTextGen 成功置 done');
    const hist = flowState.getTextHistory(t.id);
    check(hist.length === 1 && hist[0].text === '反推结果文本', 'runTextGen 成功写历史');
    check(flowState.getNode(gen.id).params.prompt === '反推结果文本', 'runTextGen 成功覆盖直接下游 prompt');
    check(flowState.getNode(gen.id).status === 'stale', 'runTextGen 成功标下游 stale');
    check(calls.length === 1 && calls[0].opts.model === 'p:m', 'chatV2 以节点 instruction+model 调用');
    check(calls[0].input === '反推这张图的提示词', 'chatV2 输入为 instruction（与历史一致）');

    // 失败路径
    reset();
    Backend.chatV2 = async () => { throw new Error('网络错误'); };
    const t2 = flowState.addNode('text-gen', 0, 0);
    flowState.updateNodeParams(t2.id, { instruction: '指令', model: 'p:m' });
    flowState.addRefImage(t2.id, 'data:image/png;base64,REF');
    await runEngine.run(t2.id);
    const n2 = flowState.getNode(t2.id);
    check(n2 && n2.status === 'fail' && n2.error === '网络错误', 'runTextGen 失败置 fail+error');
    check(n2 && !n2.outputText, 'runTextGen 失败不写 outputText');

    Backend.chatV2 = orig;
  }

  console.log('\n▶ D3: 卡片编辑语义（永远只写 outputText 结果 + 联动下游）');

  {
    reset();
    // 编辑（无论此前有无 outputText）→ 永远写 outputText + 联动直接 image-gen 下游
    const t = flowState.addNode('text-gen', 0, 0);
    const gen = flowState.addNode('image-gen', 300, 0, { params: { prompt: '旧', model: 'p:g' } });
    flowState.addEdge(t.id, gen.id, { suppressStale: true });

    // 模拟 card-view._commitTextEdit 的保存动作：写 outputText + applyTextToDownstream
    flowState.updateNode(t.id, { outputText: '新文本' });
    applyTextToDownstream(t.id, '新文本');

    const tn = flowState.getNode(t.id);
    check(tn.outputText === '新文本', '编辑永远写 outputText（结果）');
    check(tn.params.instruction === '', '编辑不再写 instruction（命令与结果分离）');
    check(flowState.getNode(gen.id).params.prompt === '新文本', '编辑结果联动直接 image-gen 下游 prompt');
    check(flowState.getNode(gen.id).status === 'stale', '编辑结果标直接下游 stale');
  }

  console.log(`\n──────────────────────────────`);
  console.log(`结果: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('失败项:');
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log('QA 行为级验证通过 ✅');
}

main().catch(e => { console.error('测试执行异常:', e); process.exit(2); });
