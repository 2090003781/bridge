// 从 session 日志里读最近的对话（reload 后把面板的消息恢复出来）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { readRecentMessages } from '../src/core/transcript.mjs';

function writeSession(file, events) {
  const frames = events.map((e) => zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n', 'utf8')));
  fs.writeFileSync(file, Buffer.concat(frames));
}

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-transcript-'));
  return path.join(dir, 'session.v3.jsonl.zstd');
}

test('取出最近的 user / assistant 消息，按时间顺序', () => {
  const f = tmpFile();
  writeSession(f, [
    { type: 'session', seq: 1, data: {} },
    { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '你好' }] } },
    { type: 'assistant/message', seq: 3, data: { message: { role: 'assistant', content: [{ type: 'text', text: '你好，有什么可以帮你' }] } } },
    { type: 'tool/call', seq: 4, data: { name: 'pwsh' } },
    { type: 'user/message', seq: 5, data: { content: [{ type: 'text', text: '看看文件' }] } },
    { type: 'assistant/message', seq: 6, data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } } },
  ]);
  const msgs = readRecentMessages(f, 10);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(msgs[0].text, '你好');
  assert.equal(msgs[1].text, '你好，有什么可以帮你');
  assert.equal(msgs[3].text, '好的');
});

test('只要最近 N 条', () => {
  const f = tmpFile();
  const events = [];
  for (let i = 0; i < 20; i += 1) {
    events.push({ type: 'user/message', seq: i * 2 + 1, data: { content: [{ type: 'text', text: 'u' + i }] } });
    events.push({ type: 'assistant/message', seq: i * 2 + 2, data: { message: { content: [{ type: 'text', text: 'a' + i }] } } });
  }
  writeSession(f, events);
  const msgs = readRecentMessages(f, 4);
  assert.equal(msgs.length, 4);
  assert.equal(msgs[msgs.length - 1].text, 'a19');
});

test('reasoning 块不算消息正文', () => {
  const f = tmpFile();
  writeSession(f, [
    { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'reasoning', text: '内心戏' }, { type: 'text', text: '真正的回答' }] } } },
  ]);
  const msgs = readRecentMessages(f, 5);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, '真正的回答');
});

test('文件不存在返回空数组', () => {
  assert.deepEqual(readRecentMessages(path.join(os.tmpdir(), 'nope-' + Date.now() + '.zstd'), 5), []);
});
