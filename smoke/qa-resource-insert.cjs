// Phase 2 统一资源侧栏回归：资源/历史插入规则统一（resource-insert）与资产库行为。
// 覆盖验收用例（规范 Phase 2 + R-01/R-02/R-03）：
//   1. 从资源拖入空白画布 → 出现素材节点，未触发生成；
//   2. 从历史放到画布 → 可预览、可继续创作；
//   3. 从资源拖到当前图片生成节点 → 只增加一个参考图，不创建意外节点；
//   4. 历史图片「保存到资源」后资源页即时出现；移出资源不删历史；
//   另覆盖：历史「继续创作」= 先放素材节点再 createContinueStep；提示词库共享 store 收藏/去重。
// 运行：
//   node node_modules/typescript/bin/tsc -p tsconfig.smoke.json --outDir .icv-qa-current
//   node smoke/qa-resource-insert.cjs

'use strict';

const path = require('path');
const BASE = path.resolve(process.argv[2] || path.join(process.cwd(), '.icv-qa-current', 'v1'));

function makeEl(over = {}) {
  const el = {
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    style: {}, dataset: {}, value: '', disabled: false, title: '', children: [],
    addEventListener() {}, removeEventListener() {}, appendChild(child) { this.children.push(child); return child; },
    remove() {}, setAttribute() {}, removeAttribute() {}, focus() {}, select() {}, click() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    ...over,
  };
  let html = '';
  Object.defineProperty(el, 'innerHTML', { get: () => html, set: value => { html = String(value); }, configurable: true });
  return el;
}

const byId = new Map([['toast', makeEl()], ['ctx-menu', makeEl()]]);
global.pywebview = { api: {
  append_history: async () => ({ status: 'success' }),
  load_local_image: async () => ({ status: 'error' }),
  load_assets: async () => ({ status: 'success', records: [] }),
  save_assets: async () => ({ status: 'success' }),
  load_prompts_library: async () => ({ status: 'success', data: { common: [], skill: [], draw: [], favorites: [] } }),
  save_prompts_library: async () => ({ status: 'success' }),
} };
global.window = {
  addEventListener() {}, removeEventListener() {}, close() {},
  setTimeout, clearTimeout, setInterval() { return 1; }, clearInterval() {},
  requestAnimationFrame: fn => fn(),
  innerWidth: 1280, innerHeight: 800, pywebview: global.pywebview,
};
global.Image = class {
  set onload(fn) { this._onload = fn; }
  get onload() { return this._onload; }
  set onerror(fn) { this._onerror = fn; }
  get onerror() { return this._onerror; }
  set src(value) { this._src = value; if (this._onload) this._onload(); }
  get src() { return this._src || ''; }
  get naturalWidth() { return 800; }
  get naturalHeight() { return 600; }
};
global.document = {
  getElementById: id => byId.get(id) || null,
  createElement: tag => tag === 'canvas'
    ? makeEl({ width: 0, height: 0, getContext: () => ({ fillStyle: '', fillRect() {}, drawImage() {} }), toDataURL: () => 'data:image/png;base64,COMPOSED' })
    : makeEl(),
  createElementNS: () => makeEl(),
  addEventListener() {}, removeEventListener() {},
  body: makeEl(), documentElement: makeEl(),
  querySelector() { return null; }, querySelectorAll() { return []; }, elementFromPoint() { return null; }, activeElement: null,
};
const localValues = new Map([['icv_prompt_library', JSON.stringify(['已保存的旧提示词'])]]);
global.localStorage = {
  getItem(key) { return localValues.get(key) || null; },
  setItem(key, value) { localValues.set(key, String(value)); },
  removeItem(key) { localValues.delete(key); },
};

const { nodeRegistry } = require(path.join(BASE, 'nodes/node-registry.js'));
require(path.join(BASE, 'nodes/image-gen.js'));
require(path.join(BASE, 'nodes/text-gen.js'));
require(path.join(BASE, 'nodes/text-split.js'));
const { flowState } = require(path.join(BASE, 'state/flow-state.js'));
const { selection } = require(path.join(BASE, 'state/selection.js'));
const { flowHistory } = require(path.join(BASE, 'state/history.js'));
const { assetStore } = require(path.join(BASE, 'asset-store.js'));
const { historyDrawer } = require(path.join(BASE, 'ui/history-drawer.js'));
const resourceInsert = require(path.join(BASE, 'ui/resource-insert.js'));
const { interactions } = require(path.join(BASE, 'canvas/interactions.js'));
const { canContinueFrom } = require(path.join(BASE, 'ui/action-bar.js'));
const { promptLibraryStore } = require(path.join(BASE, 'ui/prompt-library.js'));
const { promptTab } = require(path.join(BASE, 'ui/prompt-tab.js'));

let passed = 0;
const fail = message => { throw new Error(message); };
const check = (condition, message) => { if (!condition) fail(message); passed += 1; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function reset() {
  flowState.nodes = [];
  flowState.edges = [];
  flowState.selectedIds.clear();
  flowHistory.clear();
  assetStore['records'].clear();
  assetStore['urlByKey'].clear();
  assetStore['metaByKey'].clear();
  historyDrawer['items'] = [];
}

async function main() {
  // ── 验收 1：从资源拖入空白画布 → 素材节点，未触发生成 ──
  reset();
  const node = resourceInsert.insertImageAsAsset('data:image/png;base64,RES', null, { x: 100, y: 200 }, { ratio: 4 / 3 });
  check(!!node, '资源插入：创建节点');
  check(node && node.isAsset === true, '资源插入：isAsset=true');
  check(node && node.imageUrl === 'data:image/png;base64,RES', '资源插入：imageUrl 正确');
  check(node && node.status === 'idle', '资源插入：状态 idle（未触发生成）');
  check(flowState.edges.length === 0, '资源插入：未创建连线');
  check(flowState.nodes.length === 1, '资源插入：仅 1 个节点');
  check(selection.single()?.id === node?.id, '资源插入：自动选中');

  // 拖拽落点（interactions._dropImage 空白路径 → 同一 resource-insert 素材创建）
  reset();
  await interactions['_dropImage']('data:image/png;base64,DRAG', { x: 300, y: 300 }, 100, 100);
  check(flowState.nodes.length === 1, '拖拽空白：创建 1 个节点');
  check(flowState.nodes[0].isAsset === true, '拖拽空白：isAsset=true');
  check(flowState.edges.length === 0, '拖拽空白：未触发生成/未连线');

  // ── 验收 2：从历史放到画布 → 可预览、可继续创作 ──
  reset();
  const histItem = {
    src: 'data:image/png;base64,HIST', timestamp: 123, kind: 'image', prompt: '花园', model: 'm',
    aspectRatio: '3:4', resolution: '2k', width: 800, height: 600, originalPath: 'C:/img/h.png',
  };
  const histNode = resourceInsert.insertHistoryImageToCanvas(histItem, { x: 50, y: 60 });
  check(!!histNode && histNode.isAsset === true, '历史放到画布：创建素材节点');
  check(!!histNode && histNode.imageUrl === 'data:image/png;base64,HIST', '历史放到画布：展示图正确');
  check(!!histNode && histNode.imageOrigin && histNode.imageOrigin.path === 'C:/img/h.png', '历史放到画布：原图引用带入');
  check(!!histNode && !!histNode.imageUrl, '历史放到画布：可预览（有图）');
  check(!!histNode && canContinueFrom(histNode), '历史放到画布：可继续创作');

  // ── 验收 3：拖到当前图片生成节点 → 只增加一个参考图，不创建意外节点 ──
  reset();
  const gen = flowState.addNode('image-gen', 0, 0, {
    params: { prompt: 'x', model: 'm', aspectRatio: '3:4', resolution: '2k', count: 1 },
  });
  const beforeCount = flowState.nodes.length;
  selection.select(gen.id);
  const ok = resourceInsert.attachImageToSelectedGeneration('data:image/png;base64,REF');
  check(ok === true, '拖到生成节点：挂载成功');
  check(flowState.getNode(gen.id).refImages.length === 1, '拖到生成节点：refImages 仅增 1');
  check(flowState.getNode(gen.id).refImages[0] === 'data:image/png;base64,REF', '拖到生成节点：参考图 URL 正确');
  check(flowState.nodes.length === beforeCount, '拖到生成节点：未创建意外节点');
  check(flowState.edges.length === 0, '拖到生成节点：未创建连线');
  check(flowState.getNode(gen.id).status === 'stale', '拖到生成节点：目标标 stale（待重跑，不自动生成）');
  flowHistory.undo();
  check(flowState.getNode(gen.id).refImages.length === 0, '拖到生成节点：撤销后移除参考图');
  check(flowState.getNode(gen.id).status === 'idle', '拖到生成节点：撤销后恢复原状态');

  // 素材节点拒绝接收参考图
  const assetNode = resourceInsert.insertImageAsAsset('data:image/png;base64,A2', null, { x: 0, y: 0 });
  selection.select(assetNode.id);
  const ok2 = resourceInsert.attachImageToSelectedGeneration('data:image/png;base64,REF2');
  check(ok2 === false, '拖到素材节点：拒绝');
  check(flowState.getNode(assetNode.id).refImages.length === 0, '拖到素材节点：不挂参考图');

  // ── 验收 4：历史「保存到资源」→ 资源页即时出现；移出资源不删历史 ──
  reset();
  const saveHist = {
    src: 'data:image/png;base64,SAVE', timestamp: 456, kind: 'image', nodeId: 'n1', prompt: '绣球花',
    model: 'm', aspectRatio: '3:4', resolution: '2k', count: 1, originalPath: 'C:/img/s.png',
  };
  historyDrawer['items'] = [saveHist];
  let notified = 0;
  const unsub = assetStore.subscribe(() => { notified += 1; });
  assetStore.addByUrl(saveHist.src, saveHist.nodeId, {
    prompt: saveHist.prompt, model: saveHist.model, aspectRatio: saveHist.aspectRatio,
    resolution: saveHist.resolution, count: saveHist.count,
  }, saveHist.originalPath);
  check(assetStore.getAssets().some(a => a.url === saveHist.src), '保存到资源：资源页出现该图');
  const rec = assetStore.getByImageUrl(saveHist.src);
  check(!!rec && rec.prompt === '绣球花' && rec.model === 'm', '保存到资源：配方带入');
  check(notified >= 1, '保存到资源：store 通知订阅者（资源页即时刷新机制）');
  unsub();

  // 移出资源只移除索引，不删历史
  assetStore.removeByUrl(saveHist.src);
  check(assetStore.getAssets().length === 0, '移出资源：资源页移除');
  check(historyDrawer['items'].some(i => i.src === saveHist.src), '移出资源：历史保留');
  check(historyDrawer['items'].length === 1, '移出资源：历史条目数不变');

  // ── 附加：历史「继续创作」= 先放素材节点，再走统一 createContinueStep ──
  reset();
  await resourceInsert.startCreateFromResource('data:image/png;base64,CONT', {
    ratio: 4 / 3, originalPath: 'C:/img/c.png',
  });
  const contAsset = flowState.nodes.find(n => n.isAsset === true);
  const contStep = flowState.nodes.find(n => !n.isAsset);
  check(!!contAsset && contAsset.imageUrl === 'data:image/png;base64,CONT', '继续创作：先放素材节点');
  check(!!contStep && contStep.type === 'image-gen', '继续创作：创建下一步');
  check(!!contStep && contStep.params.prompt === '', '继续创作：新步骤提示词为空');
  check(!!contAsset && !!contStep && flowState.edges.some(e => e.from === contAsset.id && e.to === contStep.id), '继续创作：素材→步骤 已连线');
  check(!!contStep && flowState.getReferenceImages(contStep.id).includes('data:image/png;base64,CONT'), '继续创作：来源图进入参考上下文');
  check(!!contAsset && !!contStep && contStep.x === contAsset.x + 260 + 48, '继续创作：步骤位于素材右侧');
  flowHistory.undo();
  check(flowState.nodes.length === 0, '继续创作：一次撤销同时移除素材与下一步');
  check(flowState.edges.length === 0, '继续创作：一次撤销同时移除连线');

  // ── 附加：提示词库共享 store（收藏 / 去重 / 订阅） ──
  promptTab.init();
  await tick();
  check(promptLibraryStore.list().includes('已保存的旧提示词'), '提示词页签：初始化时加载既有收藏');
  const saved = await promptLibraryStore.savePrompt('雨夜霓虹');
  check(saved === true, '提示词库：收藏成功');
  check(promptLibraryStore.list().includes('雨夜霓虹'), '提示词库：列表包含新收藏');
  const duplicated = await promptLibraryStore.savePrompt('雨夜霓虹');
  check(duplicated === false, '提示词库：重复收藏拒绝');
  const savedEmpty = await promptLibraryStore.savePrompt('   ');
  check(savedEmpty === false, '提示词库：空文本拒绝');
  check(promptLibraryStore.contains('雨夜霓虹'), '提示词库：contains 命中');

  console.log(`Phase 2 资源侧栏回归通过：${passed} 项断言`);
}

main().catch(error => { console.error(`Phase 2 资源侧栏回归失败：${error.message}`); process.exit(1); });
