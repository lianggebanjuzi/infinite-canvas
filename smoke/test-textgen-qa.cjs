// smoke/test-textgen-qa.cjs
// QA 独立回归（Edward 新鲜视角，不复用工程师断言）：
//   1) 联动覆盖边界：仅直接 image-gen 下游覆盖 / 间接只 stale 不覆盖 / text-gen 下游不覆盖 /
//      产出 image-gen 下游覆盖 prompt+stale / 空文本与异常不覆盖且 fail / 覆盖值 == 反推文本（trim 后）
//   2) 历史独立：去重 / 上限 20 裁尾 / 回填动作（outputText + 覆盖直接 image-gen + stale + toast，不写历史）
//   3) persistence 独立：3.4 往返无损 / 3.2/3.3 兼容补默认 + image-result 迁移 / 3.1 拒绝 / 非法 textHistory 归一 / 非 string outputText 兜底
//   4) 其它：chatV2 images 防御性过滤（仅 data:image）、节点注册唯一、文本卡 HTML 转义
//
// 运行：node smoke/test-textgen-qa.cjs （编译产物在 D:/tmp/icv-test，先 npx tsc -p tsconfig.smoke.json --outDir D:/tmp/icv-test）

'use strict';

// ───────────────────────── DOM/浏览器桩 ─────────────────────────
const stubEl = (over = {}) => ({
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  style: {},
  dataset: {},
  innerHTML: '',
  textContent: '',
  value: '',
  disabled: false,
  addEventListener() {},
  appendChild() {},
  remove() {},
  setAttribute() {},
  removeAttribute() {},
  querySelector() { return null; },
  querySelectorAll() { return []; },
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
  ...over,
});

// toast 追踪：document.getElementById('toast') 返回可观测元素
const toastCalls = [];
const toastEl = stubEl({
  classList: {
    add(cls) { if (cls === 'show') toastCalls.push('show'); },
    remove() {},
    toggle() {},
    contains() { return false; },
  },
  set innerHTML(v) { this._html = v; },
  get innerHTML() { return this._html || ''; },
});
toastEl._html = '';

const byId = new Map([['toast', toastEl]]);
global.window = { addEventListener() {}, innerWidth: 1280, innerHeight: 800 };
global.pywebview = { api: {} };
global.document = {
  getElementById: (id) => (byId.has(id) ? byId.get(id) : null),
  createElement: () => stubEl(),
  createElementNS: () => stubEl(),
  addEventListener() {},
  body: stubEl(),
  querySelector() { return null; },
  querySelectorAll() { return []; },
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
global.Image = class { set src(_v) {} };

const BASE = 'D:/tmp/icv-test/v1';

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
const { nodeRegistry } = require(`${BASE}/nodes/node-registry.js`);
require(`${BASE}/nodes/image-gen.js`);
require(`${BASE}/nodes/text-gen.js`);
const { flowState } = require(`${BASE}/state/flow-state.js`);
const { dirty } = require(`${BASE}/state/dirty.js`);
const { persistence } = require(`${BASE}/persistence.js`);
const { runEngine } = require(`${BASE}/engine/run-engine.js`);
const { Backend } = require(`${BASE}/api.js`);
const { cmdPanel } = require(`${BASE}/ui/cmd-panel.js`);
const { cardView } = require(`${BASE}/canvas/card-view.js`);

// 保留真实实现引用（后续测试需要恢复）
const realChatV2 = Backend.chatV2;

// 测试辅助：构造项目
function mkNode(id, type, over = {}) {
  const base = {
    id, type, x: 0, y: 0, ratio: 0.75, status: 'idle', title: 't',
    params: {}, imageUrl: null, outputText: null, textHistory: [], refImages: [], error: null, lastRunAt: null, parentId: null,
  };
  return { ...base, ...over };
}

function replace(project) {
  flowState.replaceAll({
    format: 'icv', version: '3.4', projectName: 'qa',
    canvas: { scale: 1, panX: 0, panY: 0 },
    ...project,
    createdAt: 0, updatedAt: 0,
  });
}

function setChat(textOrThrow) {
  Backend.chatV2 = async () => {
    if (textOrThrow instanceof Error) throw textOrThrow;
    return { success: true, text: textOrThrow };
  };
}

// ───────────────────────── 用例 ─────────────────────────
async function main() {
  // ================= QA1: 联动覆盖边界 =================
  await section('QA1a: 仅直接 image-gen 下游被覆盖；间接只标 stale 不覆盖；text-gen 下游不覆盖', async () => {
    replace({
      nodes: [
        mkNode('tg', 'text-gen', { params: { instruction: '反推', model: 'p:c' }, refImages: ['data:image/png;base64,x'] }),
        mkNode('dg1', 'image-gen', { params: { prompt: '旧1', model: 'd:m' } }),
        mkNode('dg2', 'image-gen', { params: { prompt: '旧2', model: 'd:m' } }),
        mkNode('dtg', 'text-gen', { params: { instruction: '原指令', model: 'p:c' }, refImages: ['data:image/png;base64,y'] }),
      ],
      edges: [
        { id: 'e1', from: 'tg', to: 'dg1' },
        { id: 'e2', from: 'dg1', to: 'dg2' },   // 间接下游（多跳）
        { id: 'e3', from: 'tg', to: 'dtg' },    // text-gen 下游
      ],
    });
    setChat('  新反推文本  '); // 带首尾空白，验证 trim 后写入
    await runEngine.run('tg');
    const dg1 = flowState.getNode('dg1');
    const dg2 = flowState.getNode('dg2');
    const dtg = flowState.getNode('dtg');
    check(flowState.getNode('tg').outputText === '新反推文本', 'outputText 存 trim 后文本');
    check(dg1.params.prompt === '新反推文本', '① 直接 image-gen 下游 prompt 被覆盖');
    check(dg1.status === 'stale', '直接 image-gen 下游标 stale');
    check(dg2.params.prompt === '旧2', '① 间接 image-gen 下游 prompt 不被覆盖');
    check(dg2.status === 'stale', '① 间接下游仅标 stale');
    check(dtg.params.instruction === '原指令', '② text-gen 下游 instruction 不被覆盖');
    check(dtg.status === 'stale', 'text-gen 下游也标 stale（上游已变更）');
  });

  await section('QA1b: 产出 image-gen 下游被 applyTextToDownstream 覆盖（prompt + stale）', async () => {
    replace({
      nodes: [
        mkNode('tg', 'text-gen', { params: { instruction: '反推', model: 'p:c' }, refImages: ['data:image/png;base64,x'] }),
        mkNode('ig', 'image-gen', { imageUrl: 'data:image/png;base64,keep', params: { prompt: '旧', model: 'd:m' } }),
      ],
      edges: [{ id: 'e1', from: 'tg', to: 'ig' }], // 产出节点（image-gen）直连
    });
    setChat('结果文本');
    await runEngine.run('tg');
    const ig = flowState.getNode('ig');
    check(ig.imageUrl === 'data:image/png;base64,keep', '③ 产出 image-gen 下游 imageUrl 不被改动');
    check(ig.params.prompt === '结果文本', '③ 产出 image-gen 下游 prompt 被覆盖（image-gen 语义）');
    check(ig.status === 'stale', '③ 产出 image-gen 下游标 stale');
  });

  await section('QA1c: 空文本与异常 → fail + 不覆盖 + 不写历史', async () => {
    replace({
      nodes: [
        mkNode('tg', 'text-gen', { params: { instruction: '反推', model: 'p:c' }, outputText: '旧文本', textHistory: [{ text: '旧文本', ts: 1 }], refImages: ['data:image/png;base64,x'] }),
        mkNode('dg', 'image-gen', { params: { prompt: '旧prompt', model: 'd:m' } }),
      ],
      edges: [{ id: 'e1', from: 'tg', to: 'dg' }],
    });
    // 空文本
    setChat('   ');
    await runEngine.run('tg');
    let tg = flowState.getNode('tg');
    check(tg.status === 'fail', '④ 空文本 → 节点 fail');
    check(tg.outputText === '旧文本', '④ 空文本不覆盖 outputText');
    check(tg.textHistory.length === 1, '④ 空文本不写历史');
    check(flowState.getNode('dg').params.prompt === '旧prompt', '④ 空文本不覆盖下游 prompt');
    // 异常（命令是临时的：上一步失败后 instruction 已被清空，需重新给命令才能再跑）
    setChat(new Error('供应商未配置 API 地址'));
    flowState.updateNodeParams('tg', { instruction: '反推' });
    await runEngine.run('tg');
    tg = flowState.getNode('tg');
    check(tg.status === 'fail', '④ 异常 → 节点 fail');
    check(tg.error === '供应商未配置 API 地址', '④ 异常记录 error 原因');
    check(tg.outputText === '旧文本', '④ 异常不覆盖 outputText');
    check(tg.textHistory.length === 1, '④ 异常不写历史');
    check(flowState.getNode('dg').params.prompt === '旧prompt', '④ 异常不覆盖下游 prompt');
  });

  await section('QA1d: 覆盖值 == 反推文本（含 trim 与精确相等）', async () => {
    replace({
      nodes: [
        mkNode('tg', 'text-gen', { params: { instruction: '反推', model: 'p:c' }, refImages: ['data:image/png;base64,x'] }),
        mkNode('dg', 'image-gen', { params: { prompt: '旧prompt', model: 'd:m' } }),
      ],
      edges: [{ id: 'e1', from: 'tg', to: 'dg' }],
    });
    setChat('  一只猫坐在窗台上  ');
    await runEngine.run('tg');
    const tg = flowState.getNode('tg');
    const dg = flowState.getNode('dg');
    check(dg.params.prompt === tg.outputText, '⑤ 下游 prompt === outputText');
    check(dg.params.prompt === '一只猫坐在窗台上', `⑤ 覆盖值为 trim 后反推文本 ("${dg.params.prompt}")`);
  });

  // ================= QA2: 历史独立 =================
  await section('QA2a: pushTextHistory 去重（相邻相同忽略）/最新在前/上限 20 裁尾', () => {
    replace({ nodes: [mkNode('tg', 'text-gen')], edges: [] });
    flowState.pushTextHistory('tg', 'A');
    flowState.pushTextHistory('tg', '  A  '); // trim 相同 → 忽略
    check(flowState.getTextHistory('tg').length === 1, '去重：相邻相同（trim 后）被忽略');
    flowState.pushTextHistory('tg', 'B');
    flowState.pushTextHistory('tg', 'A');     // 非相邻相同 → 保留（历史允许回退）
    let hist = flowState.getTextHistory('tg');
    check(hist.length === 3, '非相邻相同不误删（可回退）');
    check(hist[0].text === 'A' && hist[1].text === 'B' && hist[2].text === 'A', '最新在前（unshift）');
    for (let i = 0; i < 30; i++) flowState.pushTextHistory('tg', `x${i}`);
    hist = flowState.getTextHistory('tg');
    check(hist.length === 20, `上限 20 裁尾 (${hist.length})`);
    check(hist[0].text === 'x29' && !hist.some(h => h.text === 'A'), '裁尾后最新在前且旧条目被移除');
    check(hist.every(h => typeof h.text === 'string' && typeof h.ts === 'number'), '条目仅 {text, ts}（不存图信息）');
  });

  await section('QA2b: 历史回填动作 = outputText + 覆盖直接 image-gen + stale + toast（不写历史）', async () => {
    replace({
      nodes: [
        mkNode('tg', 'text-gen', { params: { instruction: '反推', model: 'p:c' }, outputText: 'A', textHistory: [{ text: 'A', ts: 1 }, { text: 'B', ts: 2 }], refImages: ['data:image/png;base64,x'] }),
        mkNode('dg1', 'image-gen', { params: { prompt: 'A', model: 'd:m' } }),
        mkNode('dg2', 'image-gen', { params: { prompt: '间接', model: 'd:m' } }),
      ],
      edges: [
        { id: 'e1', from: 'tg', to: 'dg1' },
        { id: 'e2', from: 'dg1', to: 'dg2' },
      ],
    });
    toastCalls.length = 0;
    const item = flowState.getTextHistory('tg').find(h => h.text === 'B');
    cmdPanel['_refillHistoryItem']('tg', item);
    const tg = flowState.getNode('tg');
    const dg1 = flowState.getNode('dg1');
    const dg2 = flowState.getNode('dg2');
    check(tg.outputText === 'B', '回填更新 outputText');
    check(dg1.params.prompt === 'B', '回填覆盖直接 image-gen 下游 prompt');
    check(dg2.params.prompt === '间接', '回填不覆盖间接下游 prompt');
    check(dg1.status === 'stale' && dg2.status === 'stale', '回填后直接+间接下游标 stale');
    check(tg.textHistory.length === 2 && tg.textHistory[0].text === 'A', '回填不写历史（恢复语义，非新运行）');
    check(toastCalls.includes('show'), '回填触发 toast');
  });

  // ================= QA3: persistence 独立 =================
  await section('QA3a: 3.4 往返无损（outputText/textHistory/params 全部保留）', () => {
    replace({
      nodes: [
        mkNode('tg', 'text-gen', { status: 'done', title: '文本反推', params: { instruction: '反推', model: 'p:c' }, outputText: '反推结果', textHistory: [{ text: '反推结果', ts: 1 }, { text: '更早', ts: 0 }], refImages: ['data:image/png;base64,x'] }),
        mkNode('ig', 'image-gen', { status: 'stale', params: { prompt: '被覆盖的prompt', model: 'd:m', aspectRatio: '3:4', resolution: '2k', count: 2 }, refImages: ['data:image/png;base64,y'] }),
        mkNode('ig2', 'image-gen', { status: 'done', title: '生成结果', imageUrl: 'data:image/png;base64,z', parentId: 'ig' }),
      ],
      edges: [{ id: 'e1', from: 'tg', to: 'ig' }, { id: 'e2', from: 'ig', to: 'ig2' }],
    });
    const collected = persistence.collect();
    check(collected.version === '3.4', 'collect().version === 3.4');
    const ctg = collected.nodes.find(n => n.id === 'tg');
    check(ctg.outputText === '反推结果', 'collect 保留 outputText');
    check(Array.isArray(ctg.textHistory) && ctg.textHistory.length === 2 && ctg.textHistory[0].text === '反推结果', 'collect 保留 textHistory 全部条目');
    check(ctg.refImages.length === 1 && ctg.refImages[0].startsWith('data:image'), 'collect 保留 refImages');
    const cig = collected.nodes.find(n => n.id === 'ig');
    check(cig.params.prompt === '被覆盖的prompt' && cig.params.count === 2, 'collect 保留 image-gen 全参数');
    check(cig.outputText === null && Array.isArray(cig.textHistory) && cig.textHistory.length === 0, '非 text-gen 节点 outputText=null/textHistory=[]');
    check(collected.nodes.find(n => n.id === 'ig2').parentId === 'ig', 'collect 保留产出节点 parentId');

    const ok = persistence.restore(JSON.parse(JSON.stringify(collected)));
    check(ok === true, 'restore 3.4 成功');
    check(flowState.getNode('tg').outputText === '反推结果', '3.4 还原 outputText');
    check(flowState.getNode('tg').textHistory.length === 2 && flowState.getNode('tg').textHistory[1].text === '更早', '3.4 还原 textHistory 顺序');
    check(flowState.getNode('ig').params.prompt === '被覆盖的prompt', '3.4 还原 image-gen 参数');
    check(flowState.getNode('ig2').parentId === 'ig' && flowState.getNode('ig2').imageUrl.startsWith('data:image'), '3.4 还原产出 image-gen 节点');
  });

  await section('QA3b: 3.2 老文件兼容（缺字段补默认；text-gen 也兼容）', () => {
    const old32 = {
      format: 'icv', version: '3.2', projectName: '旧项目',
      canvas: { scale: 1, panX: 0, panY: 0 },
      nodes: [
        { id: 'ig', type: 'image-gen', x: 0, y: 0, ratio: 0.75, status: 'done', title: '图片生成', params: { prompt: '你好', model: 'd:m', aspectRatio: '3:4', resolution: '2k', count: 1 }, imageUrl: 'data:image/png;base64,y', refImages: [], error: null, lastRunAt: 5, parentId: null },
        { id: 'ir', type: 'image-result', x: 300, y: 0, ratio: 1, status: 'done', title: '生成结果', params: {}, imageUrl: 'data:image/png;base64,z', refImages: [], error: null, lastRunAt: 5, parentId: 'ig' },
        // 3.2 文件中混入 text-gen 节点（无 outputText/textHistory 字段，最坏情况）
        { id: 'tg', type: 'text-gen', x: 600, y: 0, ratio: 0.75, status: 'idle', title: '文本反推', params: { instruction: '反推', model: '' }, imageUrl: null, refImages: [], error: null, lastRunAt: null, parentId: null },
      ],
      edges: [{ id: 'e1', from: 'ig', to: 'ir' }, { id: 'e2', from: 'ig', to: 'tg' }], createdAt: 0, updatedAt: 0,
    };
    const ok = persistence.restore(old32);
    check(ok === true, 'restore 3.2 成功');
    check(flowState.getNode('ig').params.prompt === '你好', '3.2 image-gen 参数不丢');
    check(flowState.getNode('ig').outputText === null && flowState.getNode('ig').textHistory.length === 0, '3.2 image-gen 补默认 outputText=null/textHistory=[]');
    const ir = flowState.getNode('ir');
    check(ir && ir.type === 'image-gen' && ir.parentId === 'ig', '3.2 image-result 迁移为 image-gen 且 parentId 保留');
    check(ir.imageUrl === 'data:image/png;base64,z' && ir.title === '生成结果', '3.2 image-result 迁移后 imageUrl/title 保留');
    check(ir.params.prompt === '' && ir.params.aspectRatio === '3:4' && ir.params.count === 1, '3.2 image-result 迁移后 params 默认补齐');
    const tg = flowState.getNode('tg');
    check(!!tg && tg.outputText === null && Array.isArray(tg.textHistory) && tg.textHistory.length === 0, '3.2 text-gen 补默认 outputText=null/textHistory=[]');
    check(tg.params.instruction === '反推' && tg.params.model === '', '3.2 text-gen 参数保留');
  });

  await section('QA3c: 3.1 及更旧拒绝；非法格式拒绝', () => {
    const base = {
      format: 'icv', version: '3.1', projectName: 'p', canvas: { scale: 1, panX: 0, panY: 0 },
      nodes: [], edges: [], createdAt: 0, updatedAt: 0,
    };
    check(persistence.restore({ ...base, version: '3.1' }) === false, '3.1 拒绝');
    check(persistence.restore({ ...base, version: '3.0' }) === false, '3.0 拒绝');
    check(persistence.restore({ ...base, version: '2.0' }) === false, '2.0 拒绝');
    check(persistence.restore({ ...base, version: '3.2', format: 'xxx' }) === false, 'format 非 icv 拒绝');
    check(persistence.restore(null) === false, 'null 拒绝');
    check(persistence.restore({ format: 'icv', version: '3.3', nodes: 'not-array' }) === false, 'nodes 非数组拒绝');
  });

  await section('QA3d: 非法 textHistory 归一（过滤/裁尾/trim）；非 string outputText 兜底', () => {
    const raw = {
      format: 'icv', version: '3.3', projectName: 'p', canvas: { scale: 1, panX: 0, panY: 0 },
      nodes: [
        { id: 'tg', type: 'text-gen', x: 0, y: 0, ratio: 0.75, status: 'idle', title: 't', params: { instruction: 'x', model: 'm' }, imageUrl: null, outputText: 12345, textHistory: [
          { text: '  合法条目  ', ts: 9 },
          { text: 42, ts: 8 },
          { text: '', ts: 7 },
          { text: '合法2', ts: 'bad' },
          null,
          'not-an-object',
          ...Array.from({ length: 30 }, (_, i) => ({ text: `批量${i}`, ts: i })),
        ], refImages: [], error: null, lastRunAt: null, parentId: null },
      ],
      edges: [], createdAt: 0, updatedAt: 0,
    };
    const ok = persistence.restore(raw);
    check(ok === true, 'restore 3.3（含脏 textHistory）成功');
    const tg = flowState.getNode('tg');
    check(tg.outputText === null, '非 string outputText 兜底为 null');
    const hist = tg.textHistory;
    check(hist.length === 20, `非法/超限条目过滤+裁尾到 20 (${hist.length})`);
    // normalizeTextHistory 保留文件内顺序（collect 写入时即最新在前），故首条=文件首条合法条目
    check(hist[0].text === '合法条目' && hist[1].text === '合法2', '保留合法条目且保持文件序（最新在前）');
    check(hist.some(h => h.text === '合法条目'), '合法条目 trim 后保留');
    check(hist.every(h => typeof h.text === 'string' && h.text !== '' && typeof h.ts === 'number'), '所有条目均为合法 {text, ts}');
  });

  // ================= QA4: 其它质量点 =================
  await section('QA4a: Backend.chatV2 images 防御性过滤（仅 data:image）', async () => {
    // 恢复真实实现（前面用例覆盖过 chatV2）
    Backend.chatV2 = realChatV2;
    let captured = null;
    global.pywebview.api.unified_chat_v2 = async (_input, opts) => {
      captured = opts;
      return { success: true, text: 'ok' };
    };
    const res = await Backend.chatV2('指令', {
      images: ['data:image/png;base64,a', 'http://example.com/x.png', 'not-a-url', 123, null],
      model: 'p:c',
    });
    check(res.success === true && res.text === 'ok', 'chatV2 正常返回 {success, text}');
    check(Array.isArray(captured.images) && captured.images.length === 1 && captured.images[0] === 'data:image/png;base64,a',
      `仅 data:image 前缀透传后端 (${JSON.stringify(captured.images)})`);
    check(captured.model === 'p:c', '其余 options 原样透传');
    delete global.pywebview.api.unified_chat_v2;
  });

  await section('QA4b: 节点注册唯一性 + canRun 命令驱动（无需参考图）', () => {
    const types = nodeRegistry.list().map(d => d.type);
    check(types.filter(t => t === 'text-gen').length === 1, 'text-gen 仅注册一次');
    check(types.filter(t => t === 'image-gen').length === 1, 'image-gen 仅注册一次（双卡模型唯一图片节点）');
    check(!types.includes('image-result'), 'image-result 类型已彻底移除');
    const def = nodeRegistry.get('text-gen');
    check(def.label === '文本', `label 已改为「文本」 (${def.label})`);
    const noCmd = flowState.addNode('text-gen', 0, 0, { params: { instruction: '', model: 'p:c' } });
    const r1 = def.canRun(noCmd, { getReferenceImages: () => [] });
    check(typeof r1 === 'string' && r1.includes('请输入命令'), `canRun 无命令被拦截 (${r1})`);
    const noModel = flowState.addNode('text-gen', 0, 0, { params: { instruction: '翻译', model: '' } });
    const r2 = def.canRun(noModel, { getReferenceImages: () => [] });
    check(typeof r2 === 'string' && r2.includes('文本模型'), `canRun 无文本模型被拦截 (${r2})`);
    const ok = flowState.addNode('text-gen', 0, 0, { params: { instruction: '翻译成英文', model: 'p:c' } });
    check(def.canRun(ok, { getReferenceImages: () => [] }) === true, '有命令+模型（无参考图）可运行');
  });

  await section('QA4c: 文本卡 HTML 转义（防注入）', () => {
    replace({ nodes: [mkNode('tg', 'text-gen', { outputText: '<img src=x onerror=alert(1)> & "quoted"', status: 'done' })], edges: [] });
    const imgEl = stubEl({ innerHTML: '', style: {} });
    const el = stubEl({ style: {}, dataset: {} });
    el.querySelector = () => imgEl; // 稳定返回同一个 img 元素（updateCard 写入 innerHTML 后可读）
    cardView['updateCard'](el, flowState.getNode('tg'));
    check(typeof imgEl.innerHTML === 'string' && imgEl.innerHTML.includes('&lt;img') && !imgEl.innerHTML.includes('<img src=x'),
      'outputText 中的 <img> 被转义');
    check(imgEl.innerHTML.includes('&amp;') && imgEl.innerHTML.includes('&quot;'), '& 与引号被转义');
    check(imgEl.innerHTML.includes('pcard-text'), '文本卡渲染 .pcard-text 容器');
  });

  console.log(`\n══════════════════════════════════`);
  console.log(`QA 独立回归：通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) {
    console.error('失败明细：');
    failures.forEach(f => console.error(`- ${f}`));
    process.exit(1);
  }
  console.log('QA SMOKE PASS');
}

main().catch(e => { console.error(e); process.exit(1); });
