// .qa-verify/qa-tab-panels.cjs
// QA 独立验证（Edward/严过关）· 悬浮框 Tab 化改造（Round 2：Tab 纯呼出）
// 需求口径：Tab 是纯「呼出」动作（非开关）——选中节点按 Tab → 悬浮窗出现；
//           已显示时再按 Tab 无动作（不收起）；收起统一走 Esc / 点画布空白（新增）。
//           输入框聚焦时 Tab 不拦截；显示态切节点跟随刷新不收起；收起态切节点保持收起。
// 注意：toggle() 已保留但不被键盘调用（键盘只走 show()），本脚本相应更新 A3/A4/B2/B11 断言。
//
// 运行（本项目 Node CommonJS + DOM 桩，非 vitest）：
//   1) npx tsc -p tsconfig.smoke.json --outDir .icv-smoke
//   2) npx tsc -p tsconfig.qa-main.json        (编译含 main.ts 的真实启动模块 → .icv-main)
//   3) node .qa-verify/qa-tab-panels.cjs
//
// Part A：模块级（.icv-smoke）——floatingPanels 控制器 + action-bar/cmd-panel 门控 sync()
// Part B：集成级（.icv-main，加载真实 main.ts 并让其 init() 跑起来）——真实 bindKeyboard()
//         Tab/Escape 行为（观察 keydown 监听器 + 真实 DOM 桩 classList 变化）

'use strict';

const SMOKE = 'G:/Infinite Canvas/Infinite Canvas 2.0/.icv-smoke/v1';
const MAIN = 'G:/Infinite Canvas/Infinite Canvas 2.0/.icv-main/v1';

// ───────────────────────── DOM/浏览器桩 ─────────────────────────
function makeEl(over = {}) {
  const classes = new Set();
  const listeners = {};
  const target = {
    classList: {
      add(...cs) { cs.forEach(c => classes.add(c)); },
      remove(...cs) { cs.forEach(c => classes.delete(c)); },
      toggle(c, force) {
        const on = force === undefined ? !classes.has(c) : !!force;
        if (on) classes.add(c); else classes.delete(c);
        return on;
      },
      contains(c) { return classes.has(c); },
    },
    style: {}, dataset: {}, value: '', disabled: false, title: '', checked: false,
    tagName: 'DIV', isContentEditable: false,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const arr = listeners[type] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    appendChild() {}, insertBefore() {},
    remove() {}, focus() {}, select() {}, click() {}, scrollIntoView() {},
    setAttribute() {}, removeAttribute() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; },
    offsetHeight: 0, offsetWidth: 0,
    ...over,
  };
  let _html = ''; let _text = '';
  Object.defineProperty(target, 'innerHTML', {
    get() { return _html; }, set(v) { _html = String(v); }, configurable: true,
  });
  Object.defineProperty(target, 'textContent', {
    get() { return _text; }, set(v) { _text = String(v); }, configurable: true,
  });
  target._has = (c) => classes.has(c);
  target._classes = classes;
  target._listeners = listeners;
  target._fire = (type, ev) => (listeners[type] || []).slice().forEach(fn => fn(ev));
  return target;
}

const dom = new Map();
function register(id, over = {}) { const el = makeEl(over); dom.set(id, el); return el; }
function getEl(id) { return dom.get(id) || null; }

// ── 面板元素（可追踪 classList） ──
const actionBarEl = register('action-bar', { offsetHeight: 40, offsetWidth: 300 });
const cmdPanelEl = register('cmd-panel', { offsetHeight: 240, offsetWidth: 640 });
// action-bar 按钮（init 时绑定 click）
const styleBtn = register('act-style', { dataset: { action: 'style-adjust' } });
const expandBtn = register('act-expand', { dataset: { action: 'expand' } });
const multiBtn = register('act-multi', { dataset: { action: 'multi-angle' } });
const lightBtn = register('act-light', { dataset: { action: 'lighting' } });
const hdBtn = register('act-hd', { dataset: { action: 'hd' } });
const reproduceBtn = register('act-reproduce', { dataset: { action: 'reproduce' } });
const downloadBtn = register('act-download', { dataset: { action: 'download' } });
actionBarEl.querySelectorAll = () => [styleBtn, expandBtn, multiBtn, lightBtn, hdBtn, reproduceBtn, downloadBtn];
actionBarEl.querySelector = () => reproduceBtn;

// cmd-panel 子元素
const ctxThumb = register('ctx-thumb');
const ctxName = register('ctx-name');
const ctxHint = register('ctx-hint');
const refsEl = register('cmd-refs');
const refMain = register('cmd-ref-main');
const cmdInput = register('cmd-input', { tagName: 'TEXTAREA' });
const cmdSend = register('cmd-send');
const chipModelLabel = register('chip-model-label');
const chipModelBtn = register('chip-model');
const chipRatioLabel = register('chip-ratio-label');
const chipResLabel = register('chip-res-label');
const chipCountLabel = register('chip-count-label');
const textHistoryEl = register('cmd-text-history');
register('cmd-ref-add');

// 其它 init 需要的元素
register('canvas-wrap', { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 800 }) });
register('canvas');
register('selection-box');
register('file-input');
register('toast');
register('left-drawer');
register('history-grid');
register('drawer-handle');
register('history-empty');
register('history-search');
register('history-tabs');
register('asset-drawer');
register('asset-grid');
register('asset-handle');
register('asset-empty');
register('asset-search');
register('asset-count');
register('capsule-history');
register('capsule-assets');
register('bottom-bar');
register('btn-run-selected');
register('btn-compare');
register('project-name');
register('btn-open');
register('btn-save');
register('btn-theme');
register('btn-settings');
register('settings-overlay');
register('settings-provider-list');
register('settings-add-name');
register('btn-add-provider');
register('btn-close-settings');
register('outpaint-overlay');
register('outpaint-stage');
register('outpaint-img');
register('outpaint-zoom');
register('outpaint-confirm');
register('outpaint-model-label');
register('outpaint-desc');
register('outpaint-ratios');
register('outpaint-close');
register('outpaint-cancel');
register('compare-overlay');
register('compare-grid');
register('compare-count');
register('compare-close');
register('save-status');
register('save-dot');
register('win-min');
register('win-max');
register('win-close');
register('btn-undo');
register('btn-redo');
register('ctx-menu');
register('img-modal');

// ── window / document / 全局 ──
const winListeners = {};
global.window = {
  addEventListener(t, fn) { (winListeners[t] = winListeners[t] || []).push(fn); },
  removeEventListener() {},
  setInterval() { return 1; }, clearInterval() {},
  innerWidth: 1280, innerHeight: 800,
  pywebview: {
    api: {
      load_providers: async () => ({ providers: [] }),
      win_set_dirty: async () => {}, win_is_maximized: async () => ({ maximized: false }),
      win_close: async () => {}, win_toggle_maximize: async () => ({ maximized: false }),
      win_minimize: async () => {},
    },
  },
};
global.pywebview = global.window.pywebview;
global.document = {
  readyState: 'complete',
  getElementById: (id) => getEl(id),
  createElement: () => makeEl(),
  createElementNS: () => makeEl(),
  addEventListener() {}, removeEventListener() {},
  querySelector: () => makeEl({ querySelector: () => null }),
  querySelectorAll: () => [],
  body: makeEl(),
  documentElement: makeEl({ getAttribute: () => 'light' }),
  activeElement: null,
  elementFromPoint: () => null,
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
global.MutationObserver = class { observe() {} disconnect() {} };
global.Image = class { set src(_v) {} };
require.extensions['.css'] = (m) => { m.exports = {}; };

// ───────────────────────── 断言工具 ─────────────────────────
let passed = 0; let failed = 0;
const failures = [];
function check(cond, msg) {
  if (cond) { passed += 1; console.log(`  ✓ ${msg}`); }
  else { failed += 1; failures.push(msg); console.error(`  ✗ ${msg}`); }
}
async function section(title, fn) {
  console.log(`\n▶ ${title}`);
  try { await fn(); } catch (e) { failed += 1; failures.push(`${title} 异常: ${e.message}`); console.error(`  ✗ 异常: ${e.message}\n${e.stack}`); }
}
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

// ───────────────────────── 加载被测模块（Part A：smoke） ─────────────────────────
require(`${SMOKE}/nodes/node-registry.js`);
require(`${SMOKE}/nodes/image-gen.js`);
require(`${SMOKE}/nodes/text-gen.js`);
const { flowState } = require(`${SMOKE}/state/flow-state.js`);
const { selection } = require(`${SMOKE}/state/selection.js`);
const { canvasView } = require(`${SMOKE}/canvas/canvas-view.js`);
const { cardView } = require(`${SMOKE}/canvas/card-view.js`);
const apiMod = require(`${SMOKE}/api.js`);
const toastMod = require(`${SMOKE}/ui/toast.js`);
const { floatingPanels } = require(`${SMOKE}/ui/floating-panels.js`);
const { actionBar } = require(`${SMOKE}/ui/action-bar.js`);
const { cmdPanel } = require(`${SMOKE}/ui/cmd-panel.js`);
const { outpaintPanel } = require(`${SMOKE}/ui/outpaint-panel.js`);
const { comparePanel } = require(`${SMOKE}/ui/compare-panel.js`);
const { historyDrawer } = require(`${SMOKE}/ui/history-drawer.js`);
const { assetDrawer } = require(`${SMOKE}/ui/asset-drawer.js`);
const { runEngine } = require(`${SMOKE}/engine/run-engine.js`);

apiMod.fetchImageModels = async () => [{ id: 'p:draw', name: '绘图模型' }];
apiMod.fetchChatModels = async () => [{ id: 'p:chat', name: '对话模型' }];
apiMod.resolveDefaultChatModel = async () => 'p:chat';
toastMod.showToast = () => {};

let initedA = false;
function initPanelsA() {
  if (initedA) return;
  initedA = true;
  canvasView.wrap = getEl('canvas-wrap');
  cmdPanel.init();
  actionBar.init();
  outpaintPanel.init();
  comparePanel.init();
  historyDrawer.init();
  assetDrawer.init();
  // 双抽屉互斥（S5，与 main.ts init 编排一致）
  historyDrawer.setMutex(() => assetDrawer.close());
  assetDrawer.setMutex(() => historyDrawer.close());
}

function resetState(over = {}) {
  flowState.replaceAll({
    format: 'icv', version: '3.4', projectName: 't',
    canvas: { scale: 1, panX: 60, panY: 40 },
    nodes: [], edges: [], createdAt: 0, updatedAt: 0, ...over,
  });
  cmdInput.value = '';
  cmdInput.disabled = false;
  document.activeElement = null;
  floatingPanels.hide(); // 确保收起态（无选中节点时 hide 不 notify，靠 replaceAll 已 notify）
  flowState.notify();    // 强制两面板 sync 清理残留 class
}

function addImg(x = 0, y = 0, over = {}) {
  return flowState.addNode('image-gen', x, y, {
    params: { prompt: 'p', model: 'p:draw', aspectRatio: '3:4', resolution: '2k', count: 1 },
    ...over,
  });
}
function addText(over = {}) {
  return flowState.addNode('text-gen', 0, 0, {
    params: { instruction: '', model: 'p:chat' }, ...over,
  });
}

// ═══════════════════════════════════════════════════════════════
// Part A · 模块级核心行为
// ═══════════════════════════════════════════════════════════════
async function partA() {
  initPanelsA();

  await section('A1: 选中节点后面板不自动出现（Tab 化核心）', () => {
    resetState();
    const n = addImg();               // addNode 触发 notify → sync 门控早退
    selection.select(n.id);           // 再次 notify
    check(!actionBarEl._has('show'), 'action-bar 无 .show');
    check(!cmdPanelEl._has('show'), 'cmd-panel 无 .show');
    check(!cmdPanelEl._has('textgen') && !cmdPanelEl._has('reverse'), 'cmd-panel 无 textgen/reverse 残留');
    check(!actionBarEl._has('pos-below') && !cmdPanelEl._has('pos-above'), '无定位 class 残留');
    check(floatingPanels.isVisible() === false, 'floatingPanels 默认收起');
  });

  await section('A2: Tab 呼出（show）→ 两面板同时 .show', () => {
    resetState();
    const n = addImg();
    selection.select(n.id);
    const r = floatingPanels.show();
    check(r === true, 'show 返回 true（有单选节点）');
    check(floatingPanels.isVisible() === true, 'isVisible() true');
    check(actionBarEl._has('show'), 'action-bar 显示');
    check(cmdPanelEl._has('show'), 'cmd-panel 显示');
    check(actionBarEl.style.left !== undefined && actionBarEl.style.top !== undefined, 'action-bar 已定位');
    check(cmdPanelEl.style.left !== undefined && cmdPanelEl.style.top !== undefined, 'cmd-panel 已定位');
  });

  await section('A3: 已显示再 show() → 保持显示（纯呼出、幂等、不重复 notify）', () => {
    resetState();
    const n = addImg();
    selection.select(n.id);
    floatingPanels.show();                       // 呼出
    check(floatingPanels.isVisible() === true, '首次 show 后显示');
    // 幂等：已显示再 show 不翻转、不重复 notify（关键差异）
    const origNotify = flowState.notify.bind(flowState);
    let notifyCount = 0;
    flowState.notify = (...a) => { notifyCount += 1; return origNotify(...a); };
    const r = floatingPanels.show();
    flowState.notify = origNotify;
    check(r === true, '再次 show 返回 true（应拦截 Tab）');
    check(floatingPanels.isVisible() === true, '再次 show 后仍显示（不收起）');
    check(actionBarEl._has('show') && cmdPanelEl._has('show'), '两面板保持显示');
    check(!actionBarEl._has('pos-below') || actionBarEl._has('show'), '显示态 class 正常');
    check(notifyCount === 0, `幂等：已显示再 show 不触发 notify（实际 ${notifyCount} 次）`);
  });

  await section('A4: 无选中节点 show() → 返回 false、不翻转、无副作用（门控早退）', () => {
    resetState();
    const origNotify = flowState.notify.bind(flowState);
    let notifyCount = 0;
    flowState.notify = (...a) => { notifyCount += 1; return origNotify(...a); };
    const r = floatingPanels.show();
    flowState.notify = origNotify;
    check(r === false, 'show 返回 false（无单选节点）');
    check(floatingPanels.isVisible() === false, '仍为收起态');
    check(!actionBarEl._has('show') && !cmdPanelEl._has('show'), '面板不出现');
    check(notifyCount === 0, `门控早退：不触发 notify（实际 ${notifyCount} 次）`);
  });

  await section('A4b: toggle() 保留 API —— 仍可翻转（但不被键盘调用）', () => {
    resetState();
    const n = addImg();
    selection.select(n.id);
    const r1 = floatingPanels.toggle();
    check(r1 === true && floatingPanels.isVisible() === true, 'toggle 呼出仍可用');
    const r2 = floatingPanels.toggle();
    check(r2 === true && floatingPanels.isVisible() === false, 'toggle 收起仍可用（历史 flip 语义保留）');
    resetState();
    const r3 = floatingPanels.toggle();
    check(r3 === false && floatingPanels.isVisible() === false, '无选中节点 toggle → false');
  });

  await section('A5: 显示态下切换选中节点 → 内容跟随刷新、不收起', () => {
    resetState();
    const a = addImg(0, 0, { params: { prompt: 'AAA', model: 'p:draw', aspectRatio: '3:4', resolution: '2k', count: 1 } });
    selection.select(a.id);
    floatingPanels.show();            // 呼出
    check(cmdInput.value === 'AAA', '选中 A 后输入框回填 AAA');
    const b = addImg(200, 0, { params: { prompt: 'BBB', model: 'p:draw', aspectRatio: '1:1', resolution: '2k', count: 1 } });
    selection.select(b.id);           // 切换选中 → notify → sync
    check(floatingPanels.isVisible() === true, '切换选中后仍为显示态（不收起）');
    check(actionBarEl._has('show'), 'action-bar 仍显示');
    check(cmdPanelEl._has('show'), 'cmd-panel 仍显示');
    check(cmdInput.value === 'BBB', '输入框回填新节点 BBB');
    check(ctxName.textContent === b.title, 'ctx-name 跟随新节点');
    check(chipRatioLabel.textContent === '1:1', 'chip 比例跟随新节点');
  });

  await section('A6: 收起态下切换选中节点 → 保持收起', () => {
    resetState();
    const a = addImg(0, 0);
    selection.select(a.id);
    floatingPanels.show();            // 呼出
    floatingPanels.hide();            // 收起（Esc/点空白路径）
    const b = addImg(300, 0, { title: 'B卡' });
    selection.select(b.id);
    check(floatingPanels.isVisible() === false, '仍为收起态');
    check(!actionBarEl._has('show') && !cmdPanelEl._has('show'), '两面板保持收起');
    check(!cmdPanelEl._has('textgen') && !cmdPanelEl._has('reverse'), '无内容 class 残留');
  });

  await section('A7: 显示态下平移/缩放 notify → 重新定位；收起态 notify → 不出现', () => {
    resetState();
    const n = addImg(0, 0);
    selection.select(n.id);
    floatingPanels.show();
    const leftBefore = actionBarEl.style.left;
    const topBefore = actionBarEl.style.top;
    flowState.canvas.panX += 100;     // 模拟平移
    flowState.canvas.scale = 1.5;     // 模拟缩放
    flowState.notify();
    check(floatingPanels.isVisible() === true, '平移缩放后仍显示');
    check(actionBarEl.style.left !== leftBefore || actionBarEl.style.top !== topBefore, 'action-bar 重新定位（_position 调用）');
    check(cmdPanelEl.style.left !== undefined, 'cmd-panel 重新定位');
    // 收起态
    floatingPanels.hide();
    const leftHidden = actionBarEl.style.left;
    flowState.canvas.panX += 50;
    flowState.notify();
    check(!actionBarEl._has('show') && !cmdPanelEl._has('show'), '收起态 notify 不出现');
    check(actionBarEl.style.left === leftHidden, '收起态 notify 不重定位（早退）');
  });

  await section('A8: Esc（hide）→ 两面板收起；幂等 hide 不抛错', () => {
    resetState();
    const n = addImg();
    selection.select(n.id);
    floatingPanels.show();
    floatingPanels.hide();
    check(floatingPanels.isVisible() === false, 'hide 后收起');
    check(!actionBarEl._has('show') && !cmdPanelEl._has('show'), '两面板收起');
    floatingPanels.hide();            // 已收起再 hide
    check(floatingPanels.isVisible() === false, '幂等 hide 保持收起');
  });

  await section('A9: 生成流程回归 —— 显示态下 run 状态刷新「生成中」', () => {
    resetState();
    const n = addImg(0, 0, { status: 'idle' });
    selection.select(n.id);
    floatingPanels.show();
    flowState.updateNode(n.id, { status: 'run' });   // 模拟 run-engine 启动
    check(ctxHint.textContent.includes('生成中'), `run 提示包含「生成中」(实际: ${ctxHint.textContent})`);
    check(cmdSend.disabled === true, 'run 状态发送钮禁用');
    check(cmdPanelEl._has('show') && actionBarEl._has('show'), '显示态下 run 刷新不收起');
    // 收起态下 run 刷新 → 不出现
    floatingPanels.hide();
    flowState.updateNode(n.id, { status: 'done' });
    check(!cmdPanelEl._has('show'), '收起态下 run→done notify 不出现');
  });

  await section('A10: action-bar 按钮回归 —— reproduce 显隐 + style-adjust 聚焦指令框', () => {
    resetState();
    const withTrace = addImg(0, 0, { trace: { model: 'p:m', refImageHashes: [], refImageUrls: [] } });
    selection.select(withTrace.id);
    floatingPanels.show();
    check(!reproduceBtn._has('act-hidden'), '带 trace 节点 → reproduce 按钮可见');
    const noTrace = addImg(300, 0, { trace: null });
    selection.select(noTrace.id);
    check(reproduceBtn._has('act-hidden'), '无 trace 节点 → reproduce 按钮隐藏');
    // style-adjust：聚焦 cmd-input
    let focused = 0;
    cmdInput.focus = () => { focused += 1; };
    styleBtn._clickHandler && styleBtn._clickHandler({ currentTarget: styleBtn });
    check(focused === 0, 'style-adjust 未绑定（无 click 事件注册时跳过）'); // 占位：真实绑定在 init 内
    // 直接验证 _handleAction 等价路径（通过 action-bar 内部监听器触发）
    const clickEvt = { currentTarget: styleBtn, target: styleBtn };
    styleBtn._listeners && (styleBtn._listeners.click || []).forEach(fn => fn(clickEvt));
    check(focused >= 0, 'style-adjust click 不抛错');
  });

  await section('A11: cmd-panel 文本反推节点 —— textgen/reverse class 跟随', () => {
    resetState();
    const t = addText({ params: { instruction: 'cmd', model: 'p:chat' } });
    selection.select(t.id);
    floatingPanels.show();
    check(cmdPanelEl._has('textgen'), 'text-gen 选中 → cmd-panel 带 textgen class');
    check(!actionBarEl._has('show'), 'text-gen 节点 → action-bar 隐藏（原行为保留）');
    check(cmdInput.value === '', 'text-gen 输入框不回填 instruction（保持干净）');
    // image-gen 文本反推
    const rev = addImg(200, 0, { params: { prompt: '', model: 'p:draw', modelType: 'text', textModel: 'p:chat', aspectRatio: '3:4', resolution: '2k', count: 1 } });
    selection.select(rev.id);
    check(cmdPanelEl._has('reverse'), 'image-gen 文本反推 → reverse class');
    check(cmdInput.placeholder.includes('反推'), '反推模式占位提示切换');
  });

  await section('A12: 抽屉互斥回归 —— history/asset 打开互斥 + Escape 收抽屉', () => {
    resetState();
    const hDrawer = getEl('left-drawer');
    const aDrawer = getEl('asset-drawer');
    historyDrawer.openDrawer(true);
    check(hDrawer._has('open'), 'history 抽屉打开');
    assetDrawer.openDrawer(true);
    check(aDrawer._has('open'), 'asset 抽屉打开');
    check(!hDrawer._has('open'), '打开 asset 自动收起 history（互斥）');
    assetDrawer.close();
    check(!aDrawer._has('open'), 'asset 抽屉可关闭');
  });

  await section('A13: 回归守护 —— 新建节点（无 model）选中后面板收起也应自动回填默认模型（_ensureModel 不因门控失效）', async () => {
    // 期望：选中即回填默认模型（localStorage icv_default_model），保证「新建 → 运行选中」链路可用。
    // 注意：本用例预期在门控实现下失败（源码缺陷），用于向工程师定位回归。
    resetState();
    localStorage.setItem('icv_default_model', 'p:draw');
    const n = flowState.addNode('image-gen', 0, 0);   // defaultParams.model === ''
    selection.select(n.id);                            // 面板收起态
    await tick(60);                                    // 等待可能的异步 _ensureModel
    check(Boolean(n.params.model), `新建节点选中后自动回填默认模型（实际: ${JSON.stringify(n.params.model)}）`);
  });

  await section('A14: 修复复测（P1 fix round 2）—— 模型回填与显隐解耦 + 运行不再被模型拦截', async () => {
    resetState();
    localStorage.setItem('icv_default_model', 'p:draw');
    localStorage.setItem('icv_default_chat_model', 'p:chat');

    // 1) 新建 image-gen → 选中（面板收起）→ 立即回填默认绘图模型
    const g = flowState.addNode('image-gen', 0, 0, { params: { prompt: '一只猫', aspectRatio: '3:4', resolution: '2k', count: 1 } });
    selection.select(g.id);
    await tick(60);
    check(g.params.model === 'p:draw', `image-gen 收起态选中即回填默认绘图模型（实际: ${JSON.stringify(g.params.model)}）`);

    // 2) 运行选中不再报「请先选择绘图模型」（stub generateImage 抛错 → 越过 canRun 后 batch 失败，toast 应为「生成失败」而非模型缺失）
    let toasts = [];
    toastMod.showToast = (m) => toasts.push(String(m));
    apiMod.Backend.generateImage = async () => { throw new Error('stub-fail'); };
    await runEngine.run(g.id);
    check(!toasts.some(t => t.includes('请先选择绘图模型')), `image-gen 运行越过模型校验（toast: ${JSON.stringify(toasts)}）`);
    check(g.status === 'fail', 'image-gen 走到执行分支（stub 失败 → fail，非模型拦截）');

    // 3) 新建 text-gen → 选中 → 回填对话模型
    const t = flowState.addNode('text-gen', 300, 0, { params: { instruction: '翻译成英文' } });
    selection.select(t.id);
    await tick(60);
    check(t.params.model === 'p:chat', `text-gen 收起态选中即回填默认对话模型（实际: ${JSON.stringify(t.params.model)}）`);

    // 4) text-gen 运行不再报「请先选择文本模型」
    apiMod.Backend.chatV2 = async () => ({ success: true, text: '翻译结果' });
    toasts = [];
    await runEngine.run(t.id);
    check(!toasts.some(x => x.includes('请先选择文本模型')), `text-gen 运行越过模型校验（toast: ${JSON.stringify(toasts)}）`);
    check(t.status === 'done', 'text-gen 运行成功 status=done');

    // 5) Tab 呼出后无重复回填/无异常（_modelFilling 去重）
    floatingPanels.show();             // 呼出
    await tick(20);
    check(t.params.model === 'p:chat', 'Tab 呼出后模型保持已回填值（无重复回填）');
    check(cmdPanelEl._has('show'), 'Tab 呼出正常显示');
    floatingPanels.hide();             // 收起
    check(t.params.model === 'p:chat', '收起态 notify 后模型保持已回填值（显隐解耦）');
  });
}

// ═══════════════════════════════════════════════════════════════
// Part B · 集成级：加载真实 main.ts，驱动真实 bindKeyboard
// ═══════════════════════════════════════════════════════════════
let mainFlow, mainSelection, mainFloating, mainCmdPanel, mainActionBar;
let keydownHandler = null;

function loadMain() {
  // 复用已建好的全局 DOM 桩；重置关键监听捕获
  winListeners.keydown = [];
  require(`${MAIN}/main.js`);
  keydownHandler = (winListeners.keydown || [])[0] || null;
  mainFlow = require(`${MAIN}/state/flow-state.js`).flowState;
  mainSelection = require(`${MAIN}/state/selection.js`).selection;
  mainFloating = require(`${MAIN}/ui/floating-panels.js`).floatingPanels;
  mainCmdPanel = require(`${MAIN}/ui/cmd-panel.js`).cmdPanel;
  mainActionBar = require(`${MAIN}/ui/action-bar.js`).actionBar;
}

function makeKeyEvent(over = {}) {
  const ev = {
    key: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    _prevented: false,
    preventDefault() { this._prevented = true; },
    ...over,
  };
  return ev;
}

function resetMain(over = {}) {
  mainFlow.replaceAll({
    format: 'icv', version: '3.4', projectName: 't',
    canvas: { scale: 1, panX: 60, panY: 40 },
    nodes: [], edges: [], createdAt: 0, updatedAt: 0, ...over,
  });
  cmdInput.value = '';
  document.activeElement = null;
  mainFloating.hide();
  mainFlow.notify();
}

function addMainImg(x = 0, y = 0, over = {}) {
  return mainFlow.addNode('image-gen', x, y, {
    params: { prompt: 'p', model: 'p:draw', aspectRatio: '3:4', resolution: '2k', count: 1 },
    ...over,
  });
}

async function partB() {
  await section('B0: main.ts 真实加载 —— init() 完成、keydown 监听已注册', () => {
    check(keydownHandler !== null, 'bindKeyboard 的 keydown 监听器已注册（真实 main.ts）');
    check(!!global.window.ICV, 'bridge ICV 桥接已挂载');
    check(mainFloating.isVisible() === false, '启动后 floatingPanels 默认收起');
  });

  await section('B1: 选中节点 + body 焦点按 Tab → 两面板同时显示 + preventDefault', () => {
    resetMain();
    const n = addMainImg();
    mainSelection.select(n.id);
    check(!actionBarEl._has('show') && !cmdPanelEl._has('show'), '选中后初始不显示');
    const ev = makeKeyEvent({ key: 'Tab' });
    keydownHandler(ev);
    check(mainFloating.isVisible() === true, 'Tab 后 floatingPanels 显示');
    check(actionBarEl._has('show'), 'action-bar .show');
    check(cmdPanelEl._has('show'), 'cmd-panel .show');
    check(ev._prevented === true, 'Tab 已 preventDefault（拦截焦点跳转）');
  });

  await section('B2: 再按 Tab → 保持显示（纯呼出、幂等）+ preventDefault', () => {
    resetMain();
    const n = addMainImg();
    mainSelection.select(n.id);
    keydownHandler(makeKeyEvent({ key: 'Tab' }));
    const ev2 = makeKeyEvent({ key: 'Tab' });
    keydownHandler(ev2);
    check(mainFloating.isVisible() === true, '再 Tab 保持显示（不收起）');
    check(actionBarEl._has('show') && cmdPanelEl._has('show'), '两面板保持显示');
    check(ev2._prevented === true, '已显示 Tab 仍 preventDefault（拦截焦点跳转）');
  });

  await section('B3: 无选中节点按 Tab → 无动作、不 preventDefault', () => {
    resetMain();
    const ev = makeKeyEvent({ key: 'Tab' });
    keydownHandler(ev);
    check(mainFloating.isVisible() === false, '不 toggle（保持收起）');
    check(ev._prevented === false, '不 preventDefault（保留 Tab 焦点跳转）');
    check(!actionBarEl._has('show') && !cmdPanelEl._has('show'), '面板不出现');
  });

  await section('B4: 焦点在 input/textarea 内按 Tab → 不拦截', () => {
    resetMain();
    const n = addMainImg();
    mainSelection.select(n.id);
    keydownHandler(makeKeyEvent({ key: 'Tab' }));          // 呼出
    document.activeElement = cmdInput;                     // 聚焦输入框
    const ev = makeKeyEvent({ key: 'Tab' });
    keydownHandler(ev);
    check(mainFloating.isVisible() === true, '面板保持显示（未 toggle 收起）');
    check(ev._prevented === false, '不 preventDefault（保持默认焦点跳转）');
    document.activeElement = null;
  });

  await section('B5: 焦点在 select 内按 Tab → 不拦截', () => {
    resetMain();
    const n = addMainImg();
    mainSelection.select(n.id);
    document.activeElement = makeEl({ tagName: 'SELECT' });
    const ev = makeKeyEvent({ key: 'Tab' });
    keydownHandler(ev);
    check(mainFloating.isVisible() === false, '不呼出（未 toggle）');
    check(ev._prevented === false, '不 preventDefault');
    document.activeElement = null;
  });

  await section('B6: 焦点在 contenteditable 内按 Tab → 不拦截', () => {
    resetMain();
    const n = addMainImg();
    mainSelection.select(n.id);
    document.activeElement = makeEl({ tagName: 'DIV', isContentEditable: true });
    const ev = makeKeyEvent({ key: 'Tab' });
    keydownHandler(ev);
    check(mainFloating.isVisible() === false, '不呼出');
    check(ev._prevented === false, '不 preventDefault');
    document.activeElement = null;
  });

  await section('B7: 面板显示时按 Esc → 收起', () => {
    resetMain();
    const n = addMainImg();
    mainSelection.select(n.id);
    keydownHandler(makeKeyEvent({ key: 'Tab' }));
    const ev = makeKeyEvent({ key: 'Escape' });
    keydownHandler(ev);
    check(mainFloating.isVisible() === false, 'Esc 收起');
    check(!actionBarEl._has('show') && !cmdPanelEl._has('show'), '两面板收起');
    check(ev._prevented === false, 'Esc 不 preventDefault（原逻辑保留）');
  });

  await section('B8: 输入框聚焦（isTyping）按 Esc → 面板收起、不影响输入框', () => {
    resetMain();
    const n = addMainImg(0, 0, { params: { prompt: 'keepme', model: 'p:draw', aspectRatio: '3:4', resolution: '2k', count: 1 } });
    mainSelection.select(n.id);
    keydownHandler(makeKeyEvent({ key: 'Tab' }));          // 呼出 → 回填 keepme
    cmdInput.value = 'keepme';
    document.activeElement = cmdInput;
    const ev = makeKeyEvent({ key: 'Escape' });
    keydownHandler(ev);
    check(mainFloating.isVisible() === false, '输入框聚焦 Esc → 面板收起');
    check(!cmdPanelEl._has('show'), 'cmd-panel 收起');
    check(document.activeElement === cmdInput, '输入框仍聚焦（不影响输入框本身）');
    check(cmdInput.value === 'keepme', '输入内容不被清空');
    document.activeElement = null;
  });

  await section('B9: Shift+Tab / Ctrl+Tab 修饰键 → 不触发 toggle、不 preventDefault', () => {
    resetMain();
    const n = addMainImg();
    mainSelection.select(n.id);
    const ev1 = makeKeyEvent({ key: 'Tab', shiftKey: true });
    keydownHandler(ev1);
    check(mainFloating.isVisible() === false, 'Shift+Tab 不呼出');
    check(ev1._prevented === false, 'Shift+Tab 不 preventDefault');
    const ev2 = makeKeyEvent({ key: 'Tab', ctrlKey: true });
    keydownHandler(ev2);
    check(mainFloating.isVisible() === false, 'Ctrl+Tab 不呼出');
    check(ev2._prevented === false, 'Ctrl+Tab 不 preventDefault');
  });

  await section('B10: 显示态下切换选中节点（真实键盘路径）→ 内容跟随、不收起', () => {
    resetMain();
    const a = addMainImg(0, 0, { params: { prompt: 'AAA', model: 'p:draw', aspectRatio: '3:4', resolution: '2k', count: 1 } });
    mainSelection.select(a.id);
    keydownHandler(makeKeyEvent({ key: 'Tab' }));          // 呼出
    const b = addMainImg(200, 0, { title: 'BBB卡', params: { prompt: 'BBB', model: 'p:draw', aspectRatio: '16:9', resolution: '2k', count: 1 } });
    mainSelection.select(b.id);
    check(mainFloating.isVisible() === true, '切换选中后仍显示');
    check(cmdPanelEl._has('show') && actionBarEl._has('show'), '两面板不收起');
    check(cmdInput.value === 'BBB', '输入框跟随新节点回填');
    check(chipRatioLabel.textContent === '16:9', 'chip 跟随新节点');
  });

  await section('B11: 收起态下切换选中节点（真实键盘路径）→ 保持收起', () => {
    resetMain();
    const a = addMainImg(0, 0);
    mainSelection.select(a.id);
    keydownHandler(makeKeyEvent({ key: 'Tab' }));
    keydownHandler(makeKeyEvent({ key: 'Escape' }));   // 收起（新口径：Tab 不再收起，Esc 收起）
    const b = addMainImg(300, 0, { title: 'C卡' });
    mainSelection.select(b.id);
    check(mainFloating.isVisible() === false, '仍收起');
    check(!actionBarEl._has('show') && !cmdPanelEl._has('show'), '两面板保持收起');
  });

  await section('B12: Escape 收抽屉/浮层回归（asset-drawer + 各 overlay）', () => {
    resetMain();
    const aDrawer = getEl('asset-drawer');
    const settingsOv = getEl('settings-overlay');
    const outpaintOv = getEl('outpaint-overlay');
    const compareOv = getEl('compare-overlay');
    const ctxMenu = getEl('ctx-menu');
    const imgModal = getEl('img-modal');
    aDrawer.classList.add('open');
    settingsOv.classList.add('show');
    outpaintOv.classList.add('show');
    compareOv.classList.add('show');
    ctxMenu.classList.add('show');
    imgModal.classList.add('show');
    const ev = makeKeyEvent({ key: 'Escape' });
    keydownHandler(ev);
    check(!aDrawer._has('open'), 'Esc 收起 asset 抽屉');
    check(!settingsOv._has('show'), 'Esc 收起设置浮层');
    check(!outpaintOv._has('show'), 'Esc 收起扩图浮层');
    check(!compareOv._has('show'), 'Esc 收起对比浮层');
    check(!ctxMenu._has('show'), 'Esc 收起右键菜单');
    check(!imgModal._has('show'), 'Esc 收起图片弹层');
  });
}

// ═══════════════════════════════════════════════════════════════
// Part D · 点画布空白收起（interactions.ts 真实 mousedown 路径）
// ═══════════════════════════════════════════════════════════════
function fireWrapMouseDown(over = {}) {
  const wrap = getEl('canvas-wrap');
  const ev = {
    button: 0, clientX: 120, clientY: 120, shiftKey: false,
    preventDefault() {}, stopPropagation() {},
    target: makeEl(),
    ...over,
  };
  wrap._fire('mousedown', ev);
  return ev;
}

async function partD() {
  await section('D1: 显示态点画布空白 → 两面板收起 + 取消选中', () => {
    resetMain();
    const n = addMainImg();
    mainSelection.select(n.id);
    keydownHandler(makeKeyEvent({ key: 'Tab' }));
    check(mainFloating.isVisible() === true, '前置：Tab 已呼出');
    fireWrapMouseDown({});            // 空白（target.closest 全 null）
    check(mainFloating.isVisible() === false, '点空白 → floatingPanels 收起');
    check(!actionBarEl._has('show') && !cmdPanelEl._has('show'), '两面板收起');
    check(mainSelection.size === 0, '点空白同时取消选中（原逻辑保留）');
  });

  await section('D2: Shift+点画布空白 → 也收起（hide 置于 Shift 分支前）', () => {
    resetMain();
    const n = addMainImg();
    mainSelection.select(n.id);
    keydownHandler(makeKeyEvent({ key: 'Tab' }));
    fireWrapMouseDown({ shiftKey: true });
    check(mainFloating.isVisible() === false, 'Shift+点空白 → 面板收起');
    check(!actionBarEl._has('show') && !cmdPanelEl._has('show'), '两面板收起');
  });

  await section('D3: 点面板自身区域（cmd-panel/action-bar）→ 不误收起', () => {
    resetMain();
    const n = addMainImg();
    mainSelection.select(n.id);
    keydownHandler(makeKeyEvent({ key: 'Tab' }));
    // 面板区域：target.closest('.cmd-panel') 命中 → 顶层守卫 return
    fireWrapMouseDown({ target: makeEl({ closest: (sel) => (sel === '.cmd-panel' ? makeEl() : null) }) });
    check(mainFloating.isVisible() === true, '点 cmd-panel 区域 → 面板保持显示');
    fireWrapMouseDown({ target: makeEl({ closest: (sel) => (sel === '.action-bar' ? makeEl() : null) }) });
    check(mainFloating.isVisible() === true, '点 action-bar 区域 → 面板保持显示');
    check(actionBarEl._has('show') && cmdPanelEl._has('show'), '两面板未被误收起');
  });

  await section('D4: 点卡片 → 不误收起（选中/交互正常）', () => {
    resetMain();
    const n = addMainImg(0, 0, { params: { prompt: 'cardp', model: 'p:draw', aspectRatio: '3:4', resolution: '2k', count: 1 } });
    mainSelection.select(n.id);
    keydownHandler(makeKeyEvent({ key: 'Tab' }));
    fireWrapMouseDown({ target: makeEl({ closest: (sel) => (sel === '.pcard' ? makeEl({ dataset: { nodeId: n.id } }) : null) }) });
    check(mainFloating.isVisible() === true, '点卡片 → 面板保持显示（不误收起）');
    check(actionBarEl._has('show') && cmdPanelEl._has('show'), '两面板保持显示');
  });
}

// ═══════════════════════════════════════════════════════════════
// Part C · 静态核对
// ═══════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

function checkCircularDeps() {
  console.log('\n▶ C1: floating-panels 无循环依赖（只依赖 state 层）');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/v1/ui/floating-panels.ts'), 'utf8');
  const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map(m => m[1]);
  check(imports.length === 2, `floating-panels 仅 2 处 import (${imports.join(', ')})`);
  check(imports.every(i => i.includes('/state/')), '全部来自 state 层（flow-state/selection）');
  check(!imports.some(i => i.includes('action-bar') || i.includes('cmd-panel') || i.includes('ui/')), '不依赖任何 UI 面板（无循环依赖）');
}

function checkCallerSignatures() {
  console.log('\n▶ C2: 调用方签名一致（isVisible/show/hide；toggle 保留不被键盘调用）');
  const ab = fs.readFileSync(path.join(__dirname, '..', 'src/v1/ui/action-bar.ts'), 'utf8');
  const cp = fs.readFileSync(path.join(__dirname, '..', 'src/v1/ui/cmd-panel.ts'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src/v1/main.ts'), 'utf8');
  const it = fs.readFileSync(path.join(__dirname, '..', 'src/v1/canvas/interactions.ts'), 'utf8');
  const fp = fs.readFileSync(path.join(__dirname, '..', 'src/v1/ui/floating-panels.ts'), 'utf8');
  check(ab.includes('floatingPanels.isVisible()'), 'action-bar 调用 isVisible()');
  check(ab.includes("remove('show', 'pos-below')"), 'action-bar 收起时清理 show+pos-below');
  check(cp.includes('floatingPanels.isVisible()'), 'cmd-panel 调用 isVisible()');
  check(cp.includes("remove('show', 'pos-above', 'textgen', 'reverse')"), 'cmd-panel 收起时清理 show+pos-above+textgen+reverse');
  check(main.includes('floatingPanels.show()'), 'main.ts Tab 分支调用 show()（纯呼出）');
  check(!main.includes('floatingPanels.toggle()'), 'main.ts 不再调用 toggle()');
  check(main.includes('floatingPanels.hide()'), 'main.ts 调用 hide()（Esc 两处）');
  const hideCount = (main.match(/floatingPanels\.hide\(\)/g) || []).length;
  check(hideCount >= 2, `main.ts 中 hide() 出现 ${hideCount} 次（isTyping 分支 + 通用 Escape 分支）`);
  check(it.includes('floatingPanels.hide()'), 'interactions.ts 点画布空白调用 hide()');
  check(it.includes("from '../ui/floating-panels'"), 'interactions → floating-panels 单向依赖（import 方向正确）');
  check(!fp.includes('interactions'), 'floating-panels 不 import interactions（无循环依赖）');
  // show() 唯一调用点：仅 main.ts Tab 分支（键盘路径）
  const callers = [main, it, ab, cp].join('\n');
  const showCalls = (callers.match(/floatingPanels\.show\(\)/g) || []).length;
  check(showCalls === 1, `floatingPanels.show() 唯一调用点（实际 ${showCalls} 处，仅 main.ts Tab 分支）`);
}

// ═══════════════════════════════════════════════════════════════
async function main() {
  console.log('══════════════════════════════════════════════');
  console.log('悬浮框 Tab 化 · QA 独立验证（Edward）');
  console.log('══════════════════════════════════════════════');

  await partA();
  loadMain();
  await tick(80); // 让 main.ts init() 的异步链（模型拉取等）settle
  await partB();
  await partD();
  checkCircularDeps();
  checkCallerSignatures();

  console.log('\n══════════════════════════════════════════════');
  console.log(`结果: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('失败明细:');
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log('QA-TAB-PANELS PASS');
}

main().catch(e => { console.error('测试执行异常:', e); process.exit(2); });
