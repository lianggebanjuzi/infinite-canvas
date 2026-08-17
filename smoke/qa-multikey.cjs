// smoke/qa-multikey.cjs
// multi-key 前端 smoke（DOM 桩 + pywebview 桩）：三段拼接 / 默认模型宽容解析+惰性重写 / 设置面板 key 交互
//
// 运行：
//   node node_modules/typescript/bin/tsc -p tsconfig.smoke.json --outDir D:/tmp/icv-test
//   node smoke/qa-multikey.cjs
//
// 验证点：
//   A1-A2 fetchImageModels/fetchChatModels 三层遍历输出三段 id + label 含 key 名；停用 key/停用供应商被过滤
//   B1-B3 resolveDefaultModel 宽容解析 + 惰性重写（旧两段→三段；三段保留；未命中回退第一个并重写）
//   C1-C4 Backend.addKey/deleteKey/updateKey/removeModel 封装与 pywebview 声明一致
//   D1-D3 settingsPanel._renderDefaultModelSelect 按 key 三段 id + 宽容回显
//   E1-E2 settingsPanel._renderCard 模型计数跨 key 汇总
//   F1-F3 settingsPanel._renderKeyCard 名称/启停/删除/模型行（DOM 桩）

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
  // className 与 classList 双向同步（对齐真实 DOM，querySelector 依赖）
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
const settingsListEl = makeEl('div');
settingsListEl.id = 'settings-provider-list';

global.window = { addEventListener() {}, innerWidth: 1280, innerHeight: 800, isSecureContext: false };
global.document = {
  getElementById: (id) => (id === 'toast' ? toastEl : id === 'settings-provider-list' ? settingsListEl : null),
  createElement: (tag) => makeEl(tag),
  createElementNS: () => makeEl(),
  addEventListener() {},
  removeEventListener() {},
  body: makeEl('body'),
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

// pywebview 桩：load_providers 可配置，其余 key 方法记录调用参数
let providersFixture = [];
const pvCalls = { addKey: [], deleteKey: [], updateKey: [], removeModel: [] };
global.pywebview = {
  api: {
    load_providers: async () => ({ providers: providersFixture }),
    add_key: async (pid, name) => { pvCalls.addKey.push([pid, name]); return { status: 'success', key_id: 'key_new', key: { id: 'key_new', name: name || 'key2', api_key: '', enabled: true, models: [] }, keys: [] }; },
    delete_key: async (pid, kid) => { pvCalls.deleteKey.push([pid, kid]); return { status: 'success', keys: [] }; },
    update_key: async (pid, kid, updates) => { pvCalls.updateKey.push([pid, kid, updates]); return { status: 'success', key: {}, keys: [] }; },
    remove_model: async (pid, kid, mid) => { pvCalls.removeModel.push([pid, kid, mid]); return { status: 'success', message: '已删除' }; },
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
const apiMod = require(`${BASE}/api.js`);
const { settingsPanel } = require(`${BASE}/ui/settings-panel.js`);

// 供应商 fixture：provider_bbb 两个 enabled key（同名绘图模型）+ 一个停用 key + 一个停用供应商
function fixtureProviders() {
  return [
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
        { id: 'key_OFF', name: '停用组', api_key: 'sk-OFF', enabled: false, models: [
          { id: 'gemini-3.1-flash-image-preview', name: 'Nano Banana 2', type: 'drawing', enabled: true },
        ] },
      ],
    },
    {
      id: 'provider_off', name: 'Off', short_name: 'off', type: 'openai', enabled: false,
      api_url: 'https://off.example.com', use_proxy: true,
      keys: [{ id: 'key_1', name: 'key1', api_key: '', enabled: true, models: [
        { id: 'gemini-3-pro-image-preview', name: 'Nano Banana Pro', type: 'drawing', enabled: true },
      ] }],
    },
  ];
}

// ───────────────────────── 用例 ─────────────────────────
async function main() {
  await section('A: fetchImageModels / fetchChatModels 三段拼接 + label 简化 + 重名去重', async () => {
    providersFixture = fixtureProviders();
    const imgs = await apiMod.fetchImageModels();
    const imgIds = imgs.map(m => m.id);
    // T04：跨 key 重名模型去重（同供应商同名模型只留第一个 enabled key 条目）
    check(imgs.length === 1, `fetchImageModels 重名去重后只含 1 个（实际 ${imgs.length}）`);
    check(imgIds.includes('provider_bbb:key_A:gemini-3-pro-image-preview'), '三段 id 路由到第一个 enabled key（key_A）');
    check(!imgIds.some(id => id.includes('key_B')), '跨 key 重名去重：key_B 同名模型被去重');
    check(!imgIds.some(id => id.includes('key_OFF')), '停用 key 的模型不进列表');
    check(!imgIds.some(id => id.startsWith('provider_off:')), '停用供应商的模型不进列表');
    const label = imgs[0]?.name || '';
    check(label === 'flux - Nano Banana Pro', `label 简化为「供应商短名 - 模型名」（去 key 名）：${label}`);

    const chats = await apiMod.fetchChatModels();
    check(chats.length === 1, 'fetchChatModels 只含 enabled key 的 chat 模型（1 个）');
    check(chats[0].id === 'provider_bbb:key_A:gpt-4o', 'chat 三段 id');
    check(chats[0].name === 'flux - GPT-4o', `chat label 简化（去 key 名）：${chats[0].name}`);
  });

  await section('B: resolveDefaultModel 宽容解析 + 惰性重写', async () => {
    providersFixture = fixtureProviders();
    // B1: 旧两段 id → 命中 → 返回三段 + 写回 localStorage
    localStorage.setItem('icv_default_model', 'provider_bbb:gemini-3-pro-image-preview');
    const r1 = await apiMod.resolveDefaultModel();
    check(r1 === 'provider_bbb:key_A:gemini-3-pro-image-preview', `旧两段 id 宽容匹配返回三段（${r1}）`);
    check(localStorage.getItem('icv_default_model') === r1, 'localStorage 惰性重写为三段');

    // B2: 三段 id 已被去重的 key_B → 不再可解析，回退第一个可用（key_A）
    localStorage.setItem('icv_default_model', 'provider_bbb:key_B:gemini-3-pro-image-preview');
    const r2 = await apiMod.resolveDefaultModel();
    check(r2 === 'provider_bbb:key_A:gemini-3-pro-image-preview', `已去重的 key_B 三段 id 回退到 key_A（${r2}）`);

    // B3: 未命中（key 已删/模型已删）→ 回退第一个可用 + 重写
    localStorage.setItem('icv_default_model', 'provider_bbb:no-such-model');
    const r3 = await apiMod.resolveDefaultModel();
    check(r3 === 'provider_bbb:key_A:gemini-3-pro-image-preview', `未命中回退第一个可用并重写（${r3}）`);
    check(localStorage.getItem('icv_default_model') === r3, '回退后 localStorage 已重写');

    // B4: 空 → 回退第一个 + 记忆
    localStorage.removeItem('icv_default_model');
    const r4 = await apiMod.resolveDefaultModel();
    check(r4 === 'provider_bbb:key_A:gemini-3-pro-image-preview' && localStorage.getItem('icv_default_model') === r4, '无记录回退第一个并记忆');

    // B5: chat 同构
    localStorage.setItem('icv_default_chat_model', 'provider_bbb:gpt-4o');
    const r5 = await apiMod.resolveDefaultChatModel();
    check(r5 === 'provider_bbb:key_A:gpt-4o', `chat 旧两段宽容匹配（${r5}）`);
  });

  await section('C: Backend.addKey/deleteKey/updateKey/removeModel 封装', async () => {
    providersFixture = fixtureProviders();
    await apiMod.Backend.addKey('provider_bbb');
    await apiMod.Backend.addKey('provider_bbb', '自定义组');
    check(pvCalls.addKey.length === 2 && pvCalls.addKey[0][0] === 'provider_bbb' && pvCalls.addKey[0][1] === '', 'addKey 透传 (providerId, keyName=空)');
    check(pvCalls.addKey[1][1] === '自定义组', 'addKey 透传自定义 keyName');

    await apiMod.Backend.deleteKey('provider_bbb', 'key_A');
    check(pvCalls.deleteKey.length === 1 && pvCalls.deleteKey[0][0] === 'provider_bbb' && pvCalls.deleteKey[0][1] === 'key_A', 'deleteKey 透传 (providerId, keyId)');

    await apiMod.Backend.updateKey('provider_bbb', 'key_A', { name: '改名', enabled: false });
    check(pvCalls.updateKey.length === 1 && pvCalls.updateKey[0][0] === 'provider_bbb' && pvCalls.updateKey[0][1] === 'key_A'
      && pvCalls.updateKey[0][2].name === '改名' && pvCalls.updateKey[0][2].enabled === false, 'updateKey 透传 (providerId, keyId, updates)');

    await apiMod.Backend.removeModel('provider_bbb', 'key_A', 'gpt-4o');
    check(pvCalls.removeModel.length === 1 && pvCalls.removeModel[0][0] === 'provider_bbb'
      && pvCalls.removeModel[0][1] === 'key_A' && pvCalls.removeModel[0][2] === 'gpt-4o', 'removeModel 透传 (providerId, keyId, modelId)');
  });

  await section('D: settingsPanel._renderDefaultModelSelect 三段 id + 宽容回显', async () => {
    providersFixture = fixtureProviders();
    settingsPanel.providers = JSON.parse(JSON.stringify(fixtureProviders()));
    settingsPanel.list = settingsListEl;

    // D1: 旧两段 id → 回显三段值
    localStorage.setItem('icv_default_model', 'provider_bbb:gemini-3-pro-image-preview');
    settingsPanel._renderDefaultModelSelect();
    check(!!settingsPanel.defaultSelect, 'defaultSelect 已创建');
    check(settingsPanel.defaultSelect.getValue() === 'provider_bbb:key_A:gemini-3-pro-image-preview', `旧两段 id 宽容回显三段（${settingsPanel.defaultSelect.getValue()}）`);

    // D2: 已去重的 key_B 三段 id → 列表不再包含，回显占位（value 空）
    localStorage.setItem('icv_default_model', 'provider_bbb:key_B:gemini-3-pro-image-preview');
    settingsPanel._renderDefaultModelSelect();
    check(settingsPanel.defaultSelect.getValue() === '', '已去重 key_B 三段 id 不再回显（列表已去重）');

    // D3: 未命中 → 占位（value 空）
    localStorage.setItem('icv_default_model', 'provider_bbb:no-such-model');
    settingsPanel._renderDefaultModelSelect();
    check(settingsPanel.defaultSelect.getValue() === '', '未命中显示占位（不回显无效值）');

    // D4: 默认下拉 label 简化（去 key 名）+ 跨 key 重名去重（只 1 项）
    localStorage.setItem('icv_default_model', 'provider_bbb:gemini-3-pro-image-preview');
    settingsPanel._renderDefaultModelSelect();
    settingsPanel.defaultSelect.element.click(); // 打开菜单
    const menuItems = document.body.querySelectorAll('.settings-select-item');
    const itemLabels = menuItems.map(it => it.textContent);
    check(itemLabels.length === 1 && itemLabels[0] === 'flux - Nano Banana Pro',
      `默认下拉 label 简化 + 去重：${itemLabels.join(' / ')}`);
    settingsPanel.defaultSelect.element.click(); // 关闭菜单
  });

  await section('E: settingsPanel._renderCard 模型计数跨 key 汇总', async () => {
    providersFixture = fixtureProviders();
    settingsPanel.providers = JSON.parse(JSON.stringify(fixtureProviders()));
    settingsPanel.list = settingsListEl;

    const p = settingsPanel.providers[0];
    const card = settingsPanel._renderCard(p);
    check(card.className === 'provider-card', '卡片容器类名正确');
    check(card.innerHTML.includes('对话 1 · 绘图 3'), `模型计数跨 key 汇总（对话 1 · 绘图 3）: ${card.innerHTML.match(/provider-counts">[^<]+/)?.[0]}`);
    check(card.innerHTML.includes('3 Key'), `Key 数量展示（3 Key）`);
  });

  await section('F: settingsPanel._renderKeyCard 名称/启停/删除/模型行', async () => {
    providersFixture = fixtureProviders();
    settingsPanel.providers = JSON.parse(JSON.stringify(fixtureProviders()));
    settingsPanel.list = settingsListEl;

    const p = settingsPanel.providers[0];
    const ctx = {
      getUrl: () => 'https://api.ai-media.vip',
      onKeysChange: () => {},
      onRenderKeys: () => {},
    };

    // F1: enabled key
    const kA = p.keys[0];
    const cardA = settingsPanel._renderKeyCard(p, kA, ctx);
    check(cardA.className.includes('key-card') && !cardA.className.includes('disabled'), 'enabled key 卡片无 disabled 类');
    const nameInput = cardA.querySelector('.key-name-input');
    check(!!nameInput && nameInput.value === '绘图A组', 'key 名称输入框回显 name');
    const sw = cardA.querySelector('.switch');
    check(!!sw && sw.classList.contains('on'), 'enabled key 开关为 on');
    const del = cardA.querySelector('.mini-btn.danger');
    check(!!del && del.textContent === '删除', 'key 卡片有删除按钮');
    const modelList = cardA.querySelector('.model-list');
    check(!!modelList && modelList.children.length === 2, `key_A 模型行数 = 2（实际 ${modelList ? modelList.children.length : 0}）`);

    // F2: disabled key（编辑器仍展示其模型，只是不进节点下拉）
    const kOff = p.keys[2];
    const cardOff = settingsPanel._renderKeyCard(p, kOff, ctx);
    check(cardOff.className.includes('disabled'), '停用 key 卡片带 disabled 类');
    const swOff = cardOff.querySelector('.switch');
    check(!!swOff && !swOff.classList.contains('on'), '停用 key 开关为 off');
    const offList = cardOff.querySelector('.model-list');
    check(!!offList && offList.children.length === 1 && (offList.children[0].className || '').includes('model-row'),
      `停用 key 仍展示其模型行（1 行，实际 ${offList ? offList.children.length : 0}）`);
  });

  console.log(`\n──────────────────────────────`);
  console.log(`结果: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('失败项:');
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log('multi-key 前端 smoke 验证通过 ✅');
}

main().catch(e => { console.error('测试执行异常:', e); process.exit(2); });
