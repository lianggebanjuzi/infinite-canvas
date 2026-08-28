// .qa-verify/qa-capsule-closeguard.cjs
// QA 独立验证（fresh eyes）：改动1（侧边栏胶囊调）+ 改动2（关闭未响应修复）前端侧。
// 运行：先 npx tsc -p tsconfig.smoke.json --outDir .icv-smoke 再 node .qa-verify/qa-capsule-closeguard.cjs
// 覆盖：
//   C1 胶囊调结构：index.html 两图标（SVG stroke=currentColor、无 emoji）；CSS 与 bottom-bar 同变量体系；
//      把手关闭隐藏(pointer-events:none)/展开可见
//   C2 胶囊交互：点 #capsule-history → historyDrawer.toggle；点 #capsule-assets → assetDrawer.toggle；
//      active 类随抽屉 open/close 变化；两抽屉互斥；MutationObserver 覆盖所有开合路径（含生成图自动打开）
//   C3 抽屉功能未回归（关键路径）：历史图库搜索/复现/拖入/分区 tab；资产库取消采纳/锁定/查看/复现/搜索
//   C4 close-guard：init() 订阅 flowState → dirty 变化上报（仅变化时）；syncNow 强制重报；无 pywebview 不崩；
//      __icvIsDirty/__icvRequestClose 钩子；requestClose 三选一（保存并关闭/不保存/取消）
//   C5 渲染分批：12 一批、renderSeq 防重复、rIC/setTimeout 兜底、分批不丢项（历史 + 资产库）

'use strict';

const BASE = 'G:/Infinite Canvas/Infinite Canvas 2.0/.icv-smoke/v1';
const ROOT = 'G:/Infinite Canvas/Infinite Canvas 2.0';
const fs = require('fs');
const path = require('path');

// ───────────────────────── DOM 桩（工作版 classList + 事件监听 + children 跟踪） ─────────────────────────
function makeClassList(initial = []) {
  const set = new Set(initial);
  return {
    add: (...cs) => cs.forEach(c => set.add(c)),
    remove: (...cs) => cs.forEach(c => set.delete(c)),
    toggle: (c, force) => {
      const on = force === undefined ? !set.has(c) : !!force;
      if (on) set.add(c); else set.delete(c);
      return on;
    },
    contains: (c) => set.has(c),
    _set: set,
  };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function makeEl(over = {}) {
  const listeners = {};
  const children = [];
  const el = {
    classList: makeClassList(),
    style: {}, dataset: {}, value: '', disabled: false, title: '', checked: false,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter(f => f !== fn); },
    dispatch(type, ev) { (listeners[type] || []).forEach(fn => { try { fn(ev || {}); } catch (e) { /* 单监听异常不中断 */ } }); },
    appendChild(child) { children.push(child); return child; },
    remove() {}, setAttribute() {}, removeAttribute() {}, focus() {}, select() {}, click() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; },
    ...over,
  };
  let _text = ''; let _html = '';
  Object.defineProperty(el, 'children', { get() { return children; }, configurable: true });
  Object.defineProperty(el, 'childElementCount', { get() { return children.length; }, configurable: true });
  Object.defineProperty(el, 'textContent', {
    get() { return _text; },
    set(v) { _text = String(v); _html = escapeHtml(String(v)); },
    configurable: true,
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return _html; },
    set(v) { _html = String(v); children.length = 0; },
    configurable: true,
  });
  return el;
}

// 记录式 MutationObserver（真实浏览器由 class 变更自动触发；测试中手动 trigger 模拟，并校验 observe 参数）
const fakeObserverInstances = [];
class FakeMutationObserver {
  constructor(cb) { this.cb = cb; this.targets = []; fakeObserverInstances.push(this); }
  observe(target, opts) { this.targets.push({ target, opts }); }
  disconnect() {}
  trigger() { this.cb(); }
}
global.MutationObserver = FakeMutationObserver;

// ───────────────────────── DOM 元素准备 ─────────────────────────
const capsuleHistoryBtn = makeEl();
const capsuleAssetBtn = makeEl();
const leftDrawerEl = makeEl();
const assetDrawerEl = makeEl();
const historyGrid = makeEl();
const assetGrid = makeEl();
const historyEmpty = makeEl();
const assetEmpty = makeEl();
const historySearch = makeEl();
const assetSearch = makeEl();
const assetCount = makeEl();
const tabImage = makeEl({ dataset: { tab: 'image' } });
const tabText = makeEl({ dataset: { tab: 'text' } });
const tabsEl = makeEl({ querySelectorAll: () => [tabImage, tabText] });
const toastEl = makeEl();

const byId = new Map([
  ['left-capsule', makeEl()],
  ['capsule-history', capsuleHistoryBtn],
  ['capsule-assets', capsuleAssetBtn],
  ['left-drawer', leftDrawerEl],
  ['asset-drawer', assetDrawerEl],
  ['history-grid', historyGrid],
  ['asset-grid', assetGrid],
  ['history-empty', historyEmpty],
  ['asset-empty', assetEmpty],
  ['history-search', historySearch],
  ['asset-search', assetSearch],
  ['asset-count', assetCount],
  ['history-tabs', tabsEl],
  ['toast', toastEl],
  ['drawer-handle', makeEl()],
  ['asset-handle', makeEl()],
]);

global.window = {
  addEventListener() {}, removeEventListener() {}, close() { window.__closed = true; },
  setTimeout, clearTimeout, setInterval() { return 1; }, clearInterval() {},
  innerWidth: 1280, innerHeight: 800,
  pywebview: { api: {} },
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

// ───────────────────────── 加载被测模块 ─────────────────────────
const { flowState } = require(`${BASE}/state/flow-state.js`);
const { assetStore } = require(`${BASE}/asset-store.js`);
const { historyDrawer } = require(`${BASE}/ui/history-drawer.js`);
const { assetDrawer } = require(`${BASE}/ui/asset-drawer.js`);
const { leftCapsule } = require(`${BASE}/ui/left-capsule.js`);
const { closeGuard } = require(`${BASE}/close-guard.js`);
const confirmMod = require(`${BASE}/ui/confirm.js`);
const { saveCoordinator } = require(`${BASE}/save-coordinator.js`);
const { reproduceService } = require(`${BASE}/reproduce.js`);
const cardView = require(`${BASE}/canvas/card-view.js`);

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

function resetFlow() {
  flowState.replaceAll({
    format: 'icv', version: '3.4', projectName: 't', canvas: { scale: 1, panX: 0, panY: 0 },
    nodes: [], edges: [], createdAt: 0, updatedAt: 0,
  });
  historyGrid.innerHTML = '';
  assetGrid.innerHTML = '';
  historyEmpty.style.display = 'none';
  assetEmpty.style.display = 'none';
  historySearch.value = '';
  assetSearch.value = '';
  leftDrawerEl.classList.remove('open');
  assetDrawerEl.classList.remove('open');
  capsuleHistoryBtn.classList.remove('active');
  capsuleAssetBtn.classList.remove('active');
}

function resetDrawers() {
  historyDrawer['items'] = [];
  historyDrawer['query'] = '';
  historyDrawer['tab'] = 'image';
  historyDrawer['open'] = false;
  historyDrawer['renderSeq'] = 0;
  assetDrawer['query'] = '';
  assetDrawer['open'] = false;
  assetDrawer['renderSeq'] = 0;
  assetStore['records'].clear();
  assetStore['urlByKey'].clear();
  assetStore['metaByKey'].clear();
}

async function main() {
  // ═══════════════ C1 静态审查：结构 + CSS ═══════════════
  await section('C1: 胶囊调静态结构 + CSS 契约', () => {
    const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf-8');
    const m = html.match(/<div class="left-capsule" id="left-capsule">([\s\S]*?)<\/div>\s*<!--\s*画布/);
    check(!!m, 'index.html 含 #left-capsule 块');
    const block = m ? m[1] : '';
    check(block.includes('id="capsule-history"') && block.includes('id="capsule-assets"'),
      '胶囊含 #capsule-history 与 #capsule-assets 两个入口');
    const btnCount = (block.match(/<button/g) || []).length;
    check(btnCount === 2, `恰好 2 个按钮（实际 ${btnCount}）`);
    const svgCount = (block.match(/<svg/g) || []).length;
    check(svgCount === 2, `恰好 2 个 SVG 图标（实际 ${svgCount}）`);
    // SVG 描边：stroke=currentColor + fill=none
    const strokes = (block.match(/stroke="currentColor"/g) || []).length;
    check(strokes === 2, `2 个图标均 stroke="currentColor"（实际 ${strokes}）`);
    check((block.match(/fill="none"/g) || []).length === 2, '2 个图标均 fill="none"（描边风）');
    // 无 emoji（title 中文提示属正常，但图标内容不得含 emoji/文本节点）
    const emojiRe = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}\u{2B05}-\u{2B07}]/u;
    check(!emojiRe.test(block), '胶囊块无 emoji（纯 SVG）');
    const btnBodies = (block.match(/<button[\s\S]*?<\/button>/g) || []);
    const hasVisibleText = btnBodies.some(b => {
      const inner = b.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').trim();
      return inner.length > 0;
    });
    check(!hasVisibleText, '按钮无可见文本节点（纯图标）');

    // CSS：与 .bottom-bar 同变量体系（--bg-float/--border/--shadow-bar/--accent）
    const css = fs.readFileSync(path.join(ROOT, 'src', 'v1', 'styles', 'app.css'), 'utf-8');
    const capsuleCss = css.match(/\.left-capsule \{[\s\S]*?\}/);
    check(!!capsuleCss, 'app.css 含 .left-capsule 样式');
    if (capsuleCss) {
      const s = capsuleCss[0];
      check(s.includes('var(--bg-float)'), '.left-capsule 使用 --bg-float');
      check(s.includes('var(--border)'), '.left-capsule 使用 --border');
      check(s.includes('var(--shadow-bar)'), '.left-capsule 使用 --shadow-bar');
      check(s.includes('border-radius:999px'), '.left-capsule 胶囊圆角 999px');
    }
    const btnCss = css.match(/\.left-capsule \.capsule-btn\.active \{[\s\S]*?\}/);
    check(!!btnCss && btnCss[0].includes('var(--accent)') && btnCss[0].includes('var(--accent-dim)'),
      '.capsule-btn.active 使用 --accent/--accent-dim');

    // 把手：关闭隐藏（pointer-events:none, opacity:0）→ 展开可见（pointer-events:auto, opacity:1）
    const handleClosed = css.match(/\.left-drawer \.drawer-handle \{[\s\S]*?\}/);
    const handleOpen = css.match(/\.left-drawer\.open \.drawer-handle \{[\s\S]*?\}/);
    check(!!handleClosed && handleClosed[0].includes('pointer-events:none') && handleClosed[0].includes('opacity:0'),
      '把手关闭态 pointer-events:none + opacity:0');
    check(!!handleOpen && handleOpen[0].includes('pointer-events:auto') && handleOpen[0].includes('opacity:1'),
      '把手展开态 pointer-events:auto + opacity:1');
  });

  // ═══════════════ C2 胶囊交互 ═══════════════
  await section('C2: 胶囊点击 toggle + active 同步 + 互斥', async () => {
    resetFlow(); resetDrawers();
    fakeObserverInstances.length = 0;
    historyDrawer.setMutex(() => assetDrawer.close());
    assetDrawer.setMutex(() => historyDrawer.close());
    historyDrawer.init();
    assetDrawer.init();
    leftCapsule.init(); // 仅一次 init（重复 init 会重复绑 click → 双 toggle 抵消，属测试陷阱）
    const obs = fakeObserverInstances[fakeObserverInstances.length - 1];
    check(!!obs, 'MutationObserver 已创建');
    check(obs.targets.length === 2, `observer 观察 2 个抽屉（实际 ${obs.targets.length}）`);
    const histTarget = obs.targets.find(t => t.target === leftDrawerEl);
    const assetTarget = obs.targets.find(t => t.target === assetDrawerEl);
    check(!!histTarget && histTarget.opts.attributes === true && JSON.stringify(histTarget.opts.attributeFilter) === '["class"]',
      'observer 监听 #left-drawer 的 class 属性变更');
    check(!!assetTarget && assetTarget.opts.attributes === true && JSON.stringify(assetTarget.opts.attributeFilter) === '["class"]',
      'observer 监听 #asset-drawer 的 class 属性变更');
    check(!capsuleHistoryBtn.classList.contains('active') && !capsuleAssetBtn.classList.contains('active'),
      '初始两图标均非 active');

    // 点 #capsule-history → 开历史抽屉 + active
    capsuleHistoryBtn.dispatch('click');
    obs.trigger();
    check(leftDrawerEl.classList.contains('open'), '点 #capsule-history → #left-drawer.open');
    check(capsuleHistoryBtn.classList.contains('active'), '历史图标 active');
    check(!capsuleAssetBtn.classList.contains('active'), '资产图标非 active');

    // 再点 #capsule-history → 收起
    capsuleHistoryBtn.dispatch('click');
    obs.trigger();
    check(!leftDrawerEl.classList.contains('open'), '再点 #capsule-history → 收起');
    check(!capsuleHistoryBtn.classList.contains('active'), '历史图标 active 移除');

    // 点 #capsule-assets → 开资产抽屉 + active
    capsuleAssetBtn.dispatch('click');
    obs.trigger();
    check(assetDrawerEl.classList.contains('open'), '点 #capsule-assets → #asset-drawer.open');
    check(capsuleAssetBtn.classList.contains('active'), '资产图标 active');
    check(!leftDrawerEl.classList.contains('open'), '历史抽屉保持关闭');

    // 互斥：开历史后点资产 → 资产开、历史自动关
    capsuleHistoryBtn.dispatch('click');
    obs.trigger();
    check(leftDrawerEl.classList.contains('open'), '前置：历史抽屉已开');
    capsuleAssetBtn.dispatch('click');
    obs.trigger();
    check(assetDrawerEl.classList.contains('open'), '互斥：资产抽屉开');
    check(!leftDrawerEl.classList.contains('open'), '互斥：历史抽屉自动关');
    check(capsuleAssetBtn.classList.contains('active') && !capsuleHistoryBtn.classList.contains('active'),
      '互斥后 active 只落在资产图标');

    // 互斥反向：资产开时点历史
    capsuleHistoryBtn.dispatch('click');
    obs.trigger();
    check(leftDrawerEl.classList.contains('open') && !assetDrawerEl.classList.contains('open'),
      '反向互斥：历史开、资产自动关');
    check(capsuleHistoryBtn.classList.contains('active') && !capsuleAssetBtn.classList.contains('active'),
      '反向互斥后 active 只落在历史图标');

    // 其它开合路径（非胶囊点击）：openDrawer / close（mutex）/ 生成图自动打开
    assetDrawer.openDrawer(true);
    obs.trigger();
    check(capsuleAssetBtn.classList.contains('active'), 'openDrawer(true)（非点击路径）→ 资产 active 同步');
    historyDrawer.close(); // 经 mutex
    obs.trigger();
    check(!leftDrawerEl.classList.contains('open') && !capsuleHistoryBtn.classList.contains('active'),
      'close() 路径 → 历史图标 active 移除');
    historyDrawer.addImage('data:image/png;base64,AUTO', { prompt: '自动打开' });
    obs.trigger();
    check(leftDrawerEl.classList.contains('open') && capsuleHistoryBtn.classList.contains('active'),
      'addImage 自动打开路径 → 历史抽屉开 + active 同步');
  });

  // ═══════════════ C3 抽屉功能未回归（关键路径） ═══════════════
  await section('C3: 历史图库 / 资产库关键路径未回归', async () => {
    resetFlow(); resetDrawers();
    historyDrawer.setMutex(() => assetDrawer.close());
    assetDrawer.setMutex(() => historyDrawer.close());
    historyDrawer.init();
    assetDrawer.init();
    // ── 历史图库：分区 tab + 搜索 + 复现 + 拖入 ──
    historyDrawer.addImage('data:image/png;base64,H1', { prompt: '绣球花束 白色', model: 'p:seedream', nodeId: 'n1', timestamp: 1000 });
    historyDrawer.addImage('data:image/png;base64,H2', { prompt: '玫瑰 红色', model: 'q:nano-banana', nodeId: 'n2', timestamp: 2000 });
    historyDrawer['items'].push({ src: '', timestamp: 3000, kind: 'text', text: '淡奶油色陶盆' });

    check(historyDrawer['tab'] === 'image', '默认 tab=image（成图）');
    let filtered = historyDrawer['_filtered']();
    check(filtered.length === 2 && filtered.every(i => i.kind === 'image'), '成图 tab 仅显示成图');
    historyDrawer.setTab('text');
    check(historyDrawer['tab'] === 'text', '切到文本 tab');
    filtered = historyDrawer['_filtered']();
    check(filtered.length === 1 && filtered[0].text.includes('陶盆'), '文本 tab 显示文本记录');
    historyDrawer.setTab('image');
    historyDrawer.setQuery('');
    historyDrawer.setQuery('绣球');
    filtered = historyDrawer['_filtered']();
    check(filtered.length === 1 && filtered[0].prompt.includes('绣球'), '按 prompt 搜索过滤');
    historyDrawer.setQuery('banana');
    filtered = historyDrawer['_filtered']();
    check(filtered.length === 1 && filtered[0].model === 'q:nano-banana', '按 model 搜索过滤');
    historyDrawer.setQuery('不存在词');
    filtered = historyDrawer['_filtered']();
    check(filtered.length === 0, '无匹配 → 空列表（无匹配成图文案）');
    historyDrawer.setQuery('');

    // 复现（图库卡片 hover 复现 → reproduceFromHistory）
    const entry = historyDrawer.getEntryByImageUrl('data:image/png;base64,H1');
    check(!!entry && entry.prompt === '绣球花束 白色' && entry.kind === 'image', 'getEntryByImageUrl 反查 HistoryEntry');
    historyDrawer['render']();
    await tick(80);
    check(historyGrid.children.length === 2 && historyGrid.children[0].innerHTML.includes('复现'),
      `成图卡渲染 2 张且含 复现 动作（实际 ${historyGrid.children.length}）`);
    // 拖入手势（dragstart 写入 dataTransfer）
    const item = historyDrawer['items'].find(i => i.src === 'data:image/png;base64,H1');
    let dragData = null;
    const cardDiv = historyGrid.children.find(c => (c.style.backgroundImage || '').includes('H1'));
    check(!!cardDiv, '成图卡存在（含 H1 背景图）');
    if (cardDiv) {
      const fakeDT = { _d: {}, setData(k, v) { this._d[k] = v; }, getData(k) { return this._d[k]; } };
      cardDiv.dispatch('dragstart', { dataTransfer: fakeDT });
      dragData = fakeDT._d;
      check(dragData['application/history-image'] === 'data:image/png;base64,H1' && dragData['text/plain'] === 'data:image/png;base64,H1',
        '拖入手势写入 application/history-image + text/plain');
    }
    check(!!item, '历史项存在');

    // ── 资产库：取消采纳 / 锁定 / 查看 / 复现 / 搜索 ──
    assetStore.adoptByUrl('data:image/png;base64,A1', 'na1', { prompt: '资产一', model: 'm1', createdAt: 100 });
    assetStore.adoptByUrl('data:image/png;base64,A2', 'na2', { prompt: '资产二', model: 'm2', createdAt: 200 });
    const adopted = assetStore.getAdoptedAssets();
    check(adopted.length === 2, `资产库数据源 2 条（实际 ${adopted.length}）`);
    assetDrawer['render']();
    await tick(80);
    check(assetGrid.children.length === 2
      && assetGrid.children[0].innerHTML.includes('取消采纳')
      && assetGrid.children[0].innerHTML.includes('查看')
      && assetGrid.children[0].innerHTML.includes('复现'),
      `资产卡渲染 2 张且含 取消采纳/查看/复现 动作（实际 ${assetGrid.children.length}）`);
    // 搜索（S8）— assetDrawer 无 setQuery，走内部 query 字段（与输入监听器同路径）
    assetDrawer['query'] = '资产一';
    let afiltered = assetDrawer['_filtered'](assetStore.getAdoptedAssets());
    check(afiltered.length === 1 && afiltered[0].record.key === assetStore['_keyOf']('data:image/png;base64,A1'),
      '资产按 prompt 搜索过滤');
    assetDrawer['query'] = '不存在资产词';
    afiltered = assetDrawer['_filtered'](assetStore.getAdoptedAssets());
    check(afiltered.length === 0, '资产无匹配 → 空（无匹配资产文案）');
    assetDrawer['query'] = '';
    // 取消采纳 / 锁定（写路径）
    const rec1 = assetStore.getByImageUrl('data:image/png;base64,A1');
    assetStore.unadopt(rec1.key);
    check(assetStore.isAdoptedByImageUrl('data:image/png;base64,A1') === false, '取消采纳 → adopted=false');
    assetStore.setLocked(rec1.key, 'na1', true, 'data:image/png;base64,A1');
    check(assetStore.isLockedByImageUrl('data:image/png;base64,A1') === true, '单独锁定（未采纳）生效');
    // 查看（_viewImage → openImageModal）
    const viewed = [];
    const origOpen = cardView.openImageModal;
    cardView.openImageModal = (url) => viewed.push(url);
    assetDrawer['_viewImage']('data:image/png;base64,A2');
    check(viewed.length === 1 && viewed[0] === 'data:image/png;base64,A2', '查看 → openImageModal 被调用');
    cardView.openImageModal = origOpen;
    // 复现（meta 内存缓存优先）
    const entry2 = assetDrawer['_toEntry']({
      record: assetStore.getByImageUrl('data:image/png;base64,A2'),
      url: 'data:image/png;base64,A2',
      meta: { prompt: '资产二', model: 'm2', createdAt: 200 },
    });
    check(entry2.prompt === '资产二' && entry2.imageUrl === 'data:image/png;base64,A2', '资产复现 entry 构造（meta 优先）');
  });

  // ═══════════════ C4 close-guard 前端 ═══════════════
  await section('C4: close-guard dirty 上报 + 三选一 + 无 pywebview 兜底', async () => {
    resetFlow();
    // 模块级 lastReportedDirty 首次为 null → init 必上报一次（C4 在本文件首次 init closeGuard）
    closeGuard['unsubscribeDirty'] = null;
    const apiCalls = [];
    window.pywebview = { api: { win_set_dirty: (d) => { apiCalls.push(d); return true; }, win_close: () => { window.__winClose = true; } } };
    closeGuard.init();
    check(apiCalls.length === 1 && apiCalls[0] === false, `init() 初始上报一次 dirty=false（实际 ${JSON.stringify(apiCalls)}）`);
    flowState.dirty = true; flowState.notify();
    check(apiCalls.length === 2 && apiCalls[1] === true, 'dirty true 变化 → 上报 true');
    flowState.dirty = true; flowState.notify();
    check(apiCalls.length === 2, 'dirty 值未变（true→true）→ 不重复上报');
    flowState.dirty = false; flowState.notify();
    check(apiCalls.length === 3 && apiCalls[2] === false, 'dirty 变回 false → 上报 false');
    closeGuard.syncNow();
    check(apiCalls.length === 4 && apiCalls[3] === false, 'syncNow() 强制重报一次（即使值未变）');

    // 无 pywebview（typeof 守卫）不崩
    window.pywebview = undefined;
    flowState.dirty = true; flowState.notify();
    check(true, '无 pywebview 环境 notify 不抛异常');
    check(typeof window.__icvIsDirty === 'function' && window.__icvIsDirty() === true, '__icvIsDirty 钩子返回真实 dirty');
    check(typeof window.__icvRequestClose === 'function', '__icvRequestClose 钩子存在');

    // 恢复 pywebview，验证 requestClose 三选一
    window.pywebview = { api: { win_set_dirty: () => true, win_close: () => { window.__winClose = true; } } };
    flowState.dirty = false; flowState.notify();
    window.__winClose = false;
    await closeGuard.requestClose();
    check(window.__winClose === true, 'dirty=false → requestClose 直接 win_close');

    flowState.dirty = true; flowState.notify();
    confirmMod.threeWayDialog = async () => 'discard';
    window.__winClose = false;
    await closeGuard.requestClose();
    check(window.__winClose === true, '三选一「不保存」→ win_close');

    confirmMod.threeWayDialog = async () => 'cancel';
    window.__winClose = false;
    await closeGuard.requestClose();
    check(window.__winClose === false, '三选一「取消」→ 不关闭');

    const origSave = saveCoordinator.saveForClose;
    saveCoordinator.saveForClose = async () => false;
    confirmMod.threeWayDialog = async () => 'save';
    window.__winClose = false;
    await closeGuard.requestClose();
    check(window.__winClose === false, '「保存并关闭」保存失败 → 不关闭（R3.2）');
    saveCoordinator.saveForClose = async () => true;
    window.__winClose = false;
    await closeGuard.requestClose();
    check(window.__winClose === true, '「保存并关闭」保存成功 → win_close');
    saveCoordinator.saveForClose = origSave;
    confirmMod.threeWayDialog = async () => 'cancel'; // 兜底还原
    flowState.dirty = false; flowState.notify();
  });

  // ═══════════════ C5 渲染分批 ═══════════════
  await section('C5: 渲染分批（12/批、renderSeq 防重复、rIC/setTimeout 兜底、不丢项）', async () => {
    resetFlow(); resetDrawers();
    historyDrawer.setMutex(() => assetDrawer.close());
    assetDrawer.setMutex(() => historyDrawer.close());
    historyDrawer.init();
    assetDrawer.init();
    // ── 历史图库：30 条 → 首批同步 12，随后分批补全至 30（不丢项）──
    historyDrawer['items'] = Array.from({ length: 30 }, (_, i) => ({
      src: `data:image/png;base64,ITEM${i}`, timestamp: i, kind: 'image', prompt: `p${i}`, model: 'm',
    }));
    historyDrawer['render']();
    check(historyGrid.children.length === 12, `首批同步插入 12（实际 ${historyGrid.children.length}）`);
    await tick(200);
    check(historyGrid.children.length === 30, `30 条分批渲染全部插入（实际 ${historyGrid.children.length}）`);

    // ── renderSeq 防重复：渲染 30 途中发起新渲染(3条) → 旧批次作废，最终恰好 3 条 ──
    historyDrawer['items'] = Array.from({ length: 30 }, (_, i) => ({
      src: `data:image/png;base64,R${i}`, timestamp: i, kind: 'image', prompt: `r${i}`, model: 'm',
    }));
    historyDrawer['render']();
    await tick(20); // 部分批次已插入
    historyDrawer['items'] = Array.from({ length: 3 }, (_, i) => ({
      src: `data:image/png;base64,NEW${i}`, timestamp: i, kind: 'image', prompt: `n${i}`, model: 'm',
    }));
    historyDrawer['render'](); // 新渲染 renderSeq++ → 旧批次作废
    await tick(200);
    check(historyGrid.children.length === 3, `renderSeq 防重复：中途重渲染后恰好 3 条（实际 ${historyGrid.children.length}）`);

    // ── 空态路径也作废在途批次 ──
    historyDrawer['items'] = Array.from({ length: 30 }, (_, i) => ({
      src: `data:image/png;base64,E${i}`, timestamp: i, kind: 'image', prompt: `e${i}`, model: 'm',
    }));
    historyDrawer['render']();
    await tick(20);
    historyDrawer['items'] = [];
    historyDrawer['render'](); // 空 → renderSeq++ + 清空
    await tick(200);
    check(historyGrid.children.length === 0 && historyEmpty.style.display === 'block',
      '空态渲染清空在途批次并显示空态');

    // ── requestIdleCallback 兜底分支 ──
    const origRic = global.requestIdleCallback;
    global.requestIdleCallback = (fn, opts) => { setTimeout(() => fn({ didTimeout: false, timeRemaining: () => 50 }), 0); };
    historyDrawer['items'] = Array.from({ length: 25 }, (_, i) => ({
      src: `data:image/png;base64,IC${i}`, timestamp: i, kind: 'image', prompt: `ic${i}`, model: 'm',
    }));
    historyDrawer['render']();
    await tick(250);
    check(historyGrid.children.length === 25, `requestIdleCallback 分支 25 条完整渲染（实际 ${historyGrid.children.length}）`);
    if (origRic === undefined) delete global.requestIdleCallback; else global.requestIdleCallback = origRic;

    // ── 资产库：25 条已采纳 → 分批渲染完整 ──
    for (let i = 0; i < 25; i++) {
      assetStore.adoptByUrl(`data:image/png;base64,AS${i}`, `nas${i}`, { prompt: `资产${i}`, model: 'm', createdAt: i });
    }
    await tick(250);
    check(assetGrid.children.length === 25, `资产库 25 条分批渲染全部插入（实际 ${assetGrid.children.length}）`);
  });

  console.log(`\n══════════════════════════════════`);
  console.log(`QA 胶囊调 + 关闭修复：通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) {
    console.error('失败明细：');
    failures.forEach(f => console.error(`- ${f}`));
    process.exit(1);
  }
  console.log('QA-CAPSULE-CLOSEGUARD PASS');
}

main().catch(e => { console.error(e); process.exit(1); });
