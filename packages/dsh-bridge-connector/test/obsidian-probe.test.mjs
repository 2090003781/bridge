// Bridge 连接器 · 投递前现查 Obsidian
// 判据：查得到就用最新的；查不到必须安静地失败（返回 ok:false），绝不拖慢投递。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createObsidianProbe, mergeActiveNote, toSelection } from '../src/core/obsidian-probe.mjs';

function tempInfo(port, token = 'tk') {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'probe-')), 'info.json');
  fs.writeFileSync(file, JSON.stringify({ host: '127.0.0.1', port, token }), 'utf8');
  return file;
}

async function fakeBridge(handler) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const out = handler(body, req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

test('正常拿到路径、光标、行数', async (t) => {
  const bridge = await fakeBridge((body) => {
    assert.equal(body.op, 'obsidian.editor.state');
    return {
      ok: true,
      data: { available: true, path: '项目/a.md', mode: 'source', cursor: { line: 12, ch: 3 }, selection: null, lineCount: 80 },
    };
  });
  t.after(() => bridge.server.close());

  const probe = createObsidianProbe({ infoFile: tempInfo(bridge.port) });
  const live = await probe.editorState();

  assert.equal(live.ok, true);
  assert.equal(live.data.path, '项目/a.md');
  assert.deepEqual(live.data.cursor, { line: 12, ch: 3 });
  assert.equal(live.data.lineCount, 80);
});

test('Obsidian 说没有打开的笔记时，data 为 null 而不是报错', async (t) => {
  const bridge = await fakeBridge(() => ({ ok: true, data: { available: false } }));
  t.after(() => bridge.server.close());

  const probe = createObsidianProbe({ infoFile: tempInfo(bridge.port) });
  const live = await probe.editorState();

  assert.equal(live.ok, true);
  assert.equal(live.data, null);
});

test('连不上时安静失败，不抛异常', async () => {
  // 指向一个没人听的端口
  const probe = createObsidianProbe({ infoFile: tempInfo(9), timeoutMs: 300 });
  const live = await probe.editorState();
  assert.equal(live.ok, false);
  assert.ok(live.error);
});

test('info.json 不存在时直接报 offline，不发请求', async () => {
  const probe = createObsidianProbe({ infoFile: path.join(os.tmpdir(), 'no-such-info-xyz.json') });
  const live = await probe.editorState();
  assert.equal(live.ok, false);
  assert.equal(live.error.code, 'offline');
});

test('token 过期之类的失败原样返回给调用方', async (t) => {
  const bridge = await fakeBridge(() => ({ ok: false, error: { code: 'unauthorized', message: '缺少或错误的 token' } }));
  t.after(() => bridge.server.close());

  const probe = createObsidianProbe({ infoFile: tempInfo(bridge.port) });
  const live = await probe.editorState();
  assert.equal(live.ok, false);
  assert.equal(live.error.code, 'unauthorized');
});

test('合并：现查坐标优先，同篇时用缓存补字数和小节', () => {
  const pushed = {
    path: 'a.md',
    title: 'A',
    charCount: 900,
    lineCount: 100,
    updatedAt: '2026-11-08 19:00',
    heading: '## 第二节',
    cursor: { line: 5, ch: 0 },
    selection: null,
    checked: true,
  };
  const live = { path: 'a.md', cursor: { line: 60, ch: 2 }, selection: null, lineCount: 100 };

  const merged = mergeActiveNote(live, pushed);
  assert.deepEqual(merged.cursor, { line: 60, ch: 2 }, '光标用现查的');
  assert.equal(merged.heading, '## 第二节', '小节用缓存补');
  assert.equal(merged.charCount, 900);
});

test('合并：换了另一篇时不借用上一篇的缓存字段', () => {
  const pushed = { path: 'old.md', title: '旧', heading: '## 旧的', charCount: 1, checked: true };
  const live = { path: 'new.md', cursor: { line: 1, ch: 0 }, selection: null, lineCount: 10 };

  const merged = mergeActiveNote(live, pushed);
  assert.equal(merged.path, 'new.md');
  assert.equal(merged.title, 'new', '标题取新文件名，不继承旧的');
  assert.equal(merged.heading, null);
  assert.equal(merged.charCount, null);
});


// ── 选区形状转换 ──
test('toSelection 把 Obsidian 的 anchor/head 形状转成内部形状', () => {
  const s = toSelection({
    from: { line: 3, ch: 1 },
    to: { line: 5, ch: 4 },
    length: 12,
    text: '一二三',
  });
  assert.deepEqual(s, { fromLine: 3, fromCh: 1, toLine: 5, toCh: 4, chars: 12, preview: '一二三' });
});

test('toSelection 缺字段时不编位置，直接给 null', () => {
  assert.equal(toSelection(null), null);
  assert.equal(toSelection({}), null);
  assert.equal(toSelection({ from: { line: 1, ch: 0 } }), null);
});

test('editorState 带回转好的选区', async (t) => {
  const bridge = await fakeBridge(() => ({
    ok: true,
    data: {
      available: true,
      path: 'a.md',
      focused: false,
      cursor: { line: 7, ch: 2 },
      selection: { from: { line: 7, ch: 0 }, to: { line: 8, ch: 0 }, length: 30, text: '选中的一段' },
      lineCount: 200,
    },
  }));
  t.after(() => bridge.server.close());

  const probe = createObsidianProbe({ infoFile: tempInfo(bridge.port) });
  const live = await probe.editorState();

  assert.deepEqual(live.data.selection, {
    fromLine: 7,
    fromCh: 0,
    toLine: 8,
    toCh: 0,
    chars: 30,
    preview: '选中的一段',
  });
});
