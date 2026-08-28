// smoke/qa-imageperf.cjs
// 图片性能优化前端 smoke（DOM 桩 + pywebview 桩）：poller 新字段 / run-engine 写缩略图+imageOrigin /
// openImageModal 按需加载（成功/失败回退/无 origin）/ fetchImageModels label 简化 + 重名去重
//
// 运行：
//   node node_modules/typescript/bin/tsc -p tsconfig.smoke.json --outDir D:/tmp/icv-test
//   node smoke/qa-imageperf.cjs
//
// 验证点：
//   A1-A3 pollTask 透传 thumbnail/originalPath/originalUrl（后端新返回结构）
//   B1-B3 _writeBackToSelf：imageUrl=缩略图、imageOrigin={path}、history trace 带 thumbnail/originalPath
//   C1-C5 openImageModal：先缩略图+loading → loadLocalImage 成功替换原图 / 失败回退缩略图+toast / 无 origin 直接显示
//   D1-D2 fetchImageModels label 简化（去 key 名）+ 跨 key 重名去重

'use strict';

// ───────────────────────── DOM 桩（树结构：appendChild/querySelector/classList） ─────────────────────────
function makeEl(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    children: [],
    parentNode: null,
    classList: {
      _set: new Set(),
      add(...c) { c.forEach(x => this._set.add(x)); },
      remove(...c) { c.forEach(x => this._set.delete(x)); },
      toggle(c, force) {
        const has = this._set.has(c);
        const want = force === undefined ? !has : !!force;
        if (want) this._set.add(c); else this._set.delete(c);
        return want;
      },
      contains(c) { return this._set.has(c); },
    },
    style: {},
    dataset: {},
    attrs: {},
    value: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    type: '',
    placeholder: '',
    title: '',
    spellcheck: false,
    _handlers: {},
    addEventListener(t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); },
    removeEventListener(t, fn) {
      const arr = this._handlers[t] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    dispatch(t, ev) { (this._handlers[t] || []).slice().forEach(fn => fn(ev || { target: this, stopPropagation() {} })); },
    appendChild(c) {
      if (c.parentNode) c.parentNode.children = c.parentNode.children.filter(x => x !== c);
      c.parentNode = this;
      this.children.push(c);
      return c;
    },
    insertBefore(c, ref) {
      if (c.parentNode) c.parentNode.children = c.parentNode.children.filter(x => x !== c);
      c.parentNode = this;
      const idx = ref ? this.children.indexOf(ref) : -1;
      if (idx >= 0) this.children.splice(idx, 0, c); else this.children.push(c);
      return c;
    },
    replaceChild(nc, oc) {
      const idx = this.children.indexOf(oc);
      if (idx >= 0) { this.children[idx] = nc; nc.parentNode = this; }
      return oc;
    },
    remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(x => x !== this); this.parentNode = null; } },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    removeAttribute(k) { delete this.attrs[k]; },
    getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
    querySelector(sel) { return qs(this, sel); },
    querySelectorAll(sel) { const out = []; qsa(this, sel, out); return out; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 200, height: 35, bottom: 35, right: 200 }; },
    contains(node) { return node === this || this.children.includes(node); },
    focus() {},
    select() {},
    click() { this.dispatch('click', { target: this, stopPropagation() {} }); },
  };
  Object.defineProperty(el, 'firstElementChild', { get() { return el.children[0] || null; } });
  Object.defineProperty(el, 'className', {
    get() { return [...el.classList._set].join(' '); },
    set(v) {
      el.classList._set.clear();
      String(v || '').split(/\s+/).filter(Boolean).forEach(c => el.classList._set.add(c));
    },
  });
  return el;
}

function matches(el, sel) {
  sel = (sel || '').trim();
  if (!sel) return false;
  const clsRe = /^\.([\w-]+(?:\.[\w-]+)*)$/;
  const m = sel.match(clsRe);
  if (m) return m[1].split('.').every(c => el.classList.contains(c));
  if (/^[a-zA-Z][\w-]*$/.test(sel)) return el.tagName === sel.toUpperCase();
  const attrRe = /^\[([\w-]+)\]$/;
  const am = sel.match(attrRe);
  if (am) return el.attrs[am[1]] !== undefined;
  return false;
}

function qs(el, sel) {
  for (const c of el.children) {
    if (matches(c, sel)) return c;
    const d = qs(c, sel);
    if (d) return d;
  }
  return null;
}

function qsa(el, sel, out) {
  for (const c of el.children) {
    if (matches(c, sel)) out.push(c);
    qsa(c, sel, out);
  }
  return out;
}

// ───────────────────────── 全局桩 ─────────────────────────
const toastEl = makeEl('div');
toastEl.id = 'toast';

// img-modal 相关元素（openImageModal 测试用；每次测试前可 reset）
const modalEl = makeEl('div');
modalEl.id = 'img-modal';
const modalImg = makeEl('img');
modalImg.id = 'img-modal-img';
const modalLoading = makeEl('div');
modalLoading.id = 'img-modal-loading';
modalLoading.style.display = 'none';

const bodyEl = makeEl('body');
const canvasEl = makeEl('div');
canvasEl.id = 'canvas';

global.window = { addEventListener() {}, innerWidth: 1280, innerHeight: 800, isSecureContext: false };
global.document = {
  getElementById: (id) => (
    id === 'toast' ? toastEl
      : id === 'img-modal' ? modalEl
        : id === 'img-modal-img' ? modalImg
          : id === 'img-modal-loading' ? modalLoading
            : id === 'canvas' ? canvasEl
              : null
  ),
  createElement: (tag) => makeEl(tag),
  createElementNS: () => makeEl(),
  addEventListener() {},
  removeEventListener() {},
  body: bodyEl,
  querySelector: () => null,
  querySelectorAll: () => [],
  activeElement: null,
};
global.localStorage = (() => {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
})();

// Image 桩：赋 src 后异步触发 onload（模拟加载成功，供 loadImageRatio 取宽高比）
global.Image = class {
  constructor() { this.naturalWidth = 0; this.naturalHeight = 0; this._src = ''; }
  set src(v) {
    this._src = v;
    this.naturalWidth = 1024;
    this.naturalHeight = 1024;
    if (typeof this.onload === 'function') setTimeout(() => this.onload(), 0);
  }
  get src() { return this._src; }
};

// pywebview 桩：可配置 task 结果 / load_local_image 结果
let taskResultFixture = null;
let loadLocalCalls = [];
let loadLocalFixture = { status: 'success', data_url: 'data:image/png;base64,ORIGINAL' };
const historyCalls = [];
global.pywebview = {
  api: {
    unified_get_task_result: async () => taskResultFixture,
    load_local_image: async (path) => { loadLocalCalls.push(path); return loadLocalFixture; },
    load_providers: async () => ({ providers: providersFixture }),
    append_history: async (entry) => { historyCalls.push(entry); return { status: 'success' }; },
  },
};

// ───────────────────────── 测试辅助 ─────────────────────────
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

const BASE = 'D:/tmp/icv-test/v1';

// ───────────────────────── 加载被测模块 ─────────────────────────
const { pollTask } = require(`${BASE}/engine/poller.js`);
const { runEngine } = require(`${BASE}/engine/run-engine.js`);
const { flowState } = require(`${BASE}/state/flow-state.js`);
const { historyDrawer } = require(`${BASE}/ui/history-drawer.js`);
const { openImageModal } = require(`${BASE}/canvas/card-view.js`);
const apiMod = require(`${BASE}/api.js`);

// ───────────────────────── 用例 ─────────────────────────
async function main() {
  await section('A: pollTask 透传 thumbnail / originalPath / originalUrl', async () => {
    taskResultFixture = {
      status: 'done',
      result: {
        success: true,
        image_url: 'data:image/jpeg;base64,THUMB',
        thumbnail: 'data:image/jpeg;base64,THUMB',
        original_path: 'C:/saved/img_001.png',
        original_url: 'file:///C:/saved/img_001.png',
        saved_to_disk: true,
      },
    };
    const r = await pollTask('task-1', { intervalMs: 5 });
    check(r.success === true, 'pollTask 成功');
    check(r.imageUrl === 'data:image/jpeg;base64,THUMB', 'imageUrl = 展示图（缩略图）');
    check(r.thumbnail === 'data:image/jpeg;base64,THUMB', 'thumbnail 透传');
    check(r.originalPath === 'C:/saved/img_001.png', 'originalPath 透传');
    check(r.originalUrl === 'file:///C:/saved/img_001.png', 'originalUrl 透传');
    check(r.savedToDisk === true, 'savedToDisk 透传');

    // 旧后端无缩略图字段 → 新字段 undefined（双轨兼容）
    taskResultFixture = { status: 'done', result: { success: true, image_url: 'data:image/png;base64,OLD' } };
    const r2 = await pollTask('task-2', { intervalMs: 5 });
    check(r2.thumbnail === undefined && r2.originalPath === undefined, '旧后端无缩略图字段 → undefined（回退语义）');
  });

  await section('B: _writeBackToSelf 写 imageUrl=缩略图 + imageOrigin + 历史 trace', async () => {
    flowState.replaceAll({
      format: 'icv', version: '3.4', projectName: 't',
      canvas: { scale: 1, panX: 0, panY: 0 },
      nodes: [{
        id: 'gen', type: 'image-gen', x: 0, y: 0, ratio: 3 / 4, status: 'idle', title: '图片生成',
        params: { prompt: '一只猫', model: 'p:k:m', aspectRatio: '3:4', resolution: '2k', count: 1 },
        imageUrl: null, outputText: null, textHistory: [], refImages: [], error: null,
        lastRunAt: null, parentId: null,
      }],
      edges: [], createdAt: 0, updatedAt: 0,
    });
    historyCalls.length = 0;
    await runEngine._writeBackToSelf('gen', 'data:image/jpeg;base64,THUMB', { path: 'C:/saved/img_001.png', url: 'file:///C:/saved/img_001.png' });
    await new Promise(r => setTimeout(r, 10)); // 等 appendTrace 落桩

    const n = flowState.getNode('gen');
    check(n && n.imageUrl === 'data:image/jpeg;base64,THUMB', 'node.imageUrl = 缩略图');
    check(n && n.imageOrigin && n.imageOrigin.path === 'C:/saved/img_001.png', 'node.imageOrigin.path = 原图路径');
    check(n && n.imageOrigin && n.imageOrigin.url === 'file:///C:/saved/img_001.png', 'node.imageOrigin.url 透传');
    const trace = historyCalls.find(c => c && c.kind === 'image');
    check(!!trace && trace.imageUrl === 'data:image/jpeg;base64,THUMB', 'history trace 写 imageUrl=缩略图');
    check(!!trace && trace.thumbnail === 'data:image/jpeg;base64,THUMB', 'history trace 写 thumbnail');
    check(!!trace && trace.originalPath === 'C:/saved/img_001.png', 'history trace 写 originalPath');
    check(!!trace && trace.originalUrl === 'file:///C:/saved/img_001.png', 'history trace 写 originalUrl');

    // 旧后端无 originalPath → imageOrigin = null（不阻断）
    historyCalls.length = 0;
    await runEngine._writeBackToSelf('gen', 'data:image/png;base64,OLD2', null);
    const n2 = flowState.getNode('gen');
    check(n2 && n2.imageOrigin === null, '旧后端无原图引用 → imageOrigin=null（双轨）');
  });

  await section('C: openImageModal 按需加载（成功 / 失败回退 / 无 origin）', async () => {
    // C1-C2 成功：先缩略图+loading → loadLocalImage 取原图替换
    modalImg.src = '';
    modalEl.classList._set.clear();
    modalLoading.style.display = 'none';
    loadLocalCalls.length = 0;
    loadLocalFixture = { status: 'success', data_url: 'data:image/png;base64,ORIGINAL' };

    await openImageModal('data:image/jpeg;base64,THUMB', { path: 'C:/saved/img_001.png' });
    check(modalEl.classList.contains('show'), 'modal 显示');
    check(modalImg.src === 'data:image/png;base64,ORIGINAL', '成功 → img.src 替换为原图 data_url');
    check(modalLoading.style.display === 'none', '成功 → loading 隐藏');
    check(loadLocalCalls.length === 1 && loadLocalCalls[0] === 'C:/saved/img_001.png', 'loadLocalImage 只调用一次（按需）');

    // C3-C4 失败：回退缩略图 + toast
    modalImg.src = '';
    modalEl.classList._set.clear();
    modalLoading.style.display = 'none';
    loadLocalCalls.length = 0;
    toastEl.innerHTML = '';
    loadLocalFixture = { status: 'error', message: '文件不存在' };

    await openImageModal('data:image/jpeg;base64,THUMB', { path: 'C:/gone.png' });
    check(modalImg.src === 'data:image/jpeg;base64,THUMB', '失败 → 保持缩略图');
    check(modalLoading.style.display === 'none', '失败 → loading 隐藏');
    // DOM 桩的 escapeHtml 不同步 textContent→innerHTML，故校验 toast 已显示且为错误态（真实 DOM 会渲染「原图加载失败，已显示缩略图」）
    check(toastEl.classList.contains('show') && toastEl.classList.contains('err'), '失败 → toast 已显示（err 态提示）');

    // C5 无 origin（旧节点/旧历史 base64 直显）：不调 loadLocalImage
    modalImg.src = '';
    modalEl.classList._set.clear();
    modalLoading.style.display = 'none';
    loadLocalCalls.length = 0;
    await openImageModal('data:image/png;base64,OLD');
    check(modalImg.src === 'data:image/png;base64,OLD', '无 origin → 直接显示原 base64');
    check(loadLocalCalls.length === 0, '无 origin → 不触发 loadLocalImage');
    check(modalLoading.style.display === 'none', '无 origin → loading 隐藏');
  });

  await section('D: fetchImageModels label 简化 + 跨 key 重名去重', async () => {
    providersFixture = [
      {
        id: 'provider_bbb', name: 'Flux', short_name: 'flux', type: 'openai', enabled: true,
        api_url: 'https://api.ai-media.vip', use_proxy: true,
        keys: [
          { id: 'key_A', name: '绘图A组', api_key: 'sk-A', enabled: true, models: [
            { id: 'gemini-3-pro-image-preview', name: 'Nano Banana Pro', type: 'drawing', enabled: true },
            { id: 'gpt-4o', name: 'GPT-4o', type: 'chat', enabled: true },
          ] },
          { id: 'key_B', name: '绘图B组', api_key: 'sk-B', enabled: true, models: [
            { id: 'gemini-3-pro-image-preview', name: 'Nano Banana Pro', type: 'drawing', enabled: true },
          ] },
        ],
      },
    ];
    const imgs = await apiMod.fetchImageModels();
    check(imgs.length === 1, `跨 key 重名去重：只 1 个（实际 ${imgs.length}）`);
    check(imgs[0].id === 'provider_bbb:key_A:gemini-3-pro-image-preview', 'id 路由到第一个 enabled key（key_A）');
    check(imgs[0].name === 'flux - Nano Banana Pro', `label 简化为「供应商短名 - 模型名」（去 key 名）：${imgs[0].name}`);
    check(!imgs[0].name.includes('绘图A组') && !imgs[0].name.includes('绘图B组'), 'label 不含任何 key 名');
  });

  console.log(`\n──────────────────────────────`);
  console.log(`结果: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('失败项:');
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log('图片性能优化前端 smoke 验证通过 ✅');
}

// providersFixture 由 pywebview 桩引用，需提前声明
let providersFixture = [];
main().catch(e => { console.error('测试执行异常:', e); process.exit(2); });
