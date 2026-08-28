// 继续创作（从图片开始下一步）回归：两个入口共用同一函数、参数继承/清空规则、
// 不复制图片、不覆盖源节点、多下游纵向不重叠、来源由边派生为参考图。
// 运行：
//   node node_modules/typescript/bin/tsc -p tsconfig.smoke.json --outDir .icv-qa-current
//   node smoke/qa-continue-step.cjs

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
global.pywebview = { api: {
  append_history: async () => ({ status: 'success' }),
  load_local_image: async () => ({ status: 'error' }),
} };
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
const { selection } = require(path.join(BASE, 'state/selection.js'));
const { flowHistory } = require(path.join(BASE, 'state/history.js'));
const { actionBar, canContinueFrom } = require(path.join(BASE, 'ui/action-bar.js'));
const { interactions } = require(path.join(BASE, 'canvas/interactions.js'));

let passed = 0;
const fail = message => { throw new Error(message); };
const check = (condition, message) => { if (!condition) fail(message); passed += 1; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function reset() {
  flowState.nodes = [];
  flowState.edges = [];
  flowState.selectedIds.clear();
  flowHistory.clear();
}

/** 有输出图的来源（素材/结果都具备 imageUrl + ratio） */
function sourceNode(over = {}) {
  return flowState.addNode('image-gen', 0, 0, {
    imageUrl: 'data:image/png;base64,SOURCE', status: 'done', ratio: 4 / 3,
    params: { prompt: '旧提示词', model: 'demo:gemini-2.5-flash-image', aspectRatio: '16:9', resolution: '4k', count: 1 },
    ...over,
  });
}

/** 断言某节点未被继续创作改动（不覆盖源节点） */
function assertSourceUntouched(source, label) {
  check(source.imageUrl === 'data:image/png;base64,SOURCE', `${label}：源节点图片未被覆盖`);
  check(source.params.prompt === '旧提示词', `${label}：源节点提示词未被覆盖`);
  check(source.status === 'done', `${label}：源节点状态未被覆盖`);
  check(flowState.nodes.includes(source), `${label}：源节点仍在画布中`);
}

/** 断言新步骤符合 Phase 1 规格 */
function assertStepShape(step, source, label) {
  check(step.type === 'image-gen', `${label}：新步骤为 image-gen`);
  check(step.x === source.x + 260 + 48, `${label}：新步骤位于源图右侧`);
  check(step.params.prompt === '', `${label}：新步骤提示词为空`);
  check(step.params.count === 1, `${label}：新步骤张数默认 1`);
  check(step.params.model === 'demo:gemini-2.5-flash-image', `${label}：新步骤继承模型`);
  check(step.params.aspectRatio === '16:9', `${label}：新步骤继承比例`);
  check(step.params.resolution === '4k', `${label}：新步骤继承分辨率`);
  check((step.refImages || []).length === 0, `${label}：源图不写入新步骤 refImages（来源由边派生）`);
  check(flowState.edges.some(edge => edge.from === source.id && edge.to === step.id), `${label}：已自动连接源图`);
  check(step.status === 'idle', `${label}：自动连线不把新步骤标 stale（suppressStale 生效）`);
  check(selection.single()?.id === step.id, `${label}：自动选中新步骤`);
  check(flowState.getReferenceImages(step.id).includes('data:image/png;base64,SOURCE'), `${label}：任务面板参考图区可见源图`);
}

/** 两张卡垂直区间是否相交 */
function overlapsY(a, b) {
  const ha = (a.h ?? 260 / (a.ratio > 0 ? a.ratio : 4 / 3));
  const hb = (b.h ?? 260 / (b.ratio > 0 ? b.ratio : 4 / 3));
  return a.y < b.y + hb && b.y < a.y + ha;
}

async function main() {
  // 1. 守卫：文本节点 / 无图节点不能继续创作。
  reset();
  const textNode = flowState.addNode('text-gen', 0, 0);
  check(!canContinueFrom(textNode), '守卫：文本节点不可继续创作');
  selection.select(textNode.id);
  actionBar._handleAction('continue');
  await tick();
  check(flowState.nodes.length === 1, '守卫：文本节点发起继续创作不建节点');

  reset();
  const emptyNode = flowState.addNode('image-gen', 0, 0);
  check(!canContinueFrom(emptyNode), '守卫：无图且无参考图的 image-gen 不可继续创作');
  actionBar._handleAction('continue');
  await tick();
  check(flowState.nodes.length === 1, '守卫：无图节点发起继续创作不建节点');

  // 2. 有参考图但无输出图：仍可继续创作（可用参考图场景）。
  reset();
  const refOnly = flowState.addNode('image-gen', 0, 0, {
    refImages: ['data:image/png;base64,REFONLY'], ratio: 4 / 3,
    params: { prompt: '', model: 'demo:gemini-2.5-flash-image', aspectRatio: '4:3', resolution: '2k', count: 1 },
  });
  check(canContinueFrom(refOnly), '守卫：有可用参考图的节点可继续创作');
  selection.select(refOnly.id);
  actionBar._handleAction('continue');
  await tick();
  const refOnlyStep = flowState.nodes.find(n => n.id !== refOnly.id);
  check(!!refOnlyStep && refOnlyStep.type === 'image-gen', '可用参考图：创建新步骤');
  check(!!refOnlyStep && flowState.getReferenceImages(refOnlyStep.id).includes('data:image/png;base64,REFONLY'), '可用参考图：参考图进入新步骤上下文');

  // 3. 只有直接上游图片的空步骤：继续创作时仍要把该图片带入新步骤。
  reset();
  const upstreamSource = sourceNode();
  const linkedEmpty = flowState.addNode('image-gen', 308, 0, {
    ratio: 4 / 3,
    params: { prompt: '', model: 'demo:gemini-2.5-flash-image', aspectRatio: '4:3', resolution: '2k', count: 1 },
  });
  flowState.addEdge(upstreamSource.id, linkedEmpty.id, { suppressStale: true });
  check(canContinueFrom(linkedEmpty), '上游图片：只有连线图片的节点可继续创作');
  selection.select(linkedEmpty.id);
  actionBar._handleAction('continue');
  await tick();
  const linkedStep = flowState.nodes.find(n => n.id !== upstreamSource.id && n.id !== linkedEmpty.id);
  check(!!linkedStep, '上游图片：创建新步骤');
  check(!!linkedStep && flowState.edges.some(edge => edge.from === linkedEmpty.id && edge.to === linkedStep.id), '上游图片：保留来源步骤连线');
  check(!!linkedStep && flowState.edges.some(edge => edge.from === upstreamSource.id && edge.to === linkedStep.id), '上游图片：复用图片来源连线');
  check(!!linkedStep && flowState.getReferenceImages(linkedStep.id).includes('data:image/png;base64,SOURCE'), '上游图片：新步骤参考图区保留原图');

  // 4. 操作条入口：素材 → 继续创作。
  reset();
  const source = sourceNode();
  selection.select(source.id);
  actionBar._handleAction('continue');
  await tick();
  const steps = flowState.nodes.filter(n => n.id !== source.id);
  check(steps.length === 1, '操作条入口：创建 1 个新步骤');
  assertSourceUntouched(source, '操作条入口');
  assertStepShape(steps[0], source, '操作条入口');

  // 5. 右键菜单入口：与操作条调用同一函数（共享守卫与创建逻辑）。
  interactions._showCardMenu(0, 0, source);
  check(byId.get('ctx-menu').innerHTML.includes('data-act="continue"'), '右键菜单：展示继续创作项');
  interactions._handleMenuAction('continue', source.id);
  await tick();
  const afterMenu = flowState.nodes.filter(n => n.id !== source.id);
  check(afterMenu.length === 2, '右键菜单入口：创建第二个下游');
  check(afterMenu.every(step => flowState.edges.some(edge => edge.from === source.id && edge.to === step.id)), '右键菜单入口：两个下游均已连线');
  check(!overlapsY(afterMenu[0], afterMenu[1]), '多下游：两次继续创作互不垂直重叠');

  // 6. 手动移动下游后再从同一来源继续创作：新步骤避开已有下游，不产生重叠。
  const moved = afterMenu[0];
  moved.y = 480; // 模拟用户手动下移
  selection.select(source.id); // 从同一来源继续（操作条作用于当前选中节点）
  actionBar._handleAction('continue');
  await tick();
  const third = flowState.nodes.find(n => n.id !== source.id && n.id !== afterMenu[0].id && n.id !== afterMenu[1].id);
  check(!!third, '错开落位：创建第三个下游');
  check(!overlapsY(third, afterMenu[0]) && !overlapsY(third, afterMenu[1]), '错开落位：新步骤与既有下游均不重叠');

  // 7. 删除下游步骤不删除源图（源节点保留、连线清理；历史/资产不误删由既有资产测试覆盖）。
  reset();
  const s2 = sourceNode();
  selection.select(s2.id);
  actionBar._handleAction('continue');
  await tick();
  const s2Step = flowState.nodes.find(n => n.id !== s2.id);
  flowState.removeNode(s2Step.id);
  check(flowState.nodes.length === 1 && flowState.nodes[0].id === s2.id, '删除下游：源节点保留');
  check(flowState.edges.length === 0, '删除下游：相关连线清理');

  console.log(`继续创作回归通过：${passed} 项断言`);
}

main().catch(error => { console.error(`继续创作回归失败：${error.message}`); process.exit(1); });
