// 上下文占用：从会话日志尾部读出「窗口多大、现在用了多少」
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { readUsage, percentOf } from '../src/core/usage.mjs';

function writeSession(events) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-'));
  const file = path.join(dir, 'session.v3.jsonl.zstd');
  const frames = events.map((e) => zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n', 'utf8')));
  fs.writeFileSync(file, Buffer.concat(frames));
  return file;
}

const ctxEvent = (window) => ({
  type: 'request/context',
  data: { provider: 'deepseek-official', model: 'deepseek-flash', contextWindow: window },
});

const asst = (usage) => ({
  type: 'assistant/message',
  data: { message: { role: 'assistant', content: [] }, usage },
});

test('读出窗口、已用和百分比', () => {
  const file = writeSession([
    ctxEvent(1000000),
    asst({ inputTokens: 154, outputTokens: 94, cacheReadTokens: 275456, totalTokens: 275704 }),
  ]);
  const u = readUsage(file);
  assert.equal(u.window, 1000000);
  assert.equal(u.used, 275610, '已用 = 输入 + 命中缓存（输出不算进下一次的提示词压力）');
  assert.equal(u.percent, 27.6);
  assert.equal(u.model, 'deepseek-flash');
});

test('取最新一次用量，不是第一次', () => {
  const file = writeSession([
    ctxEvent(1000000),
    asst({ inputTokens: 10, cacheReadTokens: 90 }),
    asst({ inputTokens: 20, cacheReadTokens: 480 }),
  ]);
  assert.equal(readUsage(file).used, 500);
});

test('没有窗口记录时窗口给 null，百分比不算', () => {
  const file = writeSession([asst({ inputTokens: 10, cacheReadTokens: 90 })]);
  const u = readUsage(file);
  assert.equal(u.window, null);
  assert.equal(u.used, 100);
  assert.equal(u.percent, null);
});

test('没有用量时 used 为 0，不编一个数', () => {
  const file = writeSession([ctxEvent(128000)]);
  const u = readUsage(file);
  assert.equal(u.used, 0);
  assert.equal(u.percent, 0);
});

test('文件不存在 / 空文件：返回 null，不炸', () => {
  assert.equal(readUsage(path.join(os.tmpdir(), 'nope-' + Date.now() + '.zstd')), null);
  assert.equal(readUsage(null), null);
});

test('百分比：一位小数，夹在 0-100', () => {
  assert.equal(percentOf(275610, 1000000), 27.6);
  assert.equal(percentOf(0, 1000000), 0);
  assert.equal(percentOf(2000000, 1000000), 100);
  assert.equal(percentOf(1, 0), null);
  assert.equal(percentOf(1, null), null);
});
