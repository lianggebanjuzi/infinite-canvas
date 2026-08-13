// ICV v1 手动连线 QA 独立边界测试（QA 自建，验证工程师 27 项未覆盖的路径）
// 覆盖：insertStep 多级链 stale 语义 / 删除连线下游状态语义（缺陷演示）/
//       插入/删除后 persistence 往返 / 缩放坐标换算 / canConnect 边界
//
// 用法：先 npx tsc -p tsconfig.smoke.json 编译到 G:/tmp/icv-test，再 node scripts/icv-connect-qa-tests.js

/* eslint-disable no-console */
const path = require('path');

// ── 浏览器全局桩 ──
global.window = { addEventListener() {}, removeEventListener() {}, innerWidth: 1280, innerHeight: 800 };
global.document = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, setAttribute() {}, removeAttribute() {} }),
  createElementNS: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, appendChild() {}, remove() {} }),
  addEventListener: () => {},
  documentElement: { setAttribute() {}, getAttribute: () => 'light' },
  body: { appendChild() {} },
};
global.localStorage = { _s: {}, getItem() { return null; }, setItem() {}, removeItem() {} };
global.Image = class { set src(v) {} get src() { return ''; } };
global.confirm = () => true;

const base = 'G:/tmp/icv-test';
const load = m => require(path.join(base, m));

const { flowState } = load('v1/state/flow-state.js');
const { dirty } = load('v1/state/dirty.js');
const { persistence } = load('v1/persistence.js');
const { canvasView } = load('v1/canvas/canvas-view.js');
const { cardView } = load('v1/canvas/card-view.js');
const { createDefaultProject } = load('v1/templates.js');
load('v1/nodes/product-image.js');
load('v1/nodes/style-transfer.js');

let pass = 0, fail = 0;
const defects = [];
const assert = (cond, msg) => {
  if (!cond) { fail++; console.error('✗ FAIL:', msg); }
  else { pass++; console.log('✓ PASS:', msg); }
};
// 记录观察到的缺陷（不中断测试，供报告汇总）
const observeDefect = msg => { defects.push(msg); console.log('⚠ DEFECT-OBSERVED:', msg); };

function setup3Chain() {
  flowState.clear();
  const a = flowState.addNode('product-image', 0, 0);
  const b = flowState.addNode('style-transfer', 400, 0);
  const c = flowState.addNode('style-transfer', 800, 0);
  flowState.setNodeImage(a.id, 'data:image/png;base64,REF', 3 / 4);
  flowState.updateNode(a.id, { status: 'done' });
  flowState.addEdge(a.id, b.id);
  flowState.addEdge(b.id, c.id);
  return { a, b, c };
}

// 模拟 UI 插入路径（link-view._insertStep 与右键菜单一致：insertStep + markUpstreamChanged(new)）
function uiInsert(edgeId) {
  const node = flowState.insertStep(edgeId);
  if (node) dirty.markUpstreamChanged(node.id);
  return node;
}

(async () => {
  // ═══════ 1. canConnect / connect 边界 ═══════
  {
    flowState.clear();
    const a = flowState.addNode('product-image', 0, 0);
    assert(flowState.canConnect('ghost', a.id) !== null, 'canConnect 上游不存在 → 拒绝');
    assert(flowState.canConnect(a.id, 'ghost') !== null, 'canConnect 下游不存在 → 拒绝');
    const r = flowState.connect('ghost', a.id);
    assert(r.ok === false && /不存在/.test(r.error || ''), 'connect 不存在的节点 → {ok:false}');
    assert(flowState.edges.length === 0, '拒绝后不产生边');
  }

  // ═══════ 2. insertStep 链中间：A→B→C，插到 B→C ═══════
  {
    const { a, b, c } = setup3Chain();
    flowState.updateNode(b.id, { status: 'done' });
    flowState.updateNode(c.id, { status: 'done' });
    const edgeBC = flowState.edges.find(e => e.from === b.id && e.to === c.id);
    const newNode = uiInsert(edgeBC.id);
    assert(!!newNode, '链中间插入返回新节点');
    // 结构：A→B, B→New, New→C；共 3 边
    assert(flowState.edges.length === 3, '插入后边数 3');
    assert(flowState.edges.some(e => e.from === a.id && e.to === b.id), 'A→B 原边保留');
    assert(flowState.edges.some(e => e.from === b.id && e.to === newNode.id), 'B→New 新边');
    assert(flowState.edges.some(e => e.from === newNode.id && e.to === c.id), 'New→C 新边');
    assert(!flowState.edges.some(e => e.id === edgeBC.id), '原 B→C 边已断开');
    // 脏标记（UI 路径）：C 应 stale，B 不受影响
    assert(flowState.getNode(b.id).status === 'done', '插入后 B 保持 done（上游未变）');
    assert(flowState.getNode(c.id).status === 'stale', '插入后 C 标 stale（上游链已变）');
  }

  // ═══════ 3. insertStep 链中间：插到 A→B（更上游） ═══════
  {
    const { a, b, c } = setup3Chain();
    flowState.updateNode(b.id, { status: 'done' });
    flowState.updateNode(c.id, { status: 'done' });
    const edgeAB = flowState.edges.find(e => e.from === a.id && e.to === b.id);
    const newNode = uiInsert(edgeAB.id);
    assert(!!newNode, '更上游插入返回新节点');
    assert(flowState.edges.length === 3, '插入后边数 3');
    assert(flowState.edges.some(e => e.from === a.id && e.to === newNode.id), 'A→New 新边');
    assert(flowState.edges.some(e => e.from === newNode.id && e.to === b.id), 'New→B 新边');
    assert(flowState.edges.some(e => e.from === b.id && e.to === c.id), 'B→C 边不受影响');
    // 下游 B 与 C 都 stale
    assert(flowState.getNode(b.id).status === 'stale', '插入更上游后 B stale');
    assert(flowState.getNode(c.id).status === 'stale', '插入更上游后 C stale（间接）');
  }

  // ═══════ 4. insertStep 链末端场景（A→B，B 为末端） ═══════
  {
    const { a, b } = (() => {
      const x = setup3Chain();
      // 退化为 A→B：去掉 B→C
      const eBC = flowState.edges.find(e => e.from === x.b.id && e.to === x.c.id);
      flowState.removeEdge(eBC.id);
      return x;
    })();
    flowState.updateNode(b.id, { status: 'done' });
    const edgeAB = flowState.edges.find(e => e.from === a.id && e.to === b.id);
    const newNode = uiInsert(edgeAB.id);
    assert(!!newNode, '末端插入返回新节点');
    assert(flowState.edges.length === 2, '末端插入后边数 2');
    assert(flowState.edges.some(e => e.from === a.id && e.to === newNode.id)
      && flowState.edges.some(e => e.from === newNode.id && e.to === b.id), '末端插入重连 A→New→B');
    assert(flowState.getNode(b.id).status === 'stale', '末端插入后原 to 标 stale');
  }

  // ═══════ 5. 缺陷演示：删除连线后下游状态 ═══════
  {
    // 场景 5a：A→B（B done 有结果），删掉 A→B
    flowState.clear();
    const a = flowState.addNode('product-image', 0, 0);
    const b = flowState.addNode('style-transfer', 400, 0);
    flowState.setNodeImage(a.id, 'data:image/png;base64,REF', 3 / 4);
    flowState.updateNode(a.id, { status: 'done' });
    flowState.addEdge(a.id, b.id);
    flowState.updateNode(b.id, { status: 'done', imageUrl: 'file:///old.png', lastRunAt: 1 });
    const edge = flowState.edges[0];
    flowState.removeEdge(edge.id); // 与 link-view × 按钮 / 右键删除连线 相同的调用
    const bAfter = flowState.getNode(b.id);
    console.log('   [5a] 删除唯一上游连线后 B 状态 =', bAfter.status, '（设计预期: stale）');
    if (bAfter.status !== 'stale') {
      observeDefect('删除唯一上游连线后，下游节点保持 done 未被标 stale（A→B 删边，B 仍绿点）');
    }
    // 场景 5b：A→B→C，删 A→B，B/C 都应 stale
    flowState.clear();
    const a2 = flowState.addNode('product-image', 0, 0);
    const b2 = flowState.addNode('style-transfer', 400, 0);
    const c2 = flowState.addNode('style-transfer', 800, 0);
    flowState.setNodeImage(a2.id, 'data:image/png;base64,REF', 3 / 4);
    flowState.updateNode(a2.id, { status: 'done' });
    flowState.addEdge(a2.id, b2.id);
    flowState.addEdge(b2.id, c2.id);
    flowState.updateNode(b2.id, { status: 'done', imageUrl: 'file:///b.png', lastRunAt: 1 });
    flowState.updateNode(c2.id, { status: 'done', imageUrl: 'file:///c.png', lastRunAt: 2 });
    const eAB = flowState.edges.find(e => e.from === a2.id && e.to === b2.id);
    flowState.removeEdge(eAB.id);
    console.log('   [5b] 删除 A→B 后 B =', flowState.getNode(b2.id).status, 'C =', flowState.getNode(c2.id).status, '（预期: stale/stale）');
    if (flowState.getNode(b2.id).status !== 'stale' || flowState.getNode(c2.id).status !== 'stale') {
      observeDefect('删除链中间连线后，下游 B 及其子孙 C 均未被标 stale');
    }
    // 场景 5c：删边后重连新上游，结果图来自旧上游但显示 done
    flowState.clear();
    const a3 = flowState.addNode('product-image', 0, 0);
    const a4 = flowState.addNode('product-image', 0, 300);
    const b3 = flowState.addNode('style-transfer', 400, 0);
    flowState.setNodeImage(a3.id, 'data:image/png;base64,OLD', 3 / 4);
    flowState.setNodeImage(a4.id, 'data:image/png;base64,NEW', 3 / 4);
    flowState.updateNode(a3.id, { status: 'done' });
    flowState.updateNode(a4.id, { status: 'done' });
    flowState.addEdge(a3.id, b3.id);
    flowState.updateNode(b3.id, { status: 'done', imageUrl: 'file:///old-result.png', lastRunAt: 1 });
    flowState.removeEdge(flowState.edges[0].id);
    flowState.connect(a4.id, b3.id); // 重连新上游
    console.log('   [5c] 删 A3→B 后重连 A4→B，B 状态 =', flowState.getNode(b3.id).status, '（结果图仍为旧上游生成）');
    if (flowState.getNode(b3.id).status !== 'stale') {
      observeDefect('删边后重连新上游，B 仍显示 done 但结果图来自旧上游（状态与数据不一致）');
    }
  }

  // ═══════ 6. 插入步骤后 persistence 往返 ═══════
  {
    const { a, b } = (() => {
      const x = setup3Chain();
      const eBC = flowState.edges.find(e => e.from === x.b.id && e.to === x.c.id);
      flowState.removeEdge(eBC.id);
      return x;
    })();
    const edgeAB = flowState.edges.find(e => e.from === a.id && e.to === b.id);
    const newNode = uiInsert(edgeAB.id);
    const nodeIdsBefore = flowState.nodes.map(n => n.id).sort();
    const json = JSON.stringify(persistence.collect());
    flowState.clear();
    assert(persistence.restore(JSON.parse(json)) === true, '插入后项目 restore 成功');
    assert(flowState.nodes.length === 4, '插入后 nodes=4（a/b/c+新节点）往返保留');
    assert(flowState.edges.length === 2, '插入后 edges=2 往返保留');
    const nodeIdsAfter = flowState.nodes.map(n => n.id).sort();
    assert(JSON.stringify(nodeIdsBefore) === JSON.stringify(nodeIdsAfter), '节点 id 集合往返一致');
    const restoredNew = flowState.nodes.find(n => n.id === newNode.id);
    assert(!!restoredNew && restoredNew.type === 'style-transfer' && restoredNew.status === 'idle', '新节点 id/type/status 往返保留');
    assert(flowState.edges.some(e => e.from === a.id && e.to === newNode.id)
      && flowState.edges.some(e => e.from === newNode.id && e.to === b.id), '插入重连边往返保留');
  }

  // ═══════ 7. 删除连线后 persistence 往返 ═══════
  {
    const { a, b, c } = setup3Chain();
    flowState.updateNode(b.id, { status: 'done' });
    const eBC = flowState.edges.find(e => e.from === b.id && e.to === c.id);
    flowState.removeEdge(eBC.id);
    const json = JSON.stringify(persistence.collect());
    flowState.clear();
    assert(persistence.restore(JSON.parse(json)) === true, '删边后项目 restore 成功');
    assert(flowState.edges.length === 1 && flowState.edges[0].from === a.id && flowState.edges[0].to === b.id, '删边后仅剩 A→B 往返保留');
    assert(flowState.nodes.length === 3, '节点不受删边影响（3 个保留）');
  }

  // ═══════ 8. 缩放坐标换算（端口拖拽依赖 canvasView.toWorldCoords） ═══════
  {
    // 桩 wrap：视口原点 (100,50)，画布 scale 由 flowState.canvas 决定
    canvasView.wrap = { getBoundingClientRect: () => ({ left: 100, top: 50, width: 800, height: 600 }) };
    // scale=1.5：屏幕 (250, 200) → 世界 ((250-100-60)/1.5, (200-50-40)/1.5)
    flowState.canvas = { scale: 1.5, panX: 60, panY: 40 };
    let w = canvasView.toWorldCoords(250, 200);
    assert(Math.abs(w.x - (250 - 100 - 60) / 1.5) < 1e-9 && Math.abs(w.y - (200 - 50 - 40) / 1.5) < 1e-9,
      `scale=1.5 坐标换算正确（got ${w.x.toFixed(2)},${w.y.toFixed(2)}）`);
    // scale=0.5
    flowState.canvas = { scale: 0.5, panX: 30, panY: 20 };
    w = canvasView.toWorldCoords(250, 200);
    assert(Math.abs(w.x - (250 - 100 - 30) / 0.5) < 1e-9 && Math.abs(w.y - (200 - 50 - 20) / 0.5) < 1e-9,
      `scale=0.5 坐标换算正确（got ${w.x.toFixed(2)},${w.y.toFixed(2)}）`);
    // worldToWrap 反向：返回 wrap 内相对坐标（pan + world*scale = client - wrap.rect 偏移）
    flowState.canvas = { scale: 0.5, panX: 30, panY: 20 };
    const back = canvasView.worldToWrap(w.x, w.y);
    assert(Math.abs(back.x - (250 - 100)) < 1e-6 && Math.abs(back.y - (200 - 50)) < 1e-6,
      `worldToWrap 反向换算正确（got ${back.x.toFixed(2)},${back.y.toFixed(2)}，预期 150,150）`);
  }

  // ═══════ 9. 插入步骤坐标中点（世界坐标，与缩放无关） ═══════
  {
    flowState.clear();
    const a = flowState.addNode('product-image', 100, 200);
    const b = flowState.addNode('style-transfer', 600, 500);
    flowState.setNodeImage(a.id, 'data:image/png;base64,R', 3 / 4);
    flowState.updateNode(a.id, { status: 'done' });
    const e = flowState.addEdge(a.id, b.id);
    const n = flowState.insertStep(e.id);
    // 起点 (a.x+260, a.y+cardH(a)/2)，终点 (b.x, b.y+cardH(b)/2)，中点为中心
    const hA = cardView.cardHeight(a);
    const hB = cardView.cardHeight(b);
    const midX = ((a.x + 260) + b.x) / 2;
    const midY = ((a.y + hA / 2) + (b.y + hB / 2)) / 2;
    assert(Math.abs((n.x + 130) - midX) < 1e-6 && Math.abs((n.y + cardView.cardHeight(n) / 2) - midY) < 1e-6,
      '插入点位于连线中点（y 方向也正确）');
  }

  // ═══════ 10. 多次插入链式增长 ═══════
  {
    const { a, b } = setup3Chain();
    const eAB = flowState.edges.find(e => e.from === a.id && e.to === b.id);
    const n1 = uiInsert(eAB.id);
    const eN1B = flowState.edges.find(e => e.from === n1.id && e.to === b.id);
    const n2 = uiInsert(eN1B.id);
    assert(!!n2, '二次插入成功');
    assert(flowState.edges.length === 4, '二次插入后边数 4');
    assert(flowState.edges.some(e => e.from === a.id && e.to === n1.id)
      && flowState.edges.some(e => e.from === n1.id && e.to === n2.id)
      && flowState.edges.some(e => e.from === n2.id && e.to === b.id), '二次插入链 A→N1→N2→B 正确');
  }

  console.log(`\n手动连线 QA 边界测试结束：${pass} 通过 / ${fail} 失败`);
  if (defects.length > 0) {
    console.log(`\n⚠ 观察到 ${defects.length} 处潜在缺陷（未计入失败，供报告判定）：`);
    defects.forEach(d => console.log('  -', d));
  }
  process.exitCode = fail > 0 ? 1 : 0;
})().catch(e => { console.error('测试执行异常:', e); process.exitCode = 2; });
