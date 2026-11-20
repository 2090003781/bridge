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
  assert.match(first, /正文未附/);
  assert.match(first, /【Obsidian】这句什么意思/);
  // 光标位置一概不报
  assert.doesNotMatch(first, /光标/);
  assert.doesNotMatch(first, /小节/);

  await sendTask(ctx, { sessionId: 's1', message: '继续说' });
  const second = lastPromptText(ctx);
  assert.doesNotMatch(second, /【Obsidian 当前窗口】/, '整篇坐标只该给一次');
  assert.doesNotMatch(second, /【光标】/);
  assert.doesNotMatch(second, /【标记】/, '没标记就不该补行');
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
  // 没有笔记就什么都不塞；光标已经不再播报
  assert.doesNotMatch(lastPromptText(ctx), /【光标】/);
  assert.doesNotMatch(lastPromptText(ctx), /【标记】/);
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
  // 没有标记的这三轮：除了第一轮的整篇块，一句位置信息都不该有
  const withCursor = calls.filter((c) => /光标|小节/.test(c[1].content[0].text));
  assert.equal(withCursor.length, 0, '光标位置不再出现在提示词里');
});

test('现查成功时以现查那篇为准，压过推送缓存', async (t) => {
  const ctx = await boot({
    probe: {
      editorState: async () => ({
        ok: true,
        data: {
          path: '项目/现查篇.md',
          mode: 'source',
          cursor: { line: 42, ch: 7 },
          selection: null,
          lineCount: 500,
        },
      }),
    },
  });
  t.after(() => ctx.server.close());

  // 推送缓存里是架构说明；现查说现在开着的是「现查篇」—— 应当信现查
  await pushNote(ctx, note());
  await sendTask(ctx, { sessionId: 's1', message: '看这里' });

  const text = lastPromptText(ctx);
  assert.match(text, /现查篇/);
  assert.doesNotMatch(text, /架构说明/, '缓存里那篇不该顶上来');
});

test('现查明确说没有打开的笔记，就不带坐标', async (t) => {
  const ctx = await boot({ probe: { editorState: async () => ({ ok: true, data: null }) } });
  t.after(() => ctx.server.close());

  await pushNote(ctx, note()); // 缓存里还挂着上一篇
  await sendTask(ctx, { sessionId: 's1', message: '你好' });

  const text = lastPromptText(ctx);
  assert.doesNotMatch(text, /【Obsidian 当前窗口】/);
  assert.doesNotMatch(text, /【光标】/);
  assert.match(text, /【Obsidian】你好/);
});

test('标记变了才补一行，清掉时明说一句', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());

  await pushNote(ctx, note({ regions: [{ from: { line: 33, ch: 120 }, to: { line: 33, ch: 151 } }] }));
  await sendTask(ctx, { sessionId: 's1', message: '这一句帮我改' });
  const first = lastPromptText(ctx);
  assert.match(first, /区域 1 处：第 34 行/, '第一轮整篇块里就该带标记');
  assert.doesNotMatch(first, /光标/);

  // 标记没动：不该重复报
  await sendTask(ctx, { sessionId: 's1', message: '再来' });
  assert.doesNotMatch(lastPromptText(ctx), /【标记】/);

  // 挪到另一行：补一行
  await pushNote(ctx, note({ point: { line: 40, ch: 0 } }));
  await sendTask(ctx, { sessionId: 's1', message: '改成这里' });
  assert.match(lastPromptText(ctx), /【标记】.*标记第 41 行/);

  // 清掉标记：说一声，免得以为还指着
  await pushNote(ctx, note({ point: null, regions: [] }));
  await sendTask(ctx, { sessionId: 's1', message: '好了' });
  assert.match(lastPromptText(ctx), /标记已清除/);
});

test('others 会被规整保留', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());

  await pushNote(ctx, note({ others: ['a.md', 'b.md'] }));
  assert.deepEqual(ctx.server.activeNote().others, ['a.md', 'b.md']);
});

test('没给 others 时是空数组', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());

  await pushNote(ctx, note());
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