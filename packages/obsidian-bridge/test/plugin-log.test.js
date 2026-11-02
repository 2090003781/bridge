// Bridge · 插件运行日志
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createPluginLog } = require('../src/lib/plugin-log.js');

function tmpDir() {
  return path.join(os.tmpdir(), `bridge-log-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
}

test('写入后能按时间读出', () => {
  const dir = tmpDir();
  const log = createPluginLog({ file: path.join(dir, 'bridge.log') });
  log.write('start', '服务启动 :8811');
  log.write('error', '端口占用');

  const text = log.read();
  assert.match(text, /\[start\] 服务启动 :8811/);
  assert.match(text, /\[error\] 端口占用/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('read 只取最后 N 行', () => {
  const dir = tmpDir();
  const log = createPluginLog({ file: path.join(dir, 'bridge.log') });
  for (let i = 0; i < 20; i += 1) log.write('tick', `第 ${i} 条`);
  const lines = log.read(3).split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[2], /第 19 条/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('超过上限自动裁剪，不无限长', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'bridge.log');
  const log = createPluginLog({ file, maxBytes: 1024 });
  for (let i = 0; i < 200; i += 1) log.write('tick', `填充内容 ${i} ${'x'.repeat(20)}`);
  const size = fs.statSync(file).size;
  assert.ok(size <= 1024 + 200, `文件应被裁剪，实际 ${size}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('读不存在的文件返回空串', () => {
  const log = createPluginLog({ file: path.join(tmpDir(), 'nope.log') });
  assert.equal(log.read(), '');
});