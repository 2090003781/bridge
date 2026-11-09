// Bridge 连接器 · 当前笔记的坐标：什么时候记、什么时候搭车
// 判据：同一会话里同一篇只进一次；没问到就不进；没笔记就不进。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startConnector } from '../src/core/server.mjs';

function fakeSessions(items = [{ sessionId: 's1', cwd: 'D:/a', updatedAt: 5000 }]) {
  const calls = [];
  return {
    calls,
    list: async () => ({ items }),
    create: async (req) => {
      calls.push(['create', req]);
      return { sessionId: 'session-new' };
    },
    prompt: async (req) => {
      calls.push(['prompt', req]);
      return { accepted: true };
    },
  };
}

async function boot(options = {}) {
  const sessions = options.sessions || fakeSessions();
  const server = await startConnector({
    sessions,
    token: 'test-token',
    host: '127.0.0.1',
    port: 0,
    injectionState: { on: true },
    // 默认让「现查」失败：这批用例盯的是推送缓存那条路。
    // 现查成功/明确为空的分支由下面两条用例单独覆盖。
    obsidianProbe: options.probe || {
      editorState: async () => ({ ok: false, error: { code: 'offline', message: '测试不连真 Obsidian' } }),
    },
  });
  return { server, base: server.url, token: 'test-token', sessions };
}

const auth = (token) => ({ 'content-type': 'application/json', 'x-bridge-token': token });

const note = (over = {}) => ({
  path: '项目/架构说明.md',
  title: '架构说明',
  charCount: 7083,
  lineCount: 201,
  updatedAt: '2026-11-08 19:42',
  cursor: { line: 127, ch: 4 },
  heading: '## 2.4 点亮判据',
  checked: true,
  ...over,
});

async function pushNote(ctx, payload) {
  return fetch(`${ctx.base}/active-note`, {
    method: 'POST',
    headers: auth(ctx.token),
    body: JSON.stringify(payload),
  });
}

async function sendTask(ctx, payload) {
  const res = await fetch(`${ctx.base}/task`, {
    method: 'POST',
    headers: auth(ctx.token),
    body: JSON.stringify(payload),
  });
  return res.json();
}

const lastPromptText = (ctx) => {
  const calls = ctx.sessions.calls.filter((c) => c[0] === 'prompt');
  return calls[calls.length - 1][1].content[0].text;
};

test('推上来的坐标被规整存好，不存正文', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());

  await pushNote(ctx, note());
  const live = ctx.server.activeNote();

  assert.equal(live.path, '项目/架构说明.md');
  assert.equal(live.title, '架构说明');
  assert.equal(live.lineCount, 201);
  assert.deepEqual(live.cursor, { line: 127, ch: 4 });
  assert.equal(live.heading, '## 2.4 点亮判据');
  assert.equal(live.content, undefined, '不该存正文');
});

test('path:null 清空 —— 切到无正文视图时不能让旧的一篇冒充当前', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());
  await pushNote(ctx, note());
  assert.ok(ctx.server.activeNote());

  const res = await pushNote(ctx, { path: null });
  assert.equal((await res.json()).data.cleared, true);
  assert.equal(ctx.server.activeNote(), null);
});

test('第一次提问带上坐标，同一篇第二次就不带了', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());
  await pushNote(ctx, note());

  await sendTask(ctx, { sessionId: 's1', message: '这句什么意思' });
  const first = lastPromptText(ctx);
  assert.match(first, /【Obsidian 当前窗口】架构说明 · 项目\/架构说明\.md/);
  assert.match(first, /光标在第 128 行第 5 列/);
  assert.match(first, /，小节「## 2\.4 点亮判据」/);
  assert.match(first, /正文未附/);
  assert.match(first, /【Obsidian】这句什么意思/);

  await sendTask(ctx, { sessionId: 's1', message: '继续说' });
  const second = lastPromptText(ctx);
  assert.doesNotMatch(second, /【Obsidian 当前窗口】/, '整篇坐标只该给一次');
  assert.match(second, /【光标】/, '光标每轮都要有');
  assert.match(second, /第 128 行第 5 列/);
  assert.match(second, /【Obsidian】继续说/);
});

test('换一篇就重新带一次', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());
  await pushNote(ctx, note());
  await sendTask(ctx, { sessionId: 's1', message: 'A' });

  await pushNote(ctx, note({ path: '另一篇.md', title: '另一篇' }));
  await sendTask(ctx, { sessionId: 's1', message: 'B' });
  assert.match(lastPromptText(ctx), /【Obsidian 当前窗口】另一篇/);
});

test('不同会话各带一次，互不影响', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());
  await pushNote(ctx, note());

  await sendTask(ctx, { sessionId: 's1', message: '一问' });
  await sendTask(ctx, { sessionId: 's2', message: '二问' });

  const calls = ctx.sessions.calls.filter((c) => c[0] === 'prompt');
  assert.match(calls[0][1].content[0].text, /【Obsidian 当前窗口】/);
  assert.match(calls[1][1].content[0].text, /【Obsidian 当前窗口】/);
});

test('没有打开笔记时消息保持原样，不塞空壳', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());
  await sendTask(ctx, { sessionId: 's1', message: '你好' });
  // 没有笔记也要说一声「没有」，不能沉默
  assert.match(lastPromptText(ctx), /【光标】没有打开的笔记/);
  assert.match(lastPromptText(ctx), /【Obsidian】你好/);
});

test('同一会话连发三轮，只第一轮带坐标', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());
  await pushNote(ctx, note());

  await sendTask(ctx, { sessionId: 's1', message: '1' });
  await sendTask(ctx, { sessionId: 's1', message: '2' });
  await sendTask(ctx, { sessionId: 's1', message: '3' });

  const calls = ctx.sessions.calls.filter((c) => c[0] === 'prompt');
  const full = calls.filter((c) => /【Obsidian 当前窗口】/.test(c[1].content[0].text));
  assert.equal(full.length, 1, '整篇坐标三轮只该带一次');
  // 第一轮的光标写在整篇块里，第二三轮是单独的光标行——三轮都得有光标
  const withCursor = calls.filter((c) => /光标在|最后处在|【光标】/.test(c[1].content[0].text));
  assert.equal(withCursor.length, 3, '光标每轮都要有');
});

test('现查成功时以现查的光标为准，压过推送缓存', async (t) => {
  const ctx = await boot({
    probe: {
      editorState: async () => ({
        ok: true,
        data: {
          path: '项目/架构说明.md',
          mode: 'source',
          cursor: { line: 42, ch: 7 },
          selection: null,
          lineCount: 500,
        },
      }),
    },
  });
  t.after(() => ctx.server.close());

  // 推送缓存里光标在第 128 行；现查说第 43 行 —— 应当信现查
  await pushNote(ctx, note());
  await sendTask(ctx, { sessionId: 's1', message: '看这里' });

  const text = lastPromptText(ctx);
  assert.match(text, /第 43 行第 8 列/);
  assert.doesNotMatch(text, /第 128 行/);
});

test('现查明确说没有打开的笔记，就不带坐标', async (t) => {
  const ctx = await boot({ probe: { editorState: async () => ({ ok: true, data: null }) } });
  t.after(() => ctx.server.close());

  await pushNote(ctx, note()); // 缓存里还挂着上一篇
  await sendTask(ctx, { sessionId: 's1', message: '你好' });

  const text = lastPromptText(ctx);
  assert.doesNotMatch(text, /【Obsidian 当前窗口】/);
  assert.match(text, /没有打开的笔记/);
});

test('focused 和 others 会被规整保留', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());

  await pushNote(ctx, note({ focused: false, others: ['a.md', 'b.md'] }));
  const live = ctx.server.activeNote();
  assert.equal(live.focused, false);
  assert.deepEqual(live.others, ['a.md', 'b.md']);
});

test('旧客户端不发 focused 时当成「焦点在编辑器里」', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());

  await pushNote(ctx, note());
  assert.equal(ctx.server.activeNote().focused, true);
  assert.deepEqual(ctx.server.activeNote().others, []);
});

test('others 里的非字符串被丢掉，最多留 8 条', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());

  await pushNote(ctx, note({ others: ['a.md', 123, null, 'b.md', 'c.md', 'd.md', 'e.md', 'f.md', 'g.md', 'h.md', 'i.md'] }));
  const live = ctx.server.activeNote();
  assert.equal(live.others.length, 8);
  assert.ok(live.others.every((x) => typeof x === 'string'));
});