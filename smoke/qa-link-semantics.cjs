// Phase 3 连线语义回归：只验证展示推断，确保不引入 .icproj 字段或改变执行规则。
'use strict';

const path = require('path');
const BASE = path.resolve(process.argv[2] || path.join(process.cwd(), '.icv-qa-current', 'v1'));

function makeEl(over = {}) {
  const classes = new Set();
  return {
    classList: { add(c) { classes.add(c); }, remove(c) { classes.delete(c); }, toggle(c, on) { if (on) classes.add(c); else classes.delete(c); }, contains(c) { return classes.has(c); } },
    style: {}, dataset: {}, children: [], addEventListener() {}, removeEventListener() {},
    appendChild(child) { this.children.push(child); return child; }, remove() {}, setAttribute() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
    ...over,
  };
}

global.window = { addEventListener() {}, setTimeout, clearTimeout, requestAnimationFrame(fn) { fn(); }, pywebview: { api: {} } };
global.document = { getElementById() { return null; }, createElement() { return makeEl(); }, createElementNS() { return makeEl(); }, body: makeEl(), querySelector() { return null; }, querySelectorAll() { return []; } };
global.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };

const { nodeRegistry } = require(path.join(BASE, 'nodes/node-registry.js'));
require(path.join(BASE, 'nodes/image-gen.js'));
require(path.join(BASE, 'nodes/text-gen.js'));
require(path.join(BASE, 'nodes/text-split.js'));
const { flowState } = require(path.join(BASE, 'state/flow-state.js'));
const { linkRelation, connectionDescription } = require(path.join(BASE, 'canvas/link-view.js'));

let passed = 0;
function check(condition, message) { if (!condition) throw new Error(message); passed += 1; }
function reset() { flowState.nodes = []; flowState.edges = []; flowState.selectedIds.clear(); }
function image(over = {}) { return flowState.addNode('image-gen', 0, 0, { imageUrl: 'data:image/png;base64,IMAGE', status: 'done', ...over }); }

reset();
const source = image({ isAsset: true, title: '素材' });
const step = image({ imageUrl: null, status: 'idle', title: '继续创作' });
const reference = flowState.addEdge(source.id, step.id, { suppressStale: true });
check(linkRelation(reference) === 'reference', '素材图 → 创作步骤推断为「参考」');
check(connectionDescription(source.id, step.id).includes('参考图'), '参考边说明仍表明会作为参考图');

const text = flowState.addNode('text-gen', 0, 0, { outputText: '雨夜霓虹' });
const drawing = image({ imageUrl: null, status: 'idle' });
const textEdge = flowState.addEdge(text.id, drawing.id, { suppressStale: true });
check(linkRelation(textEdge) === 'text-input', '文本 → 图片生成推断为「文字」');
check(connectionDescription(text.id, drawing.id).includes('提示词'), '文字边说明仍表明会拼入提示词');

const output = image({ parentId: drawing.id, title: '生成结果' });
const result = flowState.addEdge(drawing.id, output.id, { suppressStale: true });
check(linkRelation(result) === 'result', 'parentId 匹配的图片边推断为「结果」');
check(connectionDescription(drawing.id, output.id).includes('结果'), '结果边说明明确表示来源关系');

const split = flowState.addNode('text-split', 0, 0, { params: { delimiter: '---', segments: ['甲'] } });
const splitTarget = image({ imageUrl: null, status: 'idle' });
const splitEdge = flowState.addEdge(split.id, splitTarget.id, { suppressStale: true });
check(linkRelation(splitEdge) === 'text-input', '文本拆分 → 图片生成同样显示为「文字」');

check(!Object.prototype.hasOwnProperty.call(reference, 'relation'), 'FlowEdge 未新增 relation 字段，旧 .icproj 格式不变');
console.log(`Phase 3 连线语义 QA 通过：${passed} 项`);
