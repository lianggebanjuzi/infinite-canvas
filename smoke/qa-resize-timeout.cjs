// smoke/qa-resize-timeout.cjs
// QA 独立回归（Edward）：本轮四项优化中可自动验证的逻辑部分
//   A. text-gen 右下角缩放：
//      A1 把手 mousedown 先于卡片拖拽拦截（mode='resize'，不进入 'node'）
//      A2 仅 text-gen 允许缩放（image-gen 命中把手分支直接 return）
//      A3 宽高钳制（160×120 ~ 640×800，含 scale 换算）
//      A4 resize 变更前入撤销栈（flowHistory.record 被调用）
//   D. poller 超时兜底：
//      D1 单次查询抛错 → 瞬态重试 → 整体超时 504（不误判成功）
//      D2 单次抛错后恢复（pending→done）→ 最终成功（瞬态可自愈）
//      D3 正常 done+success / done+failure / not_found 分支不回归
//
// 运行：
//   node node_modules/typescript/bin/tsc -p tsconfig.smoke.json --outDir /tmp/icv-test
//   node smoke/qa-resize-timeout.cjs

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

global.window = {
  addEventListener() {},
  innerWidth: 1280,
  innerHeight: 800,
  requestAnimationFrame: (fn) => { fn(); return 1; },
  cancelAnimationFrame() {},
};
global.requestAnimationFrame = (fn) => { fn(); return 1; };
global.cancelAnimationFrame = () => {};
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

const BASE = '/tmp/icv-test/v1';

let passed = 0;
let failed = 0;
const failures = [];
function check(cond, msg) {
  if (cond) { passed += 1; console.log(`  ✓ ${msg}`); }
  else { failed += 1; failures.push(msg); console.error(`  ✗ ${msg}`); }
}

// ───────────────────────── A：interactions resize ─────────────────────────
console.log('\n[A] resize 拖拽缩放');
require(`${BASE}/nodes/node-registry.js`);
require(`${BASE}/nodes/image-gen.js`);
require(`${BASE}/nodes/text-gen.js`);
const { flowState } = require(`${BASE}/state/flow-state.js`);
const { interactions } = require(`${BASE}/canvas/interactions.js`);
const { cardView } = require(`${BASE}/canvas/card-view.js`);

// 固定 cardHeight 便于断言（260 / (4/3) = 195）
cardView.cardHeight = () => 195;

// 造节点：text-gen 与 image-gen
const textNode = flowState.addNode('text-gen', 0, 0);
const imgNode = flowState.addNode('image-gen', 400, 0);

// A1：text-gen 把手 mousedown → mode='resize'，不进入 'node'
const textCard = { dataset: { nodeId: textNode.id } };
const handleTarget = { closest: (sel) => sel === '.pcard-resize' ? {} : null };
let recordCalls = 0;
const origRecord = require(`${BASE}/state/history.js`).flowHistory.record;
require(`${BASE}/state/history.js`).flowHistory.record = () => { recordCalls += 1; };
interactions._onCardMouseDown({ target: handleTarget, stopPropagation() {}, clientX: 10, clientY: 10 }, textCard);
check(interactions.drag && interactions.drag.mode === 'resize', 'A1 把手 mousedown → mode=resize（先于卡片拖拽拦截）');
check(interactions.drag && interactions.drag.nodeId === textNode.id, 'A1 resize 目标节点正确');
check(interactions.drag && interactions.drag.resizeW === 260 && interactions.drag.resizeH === 195, 'A1 resize 起始 = w??CARD_W / h??cardHeight（260×195）');
check(recordCalls >= 1, 'A4 resize 变更前已入撤销栈（flowHistory.record 被调用）');
interactions.drag = null;

// A2：image-gen 命中把手分支 → 不进入 resize（直接 return，drag 保持 null）
interactions._onCardMouseDown({ target: handleTarget, stopPropagation() {}, clientX: 10, clientY: 10 }, { dataset: { nodeId: imgNode.id } });
check(interactions.drag === null, 'A2 image-gen 卡把手不启动 resize（仅 text-gen 可缩放）');

// A3：钳制——最小 160×120
flowState.canvas.scale = 1;
interactions.drag = {
  mode: 'resize', startX: 0, startY: 0, moved: true, nodeId: textNode.id,
  group: null, panVx: 0, panVy: 0, selX: 0, selY: 0,
  resizeW: 100, resizeH: 100,
};
interactions._onMouseMove({ clientX: -999, clientY: -999 });
const n1 = flowState.getNode(textNode.id);
check(n1.w === 160 && n1.h === 120, `A3 下限钳制 160×120（实际 ${n1.w}×${n1.h}）`);

// A3：上限 640×800
interactions.drag = {
  mode: 'resize', startX: 0, startY: 0, moved: true, nodeId: textNode.id,
  group: null, panVx: 0, panVy: 0, selX: 0, selY: 0,
  resizeW: 100, resizeH: 100,
};
interactions._onMouseMove({ clientX: 99999, clientY: 99999 });
const n2 = flowState.getNode(textNode.id);
check(n2.w === 640 && n2.h === 800, `A3 上限钳制 640×800（实际 ${n2.w}×${n2.h}）`);

// A3：scale=2 时 dx 需除以 scale（世界坐标换算）
flowState.canvas.scale = 2;
interactions.drag = {
  mode: 'resize', startX: 0, startY: 0, moved: true, nodeId: textNode.id,
  group: null, panVx: 0, panVy: 0, selX: 0, selY: 0,
  resizeW: 200, resizeH: 150,
};
interactions._onMouseMove({ clientX: 40, clientY: 40 }); // 屏幕 40px / scale 2 = 世界 20px
const n3 = flowState.getNode(textNode.id);
check(n3.w === 220 && n3.h === 170, `A3 scale=2 下 dx 除以 scale（200+20=220 / 150+20=170，实际 ${n3.w}×${n3.h}）`);
flowState.canvas.scale = 1;
require(`${BASE}/state/history.js`).flowHistory.record = origRecord;

// ───────────────────────── D：poller 超时/瞬态重试 ─────────────────────────
console.log('\n[D] poller 超时兜底');
const { pollTask } = require(`${BASE}/engine/poller.js`);
const apiMod = require(`${BASE}/api.js`);
const origGet = apiMod.Backend.getTaskResult;

function withBackend(fn) {
  return async () => {
    const r = await fn();
    apiMod.Backend.getTaskResult = origGet;
    return r;
  };
}

(async () => {
  // D1：单次查询永远抛错 → 瞬态重试 → 整体超时 504（绝不误判成功）
  apiMod.Backend.getTaskResult = () => Promise.reject(new Error('bridge down'));
  let d1;
  try {
    d1 = await withBackend(() => pollTask('t1', { intervalMs: 5, timeoutMs: 60 }))();
  } catch (e) { d1 = { threw: e.message }; }
  check(d1 && d1.success === false && d1.code === 504, `D1 查询持续抛错 → 瞬态重试至整体超时 504（code=${d1 && d1.code}）`);
  check(!(d1 && d1.success === true), 'D1 catch 分支不会把查询失败误判为成功');

  // D2：先抛错一次，随后 pending → done → 成功（瞬态可自愈）
  let calls = 0;
  apiMod.Backend.getTaskResult = () => {
    calls += 1;
    if (calls === 1) return Promise.reject(new Error('transient'));
    if (calls === 2) return Promise.resolve({ status: 'pending' });
    return Promise.resolve({ status: 'done', result: { success: true, image_url: 'data:image/png;base64,AA==' } });
  };
  const d2 = await withBackend(() => pollTask('t2', { intervalMs: 1, timeoutMs: 5000 }))();
  check(d2.success === true && !!d2.imageUrl, `D2 单次抛错后恢复 → 最终成功（瞬态重试自愈，调用 ${calls} 次）`);

  // D3a：done + 业务失败 → 返回失败（错误码透传）
  apiMod.Backend.getTaskResult = () => Promise.resolve({ status: 'done', result: { success: false, error_code: 4001, message: '模型超时' } });
  const d3a = await withBackend(() => pollTask('t3', { intervalMs: 1, timeoutMs: 5000 }))();
  check(d3a.success === false && d3a.code === 4001 && d3a.error === '模型超时', `D3a done+失败 → code=${d3a.code} error=${d3a.error}`);

  // D3b：not_found → 404
  apiMod.Backend.getTaskResult = () => Promise.resolve({ status: 'not_found' });
  const d3b = await withBackend(() => pollTask('t4', { intervalMs: 1, timeoutMs: 5000 }))();
  check(d3b.success === false && d3b.code === 404, `D3b not_found → 404（code=${d3b.code}）`);

  console.log(`\n===== 结果：${passed} 通过 / ${failed} 失败 =====`);
  if (failed > 0) {
    console.error('失败项：');
    failures.forEach(f => console.error(`  - ${f}`));
    process.exit(1);
  }
})();
