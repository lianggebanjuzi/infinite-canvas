// ICV v1 QA 独立复核：拖线新建菜单扩展性（严过关 / Edward 独立编写）
// 场景：注册一个"未来新类型" fake-node 后，菜单候选自动包含它；
//       选择该类型后 _createNodeFromMenu 能建节点+自动连线（走 default 图标分支）。
//
// 用法：先 npx tsc -p tsconfig.smoke.json --outDir G:/tmp/icv-test，再 node scripts/icv-qa-newmenu-ext-test.js

/* eslint-disable no-console */
const path = require('path');

function makeEl() {
  const classes = new Set();
  return {
    _classes: classes,
    style: {},
    dataset: {},
    innerHTML: '',
    className: '',
    id: '',
    title: '',
    classList: {
      add: c => classes.add(c),
      remove: c => classes.delete(c),
      toggle: (c, force) => {
        if (force === undefined) {
          if (classes.has(c)) { classes.delete(c); return false; }
          classes.add(c); return true;
        }
        if (force) classes.add(c); else classes.delete(c);
        return force;
      },
      contains: c => classes.has(c),
    },
    appendChild: () => {},
    remove: () => {},
    setAttribute: () => {},
    removeAttribute: () => {},
    addEventListener: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 120, right: 200, bottom: 120 }),
    closest: () => null,
  };
}

const menuEl = makeEl();
global.window = { innerWidth: 1200, innerHeight: 800 };
global.document = {
  getElementById: id => (id === 'ctx-menu' ? menuEl : null),
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => makeEl(),
  createElementNS: () => makeEl(),
  elementFromPoint: () => null,
  addEventListener: () => {},
  documentElement: { setAttribute() {}, getAttribute: () => 'light' },
  body: { appendChild() {} },
};
global.localStorage = {
  _s: { icv_default_model: 'provA:modelX' },
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
const { selection } = load('v1/state/selection.js');
const { nodeRegistry } = load('v1/nodes/node-registry.js');
const { interactions } = load('v1/canvas/interactions.js');
load('v1/nodes/product-image.js');
load('v1/nodes/style-transfer.js');
load('v1/nodes/image-gen.js');

let pass = 0, fail = 0;
const assert = (cond, msg) => {
  if (!cond) { fail++; console.error('✗ FAIL:', msg); }
  else { pass++; console.log('✓ PASS:', msg); }
};

// ── 注册"未来新类型"（扩展性验证；仅本进程内有效） ──
nodeRegistry.register({
  type: 'fake-node',
  label: '假节点',
  defaultTitle: '假节点',
  defaultRatio: 1,
  defaultParams: { prompt: '', model: '', aspectRatio: '1:1', resolution: '2k', count: 1 },
  canRun: () => '假节点暂不可运行',
  buildOptions: () => ({}),
});

(async () => {
  // ═══════ 1. 候选列表自动包含新类型 ═══════
  {
    const cands = interactions._newNodeCandidates();
    const types = cands.map(d => d.type);
    assert(types.includes('fake-node'), `候选自动包含新注册类型 fake-node（got: ${types.join(',')}）`);
    assert(!types.includes('product-image'), '候选仍不含 product-image');
    assert(types.includes('style-transfer') && types.includes('image-gen'), '既有类型仍在候选');
    assert(cands.length === nodeRegistry.list().filter(d => d.type !== 'product-image').length, '候选与 registry 过滤口径一致（含新类型）');
  }

  // ═══════ 2. 菜单渲染含新类型项（走 default 图标分支，不崩） ═══════
  {
    flowState.clear();
    const p = flowState.addNode('product-image', 0, 0);
    flowState.setNodeImage(p.id, 'data:image/png;base64,A', 3 / 4);
    interactions._showNewNodeMenu(300, 200, p.id);
    assert((menuEl.innerHTML || '').includes('data-act="create-node" data-node-type="fake-node"'), '菜单 HTML 含新类型项');
    assert((menuEl.innerHTML || '').includes('假节点'), '菜单显示新类型 label');
    assert(menuEl.dataset.nodeId === p.id, '菜单记录源节点 id');
  }

  // ═══════ 3. 选择新类型 → 建节点 + 自动连线 + 选中 ═══════
  {
    const p = flowState.getNode(flowState.nodes.find(n => n.type === 'product-image').id);
    const before = flowState.nodes.length;
    interactions._createNodeFromMenu('fake-node', p.id, 300, 200);
    assert(flowState.nodes.length === before + 1, '选择新类型后新建 1 个节点');
    const n = flowState.nodes.find(x => x.type === 'fake-node');
    assert(!!n, '新节点类型 fake-node');
    assert(flowState.edges.some(e => e.from === p.id && e.to === n.id), '自动连上拖出的线（from→fake-node）');
    assert(selection.single()?.id === n.id, '新节点被选中');
  }

  console.log(`\nQA 独立复核（拖线新建菜单扩展性）结束：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail > 0 ? 1 : 0;
})().catch(e => { console.error('测试执行异常:', e); process.exitCode = 2; });
