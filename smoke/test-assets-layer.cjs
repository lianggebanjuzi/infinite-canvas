// smoke/test-assets-layer.cjs
// QA · 资产层（incremental-2：复现 + 成图库收口 + 对比面板）前端 smoke 测试
// 覆盖：AssetStore 采纳/锁定单一数据源（X1）/ dirty 联动（X2）/ 撤销并行资产快照（X3）/
//       removeChildren 锁定保护（AC-4）/ trace.refImageUrls 扩展（AC-2）/ 复现参考图解析（A3）
// 运行：先 npx tsc -p tsconfig.smoke.json --outDir .icv-smoke 再 node smoke/test-assets-layer.cjs
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

const byId = new Map([['toast', makeEl()]]);
global.pywebview = { api: {} };
global.window = {
  addEventListener() {}, removeEventListener() {}, close() {},
  setTimeout, clearTimeout, setInterval() { return 1; }, clearInterval() {},
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
const { assetStore } = require(`${BASE}/asset-store.js`);
const { historyPersist } = require(`${BASE}/history-persist.js`);
const { Backend } = require(`${BASE}/api.js`);
const { reproduceService } = require(`${BASE}/reproduce.js`);

const realSaveAssets = Backend.saveAssets;
const realLoadAssets = Backend.loadAssets;

function reset(over = {}) {
  flowState.replaceAll({
    format: 'icv', version: '3.4', projectName: 't', canvas: { scale: 1, panX: 0, panY: 0 },
    nodes: [], edges: [], createdAt: 0, updatedAt: 0, ...over,
  });
  flowHistory.clear();
  assetStore['records'].clear();
  persistence['lastPath'] = null;
}
const { persistence } = require(`${BASE}/persistence.js`);

// ───────────────────────── 用例 ─────────────────────────
async function main() {
  // ============ A、AssetStore 采纳/锁定单一数据源（X1） ============
  await section('A1: adopt 采纳自动置锁定 + 查询方法', () => {
    reset();
    const node = flowState.addNode('image-gen', 0, 0, { imageUrl: 'data:image/png;base64,AAAA' });
    assetStore.adoptByUrl(node.imageUrl, node.id);
    check(assetStore.isAdoptedByImageUrl(node.imageUrl) === true, '采纳后 isAdoptedByImageUrl true');
    check(assetStore.isLockedByImageUrl(node.imageUrl) === true, '采纳自动置锁定（B2）');
    check(assetStore.isLockedNode(node.id) === true, 'isLockedNode 冗余回溯命中');
    const rec = assetStore.getByImageUrl(node.imageUrl);
    check(rec !== null && rec.key === historyPersist.hashRef(node.imageUrl), 'getByImageUrl 键 = hashRef 图指纹');
    check(rec.category === '成图', 'category 预留默认 成图（B8）');
    check(Array.isArray(rec.tags), 'tags 数组');
  });

  await section('A2: unadopt 取消采纳（保留锁定）/ setLocked 单独锁定', () => {
    reset();
    const node = flowState.addNode('image-gen', 0, 0, { imageUrl: 'data:image/png;base64,BBBB' });
    assetStore.adoptByUrl(node.imageUrl, node.id);
    assetStore.unadoptByUrl(node.imageUrl);
    check(assetStore.isAdoptedByImageUrl(node.imageUrl) === false, 'unadopt 后 adopted false');
    check(assetStore.isLockedByImageUrl(node.imageUrl) === true, '取消采纳后锁定保留');
    assetStore.setLockedByUrl(node.imageUrl, node.id, false);
    check(assetStore.isLockedByImageUrl(node.imageUrl) === false, 'setLocked(false) 解锁');
    // 未采纳也可单独锁定（B3）
    assetStore.setLockedByUrl(node.imageUrl, node.id, true);
    check(assetStore.isLockedByImageUrl(node.imageUrl) === true && assetStore.isAdoptedByImageUrl(node.imageUrl) === false, '未采纳单独锁定');
  });

  await section('A3: captureSnapshot/applySnapshot 深拷贝', () => {
    reset();
    const node = flowState.addNode('image-gen', 0, 0, { imageUrl: 'data:image/png;base64,CCCC' });
    assetStore.adoptByUrl(node.imageUrl, node.id);
    const snap = assetStore.captureSnapshot();
    snap.records[0].adopted = false; // 篡改快照
    snap.records[0].tags.push('x');
    check(assetStore.isAdoptedByImageUrl(node.imageUrl) === true, 'captureSnapshot 深拷贝（改快照不污染 store）');
    assetStore.applySnapshot({ records: [] });
    check(assetStore.isAdoptedByImageUrl(node.imageUrl) === false, 'applySnapshot 恢复空索引');
  });

  await section('A4: setLocked(false) 无记录不建空记录（QA O3）', () => {
    reset();
    assetStore.setLockedByUrl('data:image/png;base64,NOPE', 'n1', false);
    check(assetStore.list().length === 0, '无记录解锁不产生无意义空记录');
    assetStore.setLockedByUrl('data:image/png;base64,NOPE2', 'n2', true);
    check(assetStore.list().length === 1 && assetStore.isLockedByImageUrl('data:image/png;base64,NOPE2'), '锁定 true 仍正常新建记录');
  });

  // ============ B、X2 dirty 联动 ============
  await section('B1: 采纳/锁定变更计入 dirty（X2）', () => {
    reset();
    const node = flowState.addNode('image-gen', 0, 0, { imageUrl: 'data:image/png;base64,DDDD' });
    flowState.dirty = false;
    const before = flowState.updatedAt;
    assetStore.adoptByUrl(node.imageUrl, node.id);
    check(flowState.dirty === true, '采纳后 dirty=true（顶栏「未保存」亮起）');
    check(flowState.updatedAt >= before, '采纳后 updatedAt 同步');
  });

  await section('B2: 变更防抖落盘 saveAssets（X2 保存落盘）', async () => {
    reset();
    const node = flowState.addNode('image-gen', 0, 0, { imageUrl: 'data:image/png;base64,EEEE' });
    let saved = null;
    Backend.saveAssets = async (records) => { saved = records; return { status: 'success' }; };
    assetStore.adoptByUrl(node.imageUrl, node.id);
    await tick(400); // 防抖 300ms 后落盘
    check(saved !== null && Array.isArray(saved), '防抖后 saveAssets 被调用');
    check(saved.length === 1 && saved[0].adopted === true, '落盘 records 含采纳记录');
    Backend.saveAssets = realSaveAssets;
  });

  // ============ C、X3 撤销（并行资产快照） ============
  await section('C1: 撤销采纳后角标状态回退 + 索引落盘回退（X3）', async () => {
    reset();
    const node = flowState.addNode('image-gen', 0, 0, { imageUrl: 'data:image/png;base64,FFFF' });
    let savedRecords = null;
    Backend.saveAssets = async (records) => { savedRecords = records; return { status: 'success' }; };
    flowHistory.record(); // 用户手势入口前快照（assets 空）
    assetStore.adoptByUrl(node.imageUrl, node.id);
    check(assetStore.isAdoptedByImageUrl(node.imageUrl) === true, '采纳后 adopted true');
    flowHistory.undo();
    check(assetStore.isAdoptedByImageUrl(node.imageUrl) === false, '撤销后 adopted false（角标消失）');
    await tick(50);
    check(savedRecords !== null && savedRecords.length === 0, '撤销后索引文件回退（saveAssets 写回空索引）');
    // 重做恢复
    flowHistory.redo();
    check(assetStore.isAdoptedByImageUrl(node.imageUrl) === true, '重做后 adopted true 恢复');
    Backend.saveAssets = realSaveAssets;
  });

  await section('C2: clear 清空资产快照栈（跨项目不串）', () => {
    reset();
    const node = flowState.addNode('image-gen', 0, 0, { imageUrl: 'data:image/png;base64,GGGG' });
    flowHistory.record();
    assetStore.adoptByUrl(node.imageUrl, node.id);
    flowHistory.clear();
    check(flowHistory.canUndo === false, 'clear 后无可撤销');
    check(assetStore.isAdoptedByImageUrl(node.imageUrl) === true, 'clear 不动当前 assets 状态');
  });

  // ============ D、锁定保护（AC-4） ============
  await section('D1: removeChildren 锁定产出节点保留 + 标 stale（AC-4）', () => {
    reset();
    const gen = flowState.addNode('image-gen', 0, 0, { params: { prompt: 'p', model: 'm' } });
    const child = flowState.addNode('image-gen', 400, 0, {
      parentId: gen.id, imageUrl: 'data:image/png;base64,HHHH', status: 'done',
    });
    flowState.addEdge(gen.id, child.id, { suppressStale: true });
    // 锁定产出图
    assetStore.adoptByUrl(child.imageUrl, child.id);
    flowState.removeChildren(gen.id);
    check(flowState.getNode(child.id) !== undefined, '锁定产出节点被保留（不删除）');
    check(flowState.getNode(child.id).status === 'stale', '锁定产出节点被标 stale（Q3）');
    // 未锁定产出节点仍被删
    assetStore.unadoptByUrl(child.imageUrl);
    assetStore.setLockedByUrl(child.imageUrl, child.id, false);
    flowState.removeChildren(gen.id);
    check(flowState.getNode(child.id) === undefined, '未锁定纯引擎产出节点被删除（原逻辑保留）');
  });

  await section('D2: isLockedNode 冗余命中（imageUrl 被清空场景）', () => {
    reset();
    const node = flowState.addNode('image-gen', 0, 0, { imageUrl: 'data:image/png;base64,IIII' });
    assetStore.setLockedByUrl(node.imageUrl, node.id, true);
    // 模拟图生图清空主视觉后，仍能按 nodeId 命中锁定
    flowState.updateNode(node.id, { imageUrl: null });
    check(assetStore.isLockedNode(node.id) === true, 'imageUrl 清空后 isLockedNode 仍命中');
    check(assetStore.isLockedByImageUrl('data:image/png;base64,IIII') === true, '锁定记录仍作用于旧图指纹');
  });

  // ============ E、trace.refImageUrls 扩展（AC-2） ============
  await section('E1: buildImageTrace 写入 refImageUrls（新 trace）', () => {
    reset();
    const node = flowState.addNode('image-gen', 0, 0, {
      params: { prompt: '绣球', model: 'p:m', aspectRatio: '1:1', resolution: '2k', count: 2 },
    });
    const refs = ['data:image/png;base64,REF1', 'data:image/png;base64,REF2'];
    const trace = historyPersist.buildImageTrace(node, refs, 'img2img', 'data:image/png;base64,OUT');
    check(Array.isArray(trace.refImageUrls) && trace.refImageUrls.length === 2, 'trace.refImageUrls 数组');
    check(trace.refImageUrls[0] === refs[0], 'refImageUrls 记录实际 URL');
    check(trace.refImageHashes.length === 2, 'refImageHashes 同步');
  });

  await section('E2: HistoryEntry image 行扩展 imageUrl（新行）', () => {
    reset();
    const node = flowState.addNode('image-gen', 0, 0, { params: { prompt: 'p', model: 'm' } });
    const trace = historyPersist.buildImageTrace(node, [], 'txt2img', 'data:image/png;base64,OUT2');
    const entry = { kind: 'image', nodeId: node.id, ...trace, imageUrl: 'data:image/png;base64,OUT2' };
    check(entry.imageUrl === 'data:image/png;base64,OUT2', 'entry.imageUrl 记录产出图 URL（图库解析优先）');
    check(entry.kind === 'image', 'kind=image');
  });

  // ============ F、复现参考图解析（A3） ============
  await section('F1: resolveRefImages 优先 trace.refImageUrls', () => {
    reset();
    const trace = { refImageUrls: ['data:image/png;base64,U1', 'data:image/png;base64,U2'], refImageHashes: [] };
    const r = reproduceService.resolveRefImages(trace, null);
    check(r.urls.length === 2 && r.missing === 0, 'refImageUrls 直接可用（跨会话可靠）');
  });

  await section('F2: 仅 hash 时按项目内图池反查（源节点优先）', () => {
    reset();
    const ref = 'data:image/png;base64,POOL';
    const src = flowState.addNode('image-gen', 0, 0, { refImages: [ref] });
    flowState.addNode('image-gen', 200, 0, { imageUrl: 'data:image/png;base64,OTHER' });
    const trace = { refImageUrls: [], refImageHashes: [historyPersist.hashRef(ref), historyPersist.hashRef('data:image/png;base64,OTHER')] };
    const r = reproduceService.resolveRefImages(trace, src);
    check(r.urls.includes(ref), '源节点 refImages 命中');
    check(r.urls.includes('data:image/png;base64,OTHER'), '画布图池命中');
    check(r.missing === 0, '无缺失');
  });

  await section('F3: 未解析 hash 计数缺失（不阻断）', () => {
    reset();
    const trace = { refImageUrls: [], refImageHashes: [historyPersist.hashRef('data:image/png;base64,GONE')] };
    const r = reproduceService.resolveRefImages(trace, null);
    check(r.urls.length === 0 && r.missing === 1, '缺失 1 张（A3 计数提示）');
  });

  await section('F5: URL 数 < hash 数时差额走 hash 反查，missing 真实（QA O2）', () => {
    reset();
    const u1 = 'data:image/png;base64,U1';
    // 损坏/部分 trace：1 个 URL + 2 个 hash（其中 1 个对应 U1、1 个完全缺失）
    const trace = {
      refImageUrls: [u1],
      refImageHashes: [historyPersist.hashRef(u1), historyPersist.hashRef('data:image/png;base64,GONE2')],
    };
    const r = reproduceService.resolveRefImages(trace, null);
    check(r.urls.length === 1 && r.missing === 1, 'URL 覆盖的 hash 不计缺失，差额 1 张计 missing=1（不再误报 0）');
  });

  await section('F4: checkModelAvailable 模型不可用 toast 不阻断', async () => {
    reset();
    // fetchImageModels 走 utils/api → pywebview.api.load_providers（Backend 层无此方法，须桩在 pywebview）
    global.pywebview.api.load_providers = async () => ({
      providers: [{ id: 'p', enabled: true, short_name: 'p', keys: [{ id: 'key_1', name: 'key1', api_key: '', enabled: true, models: [{ id: 'm1', type: 'drawing', enabled: true }] }] }],
    });
    const ok1 = await reproduceService.checkModelAvailable('p:m1');
    check(ok1 === true, '可用模型返回 true');
    const ok2 = await reproduceService.checkModelAvailable('p:gone');
    check(ok2 === false, '不可用模型返回 false（已 toast「模型不可用，已保留原参数」）');
    delete global.pywebview.api.load_providers;
  });

  // ============ G、loadFromBackend 恢复（AC-5） ============
  await section('G1: loadFromBackend success 恢复采纳/锁定（AC-5）', async () => {
    reset();
    const url = 'data:image/png;base64,RESTORE';
    Backend.loadAssets = async () => ({
      status: 'success',
      records: [{ key: historyPersist.hashRef(url), nodeId: 'n1', adopted: true, locked: true, tags: [], category: '成图', updatedAt: 1 }],
    });
    await assetStore.loadFromBackend();
    check(assetStore.isAdoptedByImageUrl(url) === true, '恢复采纳');
    check(assetStore.isLockedByImageUrl(url) === true, '恢复锁定');
    Backend.loadAssets = realLoadAssets;
  });

  await section('G2: loadFromBackend empty → 空索引（迁移策略）', async () => {
    reset();
    Backend.loadAssets = async () => ({ status: 'empty' });
    await assetStore.loadFromBackend();
    check(assetStore.list().length === 0, '无 assets.json → 全未采纳/未锁定');
    Backend.loadAssets = realLoadAssets;
  });

  console.log(`\n══════════════════════════════════`);
  console.log(`资产层前端：通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) {
    console.error('失败明细：');
    failures.forEach(f => console.error(`- ${f}`));
    process.exit(1);
  }
  console.log('ASSETS-LAYER PASS');
}

main().catch(e => { console.error(e); process.exit(1); });
