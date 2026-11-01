// Bridge · 打包覆盖
// 背景：build.js 曾用手写模块清单，新增 lib 文件漏加 → Obsidian 里运行期
// MODULE_NOT_FOUND，而单测不加载 bundle 所以全绿。这两条测试盯住这件事。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function walkJs(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) out.push(...walkJs(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('src 里所有相对 require 都指向真实存在的文件', () => {
  const missing = [];
  for (const file of walkJs(SRC)) {
    const code = fs.readFileSync(file, 'utf8');
    for (const m of code.matchAll(/require\('\.{1,2}\/([^']+)'\)/g)) {
      const target = path.resolve(path.dirname(file), m[1]);
      if (!fs.existsSync(target)) missing.push(`${path.relative(ROOT, file)} → ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], '有 require 指向不存在的文件');
});

test('build 产物包含 src/lib 下所有模块（除了显式排除的）', () => {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build.js')], { stdio: 'pipe' });
  const bundle = fs.readFileSync(path.join(ROOT, 'dist', 'main.js'), 'utf8');
  const excluded = new Set(['mcp-handler.js']);
  for (const name of fs.readdirSync(path.join(SRC, 'lib'))) {
    if (!name.endsWith('.js') || excluded.has(name)) continue;
    assert.ok(bundle.includes(`__define('lib/${name}'`), `${name} 没进 bundle`);
  }
});
