// 临时 QA 深度探针（不属于交付物，验证后删除）：
//  1) 极端布局：25 个已手动重叠的下游 + 新继续创作 → 不死循环、不重叠。
//  2) 来源摘要：循环边（绕过 canConnect 直接注入）→ 不无限递归。
//  3) 来源摘要：四层链显示「基于 … · 4 步」；五层链封顶返回空、不崩溃。
// 运行：node smoke/qa-probe-edge.cjs

'use strict';

const path = require('path');
const BASE = path.resolve(process.argv[2] || path.join(process.cwd(), '.icv-qa-current', 'v1'));

function makeEl(over = {}) {
  const el = {
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    style: {}, dataset: {}, value: '', disabled: false, title: '', children: [],
    addEventListener() {}, removeEventListener() {}, appendChild(child) { this.children.push(child); return child; },
    remove() {}, setAttribute() {}, removeAttribute() {}, focus() {}, select() {}, click() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    ...over,
  };
  let html = '';
  Object.defineProperty(el, 'innerHTML', { get: () => html, set: value => { html = String(value); }, configurable: true });
  return el;
}

const byId = new Map([['toast', makeEl()], ['ctx-menu', makeEl()]]);
global.pywebview = { api: { append_history: async () => ({ status: 'success' }), load_local_image: async () => ({ status: 'error' }) } };
global.window = {
  addEventListener() {}, removeEventListener() {}, close() {},
  setTimeout, clearTimeout, setInterval() { return 1; }, clearInterval() {},
  requestAnimationFrame: fn => fn(),
  innerWidth: 1280, innerHeight: 800, pywebview: global.pywebview,
};
global.Image = class {
  set onload(fn) { this._onload = fn; }
  get onload() { return this._onload; }
  set onerror(fn) { this._onerror = fn; }
  get onerror() { return this._onerror; }
  set src(value) { this._src = value; if (this._onload) this._onload(); }
  get src() { return this._src || ''; }
  get naturalWidth() { return 800; }
  get naturalHeight() { return 600; }
};
global.document = {
  getElementById: id => byId.get(id) || null,
  createElement: tag => tag === 'canvas'
    ? makeEl({ width: 0, height: 0, getContext: () => ({ fillStyle: '', fillRect() {}, drawImage() {} }), toDataURL: () => 'data:image/png;base64,COMPOSED' })
    : makeEl(),
  createElementNS: () => makeEl(),
  addEventListener() {}, removeEventListener() {},
  body: makeEl(), documentElement: makeEl(),
  querySelector() { return null; }, querySelectorAll() { return []; }, elementFromPoint() { return null; }, activeElement: null,
};
global.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };

const { nodeRegistry } = require(path.join(BASE, 'nodes/node-registry.js'));
require(path.join(BASE, 'nodes/image-gen.js'));
require(path.join(BASE, 'nodes/text-gen.js'));
require(path.join(BASE, 'nodes/text-split.js'));
const { flowState } = require(path.join(BASE, 'state/flow-state.js'));
const { actionBar, canContinueFrom } = require(path.join(BASE, 'ui/action-bar.js'));
const { cardView } = require(path.join(BASE, 'canvas/card-view.js'));

let passed = 0;
const fail = m => { throw new Error(m); };
const check = (c, m) => { if (!c) fail(m); passed += 1; };
const H = ratio => 260 / (ratio > 0 ? ratio : 4 / 3);

function reset() { flowState.nodes = []; flowState.edges = []; flowState.selectedIds.clear(); }

function imgNode(x, y, url, over = {}) {
  return flowState.addNode('image-gen', x, y, {
    imageUrl: url, status: 'done', ratio: 4 / 3,
    params: { prompt: 'p', model: 'm', aspectRatio: '4:3', resolution: '2k', count: 1 },
    ...over,
  });
}

// ── 1) 极端布局：25 个重叠下游，继续创作应终止且不重叠 ──
reset();
const source = imgNode(0, 0, 'data:image/png;base64,S');
for (let i = 0; i < 25; i += 1) {
  const sib = imgNode(308, 0, 'data:image/png;base64,SIB' + i);
  flowState.edges.push({ id: 'e' + i, from: source.id, to: sib.id });
}
flowState.selectedIds.add(source.id);
const before = flowState.nodes.length;
actionBar._handleAction('continue');
check(flowState.nodes.length === before + 1, '极端布局：25 个重叠下游下成功创建新步骤（未死循环）');
const created = flowState.nodes[flowState.nodes.length - 1];
const ch = H(created.ratio);
const overlap = flowState.nodes.some(sib => {
  if (sib.id === created.id || sib.id === source.id) return false;
  const sh = H(sib.ratio);
  return created.y < sib.y + sh && sib.y < created.y + ch;
});
check(!overlap, '极端布局：新步骤与全部 25 个重叠下游均不重叠 (created.y=' + created.y + ')');

// ── 2) 循环边（绕过 canConnect）：BFS 沿环遍历也不无限递归 ──
reset();
const a = imgNode(0, 0, null, { status: 'idle', refImages: [] });
const b = imgNode(308, 0, null, { status: 'idle', refImages: [] });
const c = imgNode(616, 0, null, { status: 'idle', refImages: [] });
flowState.edges.push({ id: 'ab', from: a.id, to: b.id });
flowState.edges.push({ id: 'bc', from: b.id, to: c.id });
flowState.edges.push({ id: 'ca', from: c.id, to: a.id });
const cycleLabel = cardView._provenanceLabel(a);
check(cycleLabel === '', '循环边：来源摘要沿环 BFS 后终止并返回空（实际="' + cycleLabel + '"）');

// ── 3a) 四层链：基于 … · 4 步 ──
reset();
const x = imgNode(0, 0, null, { status: 'idle', refImages: [] });
const t1 = flowState.addNode('text-gen', 308, 0);
const t2 = flowState.addNode('text-gen', 616, 0);
const t3 = flowState.addNode('text-gen', 924, 0);
const imgSrc = imgNode(1232, 0, 'data:image/png;base64,ROOT');
flowState.edges.push({ id: 'x1', from: t1.id, to: x.id });
flowState.edges.push({ id: '12', from: t2.id, to: t1.id });
flowState.edges.push({ id: '23', from: t3.id, to: t2.id });
flowState.edges.push({ id: '3r', from: imgSrc.id, to: t3.id });
const four = cardView._provenanceLabel(x);
check(four.includes('基于') && four.includes('· 4 步'), '四层链：显示「基于 … · 4 步」（实际="' + four + '"）');

// ── 3b) 五层链：封顶返回空、不崩溃 ──
reset();
const x2 = imgNode(0, 0, null, { status: 'idle', refImages: [] });
const u1 = flowState.addNode('text-gen', 308, 0);
const u2 = flowState.addNode('text-gen', 616, 0);
const u3 = flowState.addNode('text-gen', 924, 0);
const u4 = flowState.addNode('text-gen', 1232, 0);
const imgSrc2 = imgNode(1540, 0, 'data:image/png;base64,ROOT2');
flowState.edges.push({ id: 'x1', from: u1.id, to: x2.id });
flowState.edges.push({ id: '12', from: u2.id, to: u1.id });
flowState.edges.push({ id: '23', from: u3.id, to: u2.id });
flowState.edges.push({ id: '34', from: u4.id, to: u3.id });
flowState.edges.push({ id: '4r', from: imgSrc2.id, to: u4.id });
const five = cardView._provenanceLabel(x2);
check(five === '', '五层链：超过四层封顶返回空、不崩溃（实际="' + five + '"）');

console.log('QA 深度探针通过：' + passed + ' 项');
