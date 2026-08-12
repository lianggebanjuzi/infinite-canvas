// ICV v1 构建产物运行时冒烟（Node + DOM 桩）
// 加载 gui/dist/assets/index-*.js，验证整条初始化链路不抛异常，且 window.ICV 可用

/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

// ── 基础 DOM 桩 ──
function makeEl() {
  return {
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {},
    appendChild() {}, insertBefore() {}, remove() {},
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }),
    value: '', innerHTML: '', textContent: '', src: '', title: '', disabled: false, files: null,
    onclick: null, onload: null, onerror: null, onchange: null,
  };
}

global.window = {
  addEventListener() {}, removeEventListener() {},
  innerWidth: 1280, innerHeight: 800,
};
global.document = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => makeEl(),
  createElementNS: () => makeEl(),
  addEventListener() {}, removeEventListener() {},
  body: makeEl(),
  documentElement: { setAttribute() {}, getAttribute: () => 'light', removeAttribute() {} },
};
global.localStorage = {
  _s: {},
  getItem(k) { return this._s[k] ?? null; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; },
};
global.Image = class { set src(v) { this._src = v; } get src() { return this._src; } };
global.FileReader = class {
  readAsDataURL() { if (this.onload) this.onload({ target: { result: 'data:image/png;base64,x' } }); }
};
global.confirm = () => true;
global.requestAnimationFrame = cb => setTimeout(cb, 0);
global.MutationObserver = class {
  constructor() {}
  observe() {}
  disconnect() {}
};

// ── 加载构建产物 ──
const distDir = path.join('G:/Infinite Canvas/Infinite Canvas 1.0', 'gui/dist');
const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf-8');
const jsMatch = html.match(/src="(\.\/assets\/[^"]+\.js)"/);
if (!jsMatch) { console.error('✗ 未在 index.html 找到 bundle 脚本'); process.exit(1); }

const jsPath = path.join(distDir, jsMatch[1].replace('./', ''));
console.log('加载 bundle:', jsMatch[1]);
require(jsPath);

// ── 验证 ──
const assert = (cond, msg) => {
  if (!cond) { console.error('✗ FAIL:', msg); process.exitCode = 1; }
  else { console.log('✓ PASS:', msg); }
};

const ICV = global.window.ICV;
assert(!!ICV, 'window.ICV 已桥接');
assert(!!ICV.flowState && !!ICV.runEngine && !!ICV.persistence, 'ICV 核心模块已暴露');
assert(ICV.nodeRegistry.has('product-image') && ICV.nodeRegistry.has('style-transfer'), '节点注册表包含 2 种节点');

// 用 ICV 的流式 API 走一遍数据闭环
const { flowState, nodeRegistry, persistence, selection } = ICV;
flowState.clear();
const proj = ICV.__test_createProject ? ICV.__test_createProject() : null;
// 通过注册表默认参数手工构造
const p = flowState.addNode('product-image', 60, 180);
const s = flowState.addNode('style-transfer', 430, 180);
flowState.addEdge(p.id, s.id);
flowState.setNodeImage(p.id, 'data:image/png;base64,abc', 3 / 4);
flowState.updateNode(p.id, { status: 'done' });
selection.select(s.id);
assert(selection.single()?.id === s.id, '单选选中 style 节点');
assert(typeof nodeRegistry.get('style-transfer').canRun(s, {
  getUpstreams: id => flowState.getUpstreams(id),
  getDownstreams: id => flowState.getDownstreams(id),
  getImageModels: async () => [],
}) === 'string', '无模型时 canRun 返回原因（不抛异常）');

const saved = persistence.collect();
assert(saved.format === 'icv' && saved.nodes.length === 2, 'collect 输出 icv 项目');
assert(persistence.restore(JSON.parse(JSON.stringify(saved))) === true, 'restore 往返成功');
assert(flowState.dirty === false, 'restore 后 dirty=false');

console.log('\n构建产物运行时冒烟结束。');
