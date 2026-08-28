// 扩图步骤回归：两个创建入口、参数持久化、运行/重跑、失败后修改重跑，以及结果/历史追溯。
// 运行：
//   node node_modules/typescript/bin/tsc -p tsconfig.smoke.json --outDir .icv-qa-current
//   node smoke/qa-outpaint-workflow.cjs

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
} };
global.window = {
  addEventListener() {}, removeEventListener() {}, close() {},
  setTimeout, clearTimeout, setInterval() { return 1; }, clearInterval() {},
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
global.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };

const { nodeRegistry } = require(path.join(BASE, 'nodes/node-registry.js'));
require(path.join(BASE, 'nodes/image-gen.js'));
require(path.join(BASE, 'nodes/text-gen.js'));
require(path.join(BASE, 'nodes/text-split.js'));
const { flowState } = require(path.join(BASE, 'state/flow-state.js'));
const { selection } = require(path.join(BASE, 'state/selection.js'));
const { historyDrawer } = require(path.join(BASE, 'ui/history-drawer.js'));
const { runEngine } = require(path.join(BASE, 'engine/run-engine.js'));
const { actionBar } = require(path.join(BASE, 'ui/action-bar.js'));
const { outpaintPanel } = require(path.join(BASE, 'ui/outpaint-panel.js'));
const { interactions } = require(path.join(BASE, 'canvas/interactions.js'));
const api = require(path.join(BASE, 'api.js'));
const poller = require(path.join(BASE, 'engine/poller.js'));

let passed = 0;
const fail = message => { throw new Error(message); };
const check = (condition, message) => { if (!condition) fail(message); passed += 1; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function reset() {
  flowState.nodes = [];
  flowState.edges = [];
  flowState.selectedIds.clear();
  historyDrawer.items = [];
}

function sourceNode() {
  return flowState.addNode('image-gen', 0, 0, {
    // 导入图片（素材节点）也必须直接显示并创建扩图入口，不需要先「继续创作」。
    imageUrl: 'data:image/png;base64,SOURCE', status: 'done', isAsset: true,
    params: { prompt: 'source', model: 'demo:gemini-2.5-flash-image', aspectRatio: '4:3', resolution: '2k', count: 1 },
  });
}

async function main() {
  const originalResolve = api.resolveOutpaintModel;
  const originalGenerate = api.Backend.generateImage;
  const originalPoll = poller.pollTask;
  const originalOpenOutpaint = outpaintPanel.open;
  const requests = [];
  const openedOutpaintSteps = [];
  let nextResult = { success: true, imageUrl: 'data:image/png;base64,RESULT-1' };
  api.resolveOutpaintModel = async () => 'demo:gemini-2.5-flash-image';
  api.Backend.generateImage = async (prompt, options) => {
    requests.push({ prompt, options });
    return { task_id: `outpaint-${requests.length}` };
  };
  poller.pollTask = async () => nextResult;
  outpaintPanel.open = async nodeId => {
    openedOutpaintSteps.push(nodeId);
    flowState.updateNodeParams(nodeId, { model: 'demo:gemini-2.5-flash-image' });
  };

  try {
    reset();
    const source = sourceNode();

    // 图片操作条与右键菜单共同调用同一创建函数；这里直接触发两端入口。
    selection.select(source.id);
    actionBar._handleAction('expand');
    await tick();
    let steps = flowState.nodes.filter(node => node.params.mode === 'outpaint');
    check(steps.length === 1, '图片操作条创建扩图步骤');
    let step = steps[0];
    check(openedOutpaintSteps[0] === step.id, '创建后直接打开扩图调节面板');
    check(step.params.model === 'demo:gemini-2.5-flash-image', '扩图模型已预填');
    check(step.params.aspectRatio === '1:1' && step.params.resolution === '4k' && step.params.count === 1, '扩图默认参数正确');
    check(flowState.edges.some(edge => edge.from === source.id && edge.to === step.id), '扩图步骤连接源图');

    interactions._showCardMenu(0, 0, source);
    check(byId.get('ctx-menu').innerHTML.includes('data-act="expand"'), '导入图片的右键菜单直接展示创建扩图步骤');
    interactions._handleMenuAction('expand', source.id);
    await tick();
    steps = flowState.nodes.filter(node => node.params.mode === 'outpaint');
    check(steps.length === 2, '右键菜单创建扩图步骤');

    // 以首个步骤验证比例、原图摆放的持久化，随后直接运行。
    step = steps[0];
    flowState.updateNodeParams(step.id, {
      prompt: '延展为夜晚街景', aspectRatio: '16:9',
      outpaintPlacement: { posX: 120, posY: -60, scale: 1.25 },
    });
    check(step.params.aspectRatio === '16:9' && step.params.outpaintPlacement.posX === 120 && step.params.outpaintPlacement.scale === 1.25, '比例和原图摆放已持久化');

    await runEngine.run(step.id);
    let results = flowState.nodes.filter(node => node.parentId === step.id);
    check(step.status === 'done', '扩图运行成功后步骤为 done');
    check(requests.length === 1 && requests[0].options.aspectRatio === '16:9', '运行使用已保存的目标比例');
    check(requests[0].options.referenceImages[0] === 'data:image/png;base64,COMPOSED', '运行使用合成扩图底图');
    check(requests[0].prompt.includes('白色区域是待补全区域') && requests[0].prompt.includes('夜晚街景'), '运行使用固定扩图提示和用户提示');
    check(results.length === 1 && results[0].trace.outputType === 'outpaint', '产出节点携带 outpaint trace');
    check(historyDrawer.items.length === 1 && historyDrawer.items[0].outputType === 'outpaint', '历史记录写入 outpaint 条目');
    check(historyDrawer.items[0].aspectRatio === '16:9' && historyDrawer.items[0].model === 'demo:gemini-2.5-flash-image', '历史记录与结果节点参数一致');

    // 重跑替换纯引擎结果，但历史保留每次成功记录。
    nextResult = { success: true, imageUrl: 'data:image/png;base64,RESULT-2' };
    await runEngine.run(step.id);
    results = flowState.nodes.filter(node => node.parentId === step.id);
    check(results.length === 1 && results[0].imageUrl.endsWith('RESULT-2'), '重跑替换纯引擎结果节点');
    check(historyDrawer.items.length === 2, '重跑追加历史记录');

    // 失败状态保留在步骤上；修改参数后可恢复运行。
    nextResult = { success: false, error: '模拟服务失败' };
    await runEngine.run(step.id);
    check(step.status === 'fail' && step.error === '模拟服务失败', '失败原因保留在扩图步骤');
    flowState.updateNodeParams(step.id, { prompt: '改为清晨街景' });
    nextResult = { success: true, imageUrl: 'data:image/png;base64,RESULT-3' };
    await runEngine.run(step.id);
    results = flowState.nodes.filter(node => node.parentId === step.id);
    check(step.status === 'done' && step.error === null, '修改后可再次运行并恢复 done');
    check(results.length === 1 && results[0].imageUrl.endsWith('RESULT-3'), '修改后运行生成新结果');
    check(historyDrawer.items.length === 3 && historyDrawer.items.every(item => item.outputType === 'outpaint'), '每次成功均可在历史中追溯');
  } finally {
    api.resolveOutpaintModel = originalResolve;
    api.Backend.generateImage = originalGenerate;
    poller.pollTask = originalPoll;
    outpaintPanel.open = originalOpenOutpaint;
  }

  console.log(`扩图工作流回归通过：${passed} 项断言`);
}

main().catch(error => { console.error(`扩图工作流回归失败：${error.message}`); process.exit(1); });
