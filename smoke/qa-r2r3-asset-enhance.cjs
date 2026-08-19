// smoke/qa-r2r3-asset-enhance.cjs
// QA 独立回归（R2 资产配方持久化 + R3 历史批次分组，commit 1e7922f）
//
// 验证点（对应任务清单 4-9）：
//   A1 跨项目复现证据链：adopt 带 meta → 记录含 9 个配方字段 → recipeFromRecord 还原 →
//      清空 metaByKey（模拟重启/跨会话）→ getAdoptedAssets().meta 非空 → _toEntry 记录配方优先
//   A2 批次分组：_buildDisplay 同 batchId 合并、无 batchId 单图回退、按组内最新时间戳倒序；time 视图不分组
//   A3 批次卡单图能力：缩略图拖拽 dataTransfer 'application/history-image'、点击查看大图 openImageModal、
//      hover 复现 reproduceFromHistory 参数正确；x/y 计数 + +N 角标 + 配方摘要渲染
//   A4 回归：adopt 自动置 locked；hashRef 主键（_keyOf === historyPersist.hashRef）；
//      run-engine locked 分支（写回自身上锁保护）仍在；text/反推 appendTrace 不带 batchId
//   边界：部分失败 3/4；同节点重跑两批 batchId 不同；count=1 扩图批次卡 1/1；旧数据兼容
//
// 运行：
//   node node_modules/typescript/bin/tsc -p tsconfig.smoke.json --outDir .icv-qa
//   node smoke/qa-r2r3-asset-enhance.cjs

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
    // 简单 class 选择器遍历（批次卡缩略图用：_renderBatchCard 在 innerHTML 后 querySelectorAll('.history-batch-thumb')）
    querySelectorAll(sel) {
      const cls = sel.replace(/^\./, '');
      const out = [];
      const walk = (n) => {
        if (n.classList && n.classList.contains && n.classList.contains(cls)) out.push(n);
        (n.children || []).forEach(walk);
      };
      walk(this);
      return out;
    },
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; },
    ...over,
  };
  let _html = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return _html; },
    set(v) {
      _html = String(v);
      // 解析模板里创建的缩略图 div（项目桩不实现 HTML parser，仅按需支持批次卡缩略图；
      // 注意用带闭合引号的 class 精确匹配，避免把容器 .history-batch-thumbs 误算）
      const count = (String(v).match(/history-batch-thumb"/g) || []).length;
      el.children = el.children.filter(c => !(c.classList && c.classList.contains && c.classList.contains('history-batch-thumb')));
      for (let i = 0; i < count; i++) {
        el.children.push(makeEl({ classList: { add() {}, remove() {}, toggle() {}, contains(c) { return c === 'history-batch-thumb'; } }, style: {} }));
      }
    },
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
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

// ───────────────────────── 加载被测模块 ─────────────────────────
const { nodeRegistry } = require(`${BASE}/nodes/node-registry.js`);
require(`${BASE}/nodes/image-gen.js`);
require(`${BASE}/nodes/text-gen.js`);
const { flowState } = require(`${BASE}/state/flow-state.js`);
const { flowHistory } = require(`${BASE}/state/history.js`);
const { persistence } = require(`${BASE}/persistence.js`);
const { assetStore } = require(`${BASE}/asset-store.js`);
const { historyPersist } = require(`${BASE}/history-persist.js`);
const { historyDrawer } = require(`${BASE}/ui/history-drawer.js`);
const { assetDrawer } = require(`${BASE}/ui/asset-drawer.js`);
const { runEngine } = require(`${BASE}/engine/run-engine.js`);
const { reproduceService } = require(`${BASE}/reproduce.js`);
const apiMod = require(`${BASE}/api.js`);
const pollerMod = require(`${BASE}/engine/poller.js`);
const cardView = require(`${BASE}/canvas/card-view.js`);

// ───────────────────────── 测试辅助 ─────────────────────────
function reset(over = {}) {
  flowState.replaceAll({
    format: 'icv', version: '3.4', projectName: 't', canvas: { scale: 1, panX: 0, panY: 0 },
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

function mkImageGen(over = {}) {
  return flowState.addNode('image-gen', 0, 0, {
    params: { prompt: '一只猫', model: 'd:m', aspectRatio: '3:4', resolution: '2k', count: 1 },
    ...over,
  });
}

const URL_A = 'data:image/png;base64,AAAA';
const URL_B = 'data:image/png;base64,BBBB';

// ───────────────────────── 用例 ─────────────────────────
async function main() {
  // ============ A1 跨项目复现证据链（R2） ============
  await section('A1: adopt 带 meta → 记录含配方字段 → recipeFromRecord 还原 → getAdoptedAssets.meta 非空（模拟重启）', async () => {
    reset();
    const meta = {
      prompt: '花园主图', model: 'openai:key1:gpt-image', aspectRatio: '3:4', resolution: '4k',
      count: 4, refImageUrls: ['data:image/png;base64,REF1'], refImageHashes: ['ref-hash-1'],
      outputType: 'img2img', createdAt: 1234567890,
    };
    assetStore.adoptByUrl(URL_A, 'node-1', meta, 'C:/img/orig.png');

    // 1) 记录本体含 9 个配方字段（持久化真相 = 记录）
    const rec = assetStore.getByImageUrl(URL_A);
    check(!!rec, '采纳后记录存在');
    check(rec && rec.prompt === '花园主图' && rec.model === 'openai:key1:gpt-image', '记录本体写入 prompt/model');
    check(rec && rec.aspectRatio === '3:4' && rec.resolution === '4k' && rec.count === 4, '记录本体写入 aspectRatio/resolution/count');
    check(rec && Array.isArray(rec.refImageUrls) && rec.refImageUrls[0] === 'data:image/png;base64,REF1', '记录本体写入 refImageUrls');
    check(rec && Array.isArray(rec.refImageHashes) && rec.refImageHashes[0] === 'ref-hash-1', '记录本体写入 refImageHashes');
    check(rec && rec.outputType === 'img2img' && rec.createdAt === 1234567890, '记录本体写入 outputType/createdAt');

    // 2) 模拟重启/切项目：清空 metaByKey（loadFromBackend 语义），仅剩记录
    assetStore['metaByKey'].clear();
    const assets = assetStore.getAdoptedAssets();
    const a = assets.find(x => x.url === URL_A);
    check(!!a && !!a.meta && a.meta.prompt === '花园主图', 'getAdoptedAssets.meta 由记录配方合成（跨会话不空）');
    check(!!a && a.meta.model === 'openai:key1:gpt-image' && a.meta.count === 4, '合成 meta 含完整配方');
    check(!!a && a.meta.refImageUrls[0] === 'data:image/png;base64,REF1', '合成 meta 含 refImageUrls');

    // 3) recipeFromRecord 独立还原（读侧统一入口）
    const restored = assetStore.recipeFromRecord(rec);
    check(!!restored && restored.prompt === '花园主图' && restored.count === 4, 'recipeFromRecord 可还原完整配方');
    check(restored && restored.refImageHashes[0] === 'ref-hash-1', 'recipeFromRecord 还原 refImageHashes');

    // 4) _toEntry（资产库复现入口）记录配方优先 → 构造 HistoryEntry 带完整参数
    const entry = assetDrawer['_toEntry'](a);
    check(entry.prompt === '花园主图' && entry.model === 'openai:key1:gpt-image', '_toEntry 记录配方优先 → prompt/model');
    check(entry.aspectRatio === '3:4' && entry.resolution === '4k' && entry.count === 4, '_toEntry → aspectRatio/resolution/count');
    check(entry.refImageUrls[0] === 'data:image/png;base64,REF1' && entry.outputType === 'img2img', '_toEntry → refImageUrls/outputType');

    // 5) 落盘证据：list() 含配方字段 → saveAssets 收到完整记录（跨项目 assets.json 可恢复）
    const saved = assetStore.list().find(r => r.key === rec.key);
    check(!!saved && saved.prompt === '花园主图' && saved.createdAt === 1234567890, 'list() 含配方字段（随防抖落盘 assets.json）');
  });

  await section('A1b: metaFromNode 优先级（trace 优先 / params 兜底 / 无配方 undefined）', async () => {
    reset();
    // trace 优先：完整配方取自 trace（即使 params 不同）
    const nodeWithTrace = flowState.addNode('image-gen', 0, 0, {
      params: { prompt: 'params版本', model: 'p:k2:m2', count: 1 },
      trace: {
        prompt: 'trace版本', model: 'p:k1:m1', aspectRatio: '16:9', resolution: '2k',
        count: 4, refImageUrls: ['u1'], refImageHashes: ['h1'], outputType: 'txt2img', createdAt: 111,
      },
    });
    const m1 = assetStore.metaFromNode(nodeWithTrace);
    check(m1 && m1.prompt === 'trace版本' && m1.model === 'p:k1:m1' && m1.count === 4, 'trace 优先（覆盖 params）');
    check(m1 && m1.refImageUrls[0] === 'u1' && m1.outputType === 'txt2img', 'trace 优先含 refs/outputType/createdAt');

    // params 兜底：无 trace 且有 prompt → 从 params + refImages 构造
    const nodeNoTrace = flowState.addNode('image-gen', 300, 0, {
      params: { prompt: '兜底版本', model: 'p:k3:m3', aspectRatio: '1:1', resolution: '1k', count: 2 },
      refImages: ['data:image/png;base64,R1'],
    });
    const m2 = assetStore.metaFromNode(nodeNoTrace);
    check(m2 && m2.prompt === '兜底版本' && m2.model === 'p:k3:m3' && m2.count === 2, '无 trace → params 兜底');
    check(m2 && m2.refImageUrls[0] === 'data:image/png;base64,R1' && m2.refImageHashes[0] === historyPersist.hashRef('data:image/png;base64,R1'), 'params 兜底生成 refImageHashes');

    // 无配方 → undefined（调用方传 undefined = 不写配方，保持旧行为）
    const nodeNoRecipe = flowState.addNode('image-gen', 600, 0, { params: { model: 'p:k4:m4' } });
    check(assetStore.metaFromNode(nodeNoRecipe) === undefined, '无 prompt 无 trace → undefined');
    check(assetStore.metaFromNode(null) === undefined, 'null 节点 → undefined');
  });

  // ============ 旧数据兼容 / _normalize 容错（R2-4 / 任务 8） ============
  await section('A1c: _normalize 容错 + 旧 assets.json 兼容 + 配方缺失占位', async () => {
    reset();
    // 旧记录（无配方字段）→ 归一不报错、字段 undefined（key 必须 = hashRef(imageUrl)，与真实 assets.json 一致）
    const keyOld = historyPersist.hashRef(URL_A);
    const oldRec = {
      key: keyOld, nodeId: 'n1', imageUrl: URL_A, thumbnail: URL_A, originalPath: '',
      projectName: ['A'], adopted: true, locked: true, tags: [], category: '成图', updatedAt: 1000,
    };
    assetStore['applySnapshot']({ records: [oldRec] }); // 走 _normalize
    const rec = assetStore.getByImageUrl(URL_A);
    check(!!rec && rec.prompt === undefined && rec.model === undefined, '旧记录无配方 → undefined 不报错');
    check(rec && rec.refImageUrls === undefined && rec.count === undefined, '旧记录数组/数字字段 undefined');

    // 坏类型容错：prompt 为数字、refImageUrls 含非字符串 → 归一为 undefined / 过滤
    const keyBad = historyPersist.hashRef(URL_B);
    const badRec = {
      key: keyBad, nodeId: 'n1', imageUrl: URL_B, thumbnail: URL_B, originalPath: '',
      projectName: [], adopted: true, locked: true, tags: [], category: '成图', updatedAt: 1000,
      prompt: 12345, model: null, refImageUrls: ['ok', 42, null], count: '4',
    };
    assetStore['applySnapshot']({ records: [badRec] });
    const b = assetStore.getByImageUrl(URL_B);
    check(b && b.prompt === undefined && b.model === undefined, '坏类型 prompt/model → undefined');
    check(b && b.refImageUrls && b.refImageUrls.length === 1 && b.refImageUrls[0] === 'ok', 'refImageUrls 过滤非字符串');
    check(b && b.count === undefined, 'count 字符串 → undefined');

    // 无配方资产 → 卡片配方区显示缺失占位（_recipeHtml）
    const assets = assetStore.getAdoptedAssets();
    const oldAsset = assets.find(x => x.url === URL_A);
    const html = assetDrawer['_recipeHtml'](oldAsset && oldAsset.meta);
    check(html.includes('配方缺失') && html.includes('可经历史反查'), '无配方卡片显示「配方缺失（可经历史反查）」占位');

    // 反查兜底：meta 为空且 historyDrawer 有匹配项 → _toEntry 走反查
    historyDrawer['items'] = [{
      src: URL_A, timestamp: 999, kind: 'image', nodeId: 'n-hist', prompt: '历史配方', model: 'h:m',
      aspectRatio: '1:1', resolution: '1k', count: 1, refImageHashes: [], refImageUrls: [],
      outputType: 'txt2img', batchId: undefined,
    }];
    const fbEntry = assetDrawer['_toEntry']({ url: URL_A, record: oldRec, meta: undefined, thumbnailUrl: URL_A });
    check(fbEntry.prompt === '历史配方' && fbEntry.nodeId === 'n-hist', '旧记录无反查兜底成功（配方缺失时仍可复现）');
  });

  // ============ A2 批次分组（R3 读侧） ============
  await section('A2: _buildDisplay 分组逻辑（同 batchId 合并 / 无 batchId 单图 / 组内最新时间倒序 / time 视图不分组）', async () => {
    reset();
    historyDrawer['view'] = 'batch';
    historyDrawer['tab'] = 'image';
    const items = [
      { src: 'A', timestamp: 100, kind: 'image', batchId: 'g1_100' },
      { src: 'B', timestamp: 200, kind: 'image', batchId: 'g1_100' },
      { src: 'C', timestamp: 300, kind: 'image', batchId: 'g2_300' },
      { src: 'D', timestamp: 400, kind: 'image', batchId: undefined }, // 旧行
    ];
    const display = historyDrawer['_buildDisplay'](items);
    check(display.length === 3, '4 条流水 → 2 批次卡 + 1 单图（3 个展示项）');
    const g1 = display.find(d => d.kind === 'batch' && d.batchId === 'g1_100');
    const g2 = display.find(d => d.kind === 'batch' && d.batchId === 'g2_300');
    const single = display.find(d => d.kind === 'single');
    check(!!g1 && g1.items.length === 2, '同 batchId g1 合并为 1 组（2 项）');
    check(!!g2 && g2.items.length === 1, 'batchId g2 独立成组');
    check(!!single && single.item.src === 'D', '无 batchId 旧行按单图回退');
    // 排序：组内最新时间戳倒序 → g2(300) > g1(200) > D(400)? 不对，D 是 400 应最前
    // 修正：display 排序 = 组内最新时间戳倒序 → D(400) → g2(300) → g1(200)
    check(display[0].kind === 'single' && display[0].item.src === 'D', '按组内最新时间倒序：D(400) 最前');
    check(display[1].kind === 'batch' && display[1].batchId === 'g2_300', '其次 g2(300)');
    check(display[2].kind === 'batch' && display[2].batchId === 'g1_100', '最后 g1(200)');

    // time 视图：不分组、保持原渲染路径
    historyDrawer['view'] = 'time';
    const flat = historyDrawer['_buildDisplay'](items);
    check(flat.length === 4 && flat.every(d => d.kind === 'single'), 'time 视图全部 single（4 条平铺）');

    // text tab：即使 view=batch 也不分组
    historyDrawer['view'] = 'batch';
    historyDrawer['tab'] = 'text';
    const textItems = [
      { src: '', timestamp: 1, kind: 'text', text: 'hi' },
      { src: 'X', timestamp: 2, kind: 'image', batchId: 'g9' },
    ];
    const textDisplay = historyDrawer['_buildDisplay'](textItems);
    check(textDisplay.length === 2 && textDisplay.every(d => d.kind === 'single'), 'text tab 下不分组（text 不入批次）');
    historyDrawer['tab'] = 'image';
  });

  // ============ A3 批次卡渲染 + 单图能力（R3） ============
  await section('A3: 批次卡渲染 + 逐图 拖拽/查看大图/复现（openImageModal 参数正确）', async () => {
    reset();
    const grid = makeEl();
    byId.set('history-grid', grid);
    historyDrawer['grid'] = grid;

    // 桩 openImageModal / reproduceFromHistory（CJS 编译后按 exports 对象运行时取值）
    const calls = { modal: [], repro: [] };
    const origOpen = cardView.openImageModal;
    const origRepro = reproduceService.reproduceFromHistory;
    cardView.openImageModal = async (src, origin) => { calls.modal.push({ src, origin }); };
    reproduceService.reproduceFromHistory = async (entry) => { calls.repro.push(entry); };

    const items = [
      { src: 'data:image/png;base64,T1', timestamp: 100, kind: 'image', nodeId: 'g1', prompt: '批次提示词', model: 'openai:key:gpt-image', aspectRatio: '3:4', resolution: '4k', count: 4, originalPath: 'C:/img/1.png', batchId: 'g1_100' },
      { src: 'data:image/png;base64,T2', timestamp: 110, kind: 'image', nodeId: 'g1', prompt: '批次提示词', model: 'openai:key:gpt-image', aspectRatio: '3:4', resolution: '4k', count: 4, originalPath: 'C:/img/2.png', batchId: 'g1_100' },
      { src: 'data:image/png;base64,T3', timestamp: 120, kind: 'image', nodeId: 'g1', prompt: '批次提示词', model: 'openai:key:gpt-image', aspectRatio: '3:4', resolution: '4k', count: 4, originalPath: 'C:/img/3.png', batchId: 'g1_100' },
    ];
    historyDrawer['_renderBatchCard']({ batchId: 'g1_100', items });
    const card = grid.children[grid.children.length - 1];
    check(card && card.className.includes('history-batch'), '批次卡 div 已渲染');
    check(card && card.innerHTML.includes('3/4'), '部分成功计数 3/4 渲染（x=组内行数，y=count）');
    check(card && card.innerHTML.includes('批次提示词'), '批次卡配方摘要含 prompt');
    check(card && card.innerHTML.includes('gpt-image'), '批次卡配方 chips 含模型短名');
    check(card && card.innerHTML.includes('+0') === false, '3 张时不显示 +N');

    // 缩略图事件：每个 thumb 有 dragstart/click/repro
    const thumbs = card.querySelectorAll('.history-batch-thumb');
    check(thumbs.length === 3, '3 张缩略图（≤4）');

    // 拖拽：dragstart 写入 application/history-image + text/plain
    let dragData = {};
    thumbs[0].dispatch('dragstart', {
      dataTransfer: { setData: (k, v) => { dragData[k] = v; } },
    });
    check(dragData['application/history-image'] === 'data:image/png;base64,T1', '拖拽写入 application/history-image = 该图 src');
    check(dragData['text/plain'] === 'data:image/png;base64,T1', '拖拽写入 text/plain 兜底');

    // 点击查看大图：openImageModal(src, {path}) —— 参数正确
    thumbs[1].dispatch('click', { preventDefault() {}, stopPropagation() {} });
    await tick();
    check(calls.modal.length === 1 && calls.modal[0].src === 'data:image/png;base64,T2', '点击缩略图 → openImageModal(src=T2)');
    check(calls.modal[0].origin && calls.modal[0].origin.path === 'C:/img/2.png', 'openImageModal 带原图 path（查看大图按需加载）');

    // 逐张复现：reproduceFromHistory(entry) 参数为该图 trace
    const reproBtn = thumbs[2].children.find(c => c && c.className && c.className.includes && c.className.includes('history-batch-repro'));
    check(!!reproBtn, '每张缩略图附 hover「复现」按钮');
    reproBtn.dispatch('click', { preventDefault() {}, stopPropagation() {} });
    await tick();
    check(calls.repro.length === 1 && calls.repro[0].kind === 'image', '复现 → reproduceFromHistory(kind=image)');
    check(calls.repro[0].prompt === '批次提示词' && calls.repro[0].count === 4, '复现 entry 携带该图完整参数');
    check(calls.repro[0].batchId === 'g1_100', '_toEntry batchId 保真（复现 trace 构造不丢批次）');

    // 无 originalPath → openImageModal origin=null（缩略图直接显示）
    const itemsNoPath = [{ src: 'data:image/png;base64,X1', timestamp: 200, kind: 'image', nodeId: 'g9', count: 1, batchId: 'g9_200' }];
    historyDrawer['_renderBatchCard']({ batchId: 'g9_200', items: itemsNoPath });
    const card2 = grid.children[grid.children.length - 1];
    check(card2 && card2.innerHTML.includes('1/1'), 'count=1 扩图批次卡计数 1/1');
    const thumbs2 = card2.querySelectorAll('.history-batch-thumb');
    thumbs2[0].dispatch('click', { preventDefault() {}, stopPropagation() {} });
    await tick();
    check(calls.modal.length === 2 && calls.modal[1].origin === null, '无 originalPath → openImageModal origin=null（回退缩略图）');

    // +N 角标：5 张批次卡显示 +1
    const five = [];
    for (let i = 0; i < 5; i++) five.push({ src: `data:image/png;base64,F${i}`, timestamp: 300 + i, kind: 'image', nodeId: 'g5', count: 5, batchId: 'g5_300' });
    historyDrawer['_renderBatchCard']({ batchId: 'g5_300', items: five });
    const card3 = grid.children[grid.children.length - 1];
    check(card3 && card3.innerHTML.includes('+1'), '5 张 → 显示 +1 角标（≤4 缩略图 + +N）');
    check(card3 && card3.innerHTML.includes('5/5'), '5 张计数 5/5');

    // 还原桩
    cardView.openImageModal = origOpen;
    reproduceService.reproduceFromHistory = origRepro;
    historyDrawer['grid'] = null;
    byId.delete('history-grid');
  });

  // ============ A4 回归（hashRef / locked / jsonl 单行模型） ============
  await section('A4: 回归 —— adopt 自动置 locked / hashRef 主键零改动 / text 反推不带 batchId', async () => {
    reset();
    // adopt 仍自动置 locked（B2 语义不动）
    assetStore.adoptByUrl(URL_A, 'node-1');
    check(assetStore.isAdoptedByImageUrl(URL_A) === true, '采纳后 adopted=true');
    check(assetStore.isLockedByImageUrl(URL_A) === true, 'adopt 自动置 locked（回归）');

    // hashRef 主键：_keyOf === historyPersist.hashRef（同一图跨项目仍单条记录）
    const key1 = assetStore['_keyOf'](URL_A);
    check(key1 === historyPersist.hashRef(URL_A), '_keyOf 使用 historyPersist.hashRef（主键逻辑未动）');
    assetStore.adoptByUrl(URL_A, 'node-2'); // 模拟另一项目采纳同一图
    const all = assetStore.list();
    check(all.filter(r => r.key === key1).length === 1, '同图跨节点/跨项目仍单条记录（去重主键不变）');

    // 重复采纳（已 adopted）也刷新配方（meta 写在 return 之前）
    assetStore.adoptByUrl(URL_A, 'node-1', { prompt: '第二次配方', count: 2 });
    const recA = assetStore.getByImageUrl(URL_A);
    check(recA && recA.prompt === '第二次配方', '重复采纳刷新配方（写于 adopted return 之前）');
    check(recA && recA.locked === true, '重复采纳不改变 locked');

    // run-engine locked 分支：txt2img 源节点旧图被锁定 → 不写回自身，改建新节点（保护点 2 未动）
    const stub = stubGenerate([
      { url: 'data:image/png;base64,OUT1' },
    ]);
    const gen = mkImageGen({ imageUrl: 'data:image/png;base64,OLDLOCKED' });
    assetStore.adoptByUrl('data:image/png;base64,OLDLOCKED', gen.id); // 锁定旧图
    await runEngine.run(gen.id);
    stub.restore();
    const n = flowState.getNode(gen.id);
    check(n && n.imageUrl === 'data:image/png;base64,OLDLOCKED', '旧图锁定 → 不写回自身（保护点 2 回归）');
    const children = flowState.nodes.filter(x => x.parentId === gen.id && x.id !== gen.id);
    check(children.length === 1 && children[0].imageUrl === 'data:image/png;base64,OUT1', '锁定场景 → 改建新产出节点');
  });

  // ============ R3 写侧：batchId 生成/透传/边界（任务 5/9） ============
  await section('R3写侧: runBatch 生成 batchId 并透传 addImage/appendTrace；text 不入批次；同节点重跑两批不同', async () => {
    reset();
    // img2img count=2：两行历史均带同一 batchId
    const stub = stubGenerate([
      { url: 'data:image/png;base64,OUT1' },
      { url: 'data:image/png;base64,OUT2' },
    ]);
    const gen = mkImageGen({
      params: { prompt: '换背景', model: 'd:m', aspectRatio: '3:4', resolution: '2k', count: 2 },
      imageUrl: 'data:image/png;base64,OLD', refImages: ['data:image/png;base64,REF'],
    });
    await runEngine.run(gen.id);
    stub.restore();
    const items = historyDrawer['items'].filter(i => i.kind === 'image');
    const newItems = items.filter(i => i.src.startsWith('data:image/png;base64,OUT'));
    check(newItems.length === 2, 'img2img count=2 → 2 行历史');
    check(newItems.every(i => typeof i.batchId === 'string' && /^[a-zA-Z0-9-]+_\d+$/.test(i.batchId)), '每行 batchId 格式 ${nodeId}_${startTs}');
    check(newItems[0].batchId === newItems[1].batchId, '同批两行共用同一 batchId');
    const oldItems = items.filter(i => i.src === 'data:image/png;base64,OLD');
    check(oldItems.length === 1 && oldItems[0].batchId === undefined, '旧图 addImage 不带当前 batchId（单图回退）');

    // 同节点重跑两批 → 两个不同 batchId（Date.now 不同）
    const stub2 = stubGenerate([{ url: 'data:image/png;base64,OUT3' }]);
    const gen2 = mkImageGen({
      params: { prompt: '换背景', model: 'd:m', aspectRatio: '3:4', resolution: '2k', count: 1 },
      imageUrl: 'data:image/png;base64,OLD2', refImages: ['data:image/png;base64,REF'],
    });
    await runEngine.run(gen2.id);
    await tick(5);
    await runEngine.run(gen2.id);
    stub2.restore();
    const batchIds = historyDrawer['items'].filter(i => i.kind === 'image' && i.batchId).map(i => i.batchId);
    const unique = new Set(batchIds);
    check(unique.size >= 2, '同节点重跑两批 → 至少 2 个不同 batchId（可区分批次）');

    // text-gen 不入批次：buildTextTrace 行无 batchId
    reset();
    const tb = historyPersist.buildTextTrace({ id: 't1', type: 'text-gen', outputText: '文本结果' });
    check(tb && tb.kind === 'text' && tb.batchId === undefined, 'text trace 无 batchId（text 不入批次）');
  });

  await section('R3写侧b: _toEntry batchId 保真 + loadFromHistory 解析 batchId + 旧行回退', async () => {
    reset();
    // loadFromHistory：新行带 batchId 解析；旧行 → undefined
    const entries = [
      { kind: 'image', nodeId: 'g1', prompt: 'p', model: 'm', aspectRatio: '3:4', resolution: '2k', count: 2, imageUrl: 'data:image/png;base64,H1', thumbnail: 'data:image/png;base64,H1', createdAt: 100, outputType: 'txt2img', batchId: 'g1_100' },
      { kind: 'image', nodeId: 'g2', prompt: 'p2', model: 'm', aspectRatio: '3:4', resolution: '2k', count: 1, imageUrl: 'data:image/png;base64,H2', thumbnail: 'data:image/png;base64,H2', createdAt: 200, outputType: 'txt2img' }, // 旧行无 batchId
    ];
    historyDrawer['loadFromHistory'](entries);
    const loaded = historyDrawer['items'];
    const h1 = loaded.find(i => i.src === 'data:image/png;base64,H1');
    const h2 = loaded.find(i => i.src === 'data:image/png;base64,H2');
    check(h1 && h1.batchId === 'g1_100', 'loadFromHistory 解析 batchId');
    check(h2 && h2.batchId === undefined, '旧 jsonl 行无 batchId → undefined（批次视图按单图回退）');

    // _toEntry batchId 保真
    const e1 = historyDrawer['_toEntry'](h1);
    check(e1.batchId === 'g1_100', '_toEntry 保真 batchId');
    const e2 = historyDrawer['_toEntry'](h2);
    check(e2.batchId === undefined, '无 batchId 行 _toEntry 不带字段（兼容）');
  });

  // ============ 边界：部分失败计数（任务 9） ============
  await section('R3边界: 部分失败（count=4 成功 3）→ 批次卡计数 3/4', async () => {
    reset();
    const stub = stubGenerate([
      { url: 'data:image/png;base64,P1' },
      { url: 'data:image/png;base64,P2' },
      { url: 'data:image/png;base64,P3' },
      { fail: true, error: 'boom' },
    ]);
    const gen = mkImageGen({
      params: { prompt: 'x', model: 'd:m', aspectRatio: '3:4', resolution: '2k', count: 4 },
      imageUrl: 'data:image/png;base64,OLD', refImages: ['data:image/png;base64,REF'],
    });
    await runEngine.run(gen.id);
    stub.restore();
    const n = flowState.getNode(gen.id);
    check(n && n.status === 'done', '部分失败 → 节点 done（非 fail）');
    const batchItems = historyDrawer['items'].filter(i => i.kind === 'image' && i.batchId);
    check(batchItems.length === 3, '成功 3 行入历史（失败行不入）');
    check(batchItems.every(i => i.count === 4), '每行 count=4（总张数）');
    // 批次卡渲染：3/4
    const grid = makeEl();
    byId.set('history-grid', grid);
    historyDrawer['grid'] = grid;
    historyDrawer['_renderBatchCard']({ batchId: batchItems[0].batchId, items: batchItems });
    const card = grid.children[grid.children.length - 1];
    check(card && card.innerHTML.includes('3/4'), '批次卡计数 3/4（部分失败可读）');
    historyDrawer['grid'] = null;
    byId.delete('history-grid');
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
