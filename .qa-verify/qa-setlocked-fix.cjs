// QA 独立验证：asset-store.setLocked() nodeId 冗余更新缺陷修复（一行级）
// 作者：Edward (QA) — 独立设计，不复用工程师用例
// 缺陷：记录已存在时只置 locked 标志、不更新 nodeId →
//       adoptByUrl(url, nodeA) 后 setLockedByUrl(url, nodeB, true) → isLockedNode(nodeB) 为 false → 锁定保护漏判。
// 修复：命中已存在记录的分支补 else if (nodeId) { rec.nodeId = nodeId; }（空串不覆盖，与 _getOrCreate 一致）。
//
// 验证范围：
//   F1 核心修复：adoptByUrl(url,nodeA) → setLockedByUrl(url,nodeB,true) → isLockedNode(nodeB)===true，nodeId 已更新为 nodeB
//   F2 边界-空 nodeId：记录已存在时 setLockedByUrl(url,'',true) 不覆盖已有 nodeId
//   F3 边界-空 nodeId 且无记录：setLockedByUrl(url,'',true) 新建记录 nodeId=''（不抛错）
//   F4 边界-无记录解锁：直接返回，不建空记录
//   F5 边界-无记录锁定：走 _getOrCreate 新建，nodeId 正确写入
//   F6 回归-锁定/解锁标志切换：locked 翻转、重复置同一值不触发 _afterChange
//   F7 回归-变更副作用：_afterChange → dirty/updatedAt + notify + 防抖落盘
//   F8 回归-adopt 路径：adopt 后 adopted+locked 语义不变，unadopt 保留锁定，nodeId 写入
//   F9 回归-持久化往返：list() 携带修复后 nodeId，loadFromBackend 恢复后 isLockedNode 仍命中
// 运行：先 npx tsc -p tsconfig.smoke.json --outDir .icv-smoke 再 node .qa-verify/qa-setlocked-fix.cjs

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
const { flowHistory } = require(`${BASE}/state/history.js`);
const { assetStore } = require(`${BASE}/asset-store.js`);
const { historyPersist } = require(`${BASE}/history-persist.js`);
const { Backend } = require(`${BASE}/api.js`);

const realSaveAssets = Backend.saveAssets;
const realLoadAssets = Backend.loadAssets;

function reset(over = {}) {
  flowState.replaceAll({
    format: 'icv', version: '3.4', projectName: 't', canvas: { scale: 1, panX: 0, panY: 0 },
    nodes: [], edges: [], createdAt: 0, updatedAt: 0, ...over,
  });
  flowHistory.clear();
  assetStore['records'].clear();
}

// 清掉防抖定时器，避免跨用例干扰
function flushPersistTimer() {
  if (assetStore['persistTimer'] !== null) {
    clearTimeout(assetStore['persistTimer']);
    assetStore['persistTimer'] = null;
  }
}

async function main() {
  // ═══════════════ F1 核心修复：nodeId 冗余随写更新 ═══════════════
  await section('F1: adoptByUrl(nodeA) → setLockedByUrl(nodeB) → isLockedNode(nodeB) 命中 + nodeId 更新', () => {
    reset();
    const url = 'data:image/png;base64,F1CORE';
    const nodeA = flowState.addNode('image-gen', 0, 0, { imageUrl: url });
    const nodeB = flowState.addNode('image-gen', 400, 0);
    assetStore.adoptByUrl(url, nodeA.id);
    // 缺陷复现场景：锁定调用携带新节点 nodeB
    assetStore.setLockedByUrl(url, nodeB.id, true);
    check(assetStore.isLockedNode(nodeB.id) === true, 'isLockedNode(nodeB) === true（修复后锁定保护不漏判）');
    const rec = assetStore.getByImageUrl(url);
    check(rec !== null && rec.nodeId === nodeB.id, `记录 nodeId 已更新为 nodeB（实际 "${rec && rec.nodeId}"）`);
    check(rec !== null && rec.locked === true && rec.adopted === true, '锁定/采纳标志保持不变');
    // 旧节点 nodeA 不再命中（nodeId 已迁移）
    check(assetStore.isLockedNode(nodeA.id) === false, '旧节点 nodeA 不再命中（nodeId 迁移）');
  });

  // ═══════════════ F2 边界：空 nodeId 不覆盖已有值 ═══════════════
  await section('F2: 记录已存在时 setLockedByUrl(url,"",true) 不覆盖已有 nodeId', () => {
    reset();
    const url = 'data:image/png;base64,F2EMPTY';
    const nodeA = flowState.addNode('image-gen', 0, 0, { imageUrl: url });
    assetStore.adoptByUrl(url, nodeA.id);
    assetStore.setLockedByUrl(url, '', true); // 空串（无节点上下文）
    const rec = assetStore.getByImageUrl(url);
    check(rec !== null && rec.nodeId === nodeA.id, `空 nodeId 不覆盖已有 nodeId（实际 "${rec && rec.nodeId}"）`);
    check(assetStore.isLockedNode(nodeA.id) === true, 'isLockedNode(nodeA) 仍命中');
    check(rec !== null && rec.locked === true, '锁定标志正常置 true');
  });

  // ═══════════════ F3 边界：无记录 + 空 nodeId 锁定 → 新建记录 nodeId='' ═══════════════
  await section('F3: 无记录 setLockedByUrl(url,"",true) 新建记录 nodeId=""（不抛错）', () => {
    reset();
    const url = 'data:image/png;base64,F3NEWEMPTY';
    assetStore.setLockedByUrl(url, '', true);
    const rec = assetStore.getByImageUrl(url);
    check(rec !== null, '无记录锁定时新建记录');
    check(rec !== null && rec.nodeId === '', `新建记录 nodeId 为 ""（实际 "${rec && rec.nodeId}"）`);
    check(rec !== null && rec.locked === true, '新建记录 locked=true');
    check(assetStore.list().length === 1, 'store 仅 1 条记录');
  });

  // ═══════════════ F4 边界：无记录解锁直接返回 ═══════════════
  await section('F4: 无记录 setLockedByUrl(url,"n",false) 直接返回不建空记录', () => {
    reset();
    assetStore.setLockedByUrl('data:image/png;base64,F4NOPE', 'n1', false);
    check(assetStore.list().length === 0, '无记录解锁不产生空记录');
    check(assetStore.isLockedNode('n1') === false, 'isLockedNode 仍 false');
  });

  // ═══════════════ F5 边界：无记录锁定 → _getOrCreate 新建，nodeId 正确写入 ═══════════════
  await section('F5: 无记录 setLockedByUrl(url,"n2",true) 新建记录 nodeId 正确写入', () => {
    reset();
    const url = 'data:image/png;base64,F5NEW';
    assetStore.setLockedByUrl(url, 'n2', true);
    const rec = assetStore.getByImageUrl(url);
    check(rec !== null && rec.nodeId === 'n2', `新建记录 nodeId === "n2"（实际 "${rec && rec.nodeId}"）`);
    check(rec !== null && rec.locked === true && rec.adopted === false, '新建记录 locked=true / adopted=false（未采纳单独锁定语义）');
    check(assetStore.isLockedNode('n2') === true, 'isLockedNode(n2) 立即命中');
    check(rec !== null && rec.imageUrl === url, '新建记录 imageUrl 写入（urlByKey 反哺）');
  });

  // ═══════════════ F6 回归：锁定/解锁标志切换 ═══════════════
  await section('F6: locked 标志切换 + 重复置同值不触发 _afterChange', () => {
    reset();
    const url = 'data:image/png;base64,F6TOGGLE';
    const node = flowState.addNode('image-gen', 0, 0, { imageUrl: url });
    flowState.dirty = false;
    flowState.updatedAt = 0;
    // 解锁 → 锁定 → 再锁定（同值）
    assetStore.setLockedByUrl(url, node.id, true);
    check(assetStore.isLockedByImageUrl(url) === true, '锁定 true');
    const upd1 = flowState.updatedAt;
    assetStore.setLockedByUrl(url, node.id, true); // 同值 → 无变更
    check(assetStore.isLockedByImageUrl(url) === true, '重复锁定仍为 true');
    check(flowState.updatedAt === upd1, '重复置同值不触发 _afterChange（updatedAt 不变）');
    assetStore.setLockedByUrl(url, node.id, false);
    check(assetStore.isLockedByImageUrl(url) === false, '解锁 false');
    check(flowState.dirty === true, '解锁计入 dirty（X2）');
    // 解锁后再解锁（同值 false）
    const upd2 = flowState.updatedAt;
    assetStore.setLockedByUrl(url, node.id, false);
    check(flowState.updatedAt === upd2, '重复解锁不触发 _afterChange');
    // nodeId 在解锁时同样随写更新（nodeId 冗余逻辑对 locked=false 也生效）
    const nodeC = flowState.addNode('image-gen', 800, 0);
    assetStore.setLockedByUrl(url, nodeC.id, false);
    check(assetStore.getByImageUrl(url).nodeId === nodeC.id, '解锁路径 nodeId 同样随写更新');
  });

  // ═══════════════ F7 回归：_afterChange → dirty/notify/防抖落盘 ═══════════════
  await section('F7: setLocked 变更触发 notify + 防抖落盘（X2）', async () => {
    reset();
    const url = 'data:image/png;base64,F7PERSIST';
    const node = flowState.addNode('image-gen', 0, 0, { imageUrl: url });
    let notifies = 0;
    const unsub = assetStore.subscribe(() => { notifies += 1; });
    let saved = null;
    Backend.saveAssets = async (records) => { saved = records; return { status: 'success' }; };
    // 无记录锁定（走 _getOrCreate 分支）
    assetStore.setLockedByUrl(url, node.id, true);
    check(notifies >= 1, '锁定变更触发 assetStore.notify');
    check(flowState.dirty === true, '锁定变更置 dirty');
    await tick(400);
    check(saved !== null && Array.isArray(saved), '防抖后 saveAssets 被调用');
    check(saved.length === 1 && saved[0].locked === true && saved[0].nodeId === node.id, `落盘记录 locked=true 且 nodeId=${node.id}（实际 "${saved && saved[0] && saved[0].nodeId}"）`);
    unsub();
    Backend.saveAssets = realSaveAssets;
    flushPersistTimer();
  });

  // ═══════════════ F8 回归：adopt 路径不受影响 ═══════════════
  await section('F8: adopt 语义不变（adopted+locked、unadopt 保留锁定、nodeId 写入）', () => {
    reset();
    const url = 'data:image/png;base64,F8ADOPT';
    const node = flowState.addNode('image-gen', 0, 0, { imageUrl: url });
    assetStore.adoptByUrl(url, node.id);
    check(assetStore.isAdoptedByImageUrl(url) === true, 'adopt → adopted=true');
    check(assetStore.isLockedByImageUrl(url) === true, 'adopt → 自动锁定（B2）');
    check(assetStore.isLockedNode(node.id) === true, 'adopt → isLockedNode 命中');
    check(assetStore.getByImageUrl(url).nodeId === node.id, 'adopt → nodeId 写入');
    assetStore.unadoptByUrl(url);
    check(assetStore.isAdoptedByImageUrl(url) === false, 'unadopt → adopted=false');
    check(assetStore.isLockedByImageUrl(url) === true, 'unadopt 保留锁定');
    check(assetStore.isLockedNode(node.id) === true, 'unadopt 后 isLockedNode 仍命中');
  });

  // ═══════════════ F9 回归：持久化往返后 isLockedNode 仍命中 ═══════════════
  await section('F9: list()/loadFromBackend 往返保留 nodeId，isLockedNode 恢复命中', async () => {
    reset();
    const url = 'data:image/png;base64,F9ROUND';
    const nodeA = flowState.addNode('image-gen', 0, 0, { imageUrl: url });
    const nodeB = flowState.addNode('image-gen', 400, 0);
    assetStore.adoptByUrl(url, nodeA.id);
    assetStore.setLockedByUrl(url, nodeB.id, true); // 核心修复场景
    const snap = assetStore.list();
    check(snap.length === 1 && snap[0].nodeId === nodeB.id, `list() 携带修复后 nodeId（实际 "${snap[0].nodeId}"）`);
    // 模拟后端往返
    Backend.loadAssets = async () => ({ status: 'success', records: snap });
    await assetStore.loadFromBackend();
    check(assetStore.isLockedNode(nodeB.id) === true, '恢复后 isLockedNode(nodeB) 命中');
    check(assetStore.isLockedByImageUrl(url) === true, '恢复后 isLockedByImageUrl 命中');
    Backend.loadAssets = realLoadAssets;
  });

  console.log(`\n══════════════════════════════════`);
  console.log(`setLocked 修复专项验证：通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) {
    console.error('失败明细：');
    failures.forEach(f => console.error(`- ${f}`));
    process.exit(1);
  }
  console.log('SETLOCKED-FIX PASS');
}

main().catch(e => { console.error(e); process.exit(1); });
