// smoke/qa-key-group.cjs
// QA 独立验证：供应商级模型组改造（commit 4fd152b，设置面板改为一供应商一份模型组、全部密钥共享）
//
// 运行：
//   node node_modules/typescript/bin/tsc -p tsconfig.smoke.json --outDir .icv-qa
//   node smoke/qa-key-group.cjs
//
// 验证点（对应任务清单）：
//   S1 打开编辑面板不触发同步（兼容已有每 key 独立配置；providerModels 取第一个 enabled key 的 models）
//   S2 模型组「添加模型」→ 逐个 updateKey 复制到全部 enabled key 的 models[]；disabled key 跳过且数据不动
//   S3 模型组「删除模型」（确认弹窗）→ 同步到 enabled key；disabled key 不动
//   S4 模型组「启停模型」→ 同步到 enabled key
//   S5 单 key updateKey 失败 → 不中断其余 key；返回 allOk=false（toast「模型保存失败」）
//   S6 新增 key → models 初始化为当前供应商级模型组副本（非空时 updateKey 一次）
//   S7 空模型组新增 key → 不写 models（后端默认 []）
//   S8 无 enabled key 编辑模型组 → enabledKeys 为空、allOk=true（toast「已添加」）；仅本地模型组更新
//   S9 「拉取模型」→ 合并（保留旧 enabled/手动添加）→ 同步到 enabled key
//   S10 顶部默认模型下拉在模型组编辑后被重建（_refreshDefaultModelSelect）
//   S11 fetchImageModels 合并展示不退化（同供应商多 key 同名模型只显示一条、label 去 key 名、id 三段）
//   S12 单 key provider 行为与旧版一致（一次 updateKey）
//   S13 参考模型（纯函数）：同步规则 = enabled key 集；与真实闭包观测到的 updateKey key 集一致
//   S14 守卫：运行前后 providers_data.json 未被修改（只读验证，绝不写入）
//
// 说明：persistProviderModels 是 _renderEditor 内的闭包（不可直接导出）。
//       本测试通过真实 DOM 事件驱动真实编译产物 .icv-qa/v1/ui/settings-panel.js 的 UI 闭包，
//       以 pywebview.api 桩记录 updateKey/addKey 调用，属于对真实业务代码的黑盒行为验证
//       （未改动任何业务源码，仅测试桩）。

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = 'D:/Infinite Canvas/Infinite Canvas 2.0/.icv-qa/v1';
const ROOT = 'D:/Infinite Canvas/Infinite Canvas 2.0';

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
    dispatch(t, ev) { (this._handlers[t] || []).slice().forEach(fn => fn(ev || { target: this, stopPropagation() {}, preventDefault() {}, dataTransfer: null })); },
    appendChild(c) { this.children.push(c); return c; },
    remove() {}, setAttribute() {}, removeAttribute() {}, focus() {}, select() {}, click() {},
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
  // 真实 DOM 语义：textContent 与 innerHTML 同源（escapeHtml 依赖 textContent→innerHTML）
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
/** 等待异步闭包收尾（showToast 在 updateKey await 之后执行，需要多等一拍） */
const settle = () => tick(40);
async function until(fn, timeout = 2000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) return false;
    await tick();
  }
  return true;
}

// ───────────────────────── DOM 查找工具 ─────────────────────────
function walk(el, fn) {
  if (fn(el)) return el;
  for (const c of (el.children || [])) { const r = walk(c, fn); if (r) return r; }
  return null;
}
function findClass(el, cls) {
  return walk(el, n => (n.className || '').split(/\s+/).includes(cls));
}
function findByText(el, text) {
  return walk(el, n => n.textContent === text);
}
function findInputByPlaceholder(el, ph) {
  return walk(el, n => n.placeholder === ph);
}
function clickConfirmOk(confirmText) {
  for (let i = bodyChildren.length - 1; i >= 0; i--) {
    const btn = walk(bodyChildren[i], n =>
      (n.className || '').split(/\s+/).includes('confirm-btn') && n.textContent === (confirmText || '删除'));
    if (btn) { btn.dispatch('click', {}); return true; }
  }
  return false;
}

// ───────────────────────── 后端桩（记录 + 内存 store） ─────────────────────────
const updateCalls = [];
let mockFetchModels = async () => ({ status: 'success', models: [] });
let failKeyIds = new Set();

function clone(x) { return JSON.parse(JSON.stringify(x)); }

function makeStore(provider) {
  return { providers: [clone(provider)] };
}
let store = makeStore({ id: 'p', name: 'P', short_name: 'P', type: 'openai', enabled: true, keys: [] });

function installPywebview() {
  updateCalls.length = 0;
  global.pywebview.api = {
    async load_providers() { return { providers: clone(store.providers) }; },
    async load_settings() { return {}; },
    async update_key(providerId, keyId, updates) {
      updateCalls.push({ providerId, keyId, updates: clone(updates) });
      const p = store.providers.find(x => x.id === providerId);
      const k = p && p.keys.find(x => x.id === keyId);
      if (updates && Object.prototype.hasOwnProperty.call(updates, 'models') && k) k.models = clone(updates.models);
      if (updates && Object.prototype.hasOwnProperty.call(updates, 'name') && k) k.name = updates.name;
      if (updates && Object.prototype.hasOwnProperty.call(updates, 'enabled') && k) k.enabled = updates.enabled;
      if (updates && Object.prototype.hasOwnProperty.call(updates, 'api_key') && k) k.api_key = updates.api_key;
      if (failKeyIds.has(keyId)) return { status: 'error', message: '模拟失败' };
      return { status: 'success', key: k ? clone(k) : null, keys: p ? clone(p.keys) : [] };
    },
    async add_key(providerId, keyName) {
      const p = store.providers.find(x => x.id === providerId);
      const newKey = { id: 'key_new1234', name: keyName || 'keyN', api_key: '', enabled: true, models: [] };
      if (p) p.keys.push(newKey);
      return { status: 'success', key_id: newKey.id, key: clone(newKey), keys: p ? clone(p.keys) : [] };
    },
    async delete_key(providerId, keyId) {
      const p = store.providers.find(x => x.id === providerId);
      if (p) p.keys = p.keys.filter(x => x.id !== keyId);
      return { status: 'success', keys: p ? clone(p.keys) : [] };
    },
    async fetch_models(apiUrl, apiKey) { return mockFetchModels(apiUrl, apiKey); },
    async update_provider() { return { status: 'success' }; },
    async delete_provider() { return { status: 'success' }; },
    async test_api_connection() { return { success: true, message: 'ok' }; },
    async add_chat_model() { return { status: 'success' }; },
    async remove_model() { return { status: 'success' }; },
    async unified_generate_image() { return { task_id: 't' }; },
    async unified_get_task_result() { return { status: 'not_found' }; },
    async save_image_to_local() { return { path: '' }; },
    async save_image_as() { return { path: '' }; },
    async load_local_image() { return { status: 'error' }; },
    async copy_to_clipboard() { return { status: 'success' }; },
    async paste_from_clipboard() { return { cards: [] }; },
    async save_project() { return { status: 'success' }; },
    async save_project_as() { return { data: {} }; },
    async open_project_dialog() { return { data: {} }; },
    async load_project() { return { data: {} }; },
    async get_current_project_path() { return { path: '' }; },
    async append_history() { return { status: 'success' }; },
    async load_history() { return { status: 'empty' }; },
    async save_assets() { return { status: 'success' }; },
    async load_assets() { return { status: 'empty' }; },
    async save_settings() { return { status: 'success' }; },
    async select_folder() { return { path: '' }; },
    async load_prompts_library() { return {}; },
    async save_prompts_library() { return { status: 'success' }; },
    async unified_chat() { return { content: '' }; },
    async unified_chat_v2() { return { content: '' }; },
    async agent_chat() { return { content: '' }; },
    async outpaint() { return { url: '' }; },
  };
}

// ───────────────────────── 加载被测模块 ─────────────────────────
installPywebview();
const { settingsPanel } = require(`${BASE}/ui/settings-panel.js`);
const apiMod = require(`${BASE}/api.js`);

// ───────────────────────── 测试辅助 ─────────────────────────
function makeProvider(keysArr, over = {}) {
  return {
    id: 'provider_1', name: 'Test', short_name: 'T', type: 'openai', enabled: true,
    api_url: 'https://api.example.com/v1', use_proxy: true,
    keys: keysArr,
    ...over,
  };
}
function makeKey(id, name, enabled, models, apiKey = 'sk-' + id) {
  return { id, name, api_key: apiKey, enabled, models: models.map(m => ({ ...m })) };
}
function M(id, type = 'drawing', enabled = true, name) {
  return { id, name: name || id, type, enabled };
}

let editorCard = null;
function openEditor(provider, opts = {}) {
  toastLog.length = 0;
  bodyChildren.length = 0;
  failKeyIds = new Set(opts.failKeyIds || []);
  store = makeStore(provider);
  installPywebview();
  settingsPanel['providers'] = [clone(provider)];
  const listEl = makeEl({ firstElementChild: null, insertBefore(c) { this._inserted = (this._inserted || 0) + 1; }, replaceChild() {} });
  settingsPanel['list'] = opts.withList ? listEl : null;
  editorCard = settingsPanel['_renderEditor'](settingsPanel['providers'][0]);
  return editorCard;
}
function modelRowIds() {
  const list = findClass(editorCard, 'model-list');
  const rows = [];
  walk(list, n => {
    if ((n.className || '').split(/\s+/).includes('model-row')) rows.push(n);
    return false;
  });
  return rows.map(r => {
    const idEl = walk(r, n => (n.className || '').split(/\s+/).includes('model-id'));
    return idEl ? idEl.textContent : '';
  });
}
function addModelViaUI(mid) {
  const addRow = findClass(editorCard, 'model-add-row');
  addRow.children[0].value = mid;           // midInput
  addRow.children[1].value = mid + ' 名';   // mnameInput
  addRow.children[3].dispatch('click', {}); // 手动添加
}
async function clickAndWait(btn, count, timeout = 2000) {
  btn.dispatch('click', {});
  return await until(() => updateCalls.length >= count, timeout);
}

// ───────────────────────── 测试 ─────────────────────────
(async () => {
  // 运行前记录 providers_data.json 指纹（S14 守卫）
  const realFile = path.join(ROOT, 'providers_data.json');
  const beforeHash = fs.existsSync(realFile) ? crypto.createHash('sha256').update(fs.readFileSync(realFile)).digest('hex') : 'absent';
  const beforeMtime = fs.existsSync(realFile) ? fs.statSync(realFile).mtimeMs : -1;

  await section('S1 打开编辑面板不触发同步（兼容旧每 key 独立配置）', async () => {
    const provider = makeProvider([
      makeKey('key_a', 'A', true, [M('m1'), M('m2')]),
      makeKey('key_b', 'B', true, [M('m3')]),   // 旧独立配置：与 key_a 不同
    ]);
    openEditor(provider);
    check(updateCalls.length === 0, '渲染编辑面板后 updateKey 调用数为 0（数据不动）');
    check(JSON.stringify(modelRowIds()) === JSON.stringify(['m1', 'm2']),
      `providerModels 初始化为第一个 enabled key 的 models（实际 ${JSON.stringify(modelRowIds())}）`);
  });

  await section('S2 模型组添加模型 → 同步全部 enabled key、disabled key 跳过且数据不动', async () => {
    const provider = makeProvider([
      makeKey('key_a', 'A', true, [M('m1'), M('m2')]),
      makeKey('key_b', 'B', true, [M('m1'), M('m2')]),
      makeKey('key_c', 'C', false, [M('m1'), M('m2')]), // disabled
    ]);
    openEditor(provider);
    addModelViaUI('m-new');
    const ok = await until(() => updateCalls.length >= 2);
    check(ok, '添加模型后 2 次 updateKey（2 个 enabled key）');
    const calledKeys = updateCalls.map(c => c.keyId);
    check(JSON.stringify(calledKeys) === JSON.stringify(['key_a', 'key_b']), `updateKey 只发给 enabled key（实际 ${JSON.stringify(calledKeys)}）`);
    check(updateCalls.every(c => c.updates.models.some(m => m.id === 'm-new')), '每次 update 都包含新增模型 m-new');
    const storeC = store.providers[0].keys.find(k => k.id === 'key_c');
    check(JSON.stringify(storeC.models.map(m => m.id)) === JSON.stringify(['m1', 'm2']), 'disabled key 的 models[] 未被改动');
    const storeA = store.providers[0].keys.find(k => k.id === 'key_a');
    check(storeA.models.some(m => m.id === 'm-new'), 'enabled key 的 models[] 已含 m-new（后端持久化）');
    const memC = settingsPanel['providers'][0].keys.find(k => k.id === 'key_c');
    check(JSON.stringify(memC.models.map(m => m.id)) === JSON.stringify(['m1', 'm2']), '内存副本 disabled key 的 models[] 未被改动');
    await settle();
    check(toastLog.some(t => t.includes('已添加')), 'toast 提示「已添加」（allOk=true）');
  });

  await section('S3 模型组删除模型（确认弹窗）→ 同步 enabled key', async () => {
    const provider = makeProvider([
      makeKey('key_a', 'A', true, [M('m1'), M('m2'), M('m3')]),
      makeKey('key_b', 'B', true, [M('m1'), M('m2'), M('m3')]),
      makeKey('key_c', 'C', false, [M('m1'), M('m2'), M('m3')]),
    ]);
    openEditor(provider);
    const rows = [];
    walk(findClass(editorCard, 'model-list'), n => { if ((n.className || '').split(/\s+/).includes('model-row')) rows.push(n); return false; });
    const rowM1 = rows.find(r => walk(r, n => (n.className || '').split(/\s+/).includes('model-id') && n.textContent === 'm1'));
    check(!!rowM1, '找到 m1 行');
    const delBtn = findClass(rowM1, 'danger');
    delBtn.dispatch('click', {});           // 打开确认弹窗
    check(bodyChildren.length === 1, '确认弹窗已挂载');
    check(clickConfirmOk('删除'), '点击确认「删除」');
    const ok = await until(() => updateCalls.length >= 2);
    check(ok, '删除后 2 次 updateKey');
    check(updateCalls.every(c => !c.updates.models.some(m => m.id === 'm1')), 'update 的 models 不再包含 m1');
    check(updateCalls.every(c => c.updates.models.some(m => m.id === 'm2')), '其余模型保留');
    const storeC = store.providers[0].keys.find(k => k.id === 'key_c');
    check(storeC.models.some(m => m.id === 'm1'), 'disabled key 仍保留 m1（未同步删除）');
  });

  await section('S4 模型组启停模型 → 同步 enabled key', async () => {
    const provider = makeProvider([
      makeKey('key_a', 'A', true, [M('m1'), M('m2')]),
      makeKey('key_b', 'B', true, [M('m1'), M('m2')]),
    ]);
    openEditor(provider);
    const rows = [];
    walk(findClass(editorCard, 'model-list'), n => { if ((n.className || '').split(/\s+/).includes('model-row')) rows.push(n); return false; });
    const rowM1 = rows.find(r => walk(r, n => (n.className || '').split(/\s+/).includes('model-id') && n.textContent === 'm1'));
    const sw = findClass(rowM1, 'switch');
    sw.dispatch('click', {});
    const ok = await until(() => updateCalls.length >= 2);
    check(ok, '启停后 2 次 updateKey');
    const m1 = updateCalls[0].updates.models.find(m => m.id === 'm1');
    check(m1 && m1.enabled === false, `m1 被置为 disabled（enabled=${m1 && m1.enabled}）`);
    check(updateCalls.every(c => c.updates.models.find(m => m.id === 'm2').enabled !== false), 'm2 保持 enabled');
  });

  await section('S5 单 key 失败不中断 + allOk=false', async () => {
    const provider = makeProvider([
      makeKey('key_a', 'A', true, [M('m1')]),
      makeKey('key_b', 'B', true, [M('m1')]),
    ]);
    openEditor(provider, { failKeyIds: ['key_b'] });
    addModelViaUI('m-fail');
    const ok = await until(() => updateCalls.length >= 2);
    check(ok, 'key_b 失败后 key_a 仍被写入（2 次调用，未中断）');
    check(updateCalls.map(c => c.keyId).join(',') === 'key_a,key_b', '调用顺序 key_a → key_b（失败在后仍被尝试）');
    const storeA = store.providers[0].keys.find(k => k.id === 'key_a');
    check(storeA.models.some(m => m.id === 'm-fail'), 'key_a 已持久化 m-fail');
    await settle();
    check(toastLog.some(t => t.includes('模型保存失败')), 'toast「模型保存失败」（allOk=false）');
  });

  await section('S6 新增 key → models 初始化为当前模型组副本', async () => {
    const provider = makeProvider([
      makeKey('key_a', 'A', true, [M('m1'), M('m2')]),
    ]);
    openEditor(provider);
    findByText(editorCard, '添加密钥').dispatch('click', {});
    const ok = await until(() => updateCalls.length >= 1);
    check(ok, '添加 key 后 1 次 updateKey（初始化模型组）');
    check(updateCalls.length === 1, '仅 1 次 updateKey');
    check(updateCalls[0].keyId === 'key_new1234', '写入对象是新 key');
    check(JSON.stringify(updateCalls[0].updates.models.map(m => m.id)) === JSON.stringify(['m1', 'm2']),
      `新 key 的 models 为模型组副本（实际 ${JSON.stringify(updateCalls[0].updates.models.map(m => m.id))}）`);
    const newKey = store.providers[0].keys.find(k => k.id === 'key_new1234');
    check(JSON.stringify(newKey.models.map(m => m.id)) === JSON.stringify(['m1', 'm2']), '后端 store 中新 key models = [m1, m2]');
  });

  await section('S7 空模型组新增 key → 不写 models（后端默认 []）', async () => {
    const provider = makeProvider([makeKey('key_a', 'A', true, [])]);
    openEditor(provider);
    findByText(editorCard, '添加密钥').dispatch('click', {});
    await tick(30);
    check(updateCalls.length === 0, '空模型组时添加 key 不触发 updateKey');
    const newKey = store.providers[0].keys.find(k => k.id === 'key_new1234');
    check(newKey && JSON.stringify(newKey.models) === '[]', '新 key models 保持后端默认 []');
  });

  await section('S8 无 enabled key 编辑模型组 → allOk=true（仅本地）', async () => {
    const provider = makeProvider([makeKey('key_d', 'D', false, [M('m1')])]);
    openEditor(provider);
    addModelViaUI('m-local');
    await tick(30);
    check(updateCalls.length === 0, '无 enabled key → 0 次 updateKey（无 key 可写）');
    await settle();
    check(JSON.stringify(modelRowIds()) === JSON.stringify(['m1', 'm-local']), '本地模型组已更新（UI 展示）');
    check(toastLog.some(t => t.includes('已添加')), 'toast「已添加」（allOk=true，无 key 失败）');
  });

  await section('S9 拉取模型 → 合并旧列表 → 同步 enabled key', async () => {
    const provider = makeProvider([
      makeKey('key_a', 'A', true, [M('old')]),
      makeKey('key_b', 'B', true, [M('old')]),
      makeKey('key_c', 'C', false, [M('old')]),
    ]);
    mockFetchModels = async () => ({ status: 'success', models: [{ id: 'fetched', type: 'drawing', name: 'F' }] });
    openEditor(provider);
    findInputByPlaceholder(editorCard, 'https://api.example.com/v1').value = 'https://api.example.com/v1';
    findByText(editorCard, '拉取模型').dispatch('click', {});
    const ok = await until(() => updateCalls.length >= 2);
    check(ok, '拉取后 2 次 updateKey（2 enabled key）');
    check(updateCalls.every(c => c.updates.models.some(m => m.id === 'fetched') && c.updates.models.some(m => m.id === 'old')),
      'merged = 旧模型保留 + 新拉取模型（实际 ' + JSON.stringify(updateCalls[0] && updateCalls[0].updates.models.map(m => m.id)) + '）');
    const storeC = store.providers[0].keys.find(k => k.id === 'key_c');
    check(!storeC.models.some(m => m.id === 'fetched'), 'disabled key 未写入拉取结果');
  });

  await section('S10 模型组编辑后顶部默认模型下拉被重建', async () => {
    const provider = makeProvider([
      makeKey('key_a', 'A', true, [M('m1', 'drawing', true, 'Alpha')]),
      makeKey('key_b', 'B', true, [M('m1', 'drawing', true, 'Alpha')]),
    ]);
    openEditor(provider, { withList: true });
    const listEl = settingsPanel['list'];
    const before = listEl._inserted || 0;
    addModelViaUI('m-draw');
    const ok = await until(() => updateCalls.length >= 2);
    check(ok && (listEl._inserted || 0) > before, '_refreshDefaultModelSelect 已重建顶部默认模型下拉');
  });

  await section('S11 fetchImageModels 合并展示不退化（同供应商多 key 同名模型只显示一条）', async () => {
    store = makeStore(makeProvider([
      makeKey('key_a', 'A', true, [M('gemini-x', 'drawing', true, 'Nano X')]),
      makeKey('key_b', 'B', true, [M('gemini-x', 'drawing', true, 'Nano X')]), // 同名重复
      makeKey('key_c', 'C', false, [M('gemini-x', 'drawing', true, 'Nano X')]), // disabled
    ]));
    installPywebview();
    const models = await apiMod.fetchImageModels();
    check(models.length === 1, `同名模型只显示一条（实际 ${models.length} 条）`);
    check(models[0].id === 'provider_1:key_a:gemini-x', `id 为三段 provider:key:model（实际 ${models[0].id}）`);
    check(models[0].name === 'T - Nano X', `label 去 key 名（实际 ${models[0].name}）`);
  });

  await section('S12 单 key provider 行为与旧版一致（一次 updateKey）', async () => {
    const provider = makeProvider([makeKey('key_a', 'A', true, [M('m1')])]);
    openEditor(provider);
    addModelViaUI('m-only');
    const ok = await until(() => updateCalls.length >= 1);
    check(ok && updateCalls.length === 1, '单 key → 1 次 updateKey');
    check(updateCalls[0].keyId === 'key_a' && updateCalls[0].updates.models.some(m => m.id === 'm-only'), '写回唯一 key 的 models');
  });

  await section('S13 参考模型交叉验证：同步规则 = enabled key 集', async () => {
    // 参考实现（纯函数，用于交叉核对真实闭包行为；非被测代码）
    const refSyncKeys = (keys) => keys.filter(k => k.enabled !== false).map(k => k.id);
    const provider = makeProvider([
      makeKey('key_a', 'A', true, [M('m1')]),
      makeKey('key_b', 'B', true, [M('m1')]),
      makeKey('key_c', 'C', false, [M('m1')]),
    ]);
    openEditor(provider);
    addModelViaUI('m-ref');
    const ok = await until(() => updateCalls.length >= 2);
    const expected = refSyncKeys(provider.keys);
    check(ok && JSON.stringify(updateCalls.map(c => c.keyId)) === JSON.stringify(expected),
      `真实闭包写入了参考模型预期的 key 集（${JSON.stringify(expected)}）`);
  });

  await section('S15 结构：key 卡片瘦身为凭据-only（无模型编辑入口残留）', async () => {
    const provider = makeProvider([
      makeKey('key_a', 'A', true, [M('m1')]),
      makeKey('key_b', 'B', true, [M('m1')]),
    ]);
    openEditor(provider);
    // 整个编辑区只有供应商级一份 model-list / model-add-row
    let modelLists = 0, addRows = 0;
    walk(editorCard, n => {
      if ((n.className || '').split(/\s+/).includes('model-list')) modelLists += 1;
      if ((n.className || '').split(/\s+/).includes('model-add-row')) addRows += 1;
      return false;
    });
    check(modelLists === 1, `供应商级模型组只有 1 个 model-list（实际 ${modelLists}）`);
    check(addRows === 1, `手动添加行只有 1 个（实际 ${addRows}）`);
    // key 卡片内无「拉取模型」按钮
    let fetchBtns = 0;
    walk(editorCard, n => { if (n.textContent === '拉取模型') fetchBtns += 1; return false; });
    check(fetchBtns === 1, `「拉取模型」按钮只有供应商级 1 个（实际 ${fetchBtns}）`);
    // key 卡片类名与凭据字段
    const keyCards = [];
    walk(editorCard, n => { if ((n.className || '').split(/\s+/).includes('key-card')) keyCards.push(n); return false; });
    check(keyCards.length === 2, `渲染 2 张 key 卡片（实际 ${keyCards.length}）`);
    const hasApiKeyField = walk(keyCards[0], n => (n.innerHTML || '').includes('API 密钥'));
    check(!!hasApiKeyField, 'key 卡片含「API 密钥」凭据字段');
  });

  // S14 守卫：真实 providers_data.json 未被修改
  const afterHash = fs.existsSync(realFile) ? crypto.createHash('sha256').update(fs.readFileSync(realFile)).digest('hex') : 'absent';
  const afterMtime = fs.existsSync(realFile) ? fs.statSync(realFile).mtimeMs : -1;
  console.log('\n▶ S14 守卫：providers_data.json 只读');
  check(beforeHash === afterHash, `运行前后文件内容 hash 一致（${afterHash.slice(0, 12)}…）`);
  check(beforeMtime === afterMtime, `运行前后 mtime 一致（${new Date(afterMtime).toISOString()}）`);

  console.log(`\n════════ 汇总 ════════`);
  console.log(`通过 ${passed} · 失败 ${failed}`);
  if (failures.length) {
    console.log('失败项：');
    failures.forEach(f => console.log('  - ' + f));
    process.exitCode = 1;
  }
})();
