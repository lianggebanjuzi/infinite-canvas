// smoke/test-trust-layer.cjs
// QA（严过关/Edward）· 信任层（第 1 步）前端 smoke 测试
// 覆盖：HistoryStack 快照栈 / SaveCoordinator 单飞与自动保存 / CloseGuard 关闭保护与打开前检查 /
//       history-persist（buildImageTrace/buildTextTrace/hashRef/appendTrace/loadHistory）
// 运行：先 npx tsc -p tsconfig.smoke.json --outDir <workspace>/.icv-smoke 再 node smoke/test-trust-layer.cjs
// 本项目测试用 Node CommonJS + DOM 桩（非 vitest）。

'use strict';

const BASE = 'G:/Infinite Canvas/Infinite Canvas 2.0/.icv-smoke/v1';

// ───────────────────────── DOM/浏览器桩 ─────────────────────────
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function makeEl(over = {}) {
  const el = {
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    style: {}, dataset: {}, value: '', disabled: false, title: '', checked: false,
    addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {},
    setAttribute() {}, removeAttribute() {}, focus() {}, select() {}, click() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; },
    ...over,
  };
  // textContent <-> innerHTML 联动（toast.escapeHtml 依赖 div.textContent=text 后读 innerHTML）
  let _text = ''; let _html = '';
  Object.defineProperty(el, 'textContent', {
    get() { return _text; },
    set(v) { _text = String(v); _html = escapeHtml(String(v)); },
    configurable: true,
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return _html; },
    set(v) { _html = String(v); },
    configurable: true,
  });
  return el;
}

// toast 观测：showToast 触发 classList.add('show') 并写 innerHTML（含 message）
let toastShown = 0;
let toastHtml = '';
const toastEl = makeEl({
  classList: {
    add(cls) { if (cls === 'show') toastShown += 1; },
    remove() {}, toggle() {}, contains() { return false; },
  },
});
Object.defineProperty(toastEl, 'innerHTML', {
  get() { return toastHtml; },
  set(v) { toastHtml = String(v); },
  configurable: true,
});

const byId = new Map([['toast', toastEl]]);
global.pywebview = { api: {} };
global.window = {
  addEventListener() {}, removeEventListener() {}, close() {},
  setInterval() { return 1; }, clearInterval() {},
  innerWidth: 1280, innerHeight: 800,
  pywebview: global.pywebview,
};
global.document = {
  getElementById: (id) => (byId.has(id) ? byId.get(id) : null),
  createElement: () => makeEl(),
  createElementNS: () => makeEl(),
  addEventListener() {}, removeEventListener() {},
  body: makeEl(),
  documentElement: makeEl({ setAttribute() {}, getAttribute() { return 'light'; } }),
  querySelector() { return null; }, querySelectorAll() { return []; },
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
global.Image = class { set src(_v) {} };

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
const tick = (ms = 15) => new Promise(r => setTimeout(r, ms));

// ───────────────────────── 加载被测模块 ─────────────────────────
const { nodeRegistry } = require(`${BASE}/nodes/node-registry.js`);
require(`${BASE}/nodes/image-gen.js`);
require(`${BASE}/nodes/text-gen.js`);
const { flowState } = require(`${BASE}/state/flow-state.js`);
const { flowHistory } = require(`${BASE}/state/history.js`);
const { dirty } = require(`${BASE}/state/dirty.js`);
const { persistence } = require(`${BASE}/persistence.js`);
const { saveCoordinator } = require(`${BASE}/save-coordinator.js`);
const { closeGuard } = require(`${BASE}/close-guard.js`);
const { historyPersist } = require(`${BASE}/history-persist.js`);
const { runEngine } = require(`${BASE}/engine/run-engine.js`);
const { Backend } = require(`${BASE}/api.js`);
const confirmModule = require(`${BASE}/ui/confirm.js`);

const realSaveProject = Backend.saveProject;
const realSaveProjectAs = Backend.saveProjectAs;
const realAppendHistory = Backend.appendHistory;
const realLoadHistory = Backend.loadHistory;
const realThreeWay = confirmModule.threeWayDialog;

function reset(over = {}) {
  flowState.replaceAll({
    format: 'icv', version: '3.4', projectName: 't', canvas: { scale: 1, panX: 0, panY: 0 },
    nodes: [], edges: [], createdAt: 0, updatedAt: 0, ...over,
  });
  flowHistory.clear();
  persistence['lastPath'] = null;
}

// ───────────────────────── 用例 ─────────────────────────
async function main() {
  // ============ 一、HistoryStack 快照栈 ============
  await section('H1: push/undo/redo 基本往返（节点增删恢复）', () => {
    reset();
    flowHistory.record();
    flowState.addNode('image-gen', 0, 0);
    check(flowHistory.canUndo === true, 'record 后 canUndo');
    check(flowState.nodes.length === 1, '已加 1 节点');
    flowHistory.undo();
    check(flowState.nodes.length === 0, 'undo 恢复 0 节点');
    check(flowHistory.canRedo === true, 'undo 后 canRedo');
    flowHistory.redo();
    check(flowState.nodes.length === 1, 'redo 恢复 1 节点');
    check(flowHistory.canUndo === true && flowHistory.canRedo === false, 'redo 后 canUndo=true/canRedo=false');
  });

  await section('H2: HISTORY_LIMIT=50 裁尾（超出丢最旧）', () => {
    reset();
    for (let i = 0; i < 60; i++) { flowHistory.record(); flowState.addNode('image-gen', i, 0); }
    check(flowState.nodes.length === 60, '60 节点');
    let n = 0;
    while (flowHistory.canUndo) { flowHistory.undo(); n += 1; }
    check(n === 50, `撤销步数受限 50（实际 ${n}）`);
    check(flowState.nodes.length === 10, `undo 到底剩余 10 节点（最旧 10 次已被裁，实际 ${flowState.nodes.length}）`);
    let r = 0;
    while (flowHistory.canRedo) { flowHistory.redo(); r += 1; }
    check(r === 50, `重做步数 50（实际 ${r}）`);
    check(flowState.nodes.length === 60, 'redo 到底恢复 60 节点');
  });

  await section('H3: clear 清空两栈；suspend/resume 隔离', () => {
    reset();
    flowHistory.record(); flowState.addNode('image-gen', 0, 0);
    flowHistory.record(); flowState.addNode('image-gen', 100, 0);
    check(flowHistory.canUndo === true, '有可撤销');
    flowHistory.clear();
    check(!flowHistory.canUndo && !flowHistory.canRedo, 'clear 后两栈皆空');
    // suspend 期间 record 不入栈
    flowHistory.suspend();
    flowHistory.record(); flowState.addNode('image-gen', 200, 0);
    check(!flowHistory.canUndo, 'suspend 期间 record 不入栈');
    flowHistory.resume();
    check(flowHistory.canUndo === false, 'resume 后（此前无有效 record）canUndo false');
    flowHistory.record(); flowState.addNode('image-gen', 300, 0);
    check(flowHistory.canUndo === true, 'resume 后 record 恢复入栈');
    // suspend 期间 canUndo/canRedo 均 false（运行中禁用）
    flowHistory.suspend();
    check(flowHistory.canUndo === false && flowHistory.canRedo === false, 'suspend 期间 canUndo/canRedo 均 false');
    flowHistory.resume();
    check(flowHistory.canUndo === true, 'resume 后 canUndo 恢复 true');
  });

  await section('H4: 撤销穿越保存点 dirty 复位 false（AC-A13/R5.3）', () => {
    reset(); // replaceAll → dirty=false（模拟已保存状态）
    flowHistory.record(); // 捕获 dirty=false 快照
    flowState.addNode('image-gen', 0, 0); // dirty=true
    check(flowState.dirty === true, '改动后 dirty=true');
    flowHistory.undo(); // 回到 dirty=false 快照
    check(flowState.dirty === false, '撤销穿越保存点 → dirty 复位 false');
    check(flowState.nodes.length === 0, '撤销恢复空画布');
  });

  await section('H5: applySnapshot 深拷贝（快照与当前态互不污染）', () => {
    reset();
    const a = flowState.addNode('image-gen', 0, 0, { params: { prompt: 'p0', model: 'm0' } });
    const snap = flowState.captureSnapshot();
    snap.nodes[0].params.prompt = 'HACKED';
    snap.nodes[0].refImages.push('x');
    check(flowState.getNode(a.id).params.prompt === 'p0', 'captureSnapshot 深拷贝 params');
    check(flowState.getNode(a.id).refImages.length === 0, 'captureSnapshot 深拷贝 refImages');

    flowState.updateNodeParams(a.id, { prompt: 'p1' });
    const snap2 = flowState.captureSnapshot(); // 捕获 prompt=p1
    flowState.updateNodeParams(a.id, { prompt: 'p2' });
    flowState.applySnapshot(snap2); // 恢复 p1
    check(flowState.getNode(a.id).params.prompt === 'p1', 'applySnapshot 恢复快照值');
    // 篡改当前态后再 apply 同一快照 → 仍得 p1（快照不被当前态污染）
    flowState.getNode(a.id).params.prompt = 'p3';
    flowState.applySnapshot(snap2);
    check(flowState.getNode(a.id).params.prompt === 'p1', 'applySnapshot 深拷贝：快照不受当前态篡改');
  });

  // ============ 二、SaveCoordinator 保存编排 ============
  await section('S1: 自动保存门控（仅 dirty && hasPath 落盘）', async () => {
    reset();
    persistence['lastPath'] = 'C:/x.icproj';
    let called = 0;
    Backend.saveProject = async () => { called += 1; return { status: 'success', path: 'C:/x.icproj' }; };
    await saveCoordinator.save(true); // dirty=false → 静默跳过
    check(called === 0, '无改动自动保存跳过（不写盘）');

    flowState.addNode('image-gen', 0, 0); // dirty=true
    await saveCoordinator.save(true);
    check(called === 1, 'dirty+hasPath 自动保存落盘');
    check(flowState.dirty === false, '保存成功后 dirty=false');

    // 无路径：静默跳过 + 保持 dirty
    reset();
    persistence['lastPath'] = null;
    flowState.addNode('image-gen', 0, 0);
    called = 0;
    Backend.saveProject = async () => { called += 1; return { status: 'success', path: 'C:/x.icproj' }; };
    const r = await saveCoordinator.save(true);
    check(r === true && called === 0, '无路径自动保存静默跳过（不触发另存为）');
    check(flowState.dirty === true, '无路径自动保存保持 dirty');
  });

  await section('S2: 单飞互斥（在途期间多次 save 不并发写）', async () => {
    reset();
    persistence['lastPath'] = 'C:/x.icproj';
    flowState.addNode('image-gen', 0, 0); // dirty
    let release;
    const gate = new Promise(res => { release = res; });
    let total = 0; let inFlight = 0; let maxInFlight = 0;
    Backend.saveProject = async () => {
      total += 1; inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      await gate;
      inFlight -= 1;
      return { status: 'success', path: 'C:/x.icproj' };
    };
    const p1 = saveCoordinator.save(false);
    await tick();
    const p2 = saveCoordinator.save(false);
    const p3 = saveCoordinator.save(false);
    await tick();
    check(total === 1, `在途期间仅 1 次落盘（实际 ${total}）`);
    release();
    await Promise.all([p1, p2, p3]);
    await tick();
    check(maxInFlight === 1, `无并发写同一文件（maxInFlight=1，实际 ${maxInFlight}）`);
  });

  await section('S3: 在途保存期间的新改动不得静默丢失（pending 合并语义）', async () => {
    reset();
    persistence['lastPath'] = 'C:/x.icproj';
    const nodeA = flowState.addNode('image-gen', 0, 0, { params: { prompt: 'A' } }); // dirty, 状态 A
    let release;
    const gate = new Promise(res => { release = res; });
    let total = 0;
    const captured = [];
    Backend.saveProject = async (data) => {
      total += 1; captured.push(JSON.parse(JSON.stringify(data)));
      if (total === 1) await gate; // 仅卡住第一次
      return { status: 'success', path: 'C:/x.icproj' };
    };
    const p1 = saveCoordinator.save(false); // 捕获状态 A 后挂起
    await tick();
    flowState.updateNodeParams(nodeA.id, { prompt: 'B' }); // 在途期间改动 → 状态 B, dirty=true
    const p2 = saveCoordinator.save(false); // 应标记 pending
    release();
    await Promise.all([p1, p2]);
    await tick(40); // 等待可能的 pending 补写
    const bPersisted = captured.some(d => d.nodes.some(n => n.params && n.params.prompt === 'B'));
    check(total === 2, `在途改动应触发 pending 合并补写（期望 2 次写，实际 ${total}）`);
    check(bPersisted, '最新状态 B 应被落盘');
    check(flowState.dirty === false, '补写后 dirty=false（无未落盘改动）');
  });

  await section('S4: saveForClose 等待在途保存并强制补一次', async () => {
    reset();
    persistence['lastPath'] = 'C:/x.icproj';
    flowState.addNode('image-gen', 0, 0);
    let release;
    const gate = new Promise(res => { release = res; });
    let total = 0;
    Backend.saveProject = async () => {
      total += 1;
      if (total === 1) await gate;
      return { status: 'success', path: 'C:/x.icproj' };
    };
    const p1 = saveCoordinator.save(false);
    await tick();
    const closeP = saveCoordinator.saveForClose(); // 等待在途
    await tick();
    release();
    const ok = await closeP;
    await p1;
    await tick();
    check(ok === true, 'saveForClose 返回 true');
    check(total === 2, `saveForClose 等待在途并补一次（实际 ${total}）`);
  });

  await section('S5: 顶栏三态（saved/dirty/saving）', () => {
    const statusEl = makeEl();
    const dotEl = makeEl();
    saveCoordinator['statusEl'] = statusEl;
    saveCoordinator['dotEl'] = dotEl;
    reset(); // dirty=false
    saveCoordinator.setStatus();
    check(statusEl.dataset.status === 'saved' && statusEl.textContent === '已保存', '三态：已保存');
    flowState.addNode('image-gen', 0, 0); // dirty=true
    saveCoordinator.setStatus();
    check(statusEl.dataset.status === 'dirty' && statusEl.textContent === '未保存', '三态：未保存');
    saveCoordinator['saving'] = true;
    saveCoordinator.setStatus();
    check(statusEl.dataset.status === 'saving' && statusEl.textContent === '保存中…', '三态：保存中');
    saveCoordinator['saving'] = false;
    saveCoordinator['statusEl'] = null;
    saveCoordinator['dotEl'] = null;
  });

  await section('S6: 保存窗口内重命名项目 → 版本同步，pending 补写不丢', async () => {
    reset();
    persistence['lastPath'] = 'C:/x.icproj';
    flowState.projectName = '旧名';
    flowState.updatedAt = Date.now();
    flowState.dirty = true;
    let release;
    const gate = new Promise(res => { release = res; });
    let total = 0;
    const names = [];
    Backend.saveProject = async (data) => {
      total += 1; names.push(data.projectName);
      if (total === 1) await gate; // 仅卡住第一次
      return { status: 'success', path: 'C:/x.icproj' };
    };
    const p1 = saveCoordinator.save(false); // collect「旧名」后挂起
    await tick();
    // 模拟 bottom-bar 项目名 input 处理器：重命名（dirty + updatedAt + notify 三者同步）
    flowState.projectName = '新名';
    flowState.updatedAt = Date.now();
    flowState.dirty = true;
    flowState.notify();
    const p2 = saveCoordinator.save(false); // 应标记 pending
    release();
    await Promise.all([p1, p2]);
    await tick(40); // 等待可能的 pending 补写
    check(total === 2, `重命名在途应触发 pending 合并补写（期望 2 次写，实际 ${total}）`);
    check(names.includes('新名'), '最新项目名「新名」应被落盘');
    check(flowState.dirty === false, '补写后 dirty=false（无未落盘改动）');
  });

  // ============ 三、CloseGuard 关闭保护 + 打开前检查 ============
  await section('C1: 无改动直接关闭（不弹窗）；__icvIsDirty 桥接', async () => {
    reset(); // dirty=false
    let closeCalled = 0;
    global.pywebview.api.win_close = () => { closeCalled += 1; };
    check(typeof global.window.__icvIsDirty === 'function', '__icvIsDirty 已注入');
    check(global.window.__icvIsDirty() === false, '__icvIsDirty 返回 dirty=false');
    await closeGuard.requestClose();
    check(closeCalled === 1, '无改动直接 win_close');
    flowState.addNode('image-gen', 0, 0);
    check(global.window.__icvIsDirty() === true, '__icvIsDirty 返回 dirty=true');
  });

  await section('C2: 三选一：取消不关 / 不保存关 / 保存并关 / 保存失败不关', async () => {
    let closeCalled = 0;
    global.pywebview.api.win_close = () => { closeCalled += 1; };

    // 取消
    reset(); flowState.addNode('image-gen', 0, 0); // dirty
    confirmModule.threeWayDialog = async () => 'cancel';
    await closeGuard.requestClose();
    check(closeCalled === 0, '选取消 → 不关闭');

    // 不保存
    confirmModule.threeWayDialog = async () => 'discard';
    await closeGuard.requestClose();
    check(closeCalled === 1, '选不保存 → 直接关闭（跳过保存）');

    // 保存并关闭（成功）
    reset(); flowState.addNode('image-gen', 0, 0);
    persistence['lastPath'] = 'C:/x.icproj';
    Backend.saveProject = async () => ({ status: 'success', path: 'C:/x.icproj' });
    confirmModule.threeWayDialog = async () => 'save';
    await closeGuard.requestClose();
    check(closeCalled === 2, '选保存并关闭 → 保存成功后关闭');
    check(flowState.dirty === false, '关闭前保存成功 dirty=false');

    // 保存失败 → 不关闭
    reset(); flowState.addNode('image-gen', 0, 0);
    persistence['lastPath'] = 'C:/x.icproj';
    Backend.saveProject = async () => ({ status: 'error', message: '磁盘满' });
    confirmModule.threeWayDialog = async () => 'save';
    await closeGuard.requestClose();
    check(closeCalled === 2, '保存失败 → 不关闭（R3.2）');
  });

  await section('C3: 打开前 dirty 检查（guardOpen 三态）', async () => {
    let actionRan = 0;
    const action = () => { actionRan += 1; };
    // 无改动 → 直接执行
    reset();
    await closeGuard.guardOpen(action);
    check(actionRan === 1, '无改动直接执行 action');

    // 取消 → 不执行
    flowState.addNode('image-gen', 0, 0); // dirty
    confirmModule.threeWayDialog = async () => 'cancel';
    await closeGuard.guardOpen(action);
    check(actionRan === 1, '选取消 → 不执行打开');

    // 放弃 → 执行
    confirmModule.threeWayDialog = async () => 'discard';
    await closeGuard.guardOpen(action);
    check(actionRan === 2, '选放弃 → 执行打开');

    // 保存 → 先保存后执行（R4.3）
    persistence['lastPath'] = 'C:/x.icproj';
    Backend.saveProject = async () => ({ status: 'success', path: 'C:/x.icproj' });
    confirmModule.threeWayDialog = async () => 'save';
    await closeGuard.guardOpen(action);
    check(actionRan === 3, '选保存 → 保存成功后执行打开');
    check(flowState.dirty === false, '打开前保存 dirty=false');
  });

  await section('C4: promptUnsavedChanges 文案（运行中附中断警示 + 模式区分）', async () => {
    let cfg = null;
    confirmModule.threeWayDialog = async (c) => { cfg = c; return 'cancel'; };
    runEngine['busy'] = true;
    await closeGuard.promptUnsavedChanges('close');
    check(cfg && cfg.message.includes('中断'), '运行中关闭 → 中断警示');
    check(cfg && cfg.saveText === '保存并关闭', 'close 模式保存按钮文案');
    runEngine['busy'] = false;
    await closeGuard.promptUnsavedChanges('open');
    check(cfg && cfg.title.includes('打开'), 'open 模式标题');
    check(cfg && cfg.saveText === '保存', 'open 模式保存按钮文案');
    check(cfg && cfg.discardText === '放弃改动', 'open 模式放弃文案');
  });

  // ============ 四、history-persist / trace ============
  await section('P1: hashRef（djb2 确定性/区分度）', () => {
    check(historyPersist.hashRef('abc') === historyPersist.hashRef('abc'), 'hashRef 确定性');
    check(typeof historyPersist.hashRef('x') === 'string' && historyPersist.hashRef('x').length > 0, 'hashRef 返回非空字符串');
    check(historyPersist.hashRef('a') !== historyPersist.hashRef('b'), 'hashRef 区分不同输入');
    check(historyPersist.hashRef('') === '1505', `空串哈希稳定（实际 ${historyPersist.hashRef('')}）`);
  });

  await section('P2: buildImageTrace 字段齐全（含中文/默认值）', () => {
    reset();
    const node = flowState.addNode('image-gen', 0, 0, {
      params: { prompt: '一只猫', model: 'p:m', aspectRatio: '1:1', resolution: '4k', count: 2 },
    });
    const trace = historyPersist.buildImageTrace(node, ['ref1', 'ref2'], 'img2img');
    check(trace.prompt === '一只猫', 'prompt');
    check(trace.model === 'p:m', 'model');
    check(trace.aspectRatio === '1:1', 'aspectRatio');
    check(trace.resolution === '4k', 'resolution');
    check(trace.count === 2, 'count');
    check(Array.isArray(trace.refImageHashes) && trace.refImageHashes.length === 2, 'refImageHashes 数组');
    check(trace.refImageHashes[0] === historyPersist.hashRef('ref1'), 'refImageHashes 为 hashRef 结果');
    check(trace.seed === null, 'seed 默认 null');
    check(typeof trace.createdAt === 'number', 'createdAt 时间戳');
    check(trace.parentId === node.id, 'parentId 缺省为自身 id');
    check(trace.outputType === 'img2img', 'outputType');

    // 默认值兜底
    const n2 = flowState.addNode('image-gen', 300, 0, { params: {} });
    const t2 = historyPersist.buildImageTrace(n2, [], 'txt2img');
    check(t2.prompt === '' && t2.model === '', '缺参 prompt/model 空串');
    check(t2.aspectRatio === '3:4' && t2.resolution === '2k' && t2.count === 1, '缺参 aspectRatio/resolution/count 默认');
  });

  await section('P3: buildTextTrace 精简字段（无图片字段）', () => {
    reset();
    const tnode = flowState.addNode('text-gen', 0, 0, { params: { instruction: '翻译', model: 'p:c' }, outputText: '结果文本' });
    const e = historyPersist.buildTextTrace(tnode);
    check(e.kind === 'text', 'kind=text');
    check(e.nodeId === tnode.id, 'nodeId');
    check(e.instruction === '翻译', 'instruction');
    check(e.model === 'p:c', 'model');
    check(e.outputText === '结果文本', 'outputText');
    check(typeof e.createdAt === 'number', 'createdAt');
    check(e.parentId === null, 'parentId null');
    check(!('aspectRatio' in e) && !('resolution' in e), 'text trace 无图片字段');
  });

  await section('P4: appendTrace 成功静默 / 失败与异常 toast「历史记录未写入」', async () => {
    toastShown = 0; toastHtml = '';
    Backend.appendHistory = async () => ({ status: 'success' });
    await historyPersist.appendTrace({ kind: 'text', nodeId: 'x', instruction: 'i', model: 'm', outputText: 'o', createdAt: 0, parentId: null });
    check(toastShown === 0, '成功不 toast');

    Backend.appendHistory = async () => ({ status: 'error', message: 'no_path' });
    await historyPersist.appendTrace({ kind: 'text', nodeId: 'x', instruction: 'i', model: 'm', outputText: 'o', createdAt: 0, parentId: null });
    check(toastShown === 1 && toastHtml.includes('历史记录未写入'), '错误状态 → toast 历史记录未写入');

    Backend.appendHistory = async () => { throw new Error('io'); };
    await historyPersist.appendTrace({ kind: 'text', nodeId: 'x', instruction: 'i', model: 'm', outputText: 'o', createdAt: 0, parentId: null });
    check(toastShown === 2, '异常也 toast（写失败不阻断）');
  });

  await section('P5: loadHistory（success/empty/异常→[]）', async () => {
    Backend.loadHistory = async () => ({ status: 'success', entries: [{ kind: 'image', nodeId: 'n1' }, { kind: 'text', nodeId: 'n2' }] });
    let entries = await historyPersist.loadHistory();
    check(entries.length === 2 && entries[0].nodeId === 'n1', 'success 返回 entries');

    Backend.loadHistory = async () => ({ status: 'empty' });
    entries = await historyPersist.loadHistory();
    check(Array.isArray(entries) && entries.length === 0, 'empty → []');

    Backend.loadHistory = async () => { throw new Error('io'); };
    entries = await historyPersist.loadHistory();
    check(Array.isArray(entries) && entries.length === 0, '异常 → []（静默）');
  });

  console.log(`\n══════════════════════════════════`);
  console.log(`信任层前端：通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) {
    console.error('失败明细：');
    failures.forEach(f => console.error(`- ${f}`));
    process.exit(1);
  }
  console.log('TRUST-LAYER PASS');
}

main().catch(e => { console.error(e); process.exit(1); });
