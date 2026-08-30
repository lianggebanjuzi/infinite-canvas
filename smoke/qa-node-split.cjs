// smoke/qa-node-split.cjs
// 当前 3.4 节点工作流回归：持久化迁移、端口契约、引用解析、插入步骤与文本执行。
// 图片批次、素材层、媒体任务另由各自的 smoke 覆盖；本脚本不再依赖已移除的 4.0 image/text/gen 模型。

'use strict';

const path = require('path');
const BASE = process.env.ICV_SMOKE_BASE
  ? path.resolve(process.env.ICV_SMOKE_BASE)
  : path.resolve(__dirname, '..', '.icv-smoke', 'v1');

function makeEl(over = {}) {
  return {
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    style: {}, dataset: {}, value: '', disabled: false, children: [],
    addEventListener() {}, removeEventListener() {}, appendChild(child) { this.children.push(child); return child; },
    remove() {}, setAttribute() {}, removeAttribute() {}, focus() {}, select() {}, click() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; },
    isConnected: true,
    ...over,
  };
}

const byId = new Map([['toast', makeEl()]]);
global.pywebview = { api: {} };
global.window = {
  addEventListener() {}, removeEventListener() {}, close() {}, setTimeout, clearTimeout,
  setInterval() { return 1; }, clearInterval() {}, innerWidth: 1280, innerHeight: 800,
  pywebview: global.pywebview,
};
global.Image = class {
  set onload(fn) { this._onload = fn; }
  get onload() { return this._onload; }
  set onerror(fn) { this._onerror = fn; }
  get onerror() { return this._onerror; }
  set src(_value) { this._onload?.(); }
  get naturalWidth() { return 800; }
  get naturalHeight() { return 600; }
};
global.document = {
  getElementById: id => byId.get(id) || null,
  createElement: () => makeEl(), createElementNS: () => makeEl(),
  addEventListener() {}, removeEventListener() {}, body: makeEl(), documentElement: makeEl(),
  querySelector() { return null; }, querySelectorAll() { return []; }, elementFromPoint() { return null; },
  activeElement: null,
};
global.localStorage = (() => {
  const store = new Map();
  return { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key), clear: () => store.clear() };
})();
try { Object.defineProperty(global, 'navigator', { value: { clipboard: undefined }, configurable: true }); } catch { /* 旧 Node 可写 */ }

let passed = 0;
let failed = 0;
const failures = [];
function check(condition, message) {
  if (condition) { passed += 1; console.log(`  ✓ ${message}`); }
  else { failed += 1; failures.push(message); console.error(`  ✗ ${message}`); }
}
async function section(title, fn) {
  console.log(`\n▶ ${title}`);
  try { await fn(); }
  catch (error) {
    failed += 1;
    failures.push(`${title}: ${error.message}`);
    console.error(`  ✗ 异常: ${error.message}`);
  }
}

const { nodeRegistry } = require(`${BASE}/nodes/node-registry.js`);
require(`${BASE}/nodes/image-gen.js`);
require(`${BASE}/nodes/text-gen.js`);
require(`${BASE}/nodes/text-split.js`);
const { flowState } = require(`${BASE}/state/flow-state.js`);
const { flowHistory } = require(`${BASE}/state/history.js`);
const { persistence } = require(`${BASE}/persistence.js`);
const { runEngine } = require(`${BASE}/engine/run-engine.js`);
const apiMod = require(`${BASE}/api.js`);

function reset() {
  flowState.replaceAll({
    format: 'icv', version: '3.4', projectName: 'node-split-smoke',
    canvas: { scale: 1, panX: 0, panY: 0 },
    modelDefaults: { drawing: '', chat: '', video: '', audio: '' },
    nodes: [], edges: [], createdAt: 0, updatedAt: 0,
  });
  flowHistory.clear();
}

async function main() {
  await section('S1: 3.4 项目恢复、旧类型过滤与 image-result 迁移', async () => {
    reset();
    const ok = persistence.restore({
      format: 'icv', version: '3.4', projectName: 'restore', canvas: { scale: 1, panX: 2, panY: 3 },
      nodes: [
        { id: 'image', type: 'image-gen', x: 0, y: 0, imageUrl: 'data:image/png;base64,SRC', isAsset: true, params: { prompt: 'p' } },
        { id: 'text', type: 'text-gen', x: 10, y: 0, params: { instruction: '改写', model: 'chat' }, outputText: '原文', textHistory: [{ text: '历史', ts: 1 }, { text: '', ts: 2 }] },
        { id: 'split', type: 'text-split', x: 20, y: 0, params: { delimiter: '#', segments: ['甲', '', '乙'] } },
        { id: 'result', type: 'image-result', x: 30, y: 0, parentId: 'image', imageUrl: 'data:image/png;base64,RESULT', params: { count: 2 } },
        { id: 'legacy', type: 'gen', x: 40, y: 0, params: {} },
      ],
      edges: [
        { id: 'e1', from: 'image', to: 'text' }, { id: 'e2', from: 'text', to: 'split' },
        { id: 'e3', from: 'split', to: 'result' }, { id: 'legacy-edge', from: 'legacy', to: 'image' },
      ], createdAt: 0, updatedAt: 0,
    });
    check(ok === true, '3.4 项目可恢复');
    check(flowState.nodes.length === 4, '已移除的 gen 类型被过滤');
    check(flowState.nodes.every(node => ['image-gen', 'text-gen', 'text-split'].includes(node.type)), '仅当前节点类型保留');
    check(flowState.getNode('result')?.type === 'image-gen' && flowState.getNode('result')?.parentId === 'image', 'image-result 迁移为 image-gen 产出节点');
    check(flowState.getNode('text')?.textHistory.length === 1, '文本历史过滤空条目');
    check(flowState.edges.length === 3 && !flowState.edges.some(edge => edge.id === 'legacy-edge'), '引用被过滤节点的连线被过滤');

    const before = flowState.nodes.length;
    check(persistence.restore({ format: 'icv', version: '4.0', nodes: [] }) === false, '不支持的版本被拒绝');
    check(flowState.nodes.length === before, '拒绝恢复不清空当前画布');
    check(persistence.restore({ format: 'other', version: '3.4', nodes: [] }) === false, '非 icv 格式被拒绝');
    check(persistence.restore({ format: 'icv', version: '3.4', nodes: 'bad' }) === false, '节点非数组被拒绝');
  });

  await section('S2: 直接引用、文本提示词与端口契约', async () => {
    reset();
    const asset = flowState.addNode('image-gen', 0, 0, { isAsset: true, imageUrl: 'data:image/png;base64,SRC', status: 'done' });
    const text = flowState.addNode('text-gen', 300, 0, { params: { model: 'chat', instruction: '描述' }, outputText: '上游文本' });
    const split = flowState.addNode('text-split', 600, 0, { params: { delimiter: '#', segments: ['甲', '乙'] } });
    const image = flowState.addNode('image-gen', 900, 0, { params: { model: 'draw', prompt: '' }, refImages: ['data:image/png;base64,REF'] });
    check(flowState.canConnect(asset.id, text.id) === null, '图片素材可连接文本节点');
    flowState.addEdge(asset.id, text.id);
    flowState.addEdge(text.id, split.id);
    flowState.addEdge(split.id, image.id);
    flowState.addEdge(asset.id, image.id);

    check(JSON.stringify(flowState.getReferenceImages(image.id)) === JSON.stringify(['data:image/png;base64,REF', 'data:image/png;base64,SRC']), '本节点参考图在前，直接上游图片去重保序');
    check(JSON.stringify(flowState.getUpstreamTextPrompts(split.id)) === JSON.stringify(['上游文本']), '上游文本只读取直接相连的文本节点');
    check(JSON.stringify(flowState.getTextSplitSegments(split.id)) === JSON.stringify(['上游文本']), '文本拆分有上游时由上游输出动态派生');
    check(flowState.canConnect(text.id, image.id) === null, '文本可连接图片生成节点');
    check(flowState.canConnect(text.id, text.id) !== null, '自连被拒绝');
    const text2 = flowState.addNode('text-gen', 0, 200, { params: { model: 'chat' } });
    check(flowState.canConnect(text.id, text2.id) !== null, '文本到文本仍被拒绝');
    check(flowState.canConnect(split.id, text2.id) !== null, '文本拆分只能连接图片生成节点');
    check(flowState.canConnect(text.id, asset.id) !== null, '素材节点不可作为输入端');
    check(flowState.canConnect(image.id, asset.id) !== null, '素材输入端口保护适用于图片生成节点');
  });

  await section('S3: 连线中插入当前默认图片生成步骤', async () => {
    reset();
    const source = flowState.addNode('image-gen', 0, 0, { isAsset: true, imageUrl: 'data:image/png;base64,SRC', status: 'done' });
    const target = flowState.addNode('image-gen', 600, 0, { params: { model: 'draw', prompt: '目标' } });
    flowState.addEdge(source.id, target.id);
    const inserted = flowState.insertStep(flowState.edges[0].id);
    check(inserted?.type === 'image-gen', 'insertStep 插入 image-gen');
    check(flowState.edges.length === 2, '原连线拆分为两条');
    check(flowState.edges.some(edge => edge.from === source.id && edge.to === inserted?.id)
      && flowState.edges.some(edge => edge.from === inserted?.id && edge.to === target.id), '插入节点保持上下游连通');
  });

  await section('S4: 文本节点执行写回、图片引用与下游失效', async () => {
    reset();
    const calls = [];
    const originalChat = apiMod.Backend.chatV2;
    apiMod.Backend.chatV2 = async (user, options) => {
      calls.push({ user, options });
      return { text: '处理结果' };
    };
    try {
      const asset = flowState.addNode('image-gen', 0, 0, { isAsset: true, imageUrl: 'data:image/png;base64,SRC', status: 'done' });
      const text = flowState.addNode('text-gen', 300, 0, { params: { model: 'chat-model', instruction: '描述图片' } });
      const target = flowState.addNode('image-gen', 600, 0, { params: { model: 'draw', prompt: '不应覆盖' }, status: 'done' });
      flowState.addEdge(asset.id, text.id);
      flowState.addEdge(text.id, target.id);
      await runEngine.run(text.id);

      const after = flowState.getNode(text.id);
      check(calls.length === 1 && calls[0].user === '描述图片', '文本执行调用 chatV2 并使用命令');
      check(calls[0].options.model === 'chat-model' && calls[0].options.images[0] === 'data:image/png;base64,SRC', '文本执行携带模型与直接上游 data 图片');
      check(after?.status === 'done' && after.outputText === '处理结果', '文本结果写回节点');
      check(flowState.getTextHistory(text.id)[0]?.text === '处理结果', '文本结果写入节点历史');
      check(flowState.getNode(target.id)?.status === 'stale', '文本更新使下游图片节点失效');
      check(flowState.getNode(target.id)?.params.prompt === '不应覆盖', '文本执行不覆盖下游图片提示词');
      check(after?.params.instruction === '描述图片', '文本命令保留，便于修改后重试');
    } finally {
      apiMod.Backend.chatV2 = originalChat;
    }
  });

  await section('S5: 当前节点注册表完整', async () => {
    check(nodeRegistry.get('image-gen').type === 'image-gen', 'image-gen 已注册');
    check(nodeRegistry.get('text-gen').type === 'text-gen', 'text-gen 已注册');
    check(nodeRegistry.get('text-split').type === 'text-split', 'text-split 已注册');
  });

  console.log('\n══════════════════════════════════════');
  console.log(`总断言: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    console.log('失败明细:');
    failures.forEach(message => console.log(`  - ${message}`));
    process.exit(1);
  }
  console.log('ALL PASSED ✓');
}

main().catch(error => { console.error('FATAL:', error); process.exit(1); });
