// .qa-verify/qa-verify-incremental3-frontend.cjs
// QA 独立验证（fresh eyes）：incremental-3 T03 前端（AC-5/AC-6/AC-7/AC-8 + X1/X2）
// 覆盖（Node CommonJS + DOM 桩，复用 smoke 基建模式，但独立编写）：
//   AC-3 前端侧：adoptByUrl 写 imageUrl；_normalize 兼容旧记录；urlByKey 读路径反哺；projectName 去重
//   AC-6 前端侧：getAdoptedAssets 只含 adopted + updatedAt 倒序；asset-drawer 空态/无匹配/四动作
//   AC-5 前端侧：history-drawer 卡片仅复现按钮（无采纳/锁定动作）、只读角标保留
//   AC-8 前端侧：_afterChange 置 dirty；_persist 消费 degraded → 人话 toast（非报错）
//   X1：assetStore 订阅驱动 asset-drawer/history-drawer 重渲染
//
// 运行：先 npx tsc -p tsconfig.smoke.json --outDir .icv-smoke 再 node .qa-verify/qa-verify-incremental3-frontend.cjs

'use strict';

const BASE = 'G:/Infinite Canvas/Infinite Canvas 2.0/.icv-smoke/v1';

// ───────────────────────── DOM/浏览器桩（能力比 smoke 基建更强：记录 children / classList 真实态） ─────────────────────────
function makeEl(over = {}) {
  const classes = new Set(over.classes || []);
  const children = [];
  const listeners = {};
  let _text = '';
  let _html = '';
  const el = {
    style: {}, dataset: {}, value: '', disabled: false, title: '', checked: false,
    children,
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : !!force;
        if (on) classes.add(c); else classes.delete(c);
        return on;
      },
      contains: (c) => classes.has(c),
    },
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    removeEventListener() {},
    appendChild(ch) { children.push(ch); return ch; },
    remove() {},
    setAttribute() {}, removeAttribute() {}, focus() {}, select() {}, click() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; },
    _listeners: listeners,
    _classes: classes,
    ...over,
  };
  Object.defineProperty(el, 'textContent', {
    get() { return _text; }, set(v) { _text = String(v); _html = String(v); }, configurable: true,
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return _html; },
    set(v) { _html = String(v); if (String(v) === '') children.length = 0; }, // 模拟 DOM：innerHTML='' 清空子节点
    configurable: true,
  });
  return el;
}

const byId = new Map([
  ['toast', makeEl()],
  // history-drawer 依赖
  ['left-drawer', makeEl()], ['history-grid', makeEl()], ['drawer-handle', makeEl()],
  ['history-empty', makeEl()], ['history-search', makeEl()], ['history-tabs', makeEl()],
  // asset-drawer 依赖
  ['asset-drawer', makeEl()], ['asset-grid', makeEl()], ['asset-handle', makeEl()],
  ['asset-empty', makeEl()], ['asset-search', makeEl()], ['asset-count', makeEl()],
]);
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
  return { getItem: (k) => (s.has(k) ? s.get(k) : null), setItem: (k, v) => s.set(k, String(v)), removeItem: (k) => s.delete(k), clear: () => s.clear() };
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
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

// ───────────────────────── 加载被测模块 ─────────────────────────
const { nodeRegistry } = require(`${BASE}/nodes/node-registry.js`);
require(`${BASE}/nodes/image-gen.js`);
require(`${BASE}/nodes/text-gen.js`);
const { flowState } = require(`${BASE}/state/flow-state.js`);
const { flowHistory } = require(`${BASE}/state/history.js`);
const { assetStore } = require(`${BASE}/asset-store.js`);
const { historyPersist } = require(`${BASE}/history-persist.js`);
const { Backend } = require(`${BASE}/api.js`);
const toast = require(`${BASE}/ui/toast.js`);
const { historyDrawer } = require(`${BASE}/ui/history-drawer.js`);
const { assetDrawer } = require(`${BASE}/ui/asset-drawer.js`);

// toast / saveAssets 拦截（属性访问在调用时解析 → 替换即生效）
const toasts = [];
toast.showToast = (msg, ok = true) => { toasts.push({ msg, ok }); };
const realSaveAssets = Backend.saveAssets;

function reset(over = {}) {
  flowState.replaceAll({
    format: 'icv', version: '3.4', projectName: '测试项目', canvas: { scale: 1, panX: 0, panY: 0 },
    nodes: [], edges: [], createdAt: 0, updatedAt: 0, ...over,
  });
  flowHistory.clear();
  assetStore['records'].clear();
  assetStore['urlByKey'].clear();
  assetStore['metaByKey'].clear();
  toasts.length = 0;
  // 清空抽屉容器（innerHTML='' 会经 stub 清空 children）
  byId.get('history-grid').innerHTML = '';
  byId.get('asset-grid').innerHTML = '';
  byId.get('asset-empty').style.display = 'none';
  assetDrawer['query'] = '';
}

async function main() {
  // 与生产 main.ts 一致：抽屉各 init 一次（重复 init 会叠加订阅导致重复渲染，属测试污染）
  historyDrawer.init();
  assetDrawer.init();

  // ══════════════ AC-3 前端：AssetStore incremental-3 语义 ══════════════
  await section('A1: adoptByUrl 写 imageUrl + urlByKey + getAdoptedAssets', async () => {
    reset();
    const url = 'data:image/png;base64,AAA1';
    const node = flowState.addNode('image-gen', 0, 0, { imageUrl: url });
    assetStore.adoptByUrl(url, node.id, { prompt: '花园' });
    const list = assetStore.getAdoptedAssets();
    check(list.length === 1, 'getAdoptedAssets 只含 adopted');
    check(list[0].url === url, 'getAdoptedAssets.url = imageUrl');
    check(list[0].record.imageUrl === url, '记录已写 imageUrl');
    check(list[0].meta && list[0].meta.prompt === '花园', 'meta 内存缓存写入');
    const persisted = assetStore.list()[0];
    check(persisted.projectName.includes('测试项目'), 'projectName 追加当前项目名');
    // 重复采纳同图（同 key）：不重复记录、projectName 去重
    assetStore.adoptByUrl(url, node.id);
    check(assetStore.list().length === 1, '同图重复采纳不新增记录');
    check(assetStore.list()[0].projectName.filter(n => n === '测试项目').length === 1, 'projectName 去重（只一个 测试项目）');
  });

  await section('A2: getAdoptedAssets 按 updatedAt 倒序 + unadopt 移除', async () => {
    reset();
    const u1 = 'data:image/png;base64,BBB2';
    const u2 = 'data:image/png;base64,CCC3';
    const n1 = flowState.addNode('image-gen', 0, 0, { imageUrl: u1 });
    const n2 = flowState.addNode('image-gen', 0, 0, { imageUrl: u2 });
    assetStore.adoptByUrl(u1, n1.id); // t1
    await tick(5);
    assetStore.adoptByUrl(u2, n2.id); // t2 更新
    let list = assetStore.getAdoptedAssets();
    check(list[0].record.key === assetStore['_keyOf'](u2), '倒序：后采纳的在前');
    assetStore.unadopt(assetStore['_keyOf'](u2));
    list = assetStore.getAdoptedAssets();
    check(list.length === 1 && list[0].url === u1, 'unadopt 后从资产库移除');
  });

  await section('A3: loadFromBackend 兼容旧记录（缺 imageUrl/projectName）', async () => {
    reset();
    Backend.loadAssets = async () => ({
      status: 'success',
      records: [
        { key: 'old1', nodeId: 'n9', adopted: true, locked: true, tags: [], category: '成图', updatedAt: 1 },
        { key: 'new2', nodeId: 'n10', adopted: true, locked: false, tags: [], category: '成图', updatedAt: 2,
          imageUrl: 'data:image/png;base64,DDD4', projectName: ['旧项目'] },
      ],
    });
    await assetStore.loadFromBackend();
    const list = assetStore.getAdoptedAssets();
    check(list.length === 2, 'loadFromBackend 恢复两条');
    const old = assetStore.getByImageUrl('');
    // 旧记录 key=old1 无 imageUrl → 无 url，normalize 不崩
    const oldRec = assetStore['records'].get('old1');
    check(oldRec.imageUrl === '' && Array.isArray(oldRec.projectName) && oldRec.projectName.length === 0,
      '_normalize 缺 imageUrl → ""、缺 projectName → []');
    // urlByKey 反哺：读路径把 URL 回填内存缓存（旧记录在画布上被读取后资产库也能显示）
    const newUrl = 'data:image/png;base64,DDD4';
    assetStore.getByImageUrl(newUrl);
    const list2 = assetStore.getAdoptedAssets();
    check(list2.some(a => a.url === newUrl), 'getByImageUrl 读路径反哺 urlByKey');
    Backend.loadAssets = async () => ({ status: 'empty' });
  });

  // ══════════════ AC-8：dirty + 持久化 ══════════════
  await section('B1: adopt 置 dirty（X2）', async () => {
    reset();
    flowState.dirty = false;
    assetStore.adoptByUrl('data:image/png;base64,EEE5', 'n1');
    check(flowState.dirty === true, '采纳后 flowState.dirty = true（顶栏未保存）');
  });

  await section('B2: _persist degraded → 人话 toast（非报错）', async () => {
    reset();
    Backend.saveAssets = async () => ({ status: 'success', degraded: true, message: '请先在设置中配置图片保存路径' });
    assetStore.adoptByUrl('data:image/png;base64,FFF6', 'n2');
    await tick(400); // 防抖 300ms
    check(toasts.some(t => t.msg === '请先在设置中配置图片保存路径'), 'degraded 消费为「请先在设置中配置图片保存路径」toast');
    check(!toasts.some(t => t.msg === '资产索引保存失败'), '不出现「资产索引保存失败」报错');
    Backend.saveAssets = realSaveAssets;
  });

  await section('B3: _persist 成功 → 不 toast', async () => {
    reset();
    Backend.saveAssets = async () => ({ status: 'success' });
    assetStore.adoptByUrl('data:image/png;base64,GGG7', 'n3');
    await tick(400);
    check(!toasts.some(t => t.msg.includes('资产索引') || t.msg.includes('保存路径')), '成功路径无 toast（静默落盘）');
    Backend.saveAssets = realSaveAssets;
  });

  // ══════════════ AC-5：历史图库移除采纳/锁定动作 ══════════════
  await section('C1: history-drawer 卡片无采纳/锁定动作、保留复现 + 只读角标', async () => {
    reset();
    const url = 'data:image/png;base64,HHH8';
    const node = flowState.addNode('image-gen', 0, 0, { imageUrl: url, ratio: 4 / 3 });
    assetStore.adoptByUrl(url, node.id);
    // init 已在 main() 顶部统一调用
    historyDrawer.addImage(url, { nodeId: node.id, prompt: 'p', model: 'm' });
    const grid = byId.get('history-grid');
    const card = grid.children[grid.children.length - 1];
    const html = card.innerHTML;
    check(html.includes('data-act="reproduce"'), '保留「复现」动作按钮');
    check(!html.includes('data-act="adopt"') && !html.includes('data-act="unadopt"') && !html.includes('data-act="lock"'),
      '无 采纳/取消采纳/锁定 动作按钮（S1）');
    check(html.includes('ht-badge adopt'), '已采纳只读角标保留（S2）');
  });

  // ══════════════ AC-6：资产库抽屉 ══════════════
  await section('D1: asset-drawer 空态文案', async () => {
    reset();
    assetDrawer['render'](); // 触发空态渲染（生产由 init/订阅驱动）
    const emptyEl = byId.get('asset-empty');
    check(emptyEl.textContent === '还没有采纳的图。在画布或对比面板采纳满意的成图后，会出现在这里。',
      '空态文案可见（S6）');
    check(emptyEl.style.display === 'block', '空态元素显示');
  });

  await section('D2: asset-drawer 采纳后渲染 + 四动作 + 计数', async () => {
    reset();
    // init 已在 main() 顶部统一调用
    const url = 'data:image/png;base64,III9';
    const node = flowState.addNode('image-gen', 0, 0, { imageUrl: url });
    assetStore.adoptByUrl(url, node.id, { prompt: '绣球花', model: 'g-2', aspectRatio: '3:4' });
    const grid = byId.get('asset-grid');
    check(grid.children.length === 1, '采纳后资产库渲染 1 张卡');
    const card = grid.children[0];
    const html = card.innerHTML;
    check(html.includes('data-act="unadopt"'), '取消采纳按钮');
    check(html.includes('data-act="lock"'), '锁定/解锁按钮');
    check(html.includes('data-act="view"'), '查看按钮');
    check(html.includes('data-act="reproduce"'), '复现按钮');
    check(html.includes('ht-badge adopt'), '已采纳角标');
    check(byId.get('asset-empty').style.display === 'none', '有资产时隐藏空态');
    check(byId.get('asset-count').textContent === '(1)', '计数 (1)');
    // 搜索无匹配 → 「无匹配资产」
    assetDrawer['query'] = '不存在的关键词';
    assetDrawer['render']();
    check(byId.get('asset-empty').textContent === '无匹配资产', '搜索无结果 → 无匹配资产');
    assetDrawer['query'] = '';
    assetDrawer['render']();
  });

  await section('D3: asset-drawer 搜索命中 prompt/model/tags（S8）', async () => {
    reset();
    // init 已在 main() 顶部统一调用
    const n1 = flowState.addNode('image-gen', 0, 0, { imageUrl: 'data:image/png;base64,JJ10' });
    const n2 = flowState.addNode('image-gen', 0, 0, { imageUrl: 'data:image/png;base64,KK11' });
    assetStore.adoptByUrl('data:image/png;base64,JJ10', n1.id, { prompt: '花园玫瑰', model: 'g-2' });
    assetStore.adoptByUrl('data:image/png;base64,KK11', n2.id, { prompt: '夜景', model: 'g-5' });
    assetDrawer['query'] = '玫瑰';
    assetDrawer['render']();
    check(byId.get('asset-grid').children.length === 1, '按 prompt 过滤命中 1 张');
    assetDrawer['query'] = 'g-5';
    assetDrawer['render']();
    check(byId.get('asset-grid').children.length === 1, '按 model 过滤命中 1 张');
    assetDrawer['query'] = '';
    assetDrawer['render']();
  });

  await section('D4: _toEntry 用 meta 构造 HistoryEntry（S9 复现数据）', async () => {
    reset();
    const url = 'data:image/png;base64,LL12';
    const node = flowState.addNode('image-gen', 0, 0, { imageUrl: url });
    assetStore.adoptByUrl(url, node.id, { prompt: 'p1', model: 'm1', aspectRatio: '1:1', resolution: '4k', count: 2, outputType: 'outpaint' });
    const entry = assetDrawer['_toEntry'](assetStore.getAdoptedAssets()[0]);
    check(entry.kind === 'image' && entry.prompt === 'p1' && entry.model === 'm1', 'meta 构造 entry');
    check(entry.aspectRatio === '1:1' && entry.resolution === '4k' && entry.count === 2, 'meta 比例/分辨率/张数');
    check(entry.outputType === 'outpaint', 'outputType 透传');
  });

  // ══════════════ X1：订阅驱动双向刷新 ══════════════
  await section('E1: assetStore 变更 → history-drawer 只读角标即时刷新（X1）', async () => {
    reset();
    // init 已在 main() 顶部统一调用
    const url = 'data:image/png;base64,MM13';
    const node = flowState.addNode('image-gen', 0, 0, { imageUrl: url, ratio: 4 / 3 });
    historyDrawer.addImage(url, { nodeId: node.id });
    let card = byId.get('history-grid').children[0];
    check(!card.innerHTML.includes('ht-badge adopt'), '采纳前无角标');
    assetStore.adoptByUrl(url, node.id);
    await tick();
    card = byId.get('history-grid').children[0];
    check(card.innerHTML.includes('ht-badge adopt'), '采纳后历史图库角标即时出现（X1）');
  });

  const allFail = failed;
  console.log(`\n══════════════════════════════════`);
  console.log(`QA 独立前端验证：通过 ${passed} 项，失败 ${allFail} 项`);
  if (failures.length) { console.log('失败项:'); failures.forEach(f => console.log('  - ' + f)); }
  console.log(allFail ? 'QA-FRONTEND FAIL' : 'QA-FRONTEND PASS');
  process.exit(allFail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(2); });
