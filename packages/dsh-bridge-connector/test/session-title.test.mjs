// 会话标题：从 session 日志（多帧 zstd）里读 session/title 事件
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { readTitleFromLog, createTitleCache } from '../src/core/session-title.mjs';

// DSH 的日志是「一行事件一个 zstd frame」拼起来的，这里照着造一个
function writeSessionFile(file, events) {
  const frames = events.map((e) => zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n', 'utf8')));
  fs.writeFileSync(file, Buffer.concat(frames));
}

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sess-title-'));
  return path.join(dir, 'session.v3.jsonl.zstd');
}

test('能从多帧日志里取出最新的 session/title', () => {
  const f = tmpFile();
  writeSessionFile(f, [
    { type: 'session', seq: 1, data: {} },
    { type: 'user/message', seq: 2, data: {} },
    { type: 'session/title', seq: 3, data: { title: '第一版标题', source: { kind: 'fallback' } } },
    { type: 'assistant/message', seq: 4, data: {} },
    { type: 'session/title', seq: 5, data: { title: 'Obsidian与DSH内核插件连接', source: { kind: 'provider' } } },
  ]);
  assert.equal(readTitleFromLog(f), 'Obsidian与DSH内核插件连接');
});

test('没有 title 事件时返回 null', () => {
  const f = tmpFile();
  writeSessionFile(f, [
    { type: 'session', seq: 1, data: {} },
    { type: 'user/message', seq: 2, data: {} },
  ]);
  assert.equal(readTitleFromLog(f), null);
});

test('文件不存在时返回 null，不抛错', () => {
  assert.equal(readTitleFromLog(path.join(os.tmpdir(), 'nope-' + Date.now() + '.zstd')), null);
});

test('缓存按 mtime+size 判断，文件没了也还认上次的值', () => {
  const f = tmpFile();
  writeSessionFile(f, [
    { type: 'session/title', seq: 1, data: { title: '缓存标题' } },
  ]);
  const cache = createTitleCache();
  assert.equal(cache.get('s1', f), '缓存标题');
  fs.unlinkSync(f);
  assert.equal(cache.get('s1', f), '缓存标题', '缓存命中不该再读盘');
});
