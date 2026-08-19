// smoke/qa-text-wiring.cjs
// QA 独立验证：文本走线 + 反推归位（commit 31b558e）
//
// 运行：
//   node node_modules/typescript/bin/tsc -p tsconfig.smoke.json --outDir .icv-qa
//   node smoke/qa-text-wiring.cjs
//
// 验证点（对应任务清单 §验证任务）：
//   S1  composeImagePrompt 合成规则（上游文本连线序 + 自身 prompt 追加 / 空态）
//   S2  getUpstreamTextPrompts（直接上游 text-gen 非空 outputText，按 getEdgesTo 顺序，一层）
//   S3  image-gen canRun：isAsset 首行拒绝；draw 放宽（自身 prompt 空但有文本上游可运行）；
//       两者皆空拒绝；Q7 旧 modelType='text' 节点按 draw 处理
//   S4  canConnect 组合规则（图片→文本 放行 / 文本→文本 拒绝 / 任何→素材 拒绝 / 防环防重防自连）
//   S5  A1 反推走线闭环：runTextGen 请求体含 data:image + 命令 → 结果写回自身 outputText + textHistory；
//       下游 image-gen params.prompt 不被覆盖、仅标 stale；无游离反推节点
//   S6  W2-4 非 data:image 上游 → fail「图片格式不支持反推」不静默丢图
//   S7  无图片上游 → 普通文本处理（不附图）
//   S8  A2 文本关键词生图：只连文本上游、自身 prompt 空 → canRun 通过 → 运行成功 → generateImage 收到合成 prompt；
//       自身 prompt 非空追加在后；trace/history prompt = 合成 prompt
//   S9  W6 图生图 count=1 回写自身（旧图入历史 outputType=img2img、源节点 imageUrl 非空）
//   S10 count=3 → 1 自身 + 2 产出节点
//   S11 锁定保护：index=0 锁定 → 建产出节点不顶掉
//   S12 buildImageTrace promptOverride（trace 记录合成 prompt）
//   S13 persistence migrateNode isAsset 透传（restore/collect 往返不丢标记）
//   S14 三处联动不覆盖 prompt：cmd-panel 历史回填 / card-view 就地编辑（dirty.markUpstreamChanged）
//   S15 _showNewNodeMenu 候选按 from 过滤（from=图片 → [文本,图片生成]；from=文本 → 仅图片生成）
//   S16 _dropImage 三分支（空白→素材节点 / 文本卡→自动建素材+连线 / 素材→拒绝）
//   S17 指令面板：素材节点隐藏面板；prompt 预览（P1 W3-4）
//   S18 insertStep 防御（to=text-gen / to=素材 → 拒绝）
//   S19 静态：compare-panel 素材节点计入可对比（设计 §8 #13 已知语义）；action-bar 素材隐藏操作条
//
// 说明：DOM 桩 + pywebview.api 桩驱动真实编译产物（.icv-qa/v1），不改任何业务源码。
//       需要 pywebview/真机验证的项（拖放坐标命中、卡片渲染角标、锁定 UI 等）在报告中标注「需手动回归」。

'use strict';

const BASE = 'D:/Infinite Canvas/Infinite Canvas 2.0/.icv-qa/v1';

// ───────────────────────── DOM/浏览器桩 ─────────────────────────
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
    set(v) { _html = String(v); el.children.length = 0; }, // 真实 DOM 语义：设置 innerHTML 会替换子节点
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
  body: makeEl({
    appendChild(c) { bodyChildren.push(c); return c; },
    removeChild() {},
  }),
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

// ───────────────────────── Image 桩（loadImageRatio / _dropImage 用） ─────────────────────────
let imgRatio = { w: 260, h: 195 };
let failNextImage = false;
class FakeImage {
  constructor() {
    this.naturalWidth = imgRatio.w;
    this.naturalHeight = imgRatio.h;
    this.onload = null;
    this.onerror = null;
    this._src = '';
    FakeImage._instances.push(this);
  }
  set src(v) {
    this._src = v;
    if (failNextImage) { failNextImage = false; setTimeout(() => this.onerror && this.onerror(), 0); }
    else setTimeout(() => this.onload && this.onload(), 0);
  }
  get src() { return this._src; }
}
FakeImage._instances = [];
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
async function until(fn, timeout = 2000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) return false;
    await tick();
  }
  return true;
}

// ───────────────────────── pywebview 桩（记录调用） ─────────────────────────
let chatV2Calls = [];
let genCalls = [];
let historyAppendCalls = [];
let chatV2Result = { text: '绿植场景描述' };
let genQueue = ['data:image/png;base64,NEW'];
let lockedUrls = new Set();
let origIsLockedByImageUrl = null;

function installPywebview() {
  chatV2Calls = [];
  genCalls = [];
  historyAppendCalls = [];
  global.pywebview.api = {
    async load_providers() { return { providers: [] }; },
    async load_settings() { return {}; },
    async load_assets() { return { status: 'empty' }; },
    async save_assets() { return { status: 'success' }; },
    async load_history() { return { status: 'empty' }; },
    async append_history(entry) { historyAppendCalls.push(JSON.parse(JSON.stringify(entry))); return { status: 'success' }; },
    async unified_chat_v2(userInput, options) { chatV2Calls.push({ userInput, options: JSON.parse(JSON.stringify(options || {})) }); return chatV2Result; },
    async unified_generate_image(prompt, options) { genCalls.push({ prompt, options: JSON.parse(JSON.stringify(options || {})) }); return { task_id: 't' + genCalls.length }; },
    async unified_get_task_result(taskId) {
      const idx = (Number(String(taskId).replace('t', '')) || 1) - 1;
      const url = genQueue[idx % genQueue.length] || genQueue[0];
      return { status: 'done', result: { success: true, image_url: url, saved_to_disk: true } };
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
// 先注册节点定义（node-registry 不自动 import image-gen/text-gen）
require(`${BASE}/nodes/image-gen.js`);
require(`${BASE}/nodes/text-gen.js`);
const { flowState } = require(`${BASE}/state/flow-state.js`);
const { runEngine } = require(`${BASE}/engine/run-engine.js`);
const { dirty } = require(`${BASE}/state/dirty.js`);
const { persistence } = require(`${BASE}/persistence.js`);
const { historyPersist } = require(`${BASE}/history-persist.js`);
const { historyDrawer } = require(`${BASE}/ui/history-drawer.js`);
const { assetStore } = require(`${BASE}/asset-store.js`);
const { cmdPanel } = require(`${BASE}/ui/cmd-panel.js`);
const { cardView } = require(`${BASE}/canvas/card-view.js`);
const { interactions } = require(`${BASE}/canvas/interactions.js`);
const { nodeRegistry } = require(`${BASE}/nodes/node-registry.js`);

// ───────────────────────── 测试辅助 ─────────────────────────
function reset() {
  flowState.nodes = [];
  flowState.edges = [];
  flowState.selectedIds.clear();
  flowState.dirty = false;
  flowState.projectName = '未命名项目';
  historyDrawer.items = [];
  bodyChildren.length = 0;
  toastLog.length = 0;
  historyAppendCalls.length = 0;
  runEngine.busy = false;
  runEngine._createdCardIds.clear();
  runEngine.batchProgress.clear();
  chatV2Calls.length = 0;
  genCalls.length = 0;
  chatV2Result = { text: '绿植场景描述' };
  genQueue = ['data:image/png;base64,NEW'];
  imgRatio = { w: 260, h: 195 };
  failNextImage = false;
  // 解锁全部（恢复 isLockedByImageUrl 原实现）
  if (origIsLockedByImageUrl) {
    assetStore.isLockedByImageUrl = origIsLockedByImageUrl;
    origIsLockedByImageUrl = null;
  }
  lockedUrls.clear();
}

/** 便捷建节点：type + 覆盖字段 */
function N(type, over = {}) {
  return flowState.addNode(type, 100, 100, over);
}
/** 建一个文本节点（带模型与命令） */
function T(idHint, outputText, over = {}) {
  return N('text-gen', {
    title: '文本',
    outputText: outputText || null,
    params: { instruction: over.instruction ?? '反推这张图', model: over.model ?? 'chat-m1' },
    ...over,
  });
}
/** 建一个自建图片节点（带模型） */
function IMG(idHint, over = {}) {
  return N('image-gen', {
    title: '图片生成',
    params: { prompt: over.prompt ?? '', model: over.model ?? 'draw-m1', aspectRatio: '3:4', resolution: '2k', count: over.count ?? 1 },
    ...over,
  });
}
/** 建一个素材节点 */
function ASSET(idHint, imageUrl, over = {}) {
  return N('image-gen', {
    isAsset: true,
    imageUrl,
    ratio: 3 / 4,
    status: 'idle',
    title: '素材',
    refImages: [],
    params: { prompt: '', model: '', aspectRatio: '3:4', resolution: '2k', count: 1 },
    ...over,
  });
}
function edgeIdsTo(id) { return flowState.getEdgesTo(id).map(e => e.from); }

// ───────────────────────── 测试 ─────────────────────────
(async () => {

  await section('S1 composeImagePrompt 合成规则（上游文本连线序 + 自身追加 / 空态）', async () => {
    reset();
    const t1 = T('t1', '上游文本一');
    const t2 = T('t2', '上游文本二');
    const img = IMG('img');
    flowState.addEdge(t1.id, img.id);
    flowState.addEdge(t2.id, img.id); // 建立顺序：t1 先、t2 后
    check(runEngine.composeImagePrompt(img.id) === '上游文本一\n上游文本二',
      `两个上游文本按连线序 \n 拼接（实际 ${JSON.stringify(runEngine.composeImagePrompt(img.id))}）`);
    flowState.updateNodeParams(img.id, { prompt: '自身提示词' });
    check(runEngine.composeImagePrompt(img.id) === '上游文本一\n上游文本二\n自身提示词',
      `自身 prompt 非空追加在后（实际 ${JSON.stringify(runEngine.composeImagePrompt(img.id))}）`);
    flowState.updateNodeParams(img.id, { prompt: '  自身带空格  ' });
    check(runEngine.composeImagePrompt(img.id) === '上游文本一\n上游文本二\n自身带空格',
      `自身 prompt trim 后追加（实际 ${JSON.stringify(runEngine.composeImagePrompt(img.id))}）`);
    reset();
    const img2 = IMG('img2');
    check(runEngine.composeImagePrompt(img2.id) === '', '两者皆空 → 空串');
    const tE = T('tE', '   '); // 全空白 outputText 视为空
    flowState.addEdge(tE.id, img2.id);
    check(runEngine.composeImagePrompt(img2.id) === '', '上游文本为空白 → 不参与合成');
    flowState.updateNode(tE.id, { outputText: '有内容' });
    check(runEngine.composeImagePrompt(img2.id) === '有内容', '上游文本有内容 → 参与合成');
  });

  await section('S2 getUpstreamTextPrompts（直接上游、text-gen 非空、按连线序、一层）', async () => {
    reset();
    const t1 = T('t1', '文本A');
    const t2 = T('t2', '文本B');
    const tEmpty = T('tE', null); // 无 outputText
    const imgUp = IMG('imgUp');
    const img = IMG('img');
    flowState.addEdge(t1.id, img.id);
    flowState.addEdge(imgUp.id, img.id); // 图片上游不应贡献
    flowState.addEdge(tEmpty.id, img.id); // 空文本不应贡献
    flowState.addEdge(t2.id, img.id);
    const prompts = flowState.getUpstreamTextPrompts(img.id);
    check(JSON.stringify(prompts) === JSON.stringify(['文本A', '文本B']),
      `只取直接上游 text-gen 非空 outputText、按连线序（实际 ${JSON.stringify(prompts)}）`);
    // 一层验证：t3 → t1（间接上游）不应贡献
    const t3 = T('t3', '间接文本');
    flowState.addEdge(t3.id, t1.id);
    check(JSON.stringify(flowState.getUpstreamTextPrompts(img.id)) === JSON.stringify(['文本A', '文本B']),
      '只取一层，不做 BFS（间接上游不贡献）');
    // trim 验证
    flowState.updateNode(t2.id, { outputText: '  文本B带空格  ' });
    check(JSON.stringify(flowState.getUpstreamTextPrompts(img.id)) === JSON.stringify(['文本A', '文本B带空格']),
      'outputText trim 后返回');
  });

  await section('S3 image-gen canRun：isAsset 拒绝 / draw 放宽 / Q7 旧节点按 draw', async () => {
    reset();
    const def = nodeRegistry.get('image-gen');
    // 素材节点首行拒绝
    const asset = ASSET('a1', 'data:image/png;base64,AAA');
    check(def.canRun(asset, { getUpstreams: () => [] }) === '素材节点不可运行', '素材节点 canRun 首行拒绝');
    // 两者皆空拒绝
    const img = IMG('img');
    check(def.canRun(img, { getUpstreams: () => [] }) === '请输入提示词', '自身 prompt 空且无文本上游 → 拒绝');
    // 自身 prompt 非空 → 通过
    flowState.updateNodeParams(img.id, { prompt: '一只花盆' });
    check(def.canRun(img, { getUpstreams: () => [] }) === true, '自身 prompt 非空 → 允许');
    // 只连文本上游、自身 prompt 空 → 允许（W3-3）
    const img2 = IMG('img2');
    const t1 = T('t1', '关键词');
    check(def.canRun(img2, { getUpstreams: () => [t1] }) === true,
      '自身 prompt 空但有文本上游（非空 outputText）→ 允许');
    // 文本上游 outputText 空 → 不算
    const tEmpty = T('tE', null);
    check(def.canRun(img2, { getUpstreams: () => [tEmpty] }) === '请输入提示词',
      '文本上游 outputText 空 → 视为无上游 → 拒绝');
    // 无模型 → 拒绝
    const img3 = IMG('img3', { params: { prompt: '有词', model: '' } });
    check(def.canRun(img3, { getUpstreams: () => [] }) === '请先选择绘图模型', '有 prompt 无模型 → 提示选模型');
    // Q7：旧 modelType='text' 节点按 draw 处理（有 prompt + model → 允许，不再要求 textModel/文本分支）
    const oldReverse = IMG('old', { params: { prompt: '反推命令', model: 'draw-m1', modelType: 'text', textModel: 'chat-x' } });
    check(def.canRun(oldReverse, { getUpstreams: () => [] }) === true,
      '旧 modelType=\'text\' 节点按 draw 运行（不再要求 textModel）');
  });

  await section('S4 canConnect 组合规则（W1-1）', async () => {
    reset();
    const img = IMG('img');
    const img2 = IMG('img2');
    const text = T('t1', null);
    const asset = ASSET('a1', 'data:image/png;base64,AAA');
    check(flowState.canConnect(img.id, text.id) === null, '图片→文本 允许（反推输入）');
    check(flowState.canConnect(asset.id, text.id) === null, '素材→文本 允许（反推输入）');
    check(flowState.canConnect(text.id, img.id) === null, '文本→图片 允许（关键词）');
    check(flowState.canConnect(img.id, img2.id) === null, '图片→图片 允许（参考图）');
    check(flowState.canConnect(text.id, text.id) === '不能连接自己', '自连拒绝');
    const text2 = T('t2', null);
    check(flowState.canConnect(text.id, text2.id) === '暂不支持文本连文本', '文本→文本 拒绝');
    check(flowState.canConnect(img.id, asset.id) === '素材节点不能作为输入', '图片→素材 拒绝');
    check(flowState.canConnect(text.id, asset.id) === '素材节点不能作为输入', '文本→素材 拒绝');
    check(flowState.canConnect(asset.id, asset.id) === '不能连接自己', '素材自连走防自连');
    // 重复边
    flowState.addEdge(img.id, text.id);
    check(flowState.canConnect(img.id, text.id) === '已有相同连线', '重复边拒绝');
    // 防环
    const a = IMG('a'), b = IMG('b'), c = IMG('c');
    flowState.addEdge(a.id, b.id);
    flowState.addEdge(b.id, c.id);
    check(flowState.canConnect(c.id, a.id) === '不能形成循环', '防环：c→a 成环拒绝');
    check(flowState.canConnect('不存在', img.id) === '节点不存在', '节点不存在拒绝');
  });

  await section('S5 A1 反推走线闭环：runTextGen 带上游 data:image + 写回自身 + 不覆盖下游 prompt', async () => {
    reset();
    const asset = ASSET('a1', 'data:image/png;base64,UPIMG');
    const text = T('t1', null, { instruction: '反推描述这张图', model: 'chat-m1' });
    const downstream = IMG('d1', { prompt: '原下游prompt', model: 'draw-m1' });
    flowState.addEdge(asset.id, text.id);   // 素材→文本（反推输入）
    flowState.addEdge(text.id, downstream.id); // 文本→图片（关键词）
    const nodeCountBefore = flowState.nodes.length;
    await runEngine.run(text.id);
    // 请求体：命令 + images=[data:image]
    check(chatV2Calls.length === 1, 'chatV2 被调用一次');
    check(chatV2Calls[0].userInput === '反推描述这张图', `命令照常传给 chatV2（实际 ${chatV2Calls[0].userInput}）`);
    check(JSON.stringify(chatV2Calls[0].options.images) === JSON.stringify(['data:image/png;base64,UPIMG']),
      `请求体 images 含 data:image 上游图（实际 ${JSON.stringify(chatV2Calls[0].options.images)}）`);
    check(chatV2Calls[0].options.model === 'chat-m1', '请求体 model 为文本模型');
    // 写回自身
    const after = flowState.getNode(text.id);
    check(after.outputText === '绿植场景描述', `反推结果写回文本节点自身 outputText（实际 ${after.outputText}）`);
    check(after.status === 'done', '文本节点状态 done');
    check(Array.isArray(after.textHistory) && after.textHistory[0].text === '绿植场景描述', 'textHistory 写入反推结果');
    // 下游 prompt 不被覆盖（旁路已删除）仅标 stale
    const dAfter = flowState.getNode(downstream.id);
    check(dAfter.params.prompt === '原下游prompt', `下游 image-gen params.prompt 保持原值（实际 ${dAfter.params.prompt}）`);
    check(dAfter.status === 'stale', '下游节点仅标 stale');
    // 无游离反推节点：节点数不变
    check(flowState.nodes.length === nodeCountBefore, `无游离反推节点（节点数不变：${flowState.nodes.length}）`);
    // 命令执行后清空
    check((after.params.instruction || '') === '', '指令执行后清空');
  });

  await section('S6 W2-4 非 data:image 上游 → fail「图片格式不支持反推」不静默丢图', async () => {
    reset();
    const asset = ASSET('a1', 'http://example.com/old.jpg');
    const text = T('t1', null, { instruction: '反推', model: 'chat-m1' });
    flowState.addEdge(asset.id, text.id);
    await runEngine.run(text.id);
    const after = flowState.getNode(text.id);
    check(after.status === 'fail', `节点 fail（实际 ${after.status}）`);
    check(after.error === '图片格式不支持反推', `error 为「图片格式不支持反推」（实际 ${after.error}）`);
    check(toastLog.some(t => t.includes('图片格式不支持反推')), 'toast 提示「图片格式不支持反推」');
    check(chatV2Calls.length === 0, '未调用 chatV2（不静默丢图）');
    check(after.outputText === null, '未写回 outputText');
  });

  await section('S7 无图片上游 → 普通文本处理（不附图）', async () => {
    reset();
    const text = T('t1', '原文', { instruction: '翻译成英文', model: 'chat-m1' });
    await runEngine.run(text.id);
    check(chatV2Calls.length === 1, 'chatV2 调用一次');
    check(chatV2Calls[0].userInput === '原文：\n原文\n\n指令：翻译成英文', '有原文时按「原文+指令」拼装');
    check(chatV2Calls[0].options.images === undefined, '无图片上游 → 不附带 images');
    check(flowState.getNode(text.id).outputText === '绿植场景描述', '普通文本处理结果写回');
  });

  await section('S8 A2 文本关键词生图：只连文本上游、自身 prompt 空可运行 → 合成 prompt 请求', async () => {
    reset();
    const t1 = T('t1', '花园场景');
    const img = IMG('img', { prompt: '', model: 'draw-m1', count: 1 });
    flowState.addEdge(t1.id, img.id);
    const def = nodeRegistry.get('image-gen');
    check(def.canRun(img, { getUpstreams: () => [t1] }) === true, 'canRun 放宽：自身 prompt 空但有文本上游 → 允许');
    genQueue = ['data:image/png;base64,OUT1'];
    await runEngine.run(img.id);
    check(genCalls.length === 1, 'generateImage 调用一次');
    check(genCalls[0].prompt === '花园场景', `generateImage prompt = 上游文本（实际 ${JSON.stringify(genCalls[0].prompt)}）`);
    const after = flowState.getNode(img.id);
    check(after.imageUrl === 'data:image/png;base64,OUT1', '生成图写回自身（顶掉）');
    check(after.trace && after.trace.prompt === '花园场景', `trace 记录合成 prompt（实际 ${after.trace && after.trace.prompt}）`);
    // 自写回的新图经 appendTrace 落 history.jsonl（旧图才走 historyDrawer.addImage；父提交同口径）
    check(historyAppendCalls.some(e => e.kind === 'image' && e.imageUrl === 'data:image/png;base64,OUT1'),
      '新图经 appendTrace 写入历史 jsonl（kind:image）');
    // 自身 prompt 非空追加在后
    reset();
    const t2 = T('t2', '上游词');
    const img2 = IMG('img2', { prompt: '自身词', model: 'draw-m1', count: 1 });
    flowState.addEdge(t2.id, img2.id);
    genQueue = ['data:image/png;base64,OUT2'];
    await runEngine.run(img2.id);
    check(genCalls.length === 1 && genCalls[0].prompt === '上游词\n自身词',
      `合成 prompt = 上游文本 + 自身 prompt（实际 ${JSON.stringify(genCalls[0].prompt)}）`);
    check(flowState.getNode(img2.id).trace.prompt === '上游词\n自身词', 'trace 记录完整合成 prompt');
  });

  await section('S9 W6 图生图 count=1 回写自身（旧图入历史 outputType=img2img、源节点 imageUrl 非空）', async () => {
    reset();
    const asset = ASSET('a1', 'data:image/png;base64,REF');
    const img = IMG('img', { prompt: '图生图提示', model: 'draw-m1', count: 1, imageUrl: 'data:image/png;base64,OLD' });
    flowState.addEdge(asset.id, img.id); // 有参考图 → 图生图
    genQueue = ['data:image/png;base64,NEW1'];
    await runEngine.run(img.id);
    const after = flowState.getNode(img.id);
    check(after.imageUrl === 'data:image/png;base64,NEW1', `图生图 count=1 回写自身（新图覆盖）（实际 ${after.imageUrl}）`);
    check(genCalls[0].options.referenceImages.includes('data:image/png;base64,REF'), '参考图随请求透传');
    const oldEntry = historyDrawer.items.find(i => i.src === 'data:image/png;base64,OLD');
    check(!!oldEntry, '旧图入历史图库');
    check(oldEntry && oldEntry.outputType === 'img2img', `旧图历史 outputType=img2img（实际 ${oldEntry && oldEntry.outputType}）`);
    check(after.trace && after.trace.outputType === 'img2img', `trace outputType=img2img（实际 ${after.trace && after.trace.outputType}）`);
    check(after.imageUrl !== null, '源节点 imageUrl 非空（W6-2：不再清空为「空生成器」）');
    // 旧图 prompt 记录合成 prompt
    check(oldEntry && oldEntry.prompt === '图生图提示', `旧图历史 prompt = 本次合成 prompt（实际 ${oldEntry && oldEntry.prompt}）`);
  });

  await section('S10 count=3 → 1 自身 + 2 产出节点', async () => {
    reset();
    const img = IMG('img', { prompt: '批量', model: 'draw-m1', count: 3 });
    genQueue = ['data:image/png;base64,R1', 'data:image/png;base64,R2', 'data:image/png;base64,R3'];
    const beforeCount = flowState.nodes.length;
    await runEngine.run(img.id);
    const after = flowState.getNode(img.id);
    check(after.status === 'done', '批次全部成功 → done');
    check(after.imageUrl === 'data:image/png;base64,R1', `第 1 张写回自身（实际 ${after.imageUrl}）`);
    const children = flowState.nodes.filter(n => n.parentId === img.id);
    check(children.length === 2, `第 2..N 张建产出节点（实际 ${children.length} 个）`);
    check(JSON.stringify(children.map(c => c.imageUrl).sort()) === JSON.stringify(['data:image/png;base64,R2', 'data:image/png;base64,R3']),
      `产出节点承载 R2/R3（实际 ${JSON.stringify(children.map(c => c.imageUrl))}）`);
    check(children.every(c => c.type === 'image-gen' && c.status === 'done'), '产出节点为 image-gen done');
    check(flowState.nodes.length === beforeCount + 2, `节点净增 2（实际 ${flowState.nodes.length - beforeCount}）`);
    // 产出节点自动连线（gen→child）且不被标 stale
    check(children.every(c => flowState.getEdgesTo(c.id).some(e => e.from === img.id)), '产出节点自动连线');
    check(children.every(c => c.status === 'done'), '产出节点未被标 stale（suppressStale）');
  });

  await section('S11 锁定保护：index=0 锁定 → 建产出节点不顶掉', async () => {
    reset();
    const img = IMG('img', { prompt: '锁定重跑', model: 'draw-m1', count: 1, imageUrl: 'data:image/png;base64,LOCKED' });
    // 锁定旧图
    origIsLockedByImageUrl = assetStore.isLockedByImageUrl;
    assetStore.isLockedByImageUrl = (url) => url === 'data:image/png;base64,LOCKED';
    genQueue = ['data:image/png;base64,NEWX'];
    const beforeCount = flowState.nodes.length;
    await runEngine.run(img.id);
    const after = flowState.getNode(img.id);
    check(after.imageUrl === 'data:image/png;base64,LOCKED', `锁定图不被顶掉（实际 ${after.imageUrl}）`);
    check(after.status === 'done', '节点仍 done（结果有效，走产出节点）');
    const children = flowState.nodes.filter(n => n.parentId === img.id);
    check(children.length === 1 && children[0].imageUrl === 'data:image/png;base64,NEWX',
      `锁定 → 改建产出节点承载新图（实际 ${children.length} 个）`);
    check(flowState.nodes.length === beforeCount + 1, '节点净增 1（产出节点）');
    // 恢复
    assetStore.isLockedByImageUrl = origIsLockedByImageUrl;
    origIsLockedByImageUrl = null;
  });

  await section('S12 buildImageTrace promptOverride（trace 记录合成 prompt）', async () => {
    reset();
    const img = IMG('img', { prompt: '节点原始prompt', model: 'draw-m1' });
    img.parentId = null;
    const traceWithOverride = historyPersist.buildImageTrace(img, ['data:image/png;base64,R'], 'txt2img', 'data:image/png;base64,O', '合成prompt\n追加段');
    check(traceWithOverride.prompt === '合成prompt\n追加段', `promptOverride 优先写入 trace（实际 ${JSON.stringify(traceWithOverride.prompt)}）`);
    check(JSON.stringify(traceWithOverride.refImageHashes) === JSON.stringify([historyPersist.hashRef('data:image/png;base64,R')]), 'refImageHashes 由 refs 构造');
    check(traceWithOverride.outputType === 'txt2img', 'outputType 透传');
    const traceNoOverride = historyPersist.buildImageTrace(img, [], 'img2img', 'x');
    check(traceNoOverride.prompt === '节点原始prompt', '无 override → 回退 node.params.prompt');
    check(traceNoOverride.outputType === 'img2img', '无 override outputType 透传');
  });

  await section('S13 persistence isAsset 透传（restore/collect 往返不丢标记）', async () => {
    reset();
    const raw = {
      format: 'icv', version: '3.4', projectName: 'P',
      canvas: { scale: 1, panX: 60, panY: 40 },
      nodes: [
        { id: 'n1', type: 'image-gen', x: 0, y: 0, ratio: 3 / 4, status: 'idle', title: '素材', params: {}, imageUrl: 'data:image/png;base64,A', isAsset: true },
        { id: 'n2', type: 'image-gen', x: 200, y: 0, ratio: 3 / 4, status: 'idle', title: '图片生成', params: { prompt: 'p' } },
        { id: 'n3', type: 'text-gen', x: 400, y: 0, ratio: 3 / 4, status: 'idle', title: '文本', params: { model: 'm' }, outputText: 't' },
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'n3' }],
      createdAt: 1, updatedAt: 2,
    };
    check(persistence.restore(raw) === true, 'restore 成功');
    const n1 = flowState.getNode('n1');
    check(flowState.isAssetNode(n1) === true, `restore 后素材节点 isAsset 保留（实际 ${JSON.stringify(n1 && n1.isAsset)}）`);
    check(flowState.isAsset('n1') === true, 'isAsset(id) 判定命中');
    check(flowState.isAsset('n2') === false, '自建节点 isAsset=false');
    check(flowState.isAsset('n3') === false, '文本节点 isAsset=false');
    // collect 往返
    const collected = persistence.collect();
    const n1c = collected.nodes.find(n => n.id === 'n1');
    check(n1c && n1c.isAsset === true, `collect 后素材节点 isAsset 仍在（实际 ${JSON.stringify(n1c && n1c.isAsset)}）`);
    // 旧 3.2 文件 image-result 素材兼容
    reset();
    const rawOld = {
      format: 'icv', version: '3.2', projectName: 'P',
      canvas: {}, nodes: [{ id: 'r1', type: 'image-result', x: 0, y: 0, ratio: 1, status: 'done', title: '旧结果', params: {}, imageUrl: 'data:image/png;base64,X', isAsset: true }],
      edges: [], createdAt: 1, updatedAt: 2,
    };
    persistence.restore(rawOld);
    const r1 = flowState.getNode('r1');
    check(flowState.isAssetNode(r1) === true, 'image-result 旧文件迁移后 isAsset 透传');
    check(r1.type === 'image-gen', 'image-result 迁移为 image-gen');
  });

  await section('S14 三处联动不覆盖 prompt（历史回填 / 就地编辑）', async () => {
    reset();
    const text = T('t1', '旧文本', { instruction: '', model: 'chat-m1' });
    const downstream = IMG('d1', { prompt: '不可覆盖', model: 'draw-m1' });
    flowState.addEdge(text.id, downstream.id);
    flowState.updateNode(downstream.id, { status: 'done' });
    // ① 历史回填（cmd-panel _refillHistoryItem → dirty.markUpstreamChanged）
    cmdPanel['_refillHistoryItem'](text.id, { text: '回填历史文本', ts: 1 });
    const tAfter = flowState.getNode(text.id);
    check(tAfter.outputText === '回填历史文本', '历史回填写回自身 outputText');
    const dAfter = flowState.getNode(downstream.id);
    check(dAfter.params.prompt === '不可覆盖', `回填后下游 prompt 不变（实际 ${dAfter.params.prompt}）`);
    check(dAfter.status === 'stale', '回填后下游仅标 stale');
    check(toastLog.some(t => t.includes('已回填历史反推文本')), 'toast「已回填历史反推文本」');
    // ② 就地编辑（card-view _commitTextEdit → dirty.markUpstreamChanged）
    flowState.updateNode(downstream.id, { status: 'done' });
    cardView['_editingNodeId'] = text.id;
    const ta = makeEl({ isConnected: true, value: '就地编辑后的文本' });
    cardView['_commitTextEdit'](text.id, ta);
    cardView['_editingNodeId'] = null;
    const tAfter2 = flowState.getNode(text.id);
    check(tAfter2.outputText === '就地编辑后的文本', '就地编辑保存写回自身 outputText');
    const dAfter2 = flowState.getNode(downstream.id);
    check(dAfter2.params.prompt === '不可覆盖', `就地编辑后下游 prompt 不变（实际 ${dAfter2.params.prompt}）`);
    check(dAfter2.status === 'stale', '就地编辑后下游仅标 stale');
    // ③ 运行成功联动已由 S5 覆盖（不覆盖 prompt + 仅标 stale）
  });

  await section('S15 _showNewNodeMenu 候选按 from 过滤（W1-2）', async () => {
    reset();
    const img = IMG('img');
    const text = T('t1', null);
    // from=图片节点 → 候选含 文本 + 图片生成
    interactions['_showNewNodeMenu'](100, 100, img.id);
    const menuImg = bodyChildren.find(el => el.id === 'ctx-menu');
    check(!!menuImg, '图片 from：菜单已挂载');
    check(menuImg.innerHTML.includes('data-node-type="text-gen"'), 'from=图片 → 含「文本」候选');
    check(menuImg.innerHTML.includes('data-node-type="image-gen"'), 'from=图片 → 含「图片生成」候选');
    // from=文本节点 → 仅图片生成（不含文本）
    bodyChildren.length = 0;
    interactions['_showNewNodeMenu'](100, 100, text.id);
    const menuText = bodyChildren.find(el => el.id === 'ctx-menu');
    check(!!menuText, '文本 from：菜单已挂载');
    check(menuText.innerHTML.includes('data-node-type="image-gen"'), 'from=文本 → 含「图片生成」候选');
    check(!menuText.innerHTML.includes('data-node-type="text-gen"'), 'from=文本 → 不含「文本」候选（文本→文本 链式不做）');
    // from=素材节点 → 同图片（可作文本反推输入 / 图片参考图）
    bodyChildren.length = 0;
    const asset = ASSET('a1', 'data:image/png;base64,A');
    interactions['_showNewNodeMenu'](100, 100, asset.id);
    const menuAsset = bodyChildren.find(el => el.id === 'ctx-menu');
    check(menuAsset.innerHTML.includes('data-node-type="text-gen"') && menuAsset.innerHTML.includes('data-node-type="image-gen"'),
      'from=素材 → 含「文本」+「图片生成」');
    // 空白画布右键：无「素材」项（nodeRegistry 无素材类型）
    bodyChildren.length = 0;
    interactions['_showCanvasMenu'](100, 100);
    const menuCanvas = bodyChildren.find(el => el.id === 'ctx-menu');
    check(!menuCanvas.innerHTML.includes('素材'), '画布新建菜单无「素材」项');
  });

  await section('S16 _dropImage 三分支（空白→素材 / 文本卡→自动建素材+连线 / 素材→拒绝）', async () => {
    reset();
    // ① 空白 → 素材节点
    document.elementFromPoint = () => null;
    interactions['_dropImage']('data:image/png;base64,DRAG1', { x: 300, y: 300 }, 500, 500);
    const ok1 = await until(() => flowState.nodes.length === 1);
    check(ok1, '空白拖图 → 建 1 个节点');
    const asset1 = flowState.nodes[0];
    check(flowState.isAssetNode(asset1) === true, `空白拖图建素材节点（isAsset=true）`);
    check(asset1.imageUrl === 'data:image/png;base64,DRAG1', `素材节点 imageUrl=图本身（实际 ${asset1.imageUrl}）`);
    check(toastLog.some(t => t.includes('已创建素材节点')), 'toast「已创建素材节点」');
    // ② 拖到文本卡 → 自动建素材 + 素材→文本 连线
    reset();
    const text = T('t1', null);
    const cardEl = makeEl({ dataset: { nodeId: text.id }, closest: (sel) => (sel === '.pcard' ? cardEl : null) });
    document.elementFromPoint = () => cardEl;
    interactions['_dropImage']('data:image/png;base64,DRAG2', { x: 0, y: 0 }, 10, 10);
    const ok2 = await until(() => flowState.nodes.length === 2);
    check(ok2, '拖到文本卡 → 建素材节点 + 原文本节点');
    const asset2 = flowState.nodes.find(n => n.id !== text.id);
    check(flowState.isAssetNode(asset2) === true, `自动建的素材节点 isAsset=true`);
    check(asset2.imageUrl === 'data:image/png;base64,DRAG2', '素材节点 imageUrl=拖入图');
    check(flowState.getEdgesTo(text.id).some(e => e.from === asset2.id), '自动建 素材→文本 连线');
    check(toastLog.some(t => t.includes('已创建素材节点并连接')), 'toast「已创建素材节点并连接」');
    // ③ 拖到素材卡 → 拒绝
    reset();
    const asset3 = ASSET('a1', 'data:image/png;base64,EXIST');
    const assetCard = makeEl({ dataset: { nodeId: asset3.id }, closest: (sel) => (sel === '.pcard' ? assetCard : null) });
    document.elementFromPoint = () => assetCard;
    interactions['_dropImage']('data:image/png;base64,DRAG3', { x: 0, y: 0 }, 10, 10);
    await tick(30);
    check(flowState.nodes.length === 1, '拖到素材卡 → 不新建节点');
    check(toastLog.some(t => t.includes('素材节点不能添加参考图')), 'toast「素材节点不能添加参考图」');
    // 恢复默认
    document.elementFromPoint = () => null;
  });

  await section('S17 指令面板：素材隐藏面板 + prompt 预览（P1 W3-4）', async () => {
    reset();
    // 素材节点：sync() 隐藏面板（含默认模型回填跳过）
    const asset = ASSET('a1', 'data:image/png;base64,A');
    cmdPanel['el'] = makeEl();
    const removed = [];
    cmdPanel['el'].classList.remove = (...cs) => { removed.push(...cs); };
    cmdPanel['sync']();
    check(removed.includes('show'), '素材节点 sync → 面板隐藏（移除 show）');
    check(removed.includes('textgen') && removed.includes('reverse'), '素材节点 sync → 移除 textgen/reverse class');
    // prompt 预览：image-gen 非素材显示合成 prompt
    const t1 = T('t1', '预览上游词');
    const img = IMG('img', { prompt: '预览自身词', model: 'draw-m1' });
    flowState.addEdge(t1.id, img.id);
    const preview = makeEl();
    preview.hidden = true;
    cmdPanel['promptPreview'] = preview;
    cmdPanel['_renderPromptPreview'](img);
    check(preview.textContent === '最终 prompt：预览上游词\n预览自身词', `image-gen 预览显示合成 prompt（实际 ${JSON.stringify(preview.textContent)}）`);
    check(preview.hidden === false, '有内容时预览可见');
    cmdPanel['_renderPromptPreview'](asset);
    check(preview.hidden === true, '素材节点不显示 prompt 预览');
    const textNode = T('t2', '文本');
    cmdPanel['_renderPromptPreview'](textNode);
    check(preview.hidden === true, '文本节点不显示 prompt 预览');
  });

  await section('S18 insertStep 防御（to=text-gen / to=素材 → 拒绝）', async () => {
    reset();
    const img = IMG('img');
    const text = T('t1', null);
    const edge1 = flowState.addEdge(img.id, text.id);
    check(edge1 !== null, '图片→文本 边已建');
    const step1 = flowState.insertStep(edge1.id);
    check(step1 === null, 'to=text-gen → insertStep 拒绝');
    check(toastLog.some(t => t.includes('文本节点前不能插步骤')), 'toast「文本节点前不能插步骤」');
    reset();
    const asset = ASSET('a1', 'data:image/png;base64,A');
    const img2 = IMG('img2');
    // 素材作 to 的边不会通过 canConnect 建立；直接构造防御路径：用 replaceAll 造一条残留边
    flowState.nodes = [img2, asset];
    flowState.edges = [{ id: 'bad1', from: img2.id, to: asset.id }];
    const step2 = flowState.insertStep('bad1');
    check(step2 === null, 'to=素材 → insertStep 拒绝');
    check(toastLog.some(t => t.includes('素材节点前不能插步骤')), 'toast「素材节点前不能插步骤」');
  });

  await section('S19 静态核对：compare-panel 素材可对比 / action-bar 素材隐藏操作条 / 素材可运行闸门', async () => {
    reset();
    // run() 对素材静默跳过（不 toast、不设 busy）
    const asset = ASSET('a1', 'data:image/png;base64,A');
    asset.status = 'idle';
    toastLog.length = 0;
    await runEngine.run(asset.id);
    check(runEngine.busy === false, '素材 run() 静默跳过：不设 busy');
    check(toastLog.length === 0, '素材 run() 静默跳过：不 toast 噪音');
    check(flowState.getNode(asset.id).status === 'idle', '素材节点状态不变');
    // 对比面板判定（设计 §8 #13：素材自动可对比，符合「素材也是图」语义）
    const compare = require(`${BASE}/ui/compare-panel.js`).comparePanel;
    const ids = [asset.id, IMG('img').id];
    const comps = compare['_comparableNodes'](ids);
    check(comps.some(n => n.id === asset.id), `素材节点计入可对比（image-gen + imageUrl；实际 ${JSON.stringify(comps.map(n => n.id))}）`);
    // action-bar 素材隐藏操作条（判分支 #16+）：sync() 用 selection.single()；素材 → 隐藏
    const actionBar = require(`${BASE}/ui/action-bar.js`).actionBar;
    actionBar['el'] = makeEl();
    const removedCls = [];
    actionBar['el'].classList.remove = (c) => { removedCls.push(c); };
    const realSingle = require(`${BASE}/state/selection.js`).selection.single;
    require(`${BASE}/state/selection.js`).selection.single = () => asset;
    actionBar.sync();
    require(`${BASE}/state/selection.js`).selection.single = realSingle;
    check(removedCls.includes('show'), `素材节点 action-bar 隐藏操作条（移除 show；实际 ${JSON.stringify(removedCls)}）`);
  });

  await section('S20 _showCardMenu：素材节点不显示「运行当前卡」「重新运行」（判分支 #6）', async () => {
    reset();
    const asset = ASSET('a1', 'data:image/png;base64,A');
    asset.status = 'stale'; // 素材若被误判为可运行，stale 态会出现「重新运行」
    interactions['_showCardMenu'](10, 10, asset);
    const menu = bodyChildren.find(el => el.id === 'ctx-menu');
    check(!menu.innerHTML.includes('运行当前卡'), '素材右键菜单不含「运行当前卡」');
    check(!menu.innerHTML.includes('重新运行'), '素材右键菜单不含「重新运行」');
    check(menu.innerHTML.includes('删除节点'), '素材右键菜单保留「删除节点」');
    // 对照：自建图片节点（stale）含「重新运行」
    reset();
    const img = IMG('img', { prompt: 'p', model: 'draw-m1' });
    img.status = 'stale';
    interactions['_showCardMenu'](10, 10, img);
    const menu2 = bodyChildren.find(el => el.id === 'ctx-menu');
    check(menu2.innerHTML.includes('重新运行'), '自建节点（stale）含「重新运行」');
  });

  await section('S21 Q7 旧 modelType=\'text\' 节点完整运行按 draw 走 runBatch（不报错、出图）', async () => {
    reset();
    const oldReverse = IMG('old', { prompt: '旧反推命令', model: 'draw-m1', modelType: 'text', textModel: 'chat-x' });
    genQueue = ['data:image/png;base64,Q7OUT'];
    await runEngine.run(oldReverse.id);
    check(genCalls.length === 1, '旧 modelType=text 节点按 draw 调 generateImage（runBatch）');
    check(genCalls[0].prompt === '旧反推命令', `prompt 按 draw 语义使用（实际 ${genCalls[0].prompt}）`);
    const after = flowState.getNode(oldReverse.id);
    check(after.status === 'done' && after.imageUrl === 'data:image/png;base64,Q7OUT',
      `旧节点运行成功出图回写自身（实际 ${after.imageUrl}）`);
    check(after.trace && after.trace.outputType === 'txt2img', 'trace 按 txt2img 记录（无参考图）');
  });

  await section('S22 撤销/重做回归：引擎回写 suspend 不入栈；拖图建素材+连线一次 record（一步撤销）', async () => {
    reset();
    const { flowHistory } = require(`${BASE}/state/history.js`);
    flowHistory.undoStack.length = 0;
    flowHistory.redoStack.length = 0;
    // ① 引擎运行（含回写自身/建产出节点）不入撤销栈
    const img = IMG('img', { prompt: 'undo测试', model: 'draw-m1', count: 1 });
    genQueue = ['data:image/png;base64,U1'];
    await runEngine.run(img.id);
    check(flowHistory.undoStack.length === 0, `引擎回写自身不入撤销栈（undoStack=${flowHistory.undoStack.length}）`);
    // ② 拖图到文本卡（建素材 + 连线）在一次 record 后 → 一步撤销
    reset();
    const text = T('t1', null);
    const cardEl = makeEl({ dataset: { nodeId: text.id }, closest: (sel) => (sel === '.pcard' ? cardEl : null) });
    document.elementFromPoint = () => cardEl;
    interactions['_dropImage']('data:image/png;base64,UNDO', { x: 0, y: 0 }, 10, 10);
    const ok = await until(() => flowState.nodes.length === 2);
    check(ok && flowHistory.undoStack.length === 1, `拖图建素材+连线合并为一次 record（undoStack=${flowHistory.undoStack.length}）`);
    flowHistory.undo();
    check(flowState.nodes.length === 1 && flowState.edges.length === 0,
      `一步撤销恢复原状（nodes=${flowState.nodes.length}, edges=${flowState.edges.length}）`);
    // 恢复默认 elementFromPoint
    document.elementFromPoint = () => null;
  });

  console.log(`\n════════ 汇总 ════════`);
  console.log(`通过 ${passed} · 失败 ${failed}`);
  if (failures.length) {
    console.log('失败项：');
    failures.forEach(f => console.log('  - ' + f));
    process.exitCode = 1;
  }
})();
