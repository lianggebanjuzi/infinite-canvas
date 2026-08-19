// smoke/qa-round2-ui.cjs
// QA 独立回归（第二轮纯前端 UI 调整）
//
// 验证点（对应 QA 清单）：
//   R1 imageModalInfoFromNode：trace 优先 / params 兜底 / 双无 → 空字段 / Auto 透传
//   R2 renderModalInfo（经 openImageModal）：模型短名 / 时间 YYYY-MM-DD HH:mm / 比例 Auto→— /
//      分辨率真实像素优先 + 原图加载后 naturalWidth 权威覆盖 / 提示词+复制按钮 / 旧数据缺字段 → '—' 不报错
//   R3 关闭路径：× / 背景(modal) / 大图区(stage) 生效；信息栏(panel)点击不关闭
//   R4 单图卡：.ht-img 完整显示（无 .ht-size）；.ht-actions-static 常驻；复制按钮按 prompt 条件渲染；
//      点击图看大图带 info；拖拽 dataTransfer 语义保留
//   R5 批次卡：无 chips/recipe；头部复制按钮（prompt 空不渲染）；缩略图 contain 类名；+N 角标；
//      逐图看大图（handler 同单图模式，代码审查 + 类型检查双重保障）
//   R6 _buildDisplay：batch 分组 / 无 batchId 单图回退 / time 视图全 single
//
// 运行：
//   node node_modules/typescript/bin/tsc -p tsconfig.smoke.json --outDir .icv-qa
//   node smoke/qa-round2-ui.cjs

'use strict';

const BASE = 'D:/Infinite Canvas/Infinite Canvas 2.0/.icv-qa/v1';

// ───────────────────────── DOM/浏览器桩（增强：querySelector/closest/children） ─────────────────────────
function makeEl(over = {}) {
  const children = [];
  const el = {
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, f) { if (f === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else { f ? this._s.add(c) : this._s.delete(c); } },
      contains(c) { return this._s.has(c); },
    },
    style: {}, dataset: {}, value: '', disabled: false, title: '', checked: false,
    children,
    _handlers: {},
    _qs: Object.create(null),
    _closest: Object.create(null),
    addEventListener(t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); },
    removeEventListener(t, fn) { const arr = this._handlers[t] || []; const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); },
    dispatch(t, ev) { (this._handlers[t] || []).slice().forEach(fn => fn(ev || { target: this, stopPropagation() {}, preventDefault() {}, dataTransfer: null })); },
    appendChild(c) { children.push(c); c.parentNode = this; return c; },
    remove() {}, setAttribute() {}, removeAttribute() {}, focus() {}, select() {}, click() {},
    querySelector(sel) {
      if (this._qs[sel] !== undefined) return this._qs[sel];
      for (const c of children) {
        if (c.__sel && c.__sel === sel) return c;
        if (c.querySelector) { const r = c.querySelector(sel); if (r) return r; }
      }
      return null;
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (node) => {
        for (const c of node.children) {
          if (c.__sel && c.__sel === sel) out.push(c);
          if (c.children && c.children.length) walk(c);
        }
      };
      walk(this);
      return out;
    },
    closest(sel) {
      if (this._closest[sel]) return this._closest[sel];
      const target = String(sel).replace(/^\./, ''); // 与 __sel（无点前缀）对齐
      let p = this;
      while (p) { if (p.__sel && p.__sel === target) return p; p = p.parentNode; }
      return null;
    },
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

const byId = new Map();
const toastEl = makeEl();
byId.set('toast', toastEl);
// 大图浮层桩
const modal = makeEl();
const stage = makeEl(); stage.__sel = 'img-modal-stage';
const panel = makeEl(); panel.__sel = 'img-modal-panel';
modal.appendChild(stage);
modal.appendChild(panel);
const modalImg = makeEl({ naturalWidth: 1536, naturalHeight: 2048 });
let _src = '';
Object.defineProperty(modalImg, 'src', {
  get() { return _src; },
  set(v) { _src = String(v); if (typeof modalImg.onload === 'function') modalImg.onload(); },
  configurable: true,
});
const loading = makeEl();
const closeBtn = makeEl();
const fields = makeEl();
const resValue = makeEl();
fields._qs['[data-field="resolution"]'] = resValue;
fields._qs['.img-modal-copy'] = makeEl();
byId.set('img-modal', modal);
byId.set('img-modal-img', modalImg);
byId.set('img-modal-loading', loading);
byId.set('img-modal-close', closeBtn);
byId.set('img-modal-fields', fields);

global.pywebview = { api: {} };
global.window = {
  addEventListener() {}, removeEventListener() {}, close() {},
  setTimeout, clearTimeout, setInterval() { return 1; }, clearInterval() {},
  innerWidth: 1280, innerHeight: 800, pywebview: global.pywebview,
};
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
global.requestIdleCallback = (fn) => setTimeout(() => fn(), 0);

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

// ───────────────────────── 加载被测模块 ─────────────────────────
const { imageModalInfoFromNode, openImageModal } = require(`${BASE}/canvas/card-view.js`);
const apiMod = require(`${BASE}/api.js`);
const { historyDrawer } = require(`${BASE}/ui/history-drawer.js`);

// 桩：toast / loadLocalImage 捕获
const toastCalls = [];
const origToast = require(`${BASE}/ui/toast.js`).showToast;
require(`${BASE}/ui/toast.js`).showToast = (msg, ok) => { toastCalls.push({ msg, ok }); };

function fmtLocal(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function resetModalState() {
  modal.classList.remove('show');
  fields.innerHTML = '';
  resValue.textContent = '';
  loading.style.display = '';
  toastCalls.length = 0;
}

const TS = 1722499200000; // 任意固定毫秒时间戳

// ───────────────────────── 用例 ─────────────────────────
async function main() {
  // ============ R1 imageModalInfoFromNode ============
  await section('R1: imageModalInfoFromNode（trace 优先 / params 兜底 / 双无空字段 / Auto 透传）', async () => {
    const nodeFull = {
      params: { model: 'bltcy:1:flux-schnell', aspectRatio: '3:4', resolution: '2k', prompt: 'PARAMS' },
      trace: { model: 'k:2:gemini', aspectRatio: '1:1', resolution: '4k', prompt: 'TRACE', createdAt: TS },
    };
    const info = imageModalInfoFromNode(nodeFull);
    check(info.model === 'k:2:gemini' && info.aspectRatio === '1:1' && info.resolution === '4k' && info.prompt === 'TRACE' && info.createdAt === TS, 'trace 全字段优先于 params');

    const nodeTracePartial = {
      params: { model: 'bltcy:1:flux-schnell', aspectRatio: '3:4', resolution: '2k', prompt: 'PARAMS' },
      trace: { model: 'k:2:gemini' },
    };
    const info2 = imageModalInfoFromNode(nodeTracePartial);
    check(info2.model === 'k:2:gemini' && info2.prompt === 'PARAMS' && info2.aspectRatio === '3:4' && info2.resolution === '2k' && info2.createdAt === undefined, 'trace 缺字段 → 逐字段回退 params（createdAt 无则 undefined）');

    const nodeParamsOnly = { params: { model: 'm1', aspectRatio: 'Auto', resolution: '', prompt: 'P' } };
    const info3 = imageModalInfoFromNode(nodeParamsOnly);
    check(info3.model === 'm1' && info3.aspectRatio === 'Auto' && info3.prompt === 'P', '无 trace → params 兜底（Auto 透传由展示层处理）');

    const nodeBare = { params: {} };
    const info4 = imageModalInfoFromNode(nodeBare);
    check(info4.model === undefined && info4.createdAt === undefined && info4.prompt === undefined, '双无 → 空字段（渲染层兜底 —，不报错）');
  });

  // ============ R2 renderModalInfo（经 openImageModal） ============
  await section('R2: 大图信息栏（模型短名/时间/比例 Auto→—/分辨率/提示词+复制/缺字段 —）', async () => {
    resetModalState();
    await openImageModal('data:image/png;base64,THUMB', null, { width: 1536, height: 2048 },
      { model: 'bltcy:1:flux-schnell', createdAt: TS, aspectRatio: '3:4', resolution: '2k', prompt: '一只猫' });
    const h = fields.innerHTML;
    check(modal.classList.contains('show'), '打开 → modal.show');
    check(h.includes('flux-schnell') && !h.includes('bltcy:1:'), '模型短名（provider:key:model → model）');
    check(h.includes(fmtLocal(TS)), `时间 YYYY-MM-DD HH:mm（${fmtLocal(TS)}）`);
    check(h.includes('3:4'), '比例 3:4');
    check(h.includes('1536×2048'), '分辨率 = dims 真实像素优先');
    check(h.includes('一只猫') && h.includes('复制提示词'), '提示词 + 复制按钮');

    resetModalState();
    await openImageModal('u2', null, undefined, { model: 'm1', aspectRatio: 'Auto' });
    const h2 = fields.innerHTML;
    check(h2.includes('—'), '缺字段行显示 —（时间/分辨率/提示词）');
    check(!h2.includes('复制提示词'), '无提示词 → 不渲染复制按钮');
    check(h2.includes('>—<'), '比例 Auto → —');
    check(h2.includes('>m1<'), '模型值正常');

    resetModalState();
    await openImageModal('u3', null, undefined, { resolution: '2k' });
    check(fields.innerHTML.includes('2K'), '无 dims → 分辨率回退 params 并大写（2k → 2K）');

    resetModalState();
    await openImageModal('u4', null, { width: 800, height: 600 }, { resolution: '2k' });
    check(fields.innerHTML.includes('800×600'), 'dims 存在 → 优先真实像素（忽略 resolution 字符串）');

    resetModalState();
    await openImageModal('u5', null, undefined, { resolution: '' });
    check(fields.innerHTML.includes('—'), 'dims 与 resolution 均无 → 分辨率 —');
  });

  // ============ R2b 原图加载后 naturalWidth 权威覆盖 ============
  await section('R2b: 原图加载成功后分辨率以 naturalWidth/Height 权威覆盖', async () => {
    resetModalState();
    const origLoad = apiMod.Backend.loadLocalImage;
    apiMod.Backend.loadLocalImage = async () => ({ status: 'success', data_url: 'data:image/png;base64,ORIG' });
    try {
      await openImageModal('u', { path: 'C:/real.png' }, { width: 100, height: 100 }, { resolution: '2k' });
      check(resValue.textContent === '1536×2048', `原图加载 → 分辨率覆盖为 naturalWidth×naturalHeight（实际 ${resValue.textContent}）`);
      check(loading.style.display === 'none', '原图加载完成 → loading 隐藏');
      check(toastCalls.length === 0, '成功路径无失败 toast');
    } finally { apiMod.Backend.loadLocalImage = origLoad; }
  });

  await section('R2c: 原图加载失败回退缩略图 + 失败 toast', async () => {
    resetModalState();
    const origLoad = apiMod.Backend.loadLocalImage;
    apiMod.Backend.loadLocalImage = async () => ({ status: 'fail', message: 'not found' });
    try {
      await openImageModal('u', { path: 'C:/missing.png' }, undefined, { resolution: '2k' });
      check(loading.style.display === 'none', '失败 → loading 隐藏');
      check(toastCalls.some(t => t.msg.includes('原图加载失败')), '失败 → toast 原图加载失败');
      check(resValue.textContent === '', '失败 → 分辨率保持初值（不覆盖为缩略图尺寸）');
    } finally { apiMod.Backend.loadLocalImage = origLoad; }
  });

  // ============ R3 关闭路径 ============
  await section('R3: 关闭路径（× / 背景 / 大图区生效；信息栏不关闭）', async () => {
    resetModalState();
    await openImageModal('u', null, undefined, {});
    check(modal.classList.contains('show'), '打开');
    modal.onclick({ target: modal, stopPropagation() {}, preventDefault() {} });
    check(!modal.classList.contains('show'), '点背景(modal) → 关闭');

    resetModalState();
    await openImageModal('u', null, undefined, {});
    modal.onclick({ target: stage, stopPropagation() {}, preventDefault() {} });
    check(!modal.classList.contains('show'), '点大图区(stage) → 关闭');

    resetModalState();
    await openImageModal('u', null, undefined, {});
    let sp = false;
    closeBtn.onclick({ target: closeBtn, stopPropagation() { sp = true; }, preventDefault() {} });
    check(!modal.classList.contains('show') && sp, '点 × → 关闭 且 stopPropagation');

    resetModalState();
    await openImageModal('u', null, undefined, {});
    modal.onclick({ target: panel, stopPropagation() {}, preventDefault() {} });
    check(modal.classList.contains('show'), '点信息栏(panel) → 不关闭');
  });

  // ============ R4 单图卡 ============
  await section('R4: 单图卡（.ht-img 完整显示、无 .ht-size、按钮常驻、复制条件渲染、点击看大图带 info、拖拽保留）', async () => {
    const grid = makeEl();
    historyDrawer['grid'] = grid;
    historyDrawer['_renderImageItem']({ src: 'data:image/png;base64,S1', timestamp: TS, kind: 'image', prompt: 'P1', model: 'bltcy:1:flux-schnell', aspectRatio: '3:4', resolution: '2k', width: 800, height: 600 });
    const card = grid.children[0];
    const h = card.innerHTML;
    check(!!card && card.draggable === true, '卡片 draggable=true（拖入手势）');
    check(h.includes('ht-img') && h.includes('ht-media'), '内嵌 .ht-img 完整显示图片');
    check(!h.includes('ht-size'), '无 .ht-size 文字标注');
    check(h.includes('ht-actions-static'), '按钮行常驻 .ht-actions-static');
    check(h.includes('复制提示词') && h.includes('复现'), '有 prompt → 复制 + 复现按钮');

    // 点击卡片本体 → 打开大图并带 info
    resetModalState();
    card.dispatch('click', { target: card, stopPropagation() {}, preventDefault() {} });
    const h2 = fields.innerHTML;
    check(h2.includes('flux-schnell') && h2.includes('800×600') && h2.includes('P1'), '点击图 → 大图信息栏含模型短名/真实像素/提示词');

    // 拖拽 dataTransfer
    const dt = {};
    card.dispatch('dragstart', { dataTransfer: { setData: (k, v) => { dt[k] = v; } } });
    check(dt['application/history-image'] === 'data:image/png;base64,S1' && dt['text/plain'] === 'data:image/png;base64,S1', '拖拽语义 application/history-image 保留');

    // 无 prompt → 复制按钮不渲染，复现保留
    const grid2 = makeEl();
    historyDrawer['grid'] = grid2;
    historyDrawer['_renderImageItem']({ src: 'u2', timestamp: 1, kind: 'image' });
    const h3 = grid2.children[0].innerHTML;
    check(!h3.includes('复制提示词') && h3.includes('复现'), '无 prompt → 复制按钮不渲染（复现仍渲染）');
  });

  // ============ R5 批次卡 ============
  await section('R5: 批次卡（无 chips/recipe；头部复制按 prompt 条件；缩略图 contain；+N 角标）', async () => {
    const grid = makeEl();
    historyDrawer['grid'] = grid;
    historyDrawer['_renderBatchCard']({
      batchId: 'b1',
      items: [
        { src: 't1', timestamp: 100, kind: 'image', prompt: 'P', model: 'm', aspectRatio: '3:4', resolution: '2k', count: 4 },
        { src: 't2', timestamp: 200, kind: 'image', prompt: 'P', model: 'm', aspectRatio: '3:4', resolution: '2k', count: 4 },
        { src: 't3', timestamp: 300, kind: 'image', prompt: 'P', model: 'm', aspectRatio: '3:4', resolution: '2k', count: 4 },
        { src: 't4', timestamp: 400, kind: 'image', prompt: 'P', model: 'm', aspectRatio: '3:4', resolution: '2k', count: 4 },
      ],
    });
    const bc = grid.children[0];
    const h = bc.innerHTML;
    check(bc.className.includes('history-batch-c4'), '4 张 → c4 网格类');
    check(h.includes('4/4'), '头部成功计数 4/4');
    check(h.includes('history-batch-copy') && h.includes('复制提示词'), '有 prompt → 头部复制按钮');
    check(h.includes('history-batch-thumbs'), '缩略图容器');
    const thumbCount = (h.match(/class="history-batch-thumb"/g) || []).length;
    check(thumbCount === 4, `4 个缩略图（实际 ${thumbCount}）`);
    check(!h.includes('chip') && !h.includes('recipe'), '无 chips / recipe 残留');
    check(!h.includes('history-batch-more'), '无超出 → 无 +N 角标');

    // 5 张 + prompt 空 → +N 角标 + 复制按钮不渲染
    const grid3 = makeEl();
    historyDrawer['grid'] = grid3;
    historyDrawer['_renderBatchCard']({
      batchId: 'b2',
      items: Array.from({ length: 5 }, (_, i) => ({ src: 'x' + i, timestamp: i, kind: 'image', count: 5 })),
    });
    const h3 = grid3.children[0].innerHTML;
    check(!h3.includes('history-batch-copy'), 'prompt 空 → 头部复制按钮不渲染');
    check(h3.includes('history-batch-more') && h3.includes('+1'), '5 张 → +1 角标');
    check(h3.includes('5/5'), '计数 5/5（count 缺失回退 done）');
  });

  // ============ R6 _buildDisplay 分组 ============
  await section('R6: _buildDisplay（batch 分组 / 无 batchId 单图回退 / time 视图全 single）', async () => {
    historyDrawer['view'] = 'batch';
    historyDrawer['tab'] = 'image';
    const items = [
      { src: 'a', timestamp: 1, kind: 'image', batchId: 'b1' },
      { src: 'b', timestamp: 2, kind: 'image', batchId: 'b1' },
      { src: 'c', timestamp: 3, kind: 'image' },
    ];
    const d = historyDrawer['_buildDisplay'](items);
    const batch = d.find(x => x.kind === 'batch');
    const single = d.find(x => x.kind === 'single');
    check(!!batch && batch.items.length === 2 && batch.batchId === 'b1', '同 batchId → 批次卡合并');
    check(!!single && single.item.src === 'c', '无 batchId 旧行 → 单图回退');

    historyDrawer['view'] = 'time';
    const d2 = historyDrawer['_buildDisplay'](items);
    check(d2.every(x => x.kind === 'single'), 'time 视图 → 全部单图');
    historyDrawer['view'] = 'batch';

    // 批次排序：组内最新时间戳倒序
    const d3 = historyDrawer['_buildDisplay']([
      { src: 'old', timestamp: 5, kind: 'image' },
      { src: 'a', timestamp: 1, kind: 'image', batchId: 'bb' },
      { src: 'b', timestamp: 9, kind: 'image', batchId: 'bb' },
    ]);
    check(d3[0].kind === 'batch', '批次卡（组内最新 ts=9）排在单图 old(ts=5) 前');
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
