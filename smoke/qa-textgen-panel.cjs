// smoke/qa-textgen-panel.cjs
// QA 独立回归（Edward）：验证 text-gen 面板重构后的新行为 + 双卡模型面板语义
//   验证点：
//     A1: 无 _onPolish / cmd-polish 已删除
//     A2: sync() textgen 分支——输入框未聚焦时【不回填 instruction】（命令框保持干净）
//     A3: sync() 输入框聚焦时不覆盖用户输入（命令输入不被打断）
//     B1: _onSend text-gen——从 input.value 读命令 → 写 instruction → 发送后清空命令框
//     B2: _onSend text-gen——input 为空时退回 params.instruction（P1 修复：点 chip 触发 sync 清空后不丢命令）
//     C1: image-gen（含引擎产出节点）面板完整可用——readonly 分支已移除
//
// 运行：
//   node node_modules/typescript/bin/tsc -p tsconfig.smoke.json --outDir D:/tmp/icv-test
//   node smoke/qa-textgen-panel.cjs

'use strict';

// ───────────────────────── DOM 桩（cmd-panel init 需要的元素） ─────────────────────────
function makeEl(over = {}) {
  const listeners = {};
  return {
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    style: {},
    dataset: {},
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type, ev) { (listeners[type] || []).forEach(fn => fn(ev || {})); },
    appendChild() {},
    insertBefore() {},
    remove() {},
    setAttribute() {},
    removeAttribute() {},
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 600, height: 240 }; },
    offsetHeight: 240,
    offsetWidth: 640,
    ...over,
  };
}

// 可寻址 DOM：getElementById 返回稳定桩；cmd-panel 用到的 id 在此登记
const domMap = new Map();
function register(id, el) { domMap.set(id, el); return el; }
// cmd-panel 元素使用可追踪 classList（供 C1 断言 readonly 已移除）
const panelClasses = new Set();
const cmdPanelEl = makeEl({
  classList: {
    add(...cs) { cs.forEach(c => panelClasses.add(c)); },
    remove(...cs) { cs.forEach(c => panelClasses.delete(c)); },
    toggle(c, force) { if (force === undefined ? !panelClasses.has(c) : force) panelClasses.add(c); else panelClasses.delete(c); },
    contains(c) { return panelClasses.has(c); },
  },
});
const inputEl = makeEl({ value: '', placeholder: '' });
const sendEl = makeEl();
const historyEl = makeEl();
register('cmd-panel', cmdPanelEl);
register('ctx-thumb', makeEl());
register('ctx-name', makeEl());
register('ctx-hint', makeEl());
register('cmd-refs', makeEl());
register('cmd-ref-main', makeEl());
register('cmd-input', inputEl);
register('cmd-send', sendEl);
register('chip-model-label', makeEl());
register('chip-ratio-label', makeEl());
register('chip-res-label', makeEl());
register('chip-count-label', makeEl());
register('cmd-text-history', historyEl);
register('chip-model', makeEl());
register('chip-ratio', makeEl());
register('chip-res', makeEl());
register('chip-count', makeEl());
register('cmd-ref-add', makeEl());

global.window = { addEventListener() {}, innerWidth: 1280, innerHeight: 800 };
global.pywebview = { api: {} };
global.document = {
  getElementById: (id) => domMap.get(id) || null,
  createElement: () => makeEl(),
  createElementNS: () => makeEl(),
  addEventListener() {},
  body: makeEl(),
  querySelector() { return null; },
  querySelectorAll() { return []; },
  activeElement: null, // 默认输入框未聚焦
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
const { selection } = require(`${BASE}/state/selection.js`);
const { canvasView } = require(`${BASE}/canvas/canvas-view.js`);
const apiMod = require(`${BASE}/api.js`);
const toastMod = require(`${BASE}/ui/toast.js`);
const { cmdPanel } = require(`${BASE}/ui/cmd-panel.js`);

// 依赖打桩（在 cmd-panel require 后、调用前替换运行时访问）
apiMod.fetchImageModels = async () => [];
apiMod.fetchChatModels = async () => [{ id: 'p:chat', name: '对话模型' }];
apiMod.resolveDefaultChatModel = async () => 'p:chat';
apiMod.Backend.chatV2 = async () => ({ success: true, text: '处理结果' });
toastMod.showToast = () => {};

let inited = false;
function reset() {
  flowState.nodes = [];
  flowState.edges = [];
  flowState.selectedIds = new Set();
  inputEl.value = '';
  inputEl.disabled = false;
  // canvasView 需要 wrap 供 _position 定位
  canvasView.wrap = makeEl({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 800 }) });
  if (!inited) {
    cmdPanel.init(); // 显式初始化（真实应用由 main.ts 调用）
    inited = true;
  }
}

// 便捷：新建 text-gen 并选中，面板 sync 一次
function selectTextGen(over = {}) {
  const n = flowState.addNode('text-gen', 0, 0, over);
  selection.select(n.id);
  cmdPanel.sync();
  return n;
}

async function main() {
  console.log('\n▶ A1: 无 _onPolish / cmd-polish 已删除');
  {
    reset();
    check(typeof cmdPanel._onPolish === 'undefined', '_onPolish 已删除');
    check(document.getElementById('cmd-polish') === null, 'cmd-polish 元素已从 DOM 移除');
  }

  console.log('\n▶ A2: sync textgen 分支——未聚焦时【不回填 instruction】（命令框保持干净）');
  {
    reset();
    selectTextGen({ params: { instruction: '旧命令', model: 'p:chat' } });
    check(inputEl.value === '', '选中 text-gen 且未聚焦 → 命令框不回填 instruction（保持空）');
  }

  console.log('\n▶ A3: sync 输入框聚焦时不覆盖用户输入（命令输入不被打断）');
  {
    reset();
    selectTextGen({ params: { instruction: '', model: 'p:chat' } });
    inputEl.value = '翻译成英文';          // 用户正在输入命令
    document.activeElement = inputEl;      // 输入框聚焦
    cmdPanel.sync();
    check(inputEl.value === '翻译成英文', '输入框聚焦时 sync 不覆盖用户输入');
    document.activeElement = null;
  }

  console.log('\n▶ B1: _onSend text-gen——从 input.value 读命令 → 写 instruction → 发送后清空命令框');
  {
    reset();
    const n = selectTextGen({ params: { instruction: '', model: 'p:chat' } });
    inputEl.value = '翻译成英文';
    cmdPanel._onSend();
    check(flowState.getNode(n.id).params.instruction === '翻译成英文', '_onSend 以 input.value 作命令写入 instruction');
    check(inputEl.value === '', '_onSend 发送后清空命令框');
  }

  console.log('\n▶ B2: _onSend text-gen——input 为空时退回 params.instruction（P1 修复）');
  {
    reset();
    const n = selectTextGen({ params: { instruction: '翻译成英文', model: 'p:chat' } });
    // selectTextGen 的 sync 已将 input.value 清空（未聚焦）；再显式清空一次模拟「点 chip 触发 sync 清空」
    inputEl.value = '';
    cmdPanel._onSend();
    check(flowState.getNode(n.id).params.instruction === '翻译成英文', 'input 空 → 退回已暂存的 params.instruction 作命令（不丢）');
    check(inputEl.value === '', '执行后仍清空命令框');
  }

  console.log('\n▶ C1: image-gen（含引擎产出节点）面板完整可用（readonly 已移除）');
  {
    reset();
    const n = flowState.addNode('image-gen', 0, 0, { parentId: 'some-gen', title: '生成结果', imageUrl: 'data:image/png;base64,x' });
    selection.select(n.id);
    panelClasses.clear();
    cmdPanel.sync();
    check(!panelClasses.has('readonly'), '引擎产出 image-gen 面板不进入 readonly（双卡模型）');
    check(panelClasses.has('show'), '引擎产出 image-gen 面板正常显示');
    check(inputEl.value === '', 'image-gen 无 prompt → 输入框为空（可编辑）');
    check(sendEl.disabled === false, 'image-gen 非运行态 → 发送钮可用');
  }

  console.log('\n▶ C2: image-gen 文本反推节点取消选中 → reverse class 清理（P3 修复守护）');
  {
    reset();
    panelClasses.clear();
    const n = flowState.addNode('image-gen', 0, 0, {
      params: { prompt: '', model: 'p:draw', aspectRatio: '3:4', resolution: '2k', count: 1, modelType: 'text' },
    });
    selection.select(n.id);
    cmdPanel.sync();
    check(panelClasses.has('reverse'), 'image-gen 文本反推节点选中 → 面板带 reverse class');
    selection.clear();
    cmdPanel.sync();
    check(!panelClasses.has('reverse'), '取消选中（无选中分支）→ reverse class 已移除（无残留）');
    check(!panelClasses.has('show') && !panelClasses.has('textgen') && !panelClasses.has('pos-above'), '取消选中 → show/textgen/pos-above 一并清理');
  }

  console.log(`\n──────────────────────────────`);
  console.log(`结果: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('失败项:');
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log('QA 面板级验证通过 ✅');
}

main().catch(e => { console.error('测试执行异常:', e); process.exit(2); });
