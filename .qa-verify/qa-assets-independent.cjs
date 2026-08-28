// QA 独立行为验证（incremental-2：复现 + 成图库收口 + 对比面板）
// 作者：Edward (QA) — fresh eyes 视角，独立设计用例，不照抄工程师 smoke 用例
// 运行：先 npx tsc -p tsconfig.smoke.json --outDir .icv-smoke（已执行）再 node .qa-verify/qa-assets-independent.cjs
// 覆盖（PRD AC-1~8 + 需求池 A/B/C 关键项）：
//   R1 复现：带 trace 节点复现 → 新建独立节点（parentId=null，右下避让）+ 参数回填 + 自动选中 + run 调用；原节点保留
//   R2 复现：无 trace → 不新建节点不 run；busy → 拒绝
//   R3 采纳/锁定：采纳自动锁定；锁定 → removeChildren 不删（AC-4）；未采纳照旧删除
//   R4 搜索：成图按 prompt/model 过滤；文本按 outputText 过滤；无匹配显示占位（B5/B7）
//   R5 对比：n<2 禁用；文本不计入 n；面板 open 过滤不可比节点；面板内采纳写同一 AssetStore（C1/C3/AC-6）
//   R6 持久化：assets.json 往返 + 损坏容错（AC-5，后端单独 py 脚本验证，此处验证前端 loadFromBackend 归一）

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
    get() { return _text; }, set(v) { _text = String(v); _html = escapeHtml(String(v)); }, configurable: true,
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return _html; }, set(v) { _html = String(v); }, configurable: true,
  });
  return el;
}

// 抽屉/面板所需 DOM 桩
const tabImage = makeEl({ dataset: { tab: 'image' } });
const tabText = makeEl({ dataset: { tab: 'text' } });
const grid = makeEl();
const drawerEl = makeEl();
const handleEl = makeEl();
const emptyEl = makeEl();
const searchInput = makeEl();
const tabsEl = makeEl({
  querySelectorAll: () => [tabImage, tabText],
});
const compareOverlay = makeEl({
  querySelectorAll: () => [
    makeEl({ dataset: { grid: '2' } }),
    makeEl({ dataset: { grid: '4' } }),
    makeEl({ dataset: { grid: '8' } }),
  ],
});
const compareGrid = makeEl();
const compareCount = makeEl();
const compareClose = makeEl();
const runBtnSpan = makeEl();
const compareBtnSpan = makeEl();
const runBtn = makeEl({ querySelector: (sel) => (sel === 'span' ? runBtnSpan : null) });
const compareBtn = makeEl({ querySelector: (sel) => (sel === 'span' ? compareBtnSpan : null) });
const nameInput = makeEl();
const projectNameInput = makeEl();

const byId = new Map([
  ['toast', makeEl()],
  ['left-drawer', drawerEl],
  ['history-grid', grid],
  ['drawer-handle', handleEl],
  ['history-empty', emptyEl],
  ['history-search', searchInput],
  ['history-tabs', tabsEl],
  ['compare-overlay', compareOverlay],
  ['compare-grid', compareGrid],
  ['compare-count', compareCount],
  ['compare-close', compareClose],
  ['btn-run-selected', runBtn],
  ['btn-compare', compareBtn],
  ['project-name', projectNameInput],
  ['btn-open', makeEl()], ['btn-save', makeEl()], ['btn-theme', makeEl()], ['btn-settings', makeEl()],
]);

global.pywebview = { api: {} };
global.window = {
  addEventListener() {}, removeEventListener() {}, close() {},
  setTimeout, clearTimeout, setInterval() { return 1; }, clearInterval() {},
  innerWidth: 1280, innerHeight: 800, pywebview: global.pywebview,
};
global.document = {
  getElementById: (id) => (byId.has(id) ? byId.get(id) : null),
  createElement: () => makeEl(),
  createElementNS: () => makeEl(),
  addEventListener() {}, removeEventListener() {},
  body: makeEl(),
  documentElement: makeEl({ setAttribute() {}, getAttribute() { return 'light'; } }),
  querySelector: () => null,
  querySelectorAll: () => [tabImage, tabText],
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
let passed = 0; let failed = 0; const failures = [];
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
const { selection } = require(`${BASE}/state/selection.js`);
const { flowHistory } = require(`${BASE}/state/history.js`);
const { assetStore } = require(`${BASE}/asset-store.js`);
const { historyPersist } = require(`${BASE}/history-persist.js`);
const { Backend } = require(`${BASE}/api.js`);
const { reproduceService } = require(`${BASE}/reproduce.js`);
const { runEngine } = require(`${BASE}/engine/run-engine.js`);
const { historyDrawer } = require(`${BASE}/ui/history-drawer.js`);
const { comparePanel } = require(`${BASE}/ui/compare-panel.js`);
const { bottomBar } = require(`${BASE}/ui/bottom-bar.js`);

function reset(over = {}) {
  flowState.replaceAll({
    format: 'icv', version: '3.4', projectName: 't', canvas: { scale: 1, panX: 0, panY: 0 },
    nodes: [], edges: [], createdAt: 0, updatedAt: 0, ...over,
  });
  flowHistory.clear();
  assetStore['records'].clear();
  selection.clear();
  grid.innerHTML = '';
  searchInput.value = '';
  emptyEl.style.display = 'none';
  tabImage.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  tabText.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
}

async function main() {
  // ═══════════════ R1 复现：带 trace 节点 → 新建独立节点 + 参数回填 + 自动选中 + run ═══════════════
  await section('R1: reproduceFromNode 端到端（AC-1/A2/A4/A5）', async () => {
    reset();
    const src = flowState.addNode('image-gen', 100, 100, {
      imageUrl: 'data:image/png;base64,SRC',
      params: { prompt: '绣球花束', model: 'p:seedream', aspectRatio: '3:4', resolution: '2k', count: 2, modelType: 'draw' },
      trace: {
        prompt: '绣球花束', model: 'p:seedream', aspectRatio: '3:4', resolution: '2k', count: 2,
        refImageHashes: [], refImageUrls: [], seed: null, createdAt: 1, parentId: null, outputType: 'txt2img',
      },
    });
    const srcId = src.id;
    // 修正 trace.parentId（addNode 时 src 尚未有 id）
    src.trace.parentId = srcId;

    const runCalls = [];
    const origRun = runEngine.run;
    runEngine.run = async (id) => { runCalls.push(id); };
    const origBusy = runEngine.isBusy;
    runEngine.isBusy = () => false;

    await reproduceService.reproduceFromNode(srcId);

    // ① 新建独立节点（AC-1 不破坏原图）
    const nodes = flowState.nodes;
    check(nodes.length === 2, `复现后共 2 节点（原节点 + 新复现节点），实际 ${nodes.length}`);
    const newNode = nodes.find(n => n.id !== srcId);
    check(!!newNode, '存在复现新节点');
    check(newNode.parentId === null, `复现节点为独立节点 parentId=null（不被原节点 removeChildren 删除）`);
    // ② 参数回填 = trace（A2）
    check(newNode.params.prompt === '绣球花束', 'prompt 回填一致');
    check(newNode.params.model === 'p:seedream', 'model 回填一致');
    check(newNode.params.aspectRatio === '3:4', 'aspectRatio 回填一致');
    check(newNode.params.resolution === '2k', 'resolution 回填一致');
    check(newNode.params.count === 2, 'count 回填一致');
    check(newNode.params.modelType === 'draw', 'modelType 强制 draw');
    check(newNode.title === '复现结果', '标题 复现结果');
    // ③ 位置 = 源节点右下方（x = src.x + CARD_W + 48）
    check(newNode.x === src.x + 260 + 48, `复现节点 x 避让（${newNode.x} === ${src.x + 308}）`);
    check(newNode.y >= src.y, `复现节点 y 不重叠（${newNode.y} >= ${src.y}）`);
    // ④ 自动选中 + 自动 run（A4）
    check(selection.isSelected(newNode.id), '复现节点被自动选中');
    check(runCalls.length === 1 && runCalls[0] === newNode.id, 'runEngine.run 以新节点 id 被调用');
    // ⑤ 原节点保留（A5）
    const srcAfter = flowState.getNode(srcId);
    check(srcAfter.imageUrl === 'data:image/png;base64,SRC', '原节点 imageUrl 保留');
    check(!!srcAfter.trace, '原节点 trace 保留');
    // ⑥ 新节点初始 trace=null（引擎成功后写入）
    check(newNode.trace === null, '新节点 trace 初始 null（引擎成功后写入 source of truth）');

    runEngine.run = origRun;
    runEngine.isBusy = origBusy;
  });

  // ═══════════════ R2 复现：无 trace → no-op；busy → 拒绝 ═══════════════
  await section('R2: 无 trace 不执行 + busy 拒绝（A1/A7）', async () => {
    reset();
    const noTrace = flowState.addNode('image-gen', 0, 0, { imageUrl: 'data:image/png;base64,NT', trace: null });
    const runCalls = [];
    const origRun = runEngine.run;
    runEngine.run = async (id) => { runCalls.push(id); };
    runEngine.isBusy = () => false;
    await reproduceService.reproduceFromNode(noTrace.id);
    check(flowState.nodes.length === 1, '无 trace 节点复现不新建节点');
    check(runCalls.length === 0, '无 trace 节点复现不触发 run');

    // busy 拒绝（A7）
    const busyNode = flowState.addNode('image-gen', 0, 300, {
      imageUrl: 'data:image/png;base64,BS',
      trace: { prompt: 'p', model: 'm', aspectRatio: '3:4', resolution: '2k', count: 1, refImageHashes: [], refImageUrls: [], seed: null, createdAt: 1, parentId: null, outputType: 'txt2img' },
    });
    const before = flowState.nodes.length;
    runEngine.isBusy = () => true;
    await reproduceService.reproduceFromNode(busyNode.id);
    check(flowState.nodes.length === before, 'busy 时复现被拒绝（不新建节点）');
    check(runCalls.length === 0, 'busy 时复现不触发 run');
    runEngine.run = origRun;
    runEngine.isBusy = () => false;
  });

  // ═══════════════ R3 采纳/锁定保护（AC-4/B2/B3） ═══════════════
  await section('R3: 采纳自动锁定 + removeChildren 锁定保护（AC-4）', () => {
    reset();
    const gen = flowState.addNode('image-gen', 0, 0, { params: { prompt: 'p', model: 'm' } });
    const child = flowState.addNode('image-gen', 400, 0, { parentId: gen.id, imageUrl: 'data:image/png;base64,CH', status: 'done' });
    flowState.addEdge(gen.id, child.id, { suppressStale: true });

    // 采纳 → 自动锁定（B2）
    assetStore.adoptByUrl(child.imageUrl, child.id);
    check(assetStore.isAdoptedByImageUrl(child.imageUrl) === true, '采纳后 adopted=true');
    check(assetStore.isLockedByImageUrl(child.imageUrl) === true, '采纳自动置锁定');

    // 锁定 → removeChildren 保留 + 标 stale（B3/AC-4）
    flowState.removeChildren(gen.id);
    check(flowState.getNode(child.id) !== undefined, '锁定产出节点不被 removeChildren 删除');
    check(flowState.getNode(child.id).status === 'stale', '锁定产出节点被标 stale');

    // 未采纳 → 行为照旧（纯引擎产出被删除）
    assetStore.unadoptByUrl(child.imageUrl);
    assetStore.setLockedByUrl(child.imageUrl, child.id, false);
    flowState.removeChildren(gen.id);
    check(flowState.getNode(child.id) === undefined, '未锁定纯引擎产出节点照旧被删除');
  });

  // ═══════════════ R4 搜索（B5/B7/AC-3） ═══════════════
  await section('R4: 图库分区 + 搜索过滤（AC-3）', () => {
    reset();
    historyDrawer.addImage('data:image/png;base64,H1', { prompt: '绣球花束 白色', model: 'p:seedream', nodeId: 'n1' });
    historyDrawer.addImage('data:image/png;base64,H2', { prompt: '玫瑰 红色', model: 'q:nano-banana', nodeId: 'n2' });
    // 文本记录
    historyDrawer['items'].push({ src: '', timestamp: Date.now(), kind: 'text', text: '淡奶油色陶盆' });

    // 默认成图 tab：文本不混入图片网格
    historyDrawer.setTab('image');
    historyDrawer.setQuery('');
    let imageItems = historyDrawer['items'].filter(i => i.kind === 'image');
    check(imageItems.length === 2, '默认成图 tab 显示成图');
    // 成图搜索：prompt 关键词
    historyDrawer.setQuery('绣球');
    let filtered = historyDrawer['_filtered']();
    check(filtered.length === 1 && filtered[0].prompt.includes('绣球'), '按 prompt 关键词过滤成图');
    // 成图搜索：模型关键词
    historyDrawer.setQuery('banana');
    filtered = historyDrawer['_filtered']();
    check(filtered.length === 1 && filtered[0].model === 'q:nano-banana', '按模型关键词过滤成图');
    // 无匹配 → 空列表（render 显示「无匹配成图」）
    historyDrawer.setQuery('不存在词');
    filtered = historyDrawer['_filtered']();
    check(filtered.length === 0, '无匹配 → 空列表');
    // 文本 tab：outputText 过滤（B7）
    historyDrawer.setTab('text');
    historyDrawer.setQuery('陶盆');
    filtered = historyDrawer['_filtered']();
    check(filtered.length === 1 && filtered[0].text.includes('陶盆'), '文本按 outputText 过滤');
    historyDrawer.setTab('image');
    historyDrawer.setQuery('');
  });

  // ═══════════════ R5 对比：n 统计 + 面板过滤 + 面板内采纳（C1/C3/AC-6） ═══════════════
  await section('R5: 对比按钮 n 统计 + 面板内采纳（AC-6）', () => {
    reset();
    bottomBar.init();
    const img1 = flowState.addNode('image-gen', 0, 0, { imageUrl: 'data:image/png;base64,C1', params: { prompt: 'a', model: 'm1' } });
    const img2 = flowState.addNode('image-gen', 300, 0, { imageUrl: 'data:image/png;base64,C2', params: { prompt: 'b', model: 'm2' } });
    const txt = flowState.addNode('text-gen', 600, 0, { outputText: '文本' });

    // 单选 → n<2 禁用（C1）
    selection.select(img1.id);
    bottomBar['_sync']();
    check(compareBtn.disabled === true, '单选 1 张 → 对比按钮禁用');

    // 多选 2 图 + 1 文本 → n=2（文本不计入）
    selection.select(img2.id, true);
    selection.select(txt.id, true);
    bottomBar['_sync']();
    check(compareBtn.disabled === false, '2 张可对比图 → 对比按钮可用');
    const label = compareBtn.querySelector('span');
    check(!!label && label.textContent === '对比 (2)', `对比按钮显示 对比 (2)（文本不计入 n），实际 "${label ? label.textContent : ''}"`);

    // 面板 open：文本/无图节点被过滤（Q4/C2）
    comparePanel.open([img1.id, img2.id, txt.id]);
    check(comparePanel['state'].open === true, '对比面板打开');
    check(comparePanel['state'].nodeIds.length === 2, '面板 nodeIds 仅含可对比图（文本被过滤）');
    check(comparePanel['state'].grid === 2, '2 张 → 2 宫格');

    // 面板内采纳 → AssetStore 更新（C3/X1）
    comparePanel['_cellAdopt'](img1.imageUrl, img1.id);
    check(assetStore.isAdoptedByImageUrl(img1.imageUrl) === true, '面板内采纳 → AssetStore adopted=true');
    check(assetStore.isLockedByImageUrl(img1.imageUrl) === true, '面板内采纳自动锁定');
    check(comparePanel['_comparableNodes']([img1.id, img2.id]).length === 2, '面板内采纳不改变可对比节点集');

    // 关闭仅清瞬时态（C4/AC-7）
    comparePanel.close();
    check(comparePanel['state'].open === false && comparePanel['state'].nodeIds.length === 0, '关闭后瞬时态清空');
    check(flowState.getNode(img1.id) !== undefined && flowState.getNode(img2.id) !== undefined && flowState.getNode(txt.id) !== undefined, '关闭后节点全部保留（不删节点）');
    check(flowState.edges.length === 0, '关闭后连线不变（不建线）');
  });

  // ═══════════════ R6 持久化：前端 loadFromBackend 归一（AC-5） ═══════════════
  await section('R6: loadFromBackend 归一 + 损坏容错（AC-5）', async () => {
    reset();
    const url = 'data:image/png;base64,PERSIST';
    // 脏数据归一：tags 含非字符串、category 缺失、nodeId 缺失
    Backend.loadAssets = async () => ({
      status: 'success',
      records: [
        { key: historyPersist.hashRef(url), nodeId: 'n1', adopted: true, locked: true, tags: ['ok', 123, null], category: '', updatedAt: 1 },
        { key: 'bad', adopted: false, locked: false, tags: [], updatedAt: 2 }, // 缺 nodeId/category
      ],
    });
    await assetStore.loadFromBackend();
    const rec = assetStore.getByImageUrl(url);
    check(rec !== null && rec.adopted === true, '恢复采纳');
    check(Array.isArray(rec.tags) && rec.tags.length === 1 && rec.tags[0] === 'ok', 'tags 归一（过滤非字符串）');
    check(rec.category === '成图', 'category 缺省补 成图');
    const badRec = assetStore['records'].get('bad');
    check(badRec && badRec.nodeId === '' && badRec.category === '成图', '缺失字段归一兜底');
    Backend.loadAssets = undefined;
  });

  // ═══════════════ R7 参考图解析三通道（AC-2/A3 独立视角） ═══════════════
  await section('R7: resolveRefImages 三通道（A3）', () => {
    reset();
    // 通道② hash 反查：源节点 refImages 优先于画布其它节点
    const ref1 = 'data:image/png;base64,REF_A';
    const ref2 = 'data:image/png;base64,REF_B';
    const src = flowState.addNode('image-gen', 0, 0, { refImages: [ref1] });
    flowState.addNode('image-gen', 500, 0, { imageUrl: ref2 });
    const trace = { refImageUrls: [], refImageHashes: [historyPersist.hashRef(ref1), historyPersist.hashRef(ref2)] };
    const r = reproduceService.resolveRefImages(trace, src);
    check(r.urls.length === 2 && r.urls.includes(ref1) && r.urls.includes(ref2), 'hash 反查项目内图池（源节点优先）');
    // 通道③ 缺失计数
    const trace2 = { refImageUrls: [], refImageHashes: ['deadbeef'] };
    const r2 = reproduceService.resolveRefImages(trace2, null);
    check(r2.urls.length === 0 && r2.missing === 1, '未解析 hash → missing=1（缺失 toast 不阻断）');
    // 去重保序
    const r3 = reproduceService.resolveRefImages({ refImageUrls: [ref1, ref1, ref2] }, null);
    check(r3.urls.length === 2 && r3.urls[0] === ref1 && r3.urls[1] === ref2, 'refImageUrls 去重保序');
  });

  // ═══════════════ R8 AssetStore nodeId 冗余更新 ═══════════════
  await section('R8: nodeId 冗余随写更新 + 图指纹唯一定位', () => {
    reset();
    const url = 'data:image/png;base64,KEY';
    const n1 = flowState.addNode('image-gen', 0, 0, { imageUrl: url });
    const n2 = flowState.addNode('image-gen', 400, 0);
    assetStore.adoptByUrl(url, n1.id);
    // 同一图被另一节点引用时 setLocked 更新 nodeId 冗余
    assetStore.setLockedByUrl(url, n2.id, true);
    check(assetStore.isLockedNode(n2.id) === true, 'nodeId 冗余随写更新到新节点');
    check(assetStore.getByImageUrl(url).key === historyPersist.hashRef(url), '索引键 = hashRef(imageUrl) 图指纹');
  });

  console.log(`\n══════════════════════════════════`);
  console.log(`QA 独立行为验证：通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) {
    console.error('失败明细：');
    failures.forEach(f => console.error(`- ${f}`));
    process.exit(1);
  }
  console.log('QA-INDEPENDENT PASS');
}

main().catch(e => { console.error(e); process.exit(1); });
