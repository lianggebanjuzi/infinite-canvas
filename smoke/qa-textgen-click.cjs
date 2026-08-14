// smoke/qa-textgen-click.cjs
// QA 独立回归（Edward）：验证工程师对 _onMouseUp 单击分支的 text-gen 修复
//   Bug：单击 text-gen 文本反推卡误弹「添加图片」文件选择器
//   修复：条件追加 `n.type !== 'text-gen'`
//   验证方式：真实实例化 compiled Interactions，设置 drag 状态后调用真实 _onMouseUp，
//            spy 在 openFilePickerForRef 上，断言"是否弹文件选择器"符合四类节点预期。
//
// 运行：
//   node node_modules/typescript/bin/tsc -p tsconfig.smoke.json --outDir D:/tmp/icv-test
//   node smoke/qa-textgen-click.cjs

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
require(`${BASE}/nodes/image-result.js`);
require(`${BASE}/nodes/text-gen.js`);
const { flowState } = require(`${BASE}/state/flow-state.js`);
const { interactions } = require(`${BASE}/canvas/interactions.js`);

// spy：拦截 openFilePickerForRef，记录被调用次数与 nodeId
let pickerCalls = [];
const origOpenPicker = interactions.openFilePickerForRef.bind(interactions);
interactions.openFilePickerForRef = (nodeId) => { pickerCalls.push(nodeId); };

function resetDrag(nodeId, opts = {}) {
  interactions.drag = {
    mode: 'node',
    startX: 0,
    startY: 0,
    moved: !!opts.moved,
    nodeId,
    group: null,
    panVx: 0,
    panVy: 0,
    selX: 0,
    selY: 0,
  };
}

// 单击模拟：返回本次是否弹了文件选择器
function simulateClick(nodeId, opts = {}) {
  pickerCalls = [];
  resetDrag(nodeId, opts);
  interactions._onMouseUp({});
  return pickerCalls.length > 0;
}

// ───────────────────────── 用例 ─────────────────────────
console.log('\n▶ Q1: 四类节点单击行为（修复核心）');

{
  const n = flowState.addNode('text-gen', 0, 0); // 初始：imageUrl=null, refImages=[]
  check(!simulateClick(n.id), 'text-gen 空卡单击 → 不弹文件选择器（本次修复点）');
}

{
  const n = flowState.addNode('image-result', 0, 0);
  check(!simulateClick(n.id), 'image-result 结果卡单击 → 不弹文件选择器（既有排除保留）');
}

{
  const n = flowState.addNode('image-gen', 0, 0); // 无输出图、无参考图 → 空卡
  check(simulateClick(n.id), 'image-gen 空卡单击 → 弹文件选择器（原行为必须保留）');
}

{
  const n = flowState.addNode('image-gen', 0, 0, { imageUrl: 'data:image/png;base64,AAAA' });
  check(!simulateClick(n.id), '有输出图节点单击 → 不弹文件选择器');
}

console.log('\n▶ Q2: 边界与回归（防过杀）');

{
  // text-gen 用户已通过指令面板/拖图加了参考图：单击仍不应弹（修复条件与 refImages 无关，天然免疫）
  const n = flowState.addNode('text-gen', 0, 0);
  flowState.addRefImage(n.id, 'data:image/png;base64,BBBB');
  check(!simulateClick(n.id), 'text-gen 已有参考图 单击 → 仍不弹（修复不过杀）');
}

{
  // image-gen 已有参考图占位（未出图）：单击只选中不弹（既有行为）
  const n = flowState.addNode('image-gen', 0, 0, { refImages: ['data:image/png;base64,CCCC'] });
  check(!simulateClick(n.id), 'image-gen 已有参考图 单击 → 不弹（既有行为保留）');
}

{
  // 拖拽（moved=true）而非单击：永不弹
  const n = flowState.addNode('image-gen', 0, 0);
  check(!simulateClick(n.id, { moved: true }), '拖拽松手（moved）→ 不弹文件选择器');
}

{
  // 极端健壮：text-gen 若出现 imageUrl（现实中不会）也应被类型排除 → 不弹
  const n = flowState.addNode('text-gen', 0, 0, { imageUrl: 'data:image/png;base64,DDDD' });
  check(!simulateClick(n.id), 'text-gen 带 imageUrl（异常态）→ 仍不弹（类型排除优先）');
}

{
  // 无 nodeId / 无效节点：不崩、不弹
  pickerCalls = [];
  resetDrag(null);
  interactions._onMouseUp({});
  check(pickerCalls.length === 0, '无 nodeId 单击 → 不弹且不抛异常');
}

// 恢复原方法（不污染环境）
interactions.openFilePickerForRef = origOpenPicker;

console.log(`\n──────────────────────────────`);
console.log(`结果: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('失败项:');
  failures.forEach(f => console.log(`  - ${f}`));
  process.exit(1);
}
console.log('QA 行为级验证通过 ✅');
