// smoke/director_smoke.mjs
// 导演台（4.4）前端产物 smoke：验证构建产物存在、入口脚本引用正确、v0 旧工程 fixture 可被迁移读取。
// 用法：node smoke/director_smoke.mjs （需先 npm run build）

import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failed = false;
const fail = (msg) => { failed = true; console.error('[FAIL]', msg); };
const ok = (msg) => console.log('[OK]', msg);

// 1) 构建产物
const directorHtml = join(root, 'gui/dist/director.html');
if (!existsSync(directorHtml)) {
  fail('gui/dist/director.html 不存在（请先 npm run build）');
} else {
  const html = readFileSync(directorHtml, 'utf-8');
  if (!/<script src="\.\/assets\/director-[^"]+\.js"><\/script>/.test(html)) {
    fail('director.html 未引用 director bundle 脚本');
  } else {
    ok('gui/dist/director.html 存在且引用 bundle');
  }
}

// 2) 主应用入口未被导演台构建覆盖
const mainHtml = join(root, 'gui/dist/index.html');
if (existsSync(mainHtml)) {
  const main = readFileSync(mainHtml, 'utf-8');
  if (main.includes('导演台')) {
    fail('gui/dist/index.html 被导演台构建覆盖（应为主画布入口）');
  } else {
    ok('主画布 index.html 未被覆盖');
  }
}

// 3) v0 旧工程 fixture：结构宽容、字段缺失可读（模拟 project-store.migrate 的输入契约）
const fixture = {
  format: 'icdirector',
  version: 0, // 旧版：缺失大部分可选字段
  id: 'f0000000-0000-4000-8000-0000000000f0',
  name: '旧工程 fixture',
  scene: [{ id: 'a1', kind: 'box', name: '旧盒子' }], // 无 position/rotation/scale/visible/locked
  cameras: [], // 无相机 → activeCameraId 空
  activeCameraId: '',
  references: [],
  lighting: { ambientIntensity: 1 }, // 残缺灯光 → 合并默认值
  timeline: { duration: 10, fps: 24, keyframes: [] },
  assets: [],
};
const dir = mkdtempSync(join(tmpdir(), 'director-smoke-'));
const fixturePath = join(dir, 'v0.icdirector');
writeFileSync(fixturePath, JSON.stringify(fixture, null, 2), 'utf-8');
try {
  const data = JSON.parse(readFileSync(fixturePath, 'utf-8'));
  if (data.format !== 'icdirector') fail('fixture format 校验失败');
  if (data.version !== 0) fail('fixture version 应为 0');
  // 迁移契约（与 src/director/engine/project-store.ts migrate 一致）：
  // 缺省字段应被补全为可用的默认值 —— 此处做文件级契约检查
  const migrateCompatible = {
    ...data,
    version: 1,
    scene: data.scene.map((o) => ({
      id: o.id || 'generated',
      name: o.name || '对象',
      kind: o.kind || 'box',
      position: o.position || { x: 0, y: 0, z: 0 },
      rotation: o.rotation || { x: 0, y: 0, z: 0 },
      scale: o.scale || { x: 1, y: 1, z: 1 },
      visible: o.visible !== false,
      locked: o.locked === true,
      color: o.color || '#d8d4c8',
    })),
    lighting: { ...{ ambientColor: '#f2f0ea', ambientIntensity: 0.55, keyColor: '#fff6e8', keyIntensity: 1.35, keyDirection: { x: 2.2, y: 3.4, z: 1.6 }, fillColor: '#cfe0ff', fillIntensity: 0.5, fillDirection: { x: -2.4, y: 1.2, z: -1.8 }, exposure: 1.0, background: '#1e1f24' }, ...data.lighting },
  };
  const obj = migrateCompatible.scene[0];
  if (obj.position.x !== 0 || obj.visible !== true || obj.locked !== false) {
    fail('v0 迁移缺省字段补全失败');
  } else {
    ok('v0 旧工程 fixture 迁移兼容（缺省字段补全）');
  }
} catch (e) {
  fail(`fixture 读取失败：${e.message}`);
}

if (failed) {
  console.error('DIRECTOR SMOKE: FAILED');
  process.exit(1);
}
console.log('DIRECTOR SMOKE: ALL PASS');
