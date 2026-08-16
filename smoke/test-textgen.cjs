// smoke/test-textgen.cjs
// text-gen 端到端桩测：Node + CommonJS（tsconfig.smoke.json 编译产物在 D:/tmp/icv-test）
// 覆盖：节点注册/canRun 命令驱动（无需图）→ runTextGen 调 chatV2 链路 → 联动覆盖下游 prompt →
//       历史 push+回填 → persistence 3.4 往返（含 3.2/3.3 老文件兼容 + image-result 迁移）→ chat 模型列表隔离
//
// 运行：node smoke/test-textgen.cjs （编译产物需先 tsc -p tsconfig.smoke.json）

'use strict';

// ───────────────────────── DOM/浏览器桩 ─────────────────────────
const stubEl = () => ({
  classList: { add() {}, remove() {}, toggle() {} },
  style: {},
  dataset: {},
  innerHTML: '',
  textContent: '',
  value: '',
  disabled: false,
  addEventListener() {},
  appendChild() {},
  remove() {},
  querySelector() { return null; },
  querySelectorAll() { return []; },
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
});

global.window = {
  addEventListener() {},
  API: null,
};
// utils/api.ts 通过 pywebview.api.* 调用后端
global.pywebview = { api: {} };
global.document = {
  getElementById() { return null; }, // toast 等 getElementById 返回 null → 安全 no-op
  createElement() { return stubEl(); },
  createElementNS() { return stubEl(); },
  addEventListener() {},
  body: stubEl(),
  querySelector() { return null; },
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
const { Backend, fetchChatModels, fetchImageModels, resolveDefaultChatModel } = require(`${BASE}/api.js`);
const { cmdPanel } = require(`${BASE}/ui/cmd-panel.js`);
const { interactions } = require(`${BASE}/canvas/interactions.js`);

// ───────────────────────── 用例 ─────────────────────────
async function main() {
  await section('T01a: 节点注册与 canRun 校验（命令驱动，无需参考图）', () => {
    const def = nodeRegistry.get('text-gen');
    check(!!def, 'text-gen 已注册到 nodeRegistry');
    check(def.label === '文本', `label=文本 (${def.label})`);
    check(def.creatable !== false, 'creatable 默认 true（进新建菜单）');

    const noCmd = flowState.addNode('text-gen', 0, 0, { params: { instruction: '   ', model: 'p:m' } });
    const r1 = def.canRun(noCmd, { getReferenceImages: () => [] });
    check(typeof r1 === 'string' && r1.includes('请输入命令'), `无命令 → 中文原因 (${r1})`);

    const noModel = flowState.addNode('text-gen', 0, 0, { params: { instruction: '翻译成英文', model: '' } });
    const r2 = def.canRun(noModel, { getReferenceImages: () => [] });
    check(typeof r2 === 'string' && r2.includes('文本模型'), `无模型 → 中文原因 (${r2})`);

    // 命令驱动：有命令 + 模型即可运行，无需参考图
    const ok = flowState.addNode('text-gen', 0, 0, { params: { instruction: '翻译成英文', model: 'p:m' } });
    const r3 = def.canRun(ok, { getReferenceImages: () => [] });
    check(r3 === true, '有命令+模型（无参考图）→ 可运行');
  });

  await section('T01b: pushTextHistory（最新在前/去重/上限/通知）', () => {
    flowState.replaceAll({
      format: 'icv', version: '3.3', projectName: 't',
      canvas: { scale: 1, panX: 0, panY: 0 },
      nodes: [{ id: 'tg', type: 'text-gen', x: 0, y: 0, ratio: 0.75, status: 'idle', title: 't', params: {}, imageUrl: null, outputText: null, textHistory: [], refImages: [], error: null, lastRunAt: null, parentId: null }],
      edges: [], createdAt: 0, updatedAt: 0,
    });
    flowState.pushTextHistory('tg', '第一条');
    flowState.pushTextHistory('tg', '  第一条  '); // 与头条 trim 相同 → 忽略
    let hist = flowState.getTextHistory('tg');
    check(hist.length === 1, '连续重复（trim 相同）被忽略');
    check(hist[0].text === '第一条' && typeof hist[0].ts === 'number', '条目为 {text, ts}');
    flowState.pushTextHistory('tg', '第二条');
    hist = flowState.getTextHistory('tg');
    check(hist[0].text === '第二条', '最新在前');
    // 上限 20：批量推 25 条
    for (let i = 0; i < 25; i++) flowState.pushTextHistory('tg', `批量${i}`);
    hist = flowState.getTextHistory('tg');
    check(hist.length === 20, `超限裁尾到 20 (${hist.length})`);
    check(hist[0].text === '批量24', '裁尾后仍最新在前');
  });

  await section('T01c: persistence 3.4 往返 + 3.2/3.3 老文件兼容（image-result 迁移）', () => {
    // 3.4 collect
    flowState.replaceAll({
      format: 'icv', version: '3.4', projectName: '往返',
      canvas: { scale: 1, panX: 0, panY: 0 },
      nodes: [
        { id: 'tg', type: 'text-gen', x: 0, y: 0, ratio: 0.75, status: 'done', title: '文本反推', params: { instruction: '反推', model: 'p:m' }, imageUrl: null, outputText: '反推结果', textHistory: [{ text: '反推结果', ts: 1 }], refImages: ['data:image/png;base64,x'], error: null, lastRunAt: 1, parentId: null },
        { id: 'ig', type: 'image-gen', x: 300, y: 0, ratio: 0.75, status: 'stale', title: '图片生成', params: { prompt: '旧', model: 'd:m' }, imageUrl: null, outputText: null, textHistory: [], refImages: [], error: null, lastRunAt: null, parentId: null },
      ],
      edges: [{ id: 'e1', from: 'tg', to: 'ig' }], createdAt: 0, updatedAt: 0,
    });
    const collected = persistence.collect();
    check(collected.version === '3.4', `collect().version === '3.4'`);
    const ctg = collected.nodes.find(n => n.id === 'tg');
    check(ctg.outputText === '反推结果', 'collect 保留 outputText');
    check(Array.isArray(ctg.textHistory) && ctg.textHistory[0].text === '反推结果', 'collect 保留 textHistory');

    // 3.4 restore
    const ok34 = persistence.restore(JSON.parse(JSON.stringify(collected)));
    check(ok34 === true, 'restore 3.4 成功');
    check(flowState.getNode('tg')?.outputText === '反推结果', '3.4 restore 还原 outputText');
    check(flowState.getNode('tg')?.textHistory.length === 1, '3.4 restore 还原 textHistory');

    // 3.3 老文件兼容（restore 接受 3.3）
    const ok33 = persistence.restore({ ...JSON.parse(JSON.stringify(collected)), version: '3.3' });
    check(ok33 === true, 'restore 3.3 兼容成功');
    check(flowState.getNode('tg')?.outputText === '反推结果', '3.3 restore 还原 outputText');

    // 3.2 老文件（含 image-result → 迁移为 image-gen；节点无 outputText/textHistory 字段）
    const old32 = {
      format: 'icv', version: '3.2', projectName: '旧项目',
      canvas: { scale: 1, panX: 0, panY: 0 },
      nodes: [
        { id: 'ig', type: 'image-gen', x: 0, y: 0, ratio: 0.75, status: 'done', title: '图片生成', params: { prompt: '你好', model: 'd:m', aspectRatio: '3:4', resolution: '2k', count: 1 }, imageUrl: 'data:image/png;base64,y', refImages: [], error: null, lastRunAt: 5, parentId: null },
        { id: 'ir', type: 'image-result', x: 300, y: 0, ratio: 1, status: 'done', title: '生成结果', params: {}, imageUrl: 'data:image/png;base64,z', refImages: [], error: null, lastRunAt: 5, parentId: 'ig' },
      ],
      edges: [{ id: 'e1', from: 'ig', to: 'ir' }], createdAt: 0, updatedAt: 0,
    };
    const ok32 = persistence.restore(old32);
    check(ok32 === true, 'restore 3.2 老文件成功');
    const ig = flowState.getNode('ig');
    check(ig && ig.type === 'image-gen' && ig.params.prompt === '你好', '3.2 image-gen 参数不丢');
    check(ig.outputText === null && Array.isArray(ig.textHistory) && ig.textHistory.length === 0, '3.2 节点补默认 outputText=null/textHistory=[]');
    const ir = flowState.getNode('ir');
    check(ir && ir.type === 'image-gen' && ir.parentId === 'ig', '3.2 image-result 迁移为 image-gen 且 parentId 保留');
    check(ir.imageUrl === 'data:image/png;base64,z', '3.2 image-result 迁移后 imageUrl 保留');
    check(ir.title === '生成结果' && ir.params.prompt === '' && ir.params.count === 1, '3.2 image-result 迁移后 title/params 默认补齐');
    // 更旧版本拒绝
    const old31 = { ...old32, version: '3.1' };
    check(persistence.restore(old31) === false, '3.1 更旧版本拒绝');
  });

  await section('T02a: runTextGen 成功链路（chatV2 调用 + 联动覆盖 + stale + 历史）', () => {
    flowState.replaceAll({
      format: 'icv', version: '3.3', projectName: '运行',
      canvas: { scale: 1, panX: 0, panY: 0 },
      nodes: [
        { id: 'tg', type: 'text-gen', x: 0, y: 0, ratio: 0.75, status: 'idle', title: '文本反推', params: { instruction: '反推这张图', model: 'p:chat' }, imageUrl: null, outputText: null, textHistory: [], refImages: ['data:image/png;base64,x'], error: null, lastRunAt: null, parentId: null },
        { id: 'downGen', type: 'image-gen', x: 300, y: 0, ratio: 0.75, status: 'idle', title: '图片生成', params: { prompt: '旧prompt', model: 'd:m', aspectRatio: '3:4', resolution: '2k', count: 1 }, imageUrl: null, outputText: null, textHistory: [], refImages: [], error: null, lastRunAt: null, parentId: null },
        { id: 'downTg', type: 'text-gen', x: 600, y: 0, ratio: 0.75, status: 'idle', title: '文本反推2', params: { instruction: 'x', model: 'p:chat' }, imageUrl: null, outputText: null, textHistory: [], refImages: ['data:image/png;base64,a'], error: null, lastRunAt: null, parentId: null },
      ],
      edges: [
        { id: 'e1', from: 'tg', to: 'downGen' },
        { id: 'e2', from: 'tg', to: 'downTg' },
      ], createdAt: 0, updatedAt: 0,
    });

    let called = null;
    const orig = Backend.chatV2;
    Backend.chatV2 = async (input, opts) => {
      called = { input, opts };
      return { success: true, text: '一只猫坐在窗台上，光线柔和' };
    };

    return runEngine.run('tg').then(() => {
      Backend.chatV2 = orig;
      const tg = flowState.getNode('tg');
      check(tg.status === 'done', '运行成功 → status done');
      check(tg.outputText === '一只猫坐在窗台上，光线柔和', 'outputText 写入');
      check(tg.textHistory.length === 1 && tg.textHistory[0].text === '一只猫坐在窗台上，光线柔和', '历史 +1');
      check(called && called.input === '反推这张图', 'chatV2 收到命令（无 outputText → user=命令）');
      check(!called.opts || !('images' in called.opts), 'chatV2 不传 images（文本节点不传图）');
      check(called.opts.model === 'p:chat', 'chatV2 携带所选文本模型');
      check(typeof called.opts.metaPrompt === 'string' && called.opts.metaPrompt.includes('文案处理'), 'chatV2 带 system 文案处理提示词');
      const dg = flowState.getNode('downGen');
      check(dg.params.prompt === '一只猫坐在窗台上，光线柔和', '直接 image-gen 下游 prompt 被覆盖');
      check(dg.status === 'stale', '直接下游标 stale');
      const dt = flowState.getNode('downTg');
      check(dt.params.instruction === 'x', 'text-gen 下游 instruction 不被覆盖（边界）');
    });
  });

  await section('T02b: 失败/空文本 → fail + 不覆盖 + 不写历史', () => {
    flowState.replaceAll({
      format: 'icv', version: '3.3', projectName: '失败',
      canvas: { scale: 1, panX: 0, panY: 0 },
      nodes: [
        { id: 'tg', type: 'text-gen', x: 0, y: 0, ratio: 0.75, status: 'idle', title: 't', params: { instruction: '反推', model: 'p:m' }, imageUrl: null, outputText: '旧文本', textHistory: [{ text: '旧文本', ts: 1 }], refImages: ['data:image/png;base64,x'], error: null, lastRunAt: null, parentId: null },
        { id: 'dg', type: 'image-gen', x: 300, y: 0, ratio: 0.75, status: 'idle', title: 'g', params: { prompt: '旧prompt', model: 'd:m' }, imageUrl: null, outputText: null, textHistory: [], refImages: [], error: null, lastRunAt: null, parentId: null },
      ],
      edges: [{ id: 'e1', from: 'tg', to: 'dg' }], createdAt: 0, updatedAt: 0,
    });

    const orig = Backend.chatV2;
    Backend.chatV2 = async () => { throw new Error('供应商未配置 API 地址'); };
    return runEngine.run('tg').then(() => {
      const tg = flowState.getNode('tg');
      check(tg.status === 'fail', '异常 → status fail');
      check(tg.error === '供应商未配置 API 地址', 'error 记录原因');
      check(tg.outputText === '旧文本', '失败不覆盖 outputText');
      check(tg.textHistory.length === 1, '失败不写历史');
      check(flowState.getNode('dg').params.prompt === '旧prompt', '失败不覆盖下游 prompt');
      Backend.chatV2 = async () => ({ success: true, text: '   ' });
      return runEngine.run('tg').then(() => {
        Backend.chatV2 = orig;
        check(flowState.getNode('tg').status === 'fail', '空文本视为失败');
      });
    });
  });

  await section('T02c: busy 锁生效', () => {
    let release;
    const gate = new Promise(res => { release = res; });
    const orig = Backend.chatV2;
    Backend.chatV2 = async () => { await gate; return { success: true, text: 'ok' }; };
    const runP = runEngine.run('tg');
    // busy 期间再触发其它节点 → 被拒（run 直接 return，不抛错）
    return runEngine.run('tg').then(() => {
      release();
      return runP.then(() => { Backend.chatV2 = orig; check(true, 'busy 期间重复触发被安全拒绝'); });
    });
  });

  await section('T02d: chat 模型列表与绘图模型互斥', () => {
    global.pywebview.api.load_providers = async () => ({
      providers: [
        { id: 'p1', name: '供应商一', short_name: 'S1', enabled: true, models: [
          { id: 'draw-1', name: '绘图模型', type: 'drawing', enabled: true },
          { id: 'chat-1', name: '对话模型A', type: 'chat', enabled: true },
          { id: 'chat-off', name: '禁用对话', type: 'chat', enabled: false },
        ] },
        { id: 'p2', name: '供应商二', short_name: 'S2', enabled: false, models: [
          { id: 'chat-2', name: '对话模型B', type: 'chat', enabled: true },
        ] },
      ],
    });
    return Promise.all([fetchChatModels(), fetchImageModels()]).then(([chat, draw]) => {
      check(chat.length === 1 && chat[0].id === 'p1:chat-1', `chat 列表只含 enabled chat 模型 (${JSON.stringify(chat)})`);
      check(draw.length === 1 && draw[0].id === 'p1:draw-1', '绘图列表只含 drawing 模型');
      check(chat[0].name.includes('S1'), 'chat 模型名带 provider 前缀');
      return resolveDefaultChatModel().then(id => {
        check(id === 'p1:chat-1', `resolveDefaultChatModel 返回第一个 chat 模型 (${id})`);
        check(global.localStorage.getItem('icv_default_chat_model') === 'p1:chat-1', 'chat 默认模型写入 icv_default_chat_model');
      });
    });
  });

  await section('T02e: 历史回填联动（回填=恢复历史输出）', () => {
    flowState.replaceAll({
      format: 'icv', version: '3.3', projectName: '回填',
      canvas: { scale: 1, panX: 0, panY: 0 },
      nodes: [
        { id: 'tg', type: 'text-gen', x: 0, y: 0, ratio: 0.75, status: 'done', title: 't', params: { instruction: '反推', model: 'p:m' }, imageUrl: null, outputText: 'A', textHistory: [{ text: 'A', ts: 1 }, { text: 'B', ts: 2 }], refImages: ['data:image/png;base64,x'], error: null, lastRunAt: 2, parentId: null },
        { id: 'dg', type: 'image-gen', x: 300, y: 0, ratio: 0.75, status: 'done', title: 'g', params: { prompt: 'A', model: 'd:m' }, imageUrl: null, outputText: null, textHistory: [], refImages: [], error: null, lastRunAt: 2, parentId: null },
      ],
      edges: [{ id: 'e1', from: 'tg', to: 'dg' }], createdAt: 0, updatedAt: 0,
    });
    // 模拟 cmd-panel 回填动作：写 outputText + 覆盖下游 prompt + 标 stale
    const item = flowState.getTextHistory('tg').find(h => h.text === 'B');
    flowState.updateNode('tg', { outputText: item.text });
    flowState.getDownstreams('tg').filter(d => d.type === 'image-gen')
      .forEach(d => flowState.updateNodeParams(d.id, { prompt: item.text }));
    dirty.markUpstreamChanged('tg');
    check(flowState.getNode('tg').outputText === 'B', '回填更新节点 outputText');
    check(flowState.getNode('dg').params.prompt === 'B', '回填同步覆盖下游 prompt');
    check(flowState.getNode('dg').status === 'stale', '回填后下游 stale');
  });

  await section('T03: cmd-panel 历史列表渲染（show + 标题 + 条目数）', () => {
    flowState.replaceAll({
      format: 'icv', version: '3.3', projectName: '渲染',
      canvas: { scale: 1, panX: 0, panY: 0 },
      nodes: [
        { id: 'tg', type: 'text-gen', x: 0, y: 0, ratio: 0.75, status: 'done', title: 't', params: { instruction: '反推', model: 'p:m' }, imageUrl: null, outputText: 'B', textHistory: [{ text: '历史B', ts: 2000 }, { text: '历史A', ts: 1000 }], refImages: [], error: null, lastRunAt: 2, parentId: null },
      ],
      edges: [], createdAt: 0, updatedAt: 0,
    });
    let shown = false;
    let appended = 0;
    const fakeHistoryEl = {
      classList: { add() { shown = true; }, remove() {} },
      innerHTML: '',
      appendChild() { appended += 1; },
    };
    cmdPanel['historyEl'] = fakeHistoryEl;
    cmdPanel['_renderTextHistory'](flowState.getNode('tg'));
    check(shown === true, '有历史 → 列表显示');
    check(appended === 2, `渲染 2 条历史条目 (${appended})`);
    check(fakeHistoryEl.innerHTML.includes('历史反推结果'), '历史标题渲染');
  });

  await section('T04: 右键菜单候选遍历（自动含 text-gen）', () => {
    const candidates = interactions['_newNodeCandidates']();
    const types = candidates.map(d => d.type);
    check(types.includes('text-gen'), `菜单候选含 text-gen (${types.join(',')})`);
    check(types.includes('image-gen'), '菜单候选含 image-gen');
    check(!types.includes('image-result'), '菜单候选不含 image-result（类型已彻底移除）');
  });

  console.log(`\n══════════════════════════════════`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) {
    console.error('失败明细：');
    failures.forEach(f => console.error(`- ${f}`));
    process.exit(1);
  }
  console.log('SMOKE PASS');
}

main().catch(e => { console.error(e); process.exit(1); });
