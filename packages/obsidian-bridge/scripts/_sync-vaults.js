'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const A = 'D:/枢阁/库';
const B = 'D:/个人数据/辞玖';
const BACKUP = path.join(__dirname, '..', '_sync-backup');
const APPLY = process.argv.includes('--apply');

const SKIP_DIRS = new Set(['.git', '.obsidian', '.库元数据', '.trash', '.smart-env', '.claude']);
const OK_EXT = new Set([
  '.md', '.txt', '.canvas', '.excalidraw',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp',
  '.pdf', '.docx', '.xlsx', '.pptx', '.csv',
]);

function walk(root) {
  const files = new Map();
  function rec(dir) {
    let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) rec(full);
      else files.set(path.relative(root, full).replace(/\\/g, '/'), full);
    }
  }
  rec(root);
  return files;
}

const a = walk(A);
const b = walk(B);

const toCopy = [];
const toOverwrite = [];
const skippedExt = [];
for (const [rel, full] of a) {
  const ext = path.extname(rel).toLowerCase();
  if (!OK_EXT.has(ext)) { skippedExt.push(rel); continue; }
  const target = path.join(B, rel);
  if (!fs.existsSync(target)) {
    toCopy.push(rel);
    continue;
  }
  const ha = crypto.createHash('md5').update(fs.readFileSync(full)).digest('hex');
  const hb = crypto.createHash('md5').update(fs.readFileSync(target)).digest('hex');
  if (ha !== hb) toOverwrite.push(rel);
}

console.log(`干跑（${APPLY ? 'APPLY' : 'DRY-RUN'}）`);
console.log(`新增: ${toCopy.length} | 覆盖: ${toOverwrite.length} | 跳过非笔记/非附件: ${skippedExt.length}`);
console.log('跳过类型样例:', JSON.stringify([...new Set(skippedExt.map((x) => path.extname(x)))].slice(0, 12)));
console.log('\n覆盖样例（前 10）:'); console.log(toOverwrite.slice(0, 10).join('\n'));
console.log('\n新增样例（前 10）:'); console.log(toCopy.slice(0, 10).join('\n'));

if (!APPLY) process.exit(0);

// 备份会被覆盖的文件
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(BACKUP, stamp);
fs.mkdirSync(backupDir, { recursive: true });
for (const rel of toOverwrite) {
  const src = path.join(B, rel);
  const dst = path.join(backupDir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

let copied = 0;
let overwritten = 0;
for (const rel of toCopy) {
  const dst = path.join(B, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(A, rel), dst);
  copied += 1;
}
for (const rel of toOverwrite) {
  const dst = path.join(B, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(A, rel), dst);
  overwritten += 1;
}
console.log(`\n完成：新增 ${copied}，覆盖 ${overwritten}，备份在 ${backupDir}`);