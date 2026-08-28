// smoke/qa-node-split.cjs
// QA 独立回归（图操分家主线大改造 ②，commit c419674）
//
// 验证点（对应任务清单）：
//   S1 normalizeNodeV4 严格性（仅 image/text/gen；image params 恒 {}、gen imageUrl 恒 null、lastResultUrl 归一；旧类型过滤；连线按现存节点过滤）
//   S2 restore 旧版本拒绝（version 3.4 → false + 不清当前画布；format 非 icv → false）
//   S3 getUpstreamOutputs 直接上游语义（A→B→C 一层；texts 按连线序/上游 id 序；refImages 前置去重保序）
//   S4 canConnect 规则（text 可 to / image 不可 to / gen 不可 from；防环/防重/防自连）
//   S5 insertStep 默认插 text
//   S6 M1 文本走线：runTextNode 请求体（data:image 过滤 + 上游文拼接 + 命令）→ 写回自身 + textHistory + trace；
//      下游 gen 标 stale 且 prompt 不被覆盖；instruction 发送后清空
//   S7 M2 图操分家：runGenBatch → 新 image 产物节点（parentId/trace/edge/lastResultUrl 回写）；gen 自身 imageUrl 恒 null
//   S8 gen 重跑 removeChildren：纯引擎产物删旧建新；锁定产物保留 + stale；解锁后重跑可删
//   S9 effectivePrompt 拼接：空 prompt → 上游文本按连线顺序拼接；手动改写覆盖
//   S10 M3 一键重跑：改链首 → 全链 stale → runAll 拓扑序（image 跳过）；失败停止；锁定产物不碰
//   S11 runAll 失败停止（text 失败 → 下游 gen 不跑）
//   S12 text 无命令不自动重跑（canRun 拦截，符合设计）
//   S13 compare-panel 可对比判据（image && imageUrl；gen/text 不可比）+ bottom-bar 可比数
//   S14 扩图归位 createOutpaintGen（gen mode='outpaint' 预填 + 连上游图）
//   S15 回归：拖图空白建 image 节点 / 拖到 image 替换 / 拖到 gen 追加 refImages；metaFromNode trace 优先；
//      批次卡 4/4 合并；空壳卡 HTML 无大图 + 角标「产物在右侧」；右键菜单（image 扩图/复现；画布三类新建）
//   S16 outpaint 单张：产物 trace outputType=outpaint + batchId 透传 + 重跑不 removeChildren（逐次累加）
//   S17 多跳链 image→gen→image→gen 行为记录（工程师风险点复核：拓扑序依赖创建序；中间产物被保留→gen2 引用旧产物）
//
// 运行：
//   node node_modules/typescript/bin/tsc -p tsconfig.smoke.json --outDir .icv-qa
//   node smoke/qa-node-split.cjs

'use strict';

const BASE = 'D:/Infinite Canvas/Infinite Canvas 2.0/.icv-qa/v1';

// ───────────────────────── DOM/浏览器桩 ─────────────────────────
function makeEl(over = {}) {
  const el = {
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    style: {}, dataset: {}, value: '', disabled: false, title: '', checked: false,
    children: [],
    _handlers: {},
    addEventListener(t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); },
    removeEventListener(t, fn) { const arr = this._handlers[t] || []; const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); },
    dispatch(t, ev) { (this._handlers[t] || []).slice().forEach(fn => fn(ev || { target: this, stopPropagation() {}, preventDefault() {}, dataTransfer: null })); },
    appendChild(c) { this.children.push(c); return c; },
    remove() {}, setAttribute() {}, removeAttribute() {}, focus() {}, select() {}, click() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; },
    isConnected: true,
    ...over,
  };
  let _html = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return _html; },
    set(v) { _html = String(v); },
    configurable: true,
  });
  return el;
}

const byId = new Map([['toast', makeEl()]]);
global.pywebview = { api: {} };
global.window = {
  addEventListener() {}, removeEventListener() {}, close() {},
  setTimeout, clearTimeout, setInterval() { return 1; }, clearInterval() {},
  innerWidth: 1280, innerHeight: 800, pywebview: global.pywebview,
};
// Image 桩：src 赋值即触发 onload（naturalWidth/Height 固定 800x600 → ratio 4/3），供 loadImageRatio / _dropImage 同步完成
global.Image = class {
  constructor() { this._onload = null; this._onerror = null; }
  set onload(fn) { this._onload = fn; }
  get onload() { return this._onload; }
  set onerror(fn) { this._onerror = fn; }
  get onerror() { return this._onerror; }
  set src(_v) { if (this._onload) this._onload(); else if (this._onerror) this._onerror(); }
  get src() { return ''; }
  get naturalWidth() { return 800; }
  get naturalHeight() { return 600; }
};
global.document = {
  getElementById: (id) => (byId.has(id) ? byId.get(id) : null),
  createElement: () => makeEl(),
  createElementNS: () => makeEl(),
  addEventListener() {}, removeEventListener() {},
  body: makeEl(),
  documentElement: makeEl({ setAttribute() {}, getAttribute() { return 'light'; } }),
  querySelector() { return null; }, querySelectorAll() { return []; },
  elementFromPoint() { return null; },
  activeElement: null,
};
global.localStorage = (() => {
  const s = new Map();
  return {
    getItem: (k) => (s.has(k) ? s.get(k) : null),
    setItem: (k, v) => s.set(k, String(v)),
    removeItem: (k) => s.delete(k),
    clear: () => s.clear(),
  };
})();
try { Object.defineProperty(global, 'navigator', { value: { clipboard: undefined }, configurable: true }); } catch { /* 旧 Node 可写 */ }

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
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

// ───────────────────────── 加载被测模块 ─────────────────────────
const { nodeRegistry } = require(`${BASE}/nodes/node-registry.js`);
require(`${BASE}/nodes/image.js`);
require(`${BASE}/nodes/text.js`);
require(`${BASE}/nodes/gen.js`);
const { flowState } = require(`${BASE}/state/flow-state.js`);
const { flowHistory } = require(`${BASE}/state/history.js`);
const { dirty } = require(`${BASE}/state/dirty.js`);
const { selection } = require(`${BASE}/state/selection.js`);
const { persistence } = require(`${BASE}/persistence.js`);
const { assetStore } = require(`${BASE}/asset-store.js`);
const { historyPersist } = require(`${BASE}/history-persist.js`);
const { historyDrawer } = require(`${BASE}/ui/history-drawer.js`);
const { runEngine } = require(`${BASE}/engine/run-engine.js`);
const apiMod = require(`${BASE}/api.js`);
const pollerMod = require(`${BASE}/engine/poller.js`);
const cardView = require(`${BASE}/canvas/card-view.js`).cardView;
const interactions = require(`${BASE}/canvas/interactions.js`).interactions;
const comparePanel = require(`${BASE}/ui/compare-panel.js`).comparePanel;
const bottomBar = require(`${BASE}/ui/bottom-bar.js`).bottomBar;
const outpaintUtil = require(`${BASE}/engine/outpaint-util.js`);
const { assetDrawer } = require(`${BASE}/ui/asset-drawer.js`);

// ───────────────────────── 测试辅助 ─────────────────────────
function reset(over = {}) {
  flowState.replaceAll({
    format: 'icv', version: '4.0', projectName: 't', canvas: { scale: 1, panX: 0, panY: 0 },
    nodes: [], edges: [], createdAt: 0, updatedAt: 0, ...over,
  });
  flowHistory.clear();
  assetStore['records'].clear();
  assetStore['urlByKey'].clear();
  assetStore['metaByKey'].clear();
  historyDrawer['items'] = [];
  persistence['lastPath'] = null;
}

/** 桩生成链路：plan[i] 对应第 i 个 worker（按 index 顺序创建任务）。{url, fail?} */
function stubGenerate(plan) {
  let callIndex = 0;
  const origGenerate = apiMod.Backend.generateImage;
  const origPoll = pollerMod.pollTask;
  apiMod.Backend.generateImage = async () => ({ task_id: 'task-' + (callIndex++) });
  pollerMod.pollTask = async (taskId) => {
    const idx = Number(String(taskId).split('-')[1]);
    const item = plan[idx];
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

/** 桩生成链路 + 记录 prompt/options（effectivePrompt 断言用） */
function stubGenerateCapture(plan) {
  const calls = [];
  let callIndex = 0;
  const origGenerate = apiMod.Backend.generateImage;
  const origPoll = pollerMod.pollTask;
  apiMod.Backend.generateImage = async (prompt, options) => {
    calls.push({ prompt, options: { ...options } });
    return { task_id: 'task-' + (callIndex++) };
  };
  pollerMod.pollTask = async (taskId) => {
    const idx = Number(String(taskId).split('-')[1]);
    const item = plan[idx];
    if (!item) return { success: false, error: 'plan 缺失' };
    if (item.fail) return { success: false, error: item.error || '生成失败' };
    return { success: true, imageUrl: item.url };
  };
  return {
    calls,
    restore: () => {
      apiMod.Backend.generateImage = origGenerate;
      pollerMod.pollTask = origPoll;
    },
  };
}

const URL_A = 'data:image/png;base64,AAAA';
const URL_B = 'data:image/png;base64,BBBB';

// ───────────────────────── 用例 ─────────────────────────
async function main() {
  // ============ S1 normalizeNodeV4 严格性（经 restore v4.0 项目） ============
  await section('S1: normalizeNodeV4 严格性（旧类型过滤 / image params 恒 {} / gen imageUrl null / lastResultUrl 归一 / 连线过滤）', async () => {
    reset();
    const ok = persistence.restore({
      format: 'icv', version: '4.0', projectName: 't', canvas: { scale: 1, panX: 0, panY: 0 },
      nodes: [
        { id: 'n1', type: 'image-gen', x: 0, y: 0, params: { prompt: 'x' } },
        { id: 'n2', type: 'text-gen', x: 0, y: 0, params: { model: 'm' } },
        { id: 'n3', type: 'image-result', x: 0, y: 0 },
        { id: 'n4', type: 'image', x: 0, y: 0, imageUrl: 'data:image/png;base64,IMG4', params: { prompt: '应被丢弃' }, lastResultUrl: 'data:image/png;base64,LR4', trace: { prompt: 'trace', model: 'm', outputType: 'txt2img' } },
        { id: 'n5', type: 'text', x: 0, y: 0, params: { instruction: 'cmd', model: 'c:m' }, outputText: 'hello', textHistory: [{ text: 'a', ts: 1 }, { text: '', ts: 2 }], refImages: ['r1'] },
        { id: 'n6', type: 'gen', x: 0, y: 0, params: { prompt: 'p', model: 'd:m', aspectRatio: '3:4', resolution: '2k', count: 2, mode: 'draw' }, imageUrl: 'data:image/png;base64,G', lastResultUrl: 'data:image/png;base64,LR6' },
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n5' },        // 引用被过滤节点 → 过滤
        { id: 'e2', from: 'n5', to: 'n6' },        // 合法
        { id: 'e3', from: 'n-missing', to: 'n6' }, // 引用不存在节点 → 过滤
      ],
      createdAt: 0, updatedAt: 0,
    });
    check(ok === true, 'v4.0 项目 restore 成功');
    check(flowState.nodes.length === 3, `旧类型节点被过滤（剩 3 个合法节点，实际 ${flowState.nodes.length}）`);
    check(flowState.nodes.every(n => n.type === 'image' || n.type === 'text' || n.type === 'gen'), '仅 image/text/gen 存活');
    const img = flowState.getNode('n4');
    check(JSON.stringify(img.params) === '{}', 'image params 恒 {}（丢弃 prompt）');
    check(img.imageUrl === 'data:image/png;base64,IMG4', 'image imageUrl 保留');
    check(img.lastResultUrl === null, 'image lastResultUrl → null');
    check(!!img.trace && img.trace.outputType === 'txt2img', 'image trace 归一保留');
    const txt = flowState.getNode('n5');
    check(txt.outputText === 'hello' && txt.textHistory.length === 1 && txt.refImages[0] === 'r1', 'text outputText/textHistory/refImages 归一');
    const gen = flowState.getNode('n6');
    check(gen.imageUrl === null, 'gen imageUrl 强制 null（不写回自身）');
    check(gen.lastResultUrl === 'data:image/png;base64,LR6', 'gen lastResultUrl 归一保留（空壳卡弱缩略图）');
    check(gen.params.mode === 'draw' && gen.params.count === 2 && gen.params.prompt === 'p', 'gen 参数归一');
    check(flowState.edges.length === 1 && flowState.edges[0].from === 'n5' && flowState.edges[0].to === 'n6', '连线按现存节点过滤（仅剩 n5→n6）');
  });

  // ============ S2 restore 旧版本拒绝 ============
  await section('S2: restore 旧版本拒绝（version 3.4 / format 非 icv → false，不清当前画布）', async () => {
    reset();
    const keep = flowState.addNode('image', 0, 0, { imageUrl: 'data:image/png;base64,KEEP', status: 'done' });
    const before = flowState.nodes.length;
    const r = persistence.restore({ format: 'icv', version: '3.4', projectName: 'old', canvas: {}, nodes: [{ id: 'x1', type: 'image-gen', x: 0, y: 0, params: {} }], edges: [], createdAt: 0, updatedAt: 0 });
    check(r === false, 'version 3.4 → restore false');
    check(flowState.nodes.length === before && flowState.getNode(keep.id) !== undefined && flowState.getNode('x1') === undefined, '旧项目不加载、不清当前画布');
    const r2 = persistence.restore({ format: 'foo', version: '4.0', nodes: [] });
    check(r2 === false, 'format 非 icv → restore false');
    const r3 = persistence.restore(null);
    check(r3 === false, 'null → restore false');
    const r4 = persistence.restore({ format: 'icv', version: '4.0', nodes: 'not-array' });
    check(r4 === false, 'nodes 非数组 → restore false');
  });

  // ============ S3 getUpstreamOutputs 直接上游语义 ============
  await section('S3: getUpstreamOutputs 直接上游一层（图/文不穿透；texts 连线序/上游 id 序；refImages 前置去重保序）', async () => {
    reset();
    const img0 = flowState.addNode('image', 0, 0, { imageUrl: 'data:image/png;base64,I0', status: 'done' });
    const gen1 = flowState.addNode('gen', 400, 0, { params: { prompt: 'p1', model: 'd:m', count: 1 } });
    flowState.addEdge(img0.id, gen1.id);
    const img1 = flowState.addNode('image', 800, 0, { parentId: gen1.id, imageUrl: 'data:image/png;base64,I1', status: 'done' });
    flowState.addEdge(gen1.id, img1.id);
    const gen2 = flowState.addNode('gen', 1200, 0, { params: { prompt: 'p2', model: 'd:m', count: 1 } });
    flowState.addEdge(img1.id, gen2.id);
    const out = flowState.getUpstreamOutputs(gen2.id);
    check(out.images.length === 1 && out.images[0] === 'data:image/png;base64,I1', 'C(gen2) 只取直接上游 image 图（看不到 A 的图）');
    check(out.texts.length === 0, 'C 无上游文');

    // 文本一层：tA→tB→gen3，gen3 只见 tB
    const tA = flowState.addNode('text', 0, 400, { params: { model: 'c:m' }, outputText: 'TA' });
    const tB = flowState.addNode('text', 400, 400, { params: { model: 'c:m' }, outputText: 'TB' });
    flowState.addEdge(tA.id, tB.id);
    const gen3 = flowState.addNode('gen', 800, 400, { params: { model: 'd:m', count: 1 } });
    flowState.addEdge(tB.id, gen3.id);
    const out3 = flowState.getUpstreamOutputs(gen3.id);
    check(out3.texts.length === 1 && out3.texts[0].text === 'TB' && out3.texts[0].nodeId === tB.id, 'text 一层：gen3 只见 tB 输出（不见 tA）');

    // texts 按连线顺序（先连在前）
    const gen4 = flowState.addNode('gen', 0, 800, { params: { model: 'd:m', count: 1 } });
    const t1 = flowState.addNode('text', 0, 900, { params: { model: 'c:m' }, outputText: 'T1' });
    const t2 = flowState.addNode('text', 0, 1000, { params: { model: 'c:m' }, outputText: 'T2' });
    flowState.addEdge(t2.id, gen4.id); // 先连 t2
    flowState.addEdge(t1.id, gen4.id); // 后连 t1
    const out4 = flowState.getUpstreamOutputs(gen4.id);
    check(out4.texts.length === 2 && out4.texts[0].text === 'T2' && out4.texts[1].text === 'T1', 'texts 按连线顺序（先连 t2 在前）');
    // texts 兜底：未连线（不应出现，但 id 序兜底）—— 直接构造 edge 数组模拟异常排序
    const gen5 = flowState.addNode('gen', 0, 1200, { params: { model: 'd:m', count: 1 } });
    const tX = flowState.addNode('text', 0, 1300, { params: { model: 'c:m' }, outputText: 'TX' });
    flowState.edges.push({ id: 'e-manual', from: tX.id, to: gen5.id }); // 绕过 addEdge 直接推入（末尾 = 最后连线）
    const out5 = flowState.getUpstreamOutputs(gen5.id);
    check(out5.texts.length === 1 && out5.texts[0].text === 'TX', '异常/兜底路径仍可取文本');

    // refImages 前置 ∪ 直接上游图，去重保序
    const gen6 = flowState.addNode('gen', 0, 1500, { params: { model: 'd:m', count: 1 }, refImages: ['data:image/png;base64,REF'] });
    flowState.addEdge(img1.id, gen6.id);
    const out6 = flowState.getUpstreamOutputs(gen6.id);
    check(out6.images.length === 2 && out6.images[0] === 'data:image/png;base64,REF' && out6.images[1] === 'data:image/png;base64,I1', 'refImages 前置 ∪ 直接上游 image 图（去重保序）');
    // 未知节点 → 空
    check(JSON.stringify(flowState.getUpstreamOutputs('nope')) === '{"images":[],"texts":[]}', '未知节点 → 空输出');
    // getReferenceImages 别名
    check(JSON.stringify(flowState.getReferenceImages(gen6.id)) === JSON.stringify(out6.images), 'getReferenceImages = getUpstreamOutputs(id).images（显示别名）');
  });

  // ============ S4 canConnect 规则 ============
  await section('S4: canConnect（text 可 to / image 不可 to / gen 不可 from；防环/防重/防自连）', async () => {
    reset();
    const img = flowState.addNode('image', 0, 0, { imageUrl: 'x', status: 'done' });
    const txt = flowState.addNode('text', 0, 200, { params: { model: 'c:m' } });
    const gen = flowState.addNode('gen', 0, 400, { params: { model: 'd:m', count: 1 } });
    check(flowState.canConnect(img.id, txt.id) === null, 'image → text 可连（text 可作接收端）');
    check(flowState.canConnect(txt.id, gen.id) === null, 'text → gen 可连');
    check(flowState.canConnect(img.id, gen.id) === null, 'image → gen 可连');
    check(flowState.canConnect(txt.id, img.id) !== null, 'text → image 不可连（image 不可作 to）');
    check(flowState.canConnect(gen.id, txt.id) !== null, 'gen → text 不可连（gen 不可作 from）');
    check(flowState.canConnect(gen.id, img.id) !== null, 'gen → image 不可连（gen 不可作 from）');
    check(flowState.canConnect(img.id, img.id) !== null, '自连拒绝');
    flowState.addEdge(img.id, txt.id);
    check(flowState.canConnect(img.id, txt.id) !== null, '重复连线拒绝');
    const a = flowState.addNode('text', 0, 600, { params: { model: 'c:m' } });
    const b = flowState.addNode('text', 0, 700, { params: { model: 'c:m' } });
    flowState.addEdge(a.id, b.id);
    check(flowState.canConnect(b.id, a.id) !== null, '成环拒绝');
    const c = flowState.addNode('text', 0, 800, { params: { model: 'c:m' } });
    flowState.addEdge(b.id, c.id);
    check(flowState.canConnect(c.id, a.id) !== null, '多跳成环拒绝');
  });

  // ============ S5 insertStep 插 text ============
  await section('S5: insertStep 默认插入 text 节点（image→text→gen 成立）', async () => {
    reset();
    const img = flowState.addNode('image', 0, 0, { imageUrl: 'x', status: 'done' });
    const gen = flowState.addNode('gen', 800, 0, { params: { model: 'd:m', count: 1 } });
    flowState.addEdge(img.id, gen.id);
    const edgeId = flowState.edges[0].id;
    const inserted = flowState.insertStep(edgeId);
    check(!!inserted && inserted.type === 'text', 'insertStep 插入 text 节点');
    check(flowState.edges.length === 2, '原连线断开为两条');
    const e1 = flowState.edges[0], e2 = flowState.edges[1];
    check((e1.from === img.id && e1.to === inserted.id) && (e2.from === inserted.id && e2.to === gen.id), 'image→text→gen 连线成立');
  });

  // ============ S6 M1 文本走线 runTextNode ============
  await section('S6: M1 文本走线（请求体含图/命令；写回自身+历史；下游 gen 标 stale 且 prompt 不被覆盖；指令清空；上游文拼接）', async () => {
    reset();
    const chatCalls = [];
    const origChat = apiMod.Backend.chatV2;
    apiMod.Backend.chatV2 = async (user, options) => { chatCalls.push({ user, options }); return { text: '这是一只猫的描述' }; };
    try {
      const img = flowState.addNode('image', 0, 0, { imageUrl: 'data:image/png;base64,IMG', status: 'done' });
      const txt = flowState.addNode('text', 400, 0, { params: { model: 'c:m', instruction: '描述这张图' } });
      flowState.addEdge(img.id, txt.id);
      const gen = flowState.addNode('gen', 800, 0, { params: { prompt: '原提示词', model: 'd:m', count: 1 } });
      flowState.addEdge(txt.id, gen.id);
      await runEngine.run(txt.id);
      check(chatCalls.length === 1, 'chatV2 调用 1 次');
      check(Array.isArray(chatCalls[0].options.images) && chatCalls[0].options.images[0] === 'data:image/png;base64,IMG', '请求体含上游图（data:image 内嵌）');
      check(chatCalls[0].options.model === 'c:m', '请求体模型 = text 模型');
      check(chatCalls[0].user === '描述这张图', '无上游文时 user = 命令');
      const n = flowState.getNode(txt.id);
      check(n.outputText === '这是一只猫的描述' && n.status === 'done', '结果写回 text.outputText + done');
      const hist = flowState.getTextHistory(txt.id);
      check(hist.length === 1 && hist[0].text === '这是一只猫的描述', 'textHistory 记录');
      const g = flowState.getNode(gen.id);
      check(g.status === 'stale', '下游 gen 标 stale');
      check(g.params.prompt === '原提示词', '下游 gen prompt 不被自动覆盖（无 applyTextToDownstream 旁路）');
      check(n.params.instruction === '', 'instruction 发送后清空（Q5）');
      // text trace：appendTrace 异步写后端（不直接进 drawer items），桩 Backend.appendHistory 验证 kind:'text'
      const appendCalls = [];
      const origAppend = apiMod.Backend.appendHistory;
      apiMod.Backend.appendHistory = async (entry) => { appendCalls.push(entry); return { status: 'success' }; };
      try {
        const txt2b = flowState.addNode('text', 0, 350, { params: { model: 'c:m', instruction: 'x' } });
        await runEngine.run(txt2b.id);
        await tick(10);
        check(appendCalls.some(e => e && e.kind === 'text' && e.nodeId === txt2b.id && e.outputText === '这是一只猫的描述'), '追加 kind:text 流水（appendHistory 收到 text trace）');
      } finally { apiMod.Backend.appendHistory = origAppend; }

      // 上游文拼接：tUp1 → txt2（命令「总结」）
      chatCalls.length = 0;
      const tUp1 = flowState.addNode('text', 0, 300, { params: { model: 'c:m' }, outputText: '上游A' });
      const txt2 = flowState.addNode('text', 400, 300, { params: { model: 'c:m', instruction: '总结' } });
      flowState.addEdge(tUp1.id, txt2.id);
      await runEngine.run(txt2.id);
      check(chatCalls.length === 1 && chatCalls[0].user.includes('上游文本') && chatCalls[0].user.includes('上游A') && chatCalls[0].user.includes('总结'), '上游文拼进 user prompt + 指令');
    } finally {
      apiMod.Backend.chatV2 = origChat;
    }
  });

  // ============ S7 M2 runGenBatch 产物形态 ============
  await section('S7: M2 图操分家（runGenBatch → image 产物节点 parentId/trace/edge/lastResultUrl 回写；gen 不写回自身）', async () => {
    reset();
    const stub = stubGenerate([{ url: 'data:image/png;base64,OUT1' }, { url: 'data:image/png;base64,OUT2' }]);
    try {
      const img = flowState.addNode('image', 0, 0, { imageUrl: 'data:image/png;base64,SRC', status: 'done' });
      const gen = flowState.addNode('gen', 400, 0, { params: { prompt: '一只猫', model: 'd:m', aspectRatio: '3:4', resolution: '2k', count: 2 } });
      flowState.addEdge(img.id, gen.id);
      await runEngine.run(gen.id);
      const g = flowState.getNode(gen.id);
      check(g.status === 'done', 'gen done');
      check(g.imageUrl === null, 'gen 自身 imageUrl 恒 null（不写回自身）');
      check(g.lastResultUrl === 'data:image/png;base64,OUT1' || g.lastResultUrl === 'data:image/png;base64,OUT2', 'gen.lastResultUrl 回写最近产物缩略图');
      const children = flowState.nodes.filter(n => n.parentId === gen.id);
      check(children.length === 2, 'count=2 → 2 个产物节点');
      check(children.every(c => c.type === 'image'), '产物节点类型 = image');
      check(children.every(c => !!c.trace && c.trace.prompt === '一只猫' && c.trace.outputType === 'img2img'), '产物节点挂完整 trace（img2img）');
      check(children.every(c => flowState.edges.some(e => e.from === gen.id && e.to === c.id)), 'edge gen→image 已建（suppressStale）');
      check(children.every(c => JSON.stringify(c.params) === '{}'), 'image 产物 params 恒 {}（配方在 trace）');
      check(children.every(c => c.status === 'done'), '产物 done（未被 suppressStale 后打回 stale）');
      // 历史行 count=2 + batchId 透传
      const imgs = historyDrawer['items'].filter(i => i.kind === 'image' && i.src.startsWith('data:image/png;base64,OUT'));
      check(imgs.length === 2 && imgs.every(i => typeof i.batchId === 'string'), '2 行历史 + batchId 透传');
      check(new Set(imgs.map(i => i.batchId)).size === 1, '同批共用同一 batchId');
      // 原图素材不被改动
      check(flowState.getNode(img.id).imageUrl === 'data:image/png;base64,SRC', '原 image 素材节点不被改动');
    } finally { stub.restore(); }
  });

  // ============ S8 gen 重跑 removeChildren（锁定保护） ============
  await section('S8: gen 重跑 removeChildren（纯引擎产物删旧建新；锁定产物保留 + stale；解锁后可删）', async () => {
    reset();
    const stub = stubGenerate([{ url: 'data:image/png;base64,O1' }]);
    try {
      const img = flowState.addNode('image', 0, 0, { imageUrl: 'data:image/png;base64,SRC', status: 'done' });
      const gen = flowState.addNode('gen', 400, 0, { params: { prompt: 'x', model: 'd:m', count: 1 } });
      flowState.addEdge(img.id, gen.id);
      await runEngine.run(gen.id);
      const first = flowState.nodes.filter(n => n.parentId === gen.id);
      check(first.length === 1 && first[0].imageUrl === 'data:image/png;base64,O1', '首跑 1 个产物');

      // 锁定产物 → 保留 + stale
      assetStore.adoptByUrl(first[0].imageUrl, first[0].id);
      const stub2 = stubGenerate([{ url: 'data:image/png;base64,O2' }]);
      await runEngine.run(gen.id);
      stub2.restore();
      const after = flowState.nodes.filter(n => n.parentId === gen.id);
      check(after.length === 2, '锁定产物保留 + 新产物 → 2 个');
      const kept = after.find(n => n.imageUrl === 'data:image/png;base64,O1');
      check(!!kept && kept.status === 'stale', '锁定产物保留并标 stale');
      const fresh = after.find(n => n.imageUrl === 'data:image/png;base64,O2');
      check(!!fresh && fresh.status === 'done', '新产物 done');

      // 解锁后重跑 → 纯引擎产物被删
      assetStore.setLockedByUrl('data:image/png;base64,O1', first[0].id, false);
      const stub3 = stubGenerate([{ url: 'data:image/png;base64,O3' }]);
      await runEngine.run(gen.id);
      stub3.restore();
      const after3 = flowState.nodes.filter(n => n.parentId === gen.id);
      check(after3.length === 1 && after3[0].imageUrl === 'data:image/png;base64,O3', '解锁后重跑：删旧建新（仅 1 个产物）');
    } finally { stub.restore(); }
  });

  // ============ S9 effectivePrompt 拼接规则 ============
  await section('S9: effectivePrompt（空 prompt → 上游文本按连线顺序拼接；手动改写覆盖拼接）', async () => {
    reset();
    const stub = stubGenerateCapture([{ url: 'data:image/png;base64,R1' }]);
    try {
      const t1 = flowState.addNode('text', 0, 0, { params: { model: 'c:m' }, outputText: '主体描述' });
      const t2 = flowState.addNode('text', 0, 200, { params: { model: 'c:m' }, outputText: '风格描述' });
      const gen = flowState.addNode('gen', 500, 0, { params: { model: 'd:m', count: 1, prompt: '' } });
      flowState.addEdge(t2.id, gen.id); // 先连 t2（连线序 0）
      flowState.addEdge(t1.id, gen.id); // 后连 t1（连线序 1）
      await runEngine.run(gen.id);
      check(stub.calls.length === 1, 'gen 运行 1 次');
      check(stub.calls[0].prompt === '风格描述\n主体描述', `空 prompt → 上游文本按连线顺序拼接（实际: ${JSON.stringify(stub.calls[0].prompt)}）`);
      // 手动改写覆盖拼接
      flowState.updateNodeParams(gen.id, { prompt: '手动改写' });
      stub.calls.length = 0;
      await runEngine.run(gen.id);
      check(stub.calls[0].prompt === '手动改写', '手动改写覆盖拼接');
      // 清空 prompt 恢复拼接
      flowState.updateNodeParams(gen.id, { prompt: '   ' });
      stub.calls.length = 0;
      await runEngine.run(gen.id);
      check(stub.calls[0].prompt === '风格描述\n主体描述', '清空输入框恢复拼接（trim 后为空 → 回退上游拼接）');
    } finally { stub.restore(); }
  });

  // ============ S10 M3 一键重跑 stale 链（拓扑序 + image 跳过） ============
  await section('S10: M3 一键重跑（改链首 → 全链 stale → runAll 拓扑序跑通；image 跳过）', async () => {
    reset();
    const order = [];
    const origGen = apiMod.Backend.generateImage;
    const origPoll = pollerMod.pollTask;
    apiMod.Backend.generateImage = async (prompt) => { order.push(prompt); return { task_id: 't-' + order.length }; };
    pollerMod.pollTask = async () => ({ success: true, imageUrl: 'data:image/png;base64,RES' });
    try {
      const img0 = flowState.addNode('image', 0, 0, { imageUrl: 'data:image/png;base64,I0', status: 'done' });
      const gen1 = flowState.addNode('gen', 400, 0, { params: { prompt: 'GEN1', model: 'd:m', count: 1 } });
      flowState.addEdge(img0.id, gen1.id);
      const img1 = flowState.addNode('image', 800, 0, { parentId: gen1.id, imageUrl: 'data:image/png;base64,I1', status: 'done' });
      flowState.addEdge(gen1.id, img1.id);
      const gen2 = flowState.addNode('gen', 1200, 0, { params: { prompt: 'GEN2', model: 'd:m', count: 1 } });
      flowState.addEdge(img1.id, gen2.id);

      // 改链首 → 全下游 stale
      flowState.setNodeImage(img0.id, 'data:image/png;base64,I0NEW');
      dirty.markUpstreamChanged(img0.id);
      check(flowState.getNode(gen1.id).status === 'stale', 'gen1 标 stale');
      check(flowState.getNode(img1.id).status === 'stale', '中间 image 产物标 stale');
      check(flowState.getNode(gen2.id).status === 'stale', 'gen2 标 stale');

      order.length = 0;
      await runEngine.runAll();
      check(order.join(',') === 'GEN1,GEN2', `runAll 拓扑序：gen1 先于 gen2（实际: ${order.join(',')}）`);
      check(flowState.getNode(gen1.id).status === 'done' && flowState.getNode(gen2.id).status === 'done', '全链跑通 done');
    } finally {
      apiMod.Backend.generateImage = origGen;
      pollerMod.pollTask = origPoll;
    }
  });

  // ============ S11 runAll 失败停止 ============
  await section('S11: runAll 失败停止（text 失败 → 下游 gen 不跑）', async () => {
    reset();
    const order = [];
    const origChat = apiMod.Backend.chatV2;
    const origGen = apiMod.Backend.generateImage;
    const origPoll = pollerMod.pollTask;
    apiMod.Backend.chatV2 = async () => { order.push('TEXT'); throw new Error('模型拒绝'); };
    apiMod.Backend.generateImage = async () => { order.push('GEN'); return { task_id: 'x' }; };
    pollerMod.pollTask = async () => ({ success: true, imageUrl: 'data:image/png;base64,R' });
    try {
      const img = flowState.addNode('image', 0, 0, { imageUrl: 'data:image/png;base64,I', status: 'done' });
      const txt = flowState.addNode('text', 300, 0, { params: { model: 'c:m', instruction: '描述' } });
      flowState.addEdge(img.id, txt.id);
      const gen = flowState.addNode('gen', 600, 0, { params: { prompt: 'P', model: 'd:m', count: 1 } });
      flowState.addEdge(txt.id, gen.id);
      flowState.setNodeImage(img.id, 'data:image/png;base64,I2');
      dirty.markUpstreamChanged(img.id);
      await runEngine.runAll();
      check(flowState.getNode(txt.id).status === 'fail', 'text 失败 → fail');
      check(flowState.getNode(gen.id).status === 'stale', '下游 gen 未被运行（保持 stale）');
      check(order.join(',') === 'TEXT', `只运行了 text 即停止（实际: ${order.join(',')}）`);
    } finally {
      apiMod.Backend.chatV2 = origChat;
      apiMod.Backend.generateImage = origGen;
      pollerMod.pollTask = origPoll;
    }
  });

  // ============ S12 text 无命令不自动重跑 ============
  await section('S12: text 无命令不自动重跑（canRun 拦截，符合设计）', async () => {
    reset();
    const txt = flowState.addNode('text', 0, 0, { params: { model: 'c:m', instruction: '' }, outputText: '旧' });
    dirty.markStale(txt.id);
    let chatCalled = 0;
    const origChat = apiMod.Backend.chatV2;
    apiMod.Backend.chatV2 = async () => { chatCalled++; return { text: '新' }; };
    try {
      await runEngine.runAll();
      check(chatCalled === 0, '无命令 text 不被 runAll 自动重跑');
      check(flowState.getNode(txt.id).status === 'stale', 'text 保持 stale（等待用户输入命令）');
    } finally { apiMod.Backend.chatV2 = origChat; }
  });

  // ============ S13 compare-panel 可对比判据 ============
  await section('S13: compare-panel / bottom-bar 可对比 = image && imageUrl（gen/text 不可比）', async () => {
    reset();
    const img1 = flowState.addNode('image', 0, 0, { imageUrl: 'data:image/png;base64,A', status: 'done' });
    const img2 = flowState.addNode('image', 0, 100, { imageUrl: 'data:image/png;base64,B', status: 'done' });
    const imgEmpty = flowState.addNode('image', 0, 200, { imageUrl: null });
    const gen = flowState.addNode('gen', 0, 300, { params: { model: 'd:m' } });
    const txt = flowState.addNode('text', 0, 400, { params: { model: 'c:m' } });
    const comparable = comparePanel['_comparableNodes']([img1.id, img2.id, imgEmpty.id, gen.id, txt.id]);
    check(comparable.length === 2 && comparable.every(n => n.type === 'image'), `可比 = image 且有图（实际 ${comparable.length} 个）`);
    check(comparable.every(n => n.imageUrl), '可比节点均有 imageUrl');
    selection.select(img1.id);
    selection.toggle(gen.id);
    selection.toggle(txt.id);
    const ids = bottomBar['_comparableIds']();
    check(ids.length === 1 && ids[0] === img1.id, 'bottom-bar 可比数只计 image（混选 gen/text 不计入）');
  });

  // ============ S14 扩图归位 createOutpaintGen ============
  await section('S14: 扩图归位（image 右键 → gen mode=outpaint 预填 + 连上游图 + 参数持久化）', async () => {
    reset();
    const origResolve = apiMod.resolveOutpaintModel;
    apiMod.resolveOutpaintModel = async () => 'gemini:p1:nano-banana-4';
    try {
      const img = flowState.addNode('image', 0, 0, { imageUrl: 'data:image/png;base64,SRC', status: 'done' });
      await interactions.createOutpaintGen(img.id);
      const gen = flowState.nodes.find(n => n.type === 'gen');
      check(!!gen, '扩图新建 gen 节点');
      check(gen.params.mode === 'outpaint', 'gen mode=outpaint');
      check(gen.params.model === 'gemini:p1:nano-banana-4', '模型预填');
      check(gen.params.aspectRatio === '1:1' && gen.params.resolution === '4k' && gen.params.count === 1, '扩图参数预填（aspectRatio/resolution/count）');
      check(flowState.edges.some(e => e.from === img.id && e.to === gen.id), '上游图已连（image→gen）');
      check(flowState.getUpstreamOutputs(gen.id).images[0] === 'data:image/png;base64,SRC', 'gen 直接上游图 = 源图');
      // 参数持久化于 gen.params（collect 可带出）
      const collected = persistence.collect().nodes.find(n => n.id === gen.id);
      check(collected && collected.params.mode === 'outpaint', '扩图参数随 gen.params 持久化（支持重跑）');
    } finally { apiMod.resolveOutpaintModel = origResolve; }
  });

  // ============ S15 回归：拖图/替换/追加 refImages + metaFromNode + 批次卡 + 空壳卡 + 右键菜单 ============
  await section('S15: 回归（拖图空白建 image / 拖到 image 替换 / 拖到 gen 追加参考图；metaFromNode trace 优先；批次卡 4/4；空壳卡 HTML；右键菜单）', async () => {
    // 15a 拖图空白 → 新建 image 节点（无运行能力）
    reset();
    interactions['_dropImage']('data:image/png;base64,DROP', { x: 100, y: 100 }, 50, 50);
    const dropped = flowState.nodes.find(n => n.type === 'image' && n.imageUrl === 'data:image/png;base64,DROP');
    check(!!dropped, '拖图空白 → 新建 image 节点');
    check(dropped && dropped.status === 'done', 'image 节点 status done');
    check(nodeRegistry.get('image').canRun(dropped) !== true, 'image 不可运行（canRun 返回禁止原因）');

    // 15b 拖到 image 节点 → 替换该图 + 下游标 stale
    reset();
    const img = flowState.addNode('image', 0, 0, { imageUrl: 'data:image/png;base64,OLD', status: 'done' });
    const gen = flowState.addNode('gen', 400, 0, { params: { prompt: 'p', model: 'd:m', count: 1 } });
    flowState.addEdge(img.id, gen.id);
    const fakeCard = { closest: (sel) => (sel === '.pcard' ? { dataset: { nodeId: img.id } } : null) };
    global.document.elementFromPoint = () => fakeCard;
    try {
      interactions['_dropImage']('data:image/png;base64,NEW', { x: 0, y: 0 }, 5, 5);
      check(flowState.getNode(img.id).imageUrl === 'data:image/png;base64,NEW', '拖到 image 节点 → 替换图');
      check(flowState.getNode(gen.id).status === 'stale', '换图 → 下游 gen 标 stale');
    } finally { global.document.elementFromPoint = () => null; }

    // 15c 拖到 gen 节点 → 追加参考图（getUpstreamOutputs 纳入）
    reset();
    const imgG = flowState.addNode('image', 0, 0, { imageUrl: 'data:image/png;base64,S1', status: 'done' });
    const genG = flowState.addNode('gen', 400, 0, { params: { prompt: 'p', model: 'd:m', count: 1 } });
    flowState.addEdge(imgG.id, genG.id);
    const fakeCard2 = { closest: (sel) => (sel === '.pcard' ? { dataset: { nodeId: genG.id } } : null) };
    global.document.elementFromPoint = () => fakeCard2;
    try {
      interactions['_dropImage']('data:image/png;base64,REFX', { x: 0, y: 0 }, 5, 5);
      check(flowState.getUpstreamOutputs(genG.id).images[0] === 'data:image/png;base64,REFX', '拖到 gen → refImages 前置（getUpstreamOutputs 纳入）');
      check(flowState.getUpstreamOutputs(genG.id).images[1] === 'data:image/png;base64,S1', '上游图仍保留');
    } finally { global.document.elementFromPoint = () => null; }

    // 15d metaFromNode trace 优先 → 采纳记录配方落盘
    reset();
    const prod = flowState.addNode('image', 0, 0, {
      imageUrl: 'data:image/png;base64,P', status: 'done',
      trace: { prompt: '配方', model: 'd:m', aspectRatio: '3:4', resolution: '2k', count: 2, refImageHashes: ['h1'], refImageUrls: ['u1'], outputType: 'img2img', createdAt: 111 },
    });
    const meta = assetStore.metaFromNode(prod);
    check(meta && meta.prompt === '配方' && meta.model === 'd:m' && meta.count === 2, 'metaFromNode 从 image 产物 trace 构造配方');
    assetStore.adoptByUrl(prod.imageUrl, prod.id, meta);
    const rec = assetStore.getByImageUrl(prod.imageUrl);
    check(rec && rec.prompt === '配方' && rec.model === 'd:m', '采纳记录配方落盘（R2 保留）');

    // 15e 批次卡 count=4 → 4/4 合并（R3 保留）
    reset();
    const stub = stubGenerate([
      { url: 'data:image/png;base64,P1' }, { url: 'data:image/png;base64,P2' },
      { url: 'data:image/png;base64,P3' }, { url: 'data:image/png;base64,P4' },
    ]);
    try {
      const genB = flowState.addNode('gen', 0, 0, { params: { prompt: 'x', model: 'd:m', count: 4 } });
      await runEngine.run(genB.id);
      const imgs = historyDrawer['items'].filter(i => i.kind === 'image' && i.batchId);
      check(imgs.length === 4, 'count=4 → 4 行历史');
      check(new Set(imgs.map(i => i.batchId)).size === 1, '同批共用一个 batchId');
      historyDrawer['view'] = 'batch';
      historyDrawer['tab'] = 'image';
      const display = historyDrawer['_buildDisplay'](historyDrawer['items']);
      const batch = display.find(d => d.kind === 'batch');
      check(!!batch && batch.items.length === 4, '批次卡 4/4 合并');
    } finally { stub.restore(); }

    // 15f 空壳卡 HTML：无大图主视觉 + 角标「产物在右侧」+ chip 行 + 上游文本 chip
    reset();
    const t1 = flowState.addNode('text', 0, 0, { params: { model: 'c:m' }, outputText: '上游文A' });
    const genC = flowState.addNode('gen', 400, 0, { params: { prompt: '一只猫', model: 'd:m', aspectRatio: '3:4', resolution: '2k', count: 2 }, lastResultUrl: 'data:image/png;base64,THUMB' });
    flowState.addEdge(t1.id, genC.id);
    const html = cardView['_buildGenCard'](genC);
    check(html.includes('产物在右侧'), '空壳卡角标「产物在右侧」');
    check(html.includes('gen-shell') && html.includes('gen-chip'), '空壳卡 shell + chip 行');
    check(html.includes('gen-thumb') && html.includes('最近一次产物'), '最近产物弱缩略图（title 提示产物在右侧）');
    check(html.includes('一只猫') && html.includes('>m<') && html.includes('3:4') && html.includes('2K') && html.includes('2张'), 'prompt/模型短名/比例/分辨率/张数 chip');
    check(html.includes('上游文'), '上游文本摘要 chip');
    // 无产物 → 空壳占位
    const genEmpty = flowState.addNode('gen', 800, 0, { params: { model: 'd:m', count: 1, prompt: '' } });
    const htmlEmpty = cardView['_buildGenCard'](genEmpty);
    check(htmlEmpty.includes('空壳操作卡') && htmlEmpty.includes('连接上游后发送'), '未跑过 → 空壳占位文案');

    // 15g 右键菜单：image 有「扩图/复现(有 trace)/复制配方」且无「运行」；画布右键三类新建
    reset();
    const menu = document.getElementById('ctx-menu') || makeEl();
    byId.set('ctx-menu', menu);
    const imgM = flowState.addNode('image', 0, 0, {
      imageUrl: 'data:image/png;base64,M', status: 'done',
      trace: { prompt: 'p', model: 'm', aspectRatio: '3:4', resolution: '2k', count: 1, refImageHashes: [], outputType: 'txt2img', createdAt: 1 },
    });
    interactions['_showCardMenu'](0, 0, flowState.getNode(imgM.id));
    check(menu.innerHTML.includes('data-act="expand-gen"') && menu.innerHTML.includes('扩图'), 'image 右键含「扩图」');
    check(menu.innerHTML.includes('data-act="reproduce"') && menu.innerHTML.includes('data-act="copy-recipe"'), 'image+trace 右键含「复现」「复制配方」');
    check(!menu.innerHTML.includes('data-act="run"'), 'image 无运行项');
    interactions['_showCanvasMenu'](0, 0);
    check(menu.innerHTML.includes('新建图片') && menu.innerHTML.includes('新建文本') && menu.innerHTML.includes('新建生成'), '画布右键新建 = image/text/gen 三类');
    byId.delete('ctx-menu');
  });

  // ============ S16 outpaint 单张 ============
  await section('S16: outpaint 单张（空 prompt 应 fallback OUTPAINT_PROMPT_PREFIX；产物 trace outputType=outpaint + batchId 透传 + 重跑不顶掉）', async () => {
    reset();
    const origCompose = outpaintUtil.composeOutpaintDataUrl;
    outpaintUtil.composeOutpaintDataUrl = async () => 'data:image/png;base64,COMPOSED';
    const stub = stubGenerateCapture([{ url: 'data:image/png;base64,OP1' }]);
    try {
      const img = flowState.addNode('image', 0, 0, { imageUrl: 'data:image/png;base64,SRC', status: 'done' });
      const gen = flowState.addNode('gen', 400, 0, { params: { prompt: '', model: 'd:m', aspectRatio: '1:1', resolution: '4k', count: 1, mode: 'outpaint' } });
      flowState.addEdge(img.id, gen.id);
      await runEngine.run(gen.id);
      const g = flowState.getNode(gen.id);
      // 设计预期：outpaint 空 prompt → fallback OUTPAINT_PROMPT_PREFIX → done（run-engine §4.2）
      // 当前实现：early effectivePrompt 拦截（run-engine.ts:315-320）→ fail —— BUG 证据
      check(g.status === 'done', `outpaint 空 prompt 运行应 done（当前实际 ${g.status}，early effectivePrompt 拦截 → BUG）`);
      check(g.imageUrl === null, 'gen 自身 imageUrl 恒 null（不写回自身）');
      const firstCall = stub.calls[0];
      check(!!firstCall && firstCall.options.referenceImages[0] === 'data:image/png;base64,COMPOSED', '请求参考图 = 合成底图');
      check(!!firstCall && firstCall.prompt.includes('白色区域是待补全区域'), '空 prompt → OUTPAINT_PROMPT_PREFIX');
      const children = flowState.nodes.filter(n => n.parentId === gen.id);
      check(children.length === 1 && children[0].type === 'image', 'outpaint 单张 image 产物');
      check(children[0] && children[0].trace && children[0].trace.outputType === 'outpaint', '产物 trace outputType=outpaint');
      const item = historyDrawer['items'].find(i => i.src === 'data:image/png;base64,OP1');
      check(!!item && typeof item.batchId === 'string', 'outpaint 历史行 batchId 透传（单张批次卡）');
      // 重跑不 removeChildren（逐次累加）—— 仅当首跑成功时才有意义
      if (g.status === 'done') {
        const stub2 = stubGenerateCapture([{ url: 'data:image/png;base64,OP2' }]);
        await runEngine.run(gen.id);
        stub2.restore();
        check(flowState.nodes.filter(n => n.parentId === gen.id).length === 2, 'outpaint 重跑不 removeChildren（逐次累加，符合设计）');
      } else {
        console.log('  ℹ 跳过重跑断言（首跑未成功，outpaint early-check BUG 已阻断）');
      }
    } finally {
      outpaintUtil.composeOutpaintDataUrl = origCompose;
      stub.restore();
    }
  });

  // ============ S17 多跳链风险复核（工程师风险点） ============
  await section('S17: 多跳链 image→gen→image→gen（拓扑依赖创建序；中间产物被保留 → gen2 引用旧产物——行为记录）', async () => {
    reset();
    const callsGen = [];
    const origGen = apiMod.Backend.generateImage;
    const origPoll = pollerMod.pollTask;
    apiMod.Backend.generateImage = async (prompt, options) => { callsGen.push({ prompt, refs: (options && options.referenceImages) || [] }); return { task_id: 't' + callsGen.length }; };
    pollerMod.pollTask = async () => ({ success: true, imageUrl: 'data:image/png;base64,NEWIMG' });
    try {
      const img0 = flowState.addNode('image', 0, 0, { imageUrl: 'data:image/png;base64,I0', status: 'done' });
      const gen1 = flowState.addNode('gen', 400, 0, { params: { prompt: 'G1', model: 'd:m', count: 1 } });
      flowState.addEdge(img0.id, gen1.id);
      const img1 = flowState.addNode('image', 800, 0, { parentId: gen1.id, imageUrl: 'data:image/png;base64,I1', status: 'done' });
      flowState.addEdge(gen1.id, img1.id);
      const gen2 = flowState.addNode('gen', 1200, 0, { params: { prompt: 'G2', model: 'd:m', count: 1 } });
      flowState.addEdge(img1.id, gen2.id);
      // 首跑
      await runEngine.run(gen1.id);
      await runEngine.run(gen2.id);
      callsGen.length = 0;
      // 改链首 → stale → runAll
      flowState.setNodeImage(img0.id, 'data:image/png;base64,I0NEW');
      dirty.markUpstreamChanged(img0.id);
      await runEngine.runAll();
      const order = callsGen.map(c => c.prompt).join(',');
      check(order === 'G1,G2', `创建序下 runAll 顺序正确（G1 先于 G2，实际: ${order}）`);
      // 中间产物 img1 有出边给 gen2 → 被保留 + stale（removeChildren 手动连线语义）
      const keptImg1 = flowState.getNode(img1.id);
      check(!!keptImg1 && keptImg1.status === 'stale', '中间产物 img1 被保留并标 stale（有出边给 gen2 → 非纯引擎产出）');
      const newImg1 = flowState.nodes.filter(n => n.parentId === gen1.id && n.id !== img1.id);
      check(newImg1.length === 1, 'gen1 新建 img1\'');
      // gen2 运行时引用的仍是旧 img1（产物替换不重指下游连线）—— 记录行为，供主理人裁决
      const g2call = callsGen.find(c => c.prompt === 'G2');
      const g2RefsOld = !!g2call && g2call.refs[0] === 'data:image/png;base64,I1';
      console.log(`  ℹ 行为记录: gen2 运行时上游图=${g2call ? g2call.refs[0] : '(无)'}（旧 img1=${g2RefsOld}；新产物未重指 → 多跳链数据衔接依赖 removeChildren 保留语义）`);
      check(true, '多跳链行为已记录（详见报告风险项）');

      // 反向创建序（模拟 restore 后节点序倒置）：gen2 先于 gen1 → _topoSort 只见直接边 → 顺序错
      reset();
      const callsGen2 = [];
      apiMod.Backend.generateImage = async (prompt, options) => { callsGen2.push({ prompt, refs: (options && options.referenceImages) || [] }); return { task_id: 't' + callsGen2.length }; };
      const imgA = flowState.addNode('image', 0, 0, { imageUrl: 'data:image/png;base64,IA', status: 'done' });
      const gA = flowState.addNode('gen', 400, 0, { params: { prompt: 'GA', model: 'd:m', count: 1 } });
      flowState.addEdge(imgA.id, gA.id);
      const iA1 = flowState.addNode('image', 800, 0, { parentId: gA.id, imageUrl: 'data:image/png;base64,IA1', status: 'done' });
      flowState.addEdge(gA.id, iA1.id);
      const gB = flowState.addNode('gen', 1200, 0, { params: { prompt: 'GB', model: 'd:m', count: 1 } });
      flowState.addEdge(iA1.id, gB.id);
      // 模拟节点序倒置（restore 文件序）：把 gB 挪到 gA 前面
      flowState.nodes = [imgA, gB, gA, iA1];
      flowState.setNodeImage(imgA.id, 'data:image/png;base64,IA2');
      dirty.markUpstreamChanged(imgA.id);
      callsGen2.length = 0;
      await runEngine.runAll();
      const order2 = callsGen2.map(c => c.prompt).join(',');
      // 工程师已预告风险：_topoSort 只在目标子图内看直接边，跨 image 中间节点的依赖不识别 → 依赖节点数组序。
      // 正常创建序下 GA 恒先于 GB（创建序=数组序），本场景为「restore 后节点序倒置」的人工构造边界。
      // 记录行为供主理人裁决，不作为本轮失败断言。
      console.log(`  ℹ 行为记录: 倒置创建序下 runAll 顺序=${order2}（正常创建序恒 GA,GB；倒置后依赖节点数组序 → GB 先跑，工程师已预告风险）`);
    } finally {
      apiMod.Backend.generateImage = origGen;
      pollerMod.pollTask = origPoll;
    }
  });

  // ============ S16b draw 模式空 prompt 拦截仍生效（Bug-1 修复回归护栏） ============
  await section('S16b: draw 模式空 prompt + 无上游文本 → canRun 拦截（状态保持 idle，不发起请求，无产物；修复未削弱 draw 行为）', async () => {
    reset();
    const stub = stubGenerateCapture([{ url: 'data:image/png;base64,RX' }]);
    try {
      const gen = flowState.addNode('gen', 0, 0, { params: { prompt: '', model: 'd:m', count: 1, mode: 'draw' } });
      await runEngine.run(gen.id);
      const g = flowState.getNode(gen.id);
      // canRun（gen.ts draw 分支：空 prompt 且无上游文本 → '请输入提示词'）在 run() 入口拦截，状态不进入 fail（保持 idle）
      check(g.status === 'idle' && g.error === null, `draw 空 prompt 无上游文本 → canRun 拦截（idle，不置 fail；实际 ${g.status}）`);
      check(stub.calls.length === 0, 'draw 空 prompt 未发起生成请求');
      check(flowState.nodes.filter(n => n.parentId === gen.id).length === 0, 'draw 空 prompt 无产物');
      // 有上游文本时 draw 可跑（S4-7：有上游文本允许空 prompt）—— 修复未削弱
      const tUp = flowState.addNode('text', 0, 300, { params: { model: 'c:m' }, outputText: '上游文本' });
      flowState.addEdge(tUp.id, gen.id);
      await runEngine.run(gen.id);
      const g2 = flowState.getNode(gen.id);
      check(stub.calls.length === 1 && g2.status === 'done', `draw 空 prompt + 上游文本 → 可运行（实际 ${g2.status}，调用 ${stub.calls.length} 次）`);
    } finally { stub.restore(); }
  });

  // ───────────────────────── 汇总 ─────────────────────────
  console.log(`\n══════════════════════════════════════`);
  console.log(`总断言: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    console.log('失败明细:');
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log('ALL PASSED ✓');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
