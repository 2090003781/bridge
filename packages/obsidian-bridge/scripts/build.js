'use strict';
// Bridge Bridge · 零依赖打包器
// Obsidian 加载插件时按模块名解析 require，不认 main.js 的相对路径；
// 所以把 lib 模块全部内联进一个 main.js（外部的 obsidian / node:* 仍走原生 require）。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// 模块清单自动扫描，不再手写：手写清单漏一个，Obsidian 里就是运行期
// MODULE_NOT_FOUND（单测不加载 bundle，所以全绿），这个坑已经踩过一次。
const LIB_DIR = path.join(ROOT, 'src', 'lib');
const EXCLUDE = new Set([
  'mcp-handler.js', // 只给 Node 侧的 MCP 脚本用，不进 Obsidian 包
]);
const MODULES = fs
  .readdirSync(LIB_DIR)
  .filter((name) => name.endsWith('.js') && !EXCLUDE.has(name))
  .sort()
  .map((name) => `lib/${name}`);
const ENTRY = 'main.js';

function transform(code) {
  // require('./driver.js') 或 require('./lib/driver.js') → __req('lib/driver.js')
  return code.replace(/require\('\.\/(?:lib\/)?([^']+)'\)/g, (m, file) => `__req('lib/${file}')`);
}

function wrap(id, code) {
  return `__define('${id}', function (module, exports, require) {\n${transform(code)}\n});`;
}

const parts = [];
parts.push(`'use strict';
// 由 scripts/build.js 生成，不要手改。
const __nativeRequire = require;
const __mods = Object.create(null);
function __define(id, fn) { __mods[id] = { fn, loaded: false, exports: {} }; }
function __req(id) {
  const m = __mods[id];
  if (!m) return __nativeRequire(id);
  if (!m.loaded) { m.loaded = true; m.fn(m, m.exports, __req); }
  return m.exports;
}
`);

for (const id of MODULES) {
  const file = path.join(ROOT, 'src', id);
  parts.push(wrap(id, fs.readFileSync(file, 'utf8')));
}
parts.push(wrap('main.js', fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8')));
parts.push(`module.exports = __req('main.js');\n`);

// 打包自检：内联模块里引用的 lib/xxx 必须也在清单里，
// 否则 Obsidian 加载时报 MODULE_NOT_FOUND（单测发现不了，因为不加载 bundle）。
const inlineIds = new Set(MODULES);
const missingMods = [];
for (const id of MODULES) {
  const code = transform(fs.readFileSync(path.join(ROOT, 'src', id), 'utf8'));
  for (const m of code.matchAll(/__req\('(lib\/[^']+)'\)/g)) {
    if (!inlineIds.has(m[1])) missingMods.push(`${id} → ${m[1]}`);
  }
}
if (missingMods.length) {
  console.error('打包自检失败：这些模块没被内联\n' + missingMods.join('\n'));
  process.exit(1);
}

const outDir = path.join(ROOT, 'dist');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'main.js');
fs.writeFileSync(outFile, parts.join('\n'), 'utf8');

const bytes = fs.statSync(outFile).size;
console.log(`built ${outFile} (${bytes} bytes)`);