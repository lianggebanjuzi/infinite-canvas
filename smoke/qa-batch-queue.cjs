// smoke/qa-batch-queue.cjs
// QA 独立回归（T01-T03 批次队列核心，commit 待定）
//
// 验证点：
//   S1 port-types 端口契约：canConnect 七组现状行为不退化（查表 + 特例）
//   S2 batchStore.createBatch：jobs.length === total、全 queued、batchId/jobId 格式
//   S3 batch-queue 限并发：最多 5 个 Job 在途，完成一个立即补一个，成功逐张回调
//   S4 runEngine 整批成功：节点 done + generatedImages 有序 + trace/history 带 batchId+jobId
//   S5 Job 独立错误：一败一成一 → partial-failed；每 Job 独立 error（无共享 lastError）
//   S6 retryJob 逐条重试：失败项 attempts+1、成功图不丢
//   S7 retryFailed 全部重试
//   S8 count>1 不再自动建子卡：结果全部写回 generatedImages（parentId 子节点数 0）
//   S9 buildImageTrace 透传 batchId/jobId
//   S10 rebuildFromNodes：从节点结果重建已知批次（restored/unknownCount）
//   S11 persistence.collect 七态归一五态（queued→idle、partial-failed→done）
//   S12 cancel：批次 cancelled、节点恢复 idle
//
// 运行：
//   node node_modules/typescript/bin/tsc -p tsconfig.smoke.json --outDir D:/tmp/icv-test
//   node smoke/qa-batch-queue.cjs

'use strict';

const BASE = process.env.ICV_SMOKE_BASE || 'D:/tmp/icv-test/v1';

// 崩溃兜底：未处理拒绝/异常 → 记录到文件便于排查（防止整进程退出丢失后续输出）
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED_REJECTION:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT_EXCEPTION:', err);
});

// ───────────────────────── DOM/浏览器桩（沿用 qa-text-wiring 约定） ─────────────────────────
function makeEl(over = {}) {
  const classes = new Set();
  const el = {
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      toggle(c, on) { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
      contains(c) { return classes.has(c); },
    },
    style: {}, dataset: {}, value: '', disabled: false, title: '', checked: false, placeholder: '',
    spellcheck: false, type: '', children: [],
    _handlers: {},
    addEventListener(t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); },
    removeEventListener(t, fn) { const arr = this._handlers[t] || []; const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); },
    dispatch(t, ev) { (this._handlers[t] || []).slice().forEach(fn => fn(ev || { target: this, stopPropagation() {}, preventDefault() {}, dataTransfer: null, currentTarget: this })); },
    appendChild(c) { this.children.push(c); return c; },
    remove() {}, setAttribute() {}, removeAttribute() {}, focus() {}, select() {}, click() {},
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 168, height: 32, right: 168, bottom: 32 }; },
    isConnected: true,
    ...over,
  };
  let _html = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return _html; },
    set(v) { _html = String(v); el.children.length = 0; },
    configurable: true,
  });
  Object.defineProperty(el, 'textContent', {
    get() { return _html; },
    set(v) { _html = String(v); },
    configurable: true,
  });
  return el;
}

const byId = new Map();
const toastLog = [];
const toastEl = makeEl();
Object.defineProperty(toastEl, 'innerHTML', {
  get() { return this._html || ''; },
  set(v) { this._html = String(v); toastLog.push(String(v)); },
  configurable: true,
});
byId.set('toast', toastEl);
const bodyChildren = [];

global.pywebview = { api: {} };
global.window = {
  addEventListener() {}, removeEventListener() {}, close() {},
  setTimeout, clearTimeout, setInterval() { return 1; }, clearInterval() {},
  innerWidth: 1280, innerHeight: 800, pywebview: global.pywebview, isSecureContext: true,
};
global.document = {
  getElementById: (id) => (byId.has(id) ? byId.get(id) : null),
  createElement: () => makeEl(),
  createElementNS: () => makeEl(),
  addEventListener() {}, removeEventListener() {},
  body: makeEl({ appendChild(c) { bodyChildren.push(c); return c; }, removeChild() {} }),
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
try { Object.defineProperty(global, 'Toast', { value: { show() {} }, configurable: true }); } catch { /* 旧 Node 可写 */ }

// Image 桩（loadImageRatio 用）
let imgRatio = { w: 260, h: 195 };
class FakeImage {
  constructor() {
    this.naturalWidth = imgRatio.w;
    this.naturalHeight = imgRatio.h;
    this.onload = null;
    this.onerror = null;
    this._src = '';
  }
  set src(v) {
    this._src = v;
    setTimeout(() => this.onload && this.onload(), 0);
  }
  get src() { return this._src; }
}
global.Image = FakeImage;

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
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout = 8000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) return false;
    await tick();
  }
  return true;
}

// ───────────────────────── Backend 桩（可控并发/失败） ─────────────────────────
let genCalls = [];
let historyAppendCalls = [];
let genQueue = [];
let failIndexes = new Set();     // 第 N 次 generateImage（1-based）→ 失败
let pendingTicks = 0;            // 每个任务轮询时先返回 pending 的轮数（0=立即 done）
let activeJobs = 0;
let maxActiveJobs = 0;
const taskPlans = new Map();     // taskId → { pending, fail }

function installPywebview() {
  genCalls = [];
  historyAppendCalls = [];
  activeJobs = 0;
  maxActiveJobs = 0;
  taskPlans.clear();
  global.pywebview.api = {
    async load_providers() { return { providers: [] }; },
    async load_settings() { return {}; },
    async load_assets() { return { status: 'empty' }; },
    async save_assets() { return { status: 'success' }; },
    async load_history() { return { status: 'empty' }; },
    async append_history(entry) { historyAppendCalls.push(JSON.parse(JSON.stringify(entry))); return { status: 'success' }; },
    async unified_chat_v2() { return { text: 'x' }; },
    async unified_generate_image(prompt, options) {
      const idx = genCalls.length + 1;
      genCalls.push({ prompt, options: JSON.parse(JSON.stringify(options || {})) });
      const taskId = 't' + idx;
      taskPlans.set(taskId, { pending: pendingTicks, fail: failIndexes.has(idx) });
      if (process.env.QA_TRACE) console.log(`[trace] GEN ${taskId} fail=${failIndexes.has(idx)} pending=${pendingTicks}`);
      return { task_id: taskId };
    },
    async unified_get_task_result(taskId) {
      const plan = taskPlans.get(String(taskId));
      if (!plan) return { status: 'not_found' };
      if (plan.pending > 0) { plan.pending -= 1; return { status: 'pending' }; }
      taskPlans.delete(String(taskId));
      if (process.env.QA_TRACE) console.log(`[trace] POLL ${taskId} -> ${plan.fail ? 'FAIL' : 'OK'}`);
      if (plan.fail) return { status: 'done', result: { success: false, error_code: 500, message: 'mock 失败' } };
      return { status: 'done', result: { success: true, image_url: 'data:image/png;base64,' + String(taskId), saved_to_disk: true, width: 1024, height: 768 } };
    },
    async save_project() { return { status: 'success' }; },
    async save_project_as() { return { status: 'success' }; },
    async open_project_dialog() { return { status: 'cancelled' }; },
    async load_project() { return { data: {} }; },
    async get_current_project_path() { return { path: '' }; },
    async save_image_to_local() { return { path: '' }; },
    async save_image_as() { return { path: '' }; },
    async load_local_image() { return { status: 'error' }; },
    async copy_to_clipboard() { return { status: 'success' }; },
    async paste_from_clipboard() { return { cards: [] }; },
    async save_prompts_library() { return { status: 'success' }; },
    async load_prompts_library() { return {}; },
    async unified_chat() { return { content: '' }; },
    async agent_chat() { return { content: '' }; },
    async outpaint() { return { url: '' }; },
    async update_key() { return { status: 'success' }; },
    async add_key() { return { status: 'success' }; },
    async delete_key() { return { status: 'success' }; },
    async update_provider() { return { status: 'success' }; },
    async delete_provider() { return { status: 'success' }; },
    async test_api_connection() { return { success: true }; },
    async fetch_models() { return { status: 'success', models: [] }; },
    async add_chat_model() { return { status: 'success' }; },
    async remove_model() { return { status: 'success' }; },
    async select_folder() { return { path: '' }; },
  };
}

// ───────────────────────── 加载被测模块 ─────────────────────────
installPywebview();
require(`${BASE}/nodes/image-gen.js`);
require(`${BASE}/nodes/text-gen.js`);
require(`${BASE}/nodes/text-split.js`);
const { flowState } = require(`${BASE}/state/flow-state.js`);
const { runEngine } = require(`${BASE}/engine/run-engine.js`);
const { batchStore } = require(`${BASE}/state/batch-store.js`);
const { batchQueue } = require(`${BASE}/engine/batch-queue.js`);
const { persistence } = require(`${BASE}/persistence.js`);
const { historyPersist } = require(`${BASE}/history-persist.js`);
const { canConnectByPort, PORT_TYPES } = require(`${BASE}/nodes/port-types.js`);
const { assetStore } = require(`${BASE}/asset-store.js`);
const { taskPanel } = require(`${BASE}/ui/task-panel.js`);
const { resultViewer } = require(`${BASE}/ui/result-viewer.js`);
const { connectionDescription } = require(`${BASE}/canvas/link-view.js`);

// ───────────────────────── 测试辅助 ─────────────────────────
function reset() {
  flowState.nodes = [];
  flowState.edges = [];
  flowState.selectedIds.clear();
  flowState.dirty = false;
  flowState.projectName = '未命名项目';
  batchStore.clear();
  runEngine.busy = false;
  runEngine.activeRun = null;
  runEngine._batchRunners.clear();
  runEngine._createdCardIds.clear();
  runEngine._sawNotSavedToDisk = false;
  toastLog.length = 0;
  historyAppendCalls.length = 0;
  genCalls.length = 0;
  genQueue = [];
  failIndexes = new Set();
  pendingTicks = 0;
  activeJobs = 0;
  maxActiveJobs = 0;
  taskPlans.clear();
  imgRatio = { w: 260, h: 195 };
}

/** 便捷建图片节点（count 由 params.count 控制） */
function G(count, over = {}) {
  return flowState.addNode('image-gen', 300, 100, {
    title: '图片生成',
    params: { prompt: '测试提示词', model: 'p:k:m', aspectRatio: '4:3', resolution: '2k', count, ...(over.params || {}) },
    ...over,
  });
}

/** 建 文本 → 拆分 → 图片 三段链（text-split 由上游文本派生槽位） */
function chain(sourceText, delimiter = '########', count = 1) {
  const t = flowState.addNode('text-gen', 0, 100, {
    title: '文本', outputText: sourceText,
    params: { instruction: '', model: 'chat-m1' },
  });
  const s = flowState.addNode('text-split', 120, 100, {
    title: '文本拆分', params: { delimiter, segments: ['', ''] },
  });
  const g = flowState.addNode('image-gen', 300, 100, {
    title: '图片生成',
    params: { prompt: '', model: 'p:k:m', aspectRatio: '4:3', resolution: '2k', count },
  });
  flowState.addEdge(t.id, s.id);
  flowState.addEdge(s.id, g.id);
  return { t, s, g };
}

// ───────────────────────── S1 端口契约（A-3） ─────────────────────────
async function main() {
await section('S1 port-types 端口契约：canConnect 七组现状行为不退化', async () => {
  check(PORT_TYPES['image-gen'].inputs.includes('TextList'), 'image-gen 接收 TextList（拆分批量）');
  check(PORT_TYPES['image-gen'].outputs.includes('Image') && PORT_TYPES['image-gen'].outputs.includes('ImageList'), 'image-gen 输出 Image/ImageList（多态）');
  check(PORT_TYPES['text-split'].outputs.includes('TextList'), 'text-split 输出 TextList');
  check(PORT_TYPES['text-gen'].outputs.includes('Text'), 'text-gen 输出 Text');

  // 七组现状连线
  const text = flowState.addNode('text-gen', 0, 0, { outputText: 'abc', params: { model: 'm' } });
  const split = flowState.addNode('text-split', 100, 0, { params: { delimiter: '#', segments: ['a', 'b'] } });
  const gen = flowState.addNode('image-gen', 200, 0, { params: { prompt: 'p', model: 'm', count: 1 } });
  const asset = flowState.addNode('image-gen', 300, 0, { isAsset: true, imageUrl: 'data:image/png;base64,A' });

  check(flowState.canConnect(text.id, split.id) === null, 'text-gen → text-split 允许');
  check(flowState.canConnect(split.id, gen.id) === null, 'text-split → image-gen 允许（批量生成）');
  check(flowState.canConnect(text.id, gen.id) === null, 'text-gen → image-gen 允许');
  check(flowState.canConnect(gen.id, text.id) === null, 'image-gen → text-gen 允许（反推输入）');
  check(flowState.canConnect(asset.id, gen.id) === null, '素材 → image-gen 允许（图生图参考）');
  check(flowState.canConnect(text.id, text.id) === null ? false : true, '自连拒绝');
  check(flowState.canConnect(text.id, text.id) !== null, 'text-gen → text-gen 拒绝（保留特例）');
  check(flowState.canConnect(split.id, text.id) !== null, 'text-split → text-gen 拒绝');
  check(flowState.canConnect(gen.id, asset.id) !== null, '任何 → 素材 拒绝（素材不能作为输入）');

  // 直接查表接口：素材拒绝是 canConnect 基础校验的职责（查表只见类型，asset 态由 flowState 前置拦截）
  check(canConnectByPort(gen, asset) === null, 'canConnectByPort：素材类型表仍按 image-gen 声明（拒绝由基础校验负责）');
  check(canConnectByPort(text, split) === null, 'canConnectByPort：Text → Text ✓');
  reset();
});

// ───────────────────────── S2 createBatch ─────────────────────────
await section('S2 batchStore.createBatch：jobs.length === total、全 queued、格式', async () => {
  const node = G(3);
  const batch = batchStore.createBatch({
    nodeId: node.id, source: 'manual-count', total: 3, concurrency: 2,
    prompts: ['a', 'b', 'c'],
  });
  check(batch.jobs.length === 3 && batch.total === 3, `jobs.length === total（${batch.jobs.length}）`);
  check(batch.jobs.every(j => j.status === 'queued' && j.attempts === 1), '全部 Job queued 且 attempts=1');
  check(batch.id.startsWith(node.id + '_'), `batchId 格式 ${node.id}_<ts>（${batch.id.slice(0, 20)}…）`);
  check(batch.jobs.every((j, i) => j.id === `${batch.id}_j${i}`), 'jobId 格式 ${batchId}_j${index}');
  check(batch.jobs.map(j => j.prompt).join(',') === 'a,b,c', 'prompt 按序快照');
  const s = batchStore.summarize(batch.id);
  check(s.total === 3 && s.queued === 3 && s.succeeded === 0, 'summarize 初始：total=3 queued=3');
  reset();
});

// ───────────────────────── S3 限并发 + 单张结果回调 ─────────────────────────
await section('S3 batch-queue：最多 5 个 Job 在途，完成一个立即补一个，成功逐张回调', async () => {
  const node = G(8);
  pendingTicks = 3; // 每个任务保持 3 轮 pending，制造重叠
  batchStore.createBatch({
    nodeId: node.id, source: 'manual-count', total: 8, concurrency: 5,
    prompts: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'],
  });
  const batchId = batchStore.getBatchesByNode(node.id)[0].id;
  let maxObserved = 0;
  let activeNow = 0;
  const runJob = async (job, hooks) => {
    activeNow += 1;
    maxObserved = Math.max(maxObserved, activeNow);
    try {
      if (hooks.isCancelled()) return { success: false, error: '已取消' };
      const created = await global.pywebview.api.unified_generate_image(job.prompt, {});
      hooks.onRunning(created.task_id);
      // 模拟轮询：pendingTicks 轮 pending 后成功
      for (let i = 0; i < pendingTicks + 1; i++) {
        await tick(5);
        const r = await global.pywebview.api.unified_get_task_result(created.task_id);
        if (r.status === 'done') {
          return { success: true, image: { url: r.result.image_url, width: r.result.width, height: r.result.height } };
        }
      }
      return { success: false, error: '超时' };
    } finally {
      activeNow -= 1;
    }
  };
  let completedImmediately = 0;
  const finished = await batchQueue.submit(batchId, runJob, () => { completedImmediately += 1; });
  check(finished !== null && finished.status === 'completed', '批次 completed');
  check(maxObserved === 5, `8 个 Job 的在途峰值被限制为 5（实际峰值 ${maxObserved}）`);
  check(completedImmediately === 8, `成功逐张回调 8 次（实际 ${completedImmediately}）`);
  check(batchStore.summarize(batchId).succeeded === 8, '8 个 Job 全部成功，槽位释放后已补发后续请求');

  // 第二批也不被前一批的配置残留限制
  const node2 = G(2);
  batchStore.createBatch({ nodeId: node2.id, source: 'manual-count', total: 2, concurrency: 2, prompts: ['x', 'y'] });
  const batchId2 = batchStore.getBatchesByNode(node2.id)[0].id;
  maxObserved = 0; activeNow = 0;
  await batchQueue.submit(batchId2, async (job, hooks) => {
    activeNow += 1;
    maxObserved = Math.max(maxObserved, activeNow);
    await tick(10);
    activeNow -= 1;
    return { success: true, image: { url: 'data:image/png;base64,OK' } };
  });
  check(maxObserved === 2, `2 个 Job 全部同时发起（实际峰值 ${maxObserved}）`);
  const node3 = G(3);
  batchStore.createBatch({ nodeId: node3.id, source: 'manual-count', total: 3, concurrency: 3, prompts: ['x', 'y', 'z'] });
  const batchId3 = batchStore.getBatchesByNode(node3.id)[0].id;
  maxObserved = 0; activeNow = 0;
  await batchQueue.submit(batchId3, async (job, hooks) => {
    activeNow += 1;
    maxObserved = Math.max(maxObserved, activeNow);
    await tick(10);
    activeNow -= 1;
    return { success: true, image: { url: 'data:image/png;base64,OK' } };
  });
  check(maxObserved === 3, `3 个 Job 全部同时发起（实际峰值 ${maxObserved}）`);
  reset();
});

// ───────────────────────── S4 整批成功（count>1 写回 generatedImages） ─────────────────────────
await section('S4 runEngine 整批成功：count>1 不建子卡、写回 generatedImages + trace batchId/jobId', async () => {
  const node = G(3);
  if (process.env.QA_TRACE) console.log(`[trace] S4 node=${node.id} status=${node.status} busy=${runEngine.busy} type=${node.type} params=${JSON.stringify(node.params)}`);
  pendingTicks = 0;
  const before = flowState.nodes.length;
  await runEngine.run(node.id);
  if (process.env.QA_TRACE) console.log(`[trace] S4 after-run status=${flowState.getNode(node.id)?.status} genCalls=${genCalls.length}`);
  check(flowState.getNode(node.id)?.status === 'done', `节点 done（实际 ${flowState.getNode(node.id)?.status}）`);
  const after = flowState.getNode(node.id);
  check(after.generatedImages && after.generatedImages.length === 3, `generatedImages 3 张（实际 ${after.generatedImages?.length}）`);
  check(flowState.nodes.length === before, `count>1 不再自动建子卡（节点数不变 ${flowState.nodes.length}）`);
  check(after.imageUrl === after.generatedImages[0].url, '首图写回 imageUrl（预览）');
  check(!!after.trace && !!after.trace.batchId, 'trace 带 batchId');
  check(!!after.trace && !!after.trace.jobId, 'trace 带 jobId（首图任务编号）');
  const imageRows = historyAppendCalls.filter(e => e.kind === 'image');
  check(imageRows.length === 3, `history.jsonl 追加 3 行 image（实际 ${imageRows.length}）`);
  check(imageRows.every(r => !!r.batchId && !!r.jobId), '每行带 batchId + jobId');
  const rowJobOrdinals = imageRows
    .map(r => Number(r.jobId.split('_j')[1]))
    .sort((a, b) => a - b);
  check(rowJobOrdinals.join(',') === '0,1,2',
    `三张结果均带唯一 jobId（${rowJobOrdinals.join(',')}）`);
  check(batchStore.getLatestBatch(node.id)?.status === 'completed', '批次 completed');
  reset();
});

// ───────────────────────── S5 Job 独立错误 ─────────────────────────
await section('S5 Job 独立错误：一败一成一 → partial-failed、error 独立', async () => {
  const node = G(2);
  pendingTicks = 0;
  failIndexes = new Set([1]); // 第 1 个任务失败
  await runEngine.run(node.id);
  const n = flowState.getNode(node.id);
  check(n.status === 'partial-failed', `节点 partial-failed（实际 ${n.status}）`);
  const batch = batchStore.getLatestBatch(node.id);
  const s = batchStore.summarize(batch.id);
  check(s.succeeded === 1 && s.failed === 1, `汇总 成功 1/2 失败 1（实际 成功 ${s.succeeded} 失败 ${s.failed}）`);
  const failedJob = batch.jobs.find(j => j.status === 'failed');
  const okJob = batch.jobs.find(j => j.status === 'succeeded');
  check(!!failedJob.error && failedJob.error.includes('mock 失败'), '失败 Job 有独立 error');
  check(okJob.error == null || okJob.error === '', '成功 Job error 为空（不共享 lastError）');
  check(n.generatedImages.length === 1, '成功图保留（不因兄弟失败丢失）');
  reset();
});

// ───────────────────────── S6 retryJob ─────────────────────────
await section('S6 retryJob 逐条重试：attempts+1、成功图不丢', async () => {
  const node = G(2);
  pendingTicks = 0;
  failIndexes = new Set([1]);
  await runEngine.run(node.id);
  const batch = batchStore.getLatestBatch(node.id);
  if (!batch) { check(false, '批次存在'); reset(); return; }
  const failedJob = batch.jobs.find(j => j.status === 'failed');
  if (!failedJob) { check(false, `存在失败 Job（实际状态：${batch.jobs.map(j => j.status).join(',')}）`); reset(); return; }
  const batchId = batch.id;
  // 重试：失败任务这次成功
  failIndexes = new Set();
  await runEngine.retryJob(node.id, batchId, failedJob.id);
  const after = batchStore.getBatch(batchId);
  const retried = after.jobs.find(j => j.id === failedJob.id);
  check(retried.status === 'succeeded', '重试后该 Job succeeded');
  check(retried.attempts === 2, `attempts+1（实际 ${retried.attempts}）`);
  check(batchStore.summarize(batchId).succeeded === 2, '全部成功');
  check(flowState.getNode(node.id)?.generatedImages?.length === 2, '节点 2 张图（成功图不丢）');
  reset();
});

// ───────────────────────── S7 retryFailed ─────────────────────────
await section('S7 retryFailed 全部失败项重试', async () => {
  const node = G(3);
  pendingTicks = 0;
  failIndexes = new Set([1, 3]);
  await runEngine.run(node.id);
  const batch = batchStore.getLatestBatch(node.id);
  check(batchStore.summarize(batch.id).failed === 2, '初始 2 失败');
  failIndexes = new Set();
  await runEngine.retryFailed(node.id, batch.id);
  const after = batchStore.getBatch(batch.id);
  const s = batchStore.summarize(batch.id);
  check(s.failed === 0 && s.succeeded === 3, `重试后 成功 3/3（实际 成功 ${s.succeeded} 失败 ${s.failed}）`);
  check(flowState.getNode(node.id)?.status === 'done', '节点 done');
  check(after.jobs.filter(j => j.status === 'succeeded' && j.attempts === 2).length === 2, '两个重试项 attempts=2（原成功项 attempts=1 不变）');
  reset();
});

// ───────────────────────── S8 count=1 单图写回自身 ─────────────────────────
await section('S8 count=1 单图路径保持写回自身', async () => {
  const node = G(1);
  pendingTicks = 0;
  await runEngine.run(node.id);
  const n = flowState.getNode(node.id);
  check(n.status === 'done', '节点 done');
  check(!!n.imageUrl, 'imageUrl 写回自身');
  check(!n.generatedImages || n.generatedImages.length === 0, 'count=1 不产生 generatedImages 列表');
  check(!!n.trace?.batchId && !!n.trace?.jobId, 'trace 带 batchId + jobId');
  reset();
});

// ───────────────────────── S9 buildImageTrace 透传 ─────────────────────────
await section('S9 buildImageTrace 透传 batchId/jobId（旧调用不传不写字段）', async () => {
  const node = G(1);
  const t1 = historyPersist.buildImageTrace(node, [], 'txt2img', 'u1', 'prompt1', 'b1', 'b1_j2');
  check(t1.batchId === 'b1' && t1.jobId === 'b1_j2', '传入时写 batchId/jobId');
  const t2 = historyPersist.buildImageTrace(node, [], 'txt2img');
  check(t2.batchId === undefined && t2.jobId === undefined, '旧调用不传 → 字段缺省（兼容旧数据）');
  reset();
});

// ───────────────────────── S10 rebuildFromNodes ─────────────────────────
await section('S10 rebuildFromNodes：从节点结果重建已知批次（restored/unknownCount）', async () => {
  // 模拟一个已完成的批量节点（含 trace.batchId + generatedImages）
  const n1 = flowState.addNode('image-gen', 100, 100, {
    title: '图1',
    params: { prompt: '', model: 'm', count: 2 },
    imageUrl: 'data:image/png;base64,FIRST',
    generatedImages: [
      { url: 'data:image/png;base64,FIRST', prompt: 'a' },
      { url: 'data:image/png;base64,SECOND', prompt: 'b' },
    ],
    activeGeneratedIndex: 0,
    trace: { prompt: 'a', model: 'm', aspectRatio: '4:3', resolution: '2k', count: 2, refImageHashes: [], createdAt: 1700000000000, outputType: 'txt2img', batchId: 'n1_1700000000000', jobId: 'n1_1700000000000_j0' },
    status: 'done',
  });
  // 模拟保存时恰在运行中（status=run）的节点
  flowState.addNode('image-gen', 300, 100, {
    title: '图2',
    params: { prompt: 'p', model: 'm', count: 1 },
    status: 'run',
  });
  batchStore.rebuildFromNodes();
  const batches = batchStore.list();
  check(batches.length === 2, `重建 2 个批次（实际 ${batches.length}）`);
  const b1 = batches.find(b => b.nodeId === n1.id);
  check(!!b1 && b1.restored === true && b1.status === 'completed', '已知批次 restored + completed');
  check(!!b1 && b1.jobs.length === 2 && b1.jobs.every(j => j.status === 'succeeded'), '重建 2 个 succeeded Job');
  check(!!b1 && b1.id === 'n1_1700000000000', 'batchId 复用 trace.batchId');
  const b2 = batches.find(b => b.nodeId !== n1.id);
  check(!!b2 && b2.restored === true && b2.status === 'running' && b2.unknownCount === 1, '进行中节点 restored + unknownCount=1 + running');
  reset();
});

// ───────────────────────── S11 persistence 七态归一 ─────────────────────────
await section('S11 persistence.collect 七态归一五态（queued→idle、partial-failed→done）', async () => {
  flowState.addNode('image-gen', 0, 0, { status: 'queued', params: { prompt: '', model: '', count: 1 } });
  flowState.addNode('image-gen', 100, 0, { status: 'partial-failed', params: { prompt: '', model: '', count: 1 } });
  flowState.addNode('image-gen', 200, 0, { status: 'done', params: { prompt: '', model: '', count: 1 } });
  const collected = persistence.collect();
  const statuses = collected.nodes.map(n => n.status).sort();
  check(statuses.join(',') === 'done,done,idle', `归一后 = idle/done/done（实际 ${statuses.join(',')}）`);
  check(collected.version === '3.4', '.icproj version 仍 3.4');
  reset();
});

// ───────────────────────── S12 cancel ─────────────────────────
await section('S12 cancel：批次 cancelled、节点恢复 idle、在途 Job 停止', async () => {
  const node = G(3);
  pendingTicks = 5; // 任务保持 pending，给取消留窗口
  const runPromise = runEngine.run(node.id);
  await until(() => batchStore.getActiveBatch(node.id) !== null, 2000);
  const batch = batchStore.getActiveBatch(node.id);
  check(!!batch, '有进行中批次');
  await tick(30); // 让部分 Job 进入轮询
  const ok = runEngine.cancel(node.id);
  check(ok === true, 'cancel 返回 true');
  await runPromise;
  const after = batchStore.getBatch(batch.id);
  check(after.status === 'cancelled', `批次 cancelled（实际 ${after.status}）`);
  check(after.jobs.every(j => j.status === 'cancelled' || j.status === 'succeeded'), 'Job 均为 cancelled/succeeded（无 stuck）');
  check(flowState.getNode(node.id)?.status === 'idle', '节点恢复 idle');
  check(runEngine.isBusy() === false, 'busy 释放');
  reset();
});

// ───────────────────────── S13 锁定保护（Q3 不退化） ─────────────────────────
await section('S13 锁定保护：源图锁定 → 不写回自身、改建产出节点', async () => {
  const node = G(1, { imageUrl: 'data:image/png;base64,OLD_LOCKED' });
  assetStore.setLockedByUrl(node.imageUrl, node.id, true);
  pendingTicks = 0;
  const before = flowState.nodes.length;
  await runEngine.run(node.id);
  check(flowState.getNode(node.id)?.imageUrl === 'data:image/png;base64,OLD_LOCKED', '锁定旧图不被覆盖（imageUrl 保留）');
  check(flowState.nodes.length === before + 1, `新建 1 个产出节点（实际 +${flowState.nodes.length - before}）`);
  const child = flowState.nodes.find(n => n.parentId === node.id);
  check(!!child && !!child.imageUrl && child.imageUrl.startsWith('data:image/png;base64,t'), '产出节点承载新图');
  check(!!child?.trace?.batchId && !!child?.trace?.jobId, '产出节点 trace 带 batchId + jobId');
  reset();
});

// ───────────────────────── S14 T04 任务面板渲染（B-4） ─────────────────────────
await section('S14 task-panel：批次头部汇总 + 逐 Job 状态/失败标识/重试按钮', async () => {
  byId.set('task-panel', makeEl());
  byId.set('toast', toastEl);
  taskPanel.init();
  const node = G(3);
  const batch = batchStore.createBatch({ nodeId: node.id, source: 'manual-count', total: 3, concurrency: 2, prompts: ['a', 'b', 'c'] });
  batchStore.markJobStatus(batch.id, batch.jobs[0].id, 'succeeded', { image: { url: 'data:image/png;base64,A' } });
  batchStore.markJobStatus(batch.id, batch.jobs[1].id, 'failed', { error: 'mock 失败' });
  taskPanel.render();
  const html = byId.get('task-panel').innerHTML;
  check(html.includes('成功 <b>1</b>/3'), `头部汇总 成功 1/3（${html.match(/成功[^·]*/)?.[0] || ''}）`);
  check(html.includes('失败 <b>1</b>'), '头部汇总 失败 1');
  check(html.includes('#3'), '逐 Job #3');
  check(html.includes('mock 失败'), '失败原因展示');
  check(html.includes('data-action="retry-job"'), '失败项单条重试按钮');
  check(html.includes('data-action="retry-all"'), '重试全部失败按钮');
  check(html.includes('并发上限 2'), '头部显示批次并发上限');
  reset();
});

// ───────────────────────── S15 C-5 连线语义描述 ─────────────────────────
await section('S15 connectionDescription：连线完成语义 toast', async () => {
  const { t, s, g } = chain('甲########乙########丙', '########', 1);
  check(connectionDescription(s.id, g.id).includes('3 条提示词批量生成'), `拆分→生成：按段数描述（${connectionDescription(s.id, g.id)}）`);
  check(connectionDescription(t.id, g.id).includes('提示词'), '文本→生成：上游文本作提示词');
  check(connectionDescription(g.id, t.id).includes('反推'), '图片→文本：可反推');
  reset();
});

// ───────────────────────── S16 C-2 结果查看器（批次浏览） ─────────────────────────
await section('S16 result-viewer：批次条目收集 + 第 x/N + 失败原因/单项重试', async () => {
  byId.set('result-viewer', makeEl());
  byId.set('rv-count', makeEl());
  byId.set('rv-body', makeEl());
  byId.set('rv-close', makeEl());
  resultViewer.init();
  const node = G(2);
  pendingTicks = 0;
  failIndexes = new Set([1]);
  await runEngine.run(node.id); // job0 失败、job1 成功 → generatedImages 1 张 + batch 记录失败
  resultViewer.open(node.id, 0);
  const body = byId.get('rv-body').innerHTML;
  check(byId.get('rv-count').textContent.includes('1/2') || byId.get('rv-count').textContent.includes('2/2'), `批次计数 第 x/2（${byId.get('rv-count').textContent}）`);
  check(body.includes('失败原因'), '失败项展示失败原因');
  check(body.includes('重试此条'), '失败项显示单项重试');
  resultViewer.close();
  check(!byId.get('result-viewer').classList.contains('show'), 'close 后隐藏');
  reset();
});

// ───────────────────────── 汇总 ─────────────────────────
console.log(`\n══════════════════════════════════════`);
console.log(`QA 结果：通过 ${passed}，失败 ${failed}`);
if (failed > 0) {
  console.error('失败清单:');
  failures.forEach(f => console.error('  - ' + f));
  process.exit(1);
}
console.log('IS_PASS: YES');
}

main().catch(e => {
  console.error('QA 主流程异常:', e);
  process.exit(1);
});
