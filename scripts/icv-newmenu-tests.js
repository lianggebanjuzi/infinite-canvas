// ICV v1 拖线松手 → 新建节点菜单桩测试（P0）
// 覆盖：菜单候选列表=非 product-image 类型（style-transfer/image-gen，未来新类型自动出现）/
//       弹菜单本身不建节点 / 选择后 addEdge 正确（from→new）且节点中心对准松手点 /
//       取消（cancel-connect）不建节点 / 松手在合法 in 端口正常连线且不弹菜单 /
//       松手在空白弹菜单 / 模型回填
//
// 用法：先 npx tsc -p tsconfig.smoke.json 编译 src/v1 到 G:/tmp/icv-test，再 node scripts/icv-newmenu-tests.js

/* eslint-disable no-console */
const path = require('path');

// ── 浏览器全局桩（富 DOM：支持 ctx-menu 元素/元素命中）──
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
  // ctx-menu 返回持久元素（可检查 show class）；其余为 null
  getElementById: id => (id === 'ctx-menu' ? menuEl : null),
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => makeEl(),
  createElementNS: () => makeEl(),
  elementFromPoint: () => null, // 默认空白；用例内按需覆盖
  addEventListener: () => {},
  documentElement: { setAttribute() {}, getAttribute: () => 'light' },
  body: { appendChild() {} },
};
global.localStorage = {
  _s: { icv_default_model: 'provA:modelX' }, // 预置默认模型，避免 resolveDefaultModel 打 backend
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

const tick = () => new Promise(r => setTimeout(r, 0));

// 便捷构造：一个带图产品图
function setupProduct() {
  flowState.clear();
  const p = flowState.addNode('product-image', 0, 0);
  flowState.setNodeImage(p.id, 'data:image/png;base64,A', 3 / 4);
  flowState.updateNode(p.id, { status: 'done' });
  return p;
}

// 设置拖线状态（fromId 为拖出端口的源节点）
function setConnectDrag(fromId) {
  interactions.drag = {
    mode: 'connect',
    startX: 0,
    startY: 0,
    moved: false,
    nodeId: fromId,
    group: null,
    panVx: 0,
    panVy: 0,
    selX: 0,
    selY: 0,
  };
}

(async () => {
  // ═══════ 1. 菜单候选列表 = 非 product-image 类型 ═══════
  {
    const cands = interactions._newNodeCandidates();
    const types = cands.map(d => d.type).sort();
    assert(types.includes('style-transfer') && types.includes('image-gen'), `候选含 style-transfer/image-gen（got: ${types.join(',')}）`);
    assert(!types.includes('product-image'), '候选不含 product-image（产品图不能作下游）');
    assert(cands.length === nodeRegistry.list().filter(d => d.type !== 'product-image').length, '候选与 registry 过滤口径一致');
  }

  // ═══════ 2. 弹菜单本身不建节点（仅显示，等待选择） ═══════
  {
    const p = setupProduct();
    const before = flowState.nodes.length;
    interactions._showNewNodeMenu(300, 200, p.id);
    assert(flowState.nodes.length === before, '弹菜单不创建节点');
    assert(menuEl._classes.has('show'), '菜单已显示（show class）');
    assert((menuEl.innerHTML || '').includes('图片生成') && (menuEl.innerHTML || '').includes('换风格'), '菜单项含图片生成/换风格');
    assert(menuEl.dataset.nodeId === p.id, '菜单记录源节点 id（fromId）');
    // 关闭菜单（Esc/点击外部路径 → 仅隐藏）仍不建节点
    interactions._hideMenu();
    assert(flowState.nodes.length === before, '关闭菜单不创建节点');
  }

  // ═══════ 3. 选择类型 → 创建节点 + 自动连线 + 选中 + 位置居中 + 模型回填 ═══════
  {
    const p = setupProduct();
    const before = flowState.nodes.length;
    interactions._createNodeFromMenu('style-transfer', p.id, 300, 200);
    await tick(); // 等模型回填微任务
    assert(flowState.nodes.length === before + 1, '选择后新建 1 个节点');
    const n = flowState.nodes.find(x => x.type === 'style-transfer');
    assert(!!n, '新节点类型 style-transfer');
    assert(flowState.edges.some(e => e.from === p.id && e.to === n.id), '自动连上拖出的线（from→new）');
    assert(selection.single()?.id === n.id, '新节点被选中');
    // 节点中心对准松手点（世界坐标 240,160：panX60 panY40 scale1）
    const world = { x: (300 - 60) / 1, y: (200 - 40) / 1 };
    const h = 260 / (3 / 4);
    assert(Math.abs(n.x + 260 / 2 - world.x) < 0.001, `节点中心 x 对准松手点（got ${n.x + 130}）`);
    assert(Math.abs(n.y + h / 2 - world.y) < 0.001, `节点中心 y 对准松手点（got ${n.y + h / 2}）`);
    assert((flowState.getNode(n.id).params.model || '') === 'provA:modelX', '模型回填默认模型');
  }

  // ═══════ 4. 取消（cancel-connect）不建节点 ═══════
  {
    const p = setupProduct();
    const before = flowState.nodes.length;
    interactions._handleMenuAction('cancel-connect', p.id);
    assert(flowState.nodes.length === before, '取消不创建节点');
    assert(flowState.edges.length === 0, '取消不产生连线');
  }

  // ═══════ 5. 松手在合法 in 端口 → 正常连线且不弹菜单（回归） ═══════
  {
    flowState.clear();
    const p = flowState.addNode('product-image', 0, 0);
    flowState.setNodeImage(p.id, 'data:image/png;base64,A', 3 / 4);
    const s = flowState.addNode('style-transfer', 300, 0);
    const toId = s.id;
    // 构造命中：elementFromPoint 返回 in 端口 → closest('.port.in') 命中、closest('.pcard') 返回卡片
    const fakeCard = makeEl();
    fakeCard.dataset.nodeId = toId;
    fakeCard.closest = sel => (sel === '.pcard' ? fakeCard : null);
    const fakeInPort = makeEl();
    fakeInPort.closest = sel => (sel === '.port.in' ? fakeInPort : sel === '.pcard' ? fakeCard : null);
    document.elementFromPoint = () => fakeInPort;

    setConnectDrag(p.id);
    menuEl._classes.delete('show'); // 复位菜单状态
    interactions._finishConnect({ clientX: 320, clientY: 30 });
    assert(flowState.edges.some(e => e.from === p.id && e.to === toId), '合法端口 → 正常连线（回归）');
    assert(flowState.nodes.length === 2, '合法端口 → 不新建节点');
    assert(!menuEl._classes.has('show'), '合法端口 → 不弹新建菜单');
  }

  // ═══════ 6. 松手在空白 → 弹新建菜单且不建节点 ═══════
  {
    const p = setupProduct();
    const before = flowState.nodes.length;
    document.elementFromPoint = () => null; // 空白
    menuEl._classes.delete('show');
    setConnectDrag(p.id);
    interactions._finishConnect({ clientX: 500, clientY: 300 });
    assert(flowState.nodes.length === before, '空白松手不建节点（等待选择）');
    assert(flowState.edges.length === 0, '空白松手不产生连线');
    assert(menuEl._classes.has('show'), '空白松手 → 弹出新建菜单');
    assert((menuEl.innerHTML || '').includes('松手新建节点并连接'), '菜单含引导文案');
  }

  console.log(`\n拖线新建菜单测试结束：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail > 0 ? 1 : 0;
})().catch(e => { console.error('测试执行异常:', e); process.exitCode = 2; });
