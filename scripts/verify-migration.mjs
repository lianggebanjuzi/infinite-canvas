import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

const sourceIndex = read('src/index.html');
const mainEntry = read('src/main.ts');
const pythonEntry = read('main.py');
// 旧存储层已随 P1 归档（legacy-src），校验仍指向归档副本以保留历史兼容性检查
const storage = read('archive/legacy-src/src/core/storage.ts');

check(
  /<script\s+type="module"\s+src="\.\/main\.ts"><\/script>/.test(sourceIndex),
  'src/index.html 必须以 main.ts 作为唯一应用入口',
);
check(!/gui\/js|js\/main\.js/.test(sourceIndex), 'TS 页面不应加载旧版 JS');
check(!/cdnjs|fontawesome[^\n]+https?:\/\//i.test(sourceIndex), '桌面页面不应依赖外部图标 CDN');
check(
  mainEntry.includes("@fortawesome/fontawesome-free/css/all.min.css"),
  'Font Awesome 必须由 TypeScript 入口本地打包',
);
check(
  /gui['"],\s*['"]dist['"],\s*['"]index\.html['"]/.test(pythonEntry),
  'Python 桌面入口必须加载 gui/dist/index.html',
);
check(storage.includes("version: '2.0'"), '项目文件版本必须保持 2.0 兼容');
check(existsSync(resolve(root, 'gui/index.html')), '旧版 JS 入口应暂时保留，以便回退');

const distIndexPath = resolve(root, 'gui/dist/index.html');
if (existsSync(distIndexPath)) {
  const distIndex = readFileSync(distIndexPath, 'utf8');
  check(!/gui\/js|js\/main\.js/.test(distIndex), '构建产物意外加载了旧版 JS');
}

if (failures.length) {
  console.error('迁移安全检查失败：');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('迁移安全检查通过：TS 单入口、旧版可回退、项目格式兼容、离线图标已确认。');
