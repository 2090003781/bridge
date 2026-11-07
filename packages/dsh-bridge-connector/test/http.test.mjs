// Bridge 连接器 · HTTP 协议层（纯逻辑，不依赖 DSH 运行时）
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startConnector } from '../src/core/server.mjs';

function fakeSessions(items) {
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

async function boot(sessions, options = {}) {
  const token = options.token || 'test-token';
  const server = await startConnector({ sessions, token, host: '127.0.0.1', port: 0, clientTimeZone: 'Asia/Shanghai', injectionState: { on: options.injectionEnabled !== false } });
  return { server, base: server.url, token, sessions };
}

test('GET /health 不需要 token', async (t) => {
  const ctx = await boot(fakeSessions([]));
  t.after(() => ctx.server.close());
  const res = await fetch(`${ctx.base}/health`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test('POST /task 没带 token 返回 401', async (t) => {
  const ctx = await boot(fakeSessions([]));
  t.after(() => ctx.server.close());
  const res = await fetch(`${ctx.base}/task`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'hi' }),
  });
  assert.equal(res.status, 401);
});

test('POST /task 默认投给最近活跃的会话', async (t) => {
  const sessions = fakeSessions([
    { sessionId: 'old', cwd: 'D:/a', running: false, updatedAt: 1000 },
    { sessionId: 'recent', cwd: 'D:/b', running: false, updatedAt: 5000 },
  ]);
  const ctx = await boot(sessions);
  t.after(() => ctx.server.close());

  const res = await fetch(`${ctx.base}/task`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': ctx.token },
    body: JSON.stringify({ message: '把这段改一下' }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.sessionId, 'recent');
  const promptCall = sessions.calls.find((c) => c[0] === 'prompt')[1];
  assert.equal(promptCall.sessionId, 'recent');
  // 投递时统一加来源标记，所以这里期望带前缀
  assert.deepEqual(promptCall.content, [{ type: 'text', text: '【Obsidian】把这段改一下' }]);
  assert.equal(promptCall.mode, 'queue');
});

test('POST /task 指定 sessionId 时投给指定的那个', async (t) => {
  const sessions = fakeSessions([
    { sessionId: 'a', updatedAt: 1000 },
    { sessionId: 'b', updatedAt: 5000 },
  ]);
  const ctx = await boot(sessions);
  t.after(() => ctx.server.close());

  const res = await fetch(`${ctx.base}/task`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': ctx.token },
    body: JSON.stringify({ message: 'x', sessionId: 'a' }),
  });
  assert.equal((await res.json()).data.sessionId, 'a');
});

test('POST /task newSession=true 时先建会话再投递', async (t) => {
  const sessions = fakeSessions([]);
  const ctx = await boot(sessions);
  t.after(() => ctx.server.close());

  const res = await fetch(`${ctx.base}/task`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': ctx.token },
    body: JSON.stringify({ message: 'y', newSession: true, cwd: 'D:/工作' }),
  });
  const body = await res.json();

  assert.equal(body.data.sessionId, 'session-new');
  assert.deepEqual(sessions.calls.find((c) => c[0] === 'create')[1], { cwd: 'D:/工作' });
  assert.equal(sessions.calls.find((c) => c[0] === 'prompt')[1].sessionId, 'session-new');
});

test('POST /task 缺 message 返回 400', async (t) => {
  const ctx = await boot(fakeSessions([]));
  t.after(() => ctx.server.close());
  const res = await fetch(`${ctx.base}/task`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': ctx.token },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test('GET /sessions 返回精简会话清单', async (t) => {
  const sessions = fakeSessions([
    { sessionId: 'a', cwd: 'D:/a', running: true, updatedAt: 2000 },
    { sessionId: 'b', cwd: 'D:/b', running: false, updatedAt: 1000 },
  ]);
  const ctx = await boot(sessions);
  t.after(() => ctx.server.close());

  const res = await fetch(`${ctx.base}/sessions`, { headers: { 'x-bridge-token': ctx.token } });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.sessions[0].sessionId, 'a');
  assert.equal(body.data.sessions[0].running, true);
});
test('GET /events 推送该会话的事件（SSE）', async (t) => {
  const ctx = await boot(fakeSessions([]));
  t.after(() => ctx.server.close());

  const ac = new AbortController();
  const res = await fetch(`${ctx.base}/events?sessionId=s1`, {
    headers: { 'x-bridge-token': ctx.token },
    signal: ac.signal,
  });
  assert.equal(res.status, 200);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const read = async () => {
    const { value } = await reader.read();
    buf += decoder.decode(value, { stream: true });
    return buf;
  };

  await read();
  ctx.server.broadcast('s1', {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '你好' }] } },
  });
  await read();

  assert.match(buf, /assistant\/message/);
  assert.match(buf, /你好/);
  ac.abort();
});

test('POST /session 新建会话并返回 sessionId', async (t) => {
  const sessions = fakeSessions([]);
  const ctx = await boot(sessions);
  t.after(() => ctx.server.close());

  const res = await fetch(`${ctx.base}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': ctx.token },
    body: JSON.stringify({ cwd: 'D:/个人数据/辞玖' }),
  });
  const body = await res.json();
  assert.equal(body.data.sessionId, 'session-new');
  assert.deepEqual(sessions.calls.find((c) => c[0] === 'create')[1], { cwd: 'D:/个人数据/辞玖' });
});
test('OPTIONS 预检返回 CORS 头（Obsidian 是 app:// 源）', async (t) => {
  const ctx = await boot(fakeSessions([]));
  t.after(() => ctx.server.close());

  const res = await fetch(`${ctx.base}/sessions`, {
    method: 'OPTIONS',
    headers: {
      origin: 'app://obsidian.md',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'x-bridge-token,content-type',
    },
  });

  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.match(res.headers.get('access-control-allow-headers'), /x-bridge-token/);
});

test('普通响应也带 CORS 头', async (t) => {
  const ctx = await boot(fakeSessions([]));
  t.after(() => ctx.server.close());

  const res = await fetch(`${ctx.base}/health`, { headers: { origin: 'app://obsidian.md' } });
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});
test('POST /inject 入队并返回回执', async (t) => {
  const ctx = await boot(fakeSessions([]));
  t.after(() => ctx.server.close());

  const res = await fetch(`${ctx.base}/inject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': ctx.token },
    body: JSON.stringify({ sessionId: 's1', content: '当前笔记：A', title: '项目/A.md' }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.queued, true);
  assert.equal(body.data.sessionId, 's1');
  assert.equal(ctx.server.injections.currentItems().length, 1);
});

test('POST /inject 不指定会话时投给最近活跃会话', async (t) => {
  const sessions = fakeSessions([
    { sessionId: 'old', updatedAt: 1000 },
    { sessionId: 'recent', updatedAt: 9000 },
  ]);
  const ctx = await boot(sessions);
  t.after(() => ctx.server.close());

  const res = await fetch(`${ctx.base}/inject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': ctx.token },
    body: JSON.stringify({ content: 'x' }),
  });
  assert.equal((await res.json()).data.sessionId, 'recent');
});

test('POST /inject 缺 content 返回 400', async (t) => {
  const ctx = await boot(fakeSessions([]));
  t.after(() => ctx.server.close());
  const res = await fetch(`${ctx.base}/inject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': ctx.token },
    body: JSON.stringify({ sessionId: 's1' }),
  });
  assert.equal(res.status, 400);
});
test('注入关闭时 /inject 返回 injection-disabled', async (t) => {
  const ctx = await boot(fakeSessions([]), { injectionEnabled: false });
  t.after(() => ctx.server.close());

  const res = await fetch(`${ctx.base}/inject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': ctx.token },
    body: JSON.stringify({ sessionId: 's1', content: 'x' }),
  });
  const body = await res.json();
  assert.equal(res.status, 409);
  assert.equal(body.error.code, 'injection-disabled');
});

test('health 报告注入开关状态', async (t) => {
  const off = await boot(fakeSessions([]), { injectionEnabled: false });
  t.after(() => off.server.close());
  const offBody = await (await fetch(`${off.base}/health`)).json();
  assert.equal(offBody.data.injection, false);

  const on = await boot(fakeSessions([]), { injectionEnabled: true });
  t.after(() => on.server.close());
  const onBody = await (await fetch(`${on.base}/health`)).json();
  assert.equal(onBody.data.injection, true);
});
test('/config 可运行时切换注入，/inject 立即跟随', async (t) => {
  const ctx = await boot(fakeSessions([]), { injectionEnabled: false });
  t.after(() => ctx.server.close());

  const denied = await fetch(`${ctx.base}/inject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': ctx.token },
    body: JSON.stringify({ sessionId: 's1', content: 'x' }),
  });
  assert.equal(denied.status, 409);

  const set = await fetch(`${ctx.base}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': ctx.token },
    body: JSON.stringify({ injection: true }),
  });
  assert.equal(set.status, 200);
  assert.equal((await set.json()).data.injection, true);

  const allowed = await fetch(`${ctx.base}/inject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': ctx.token },
    body: JSON.stringify({ sessionId: 's1', content: 'x' }),
  });
  assert.equal(allowed.status, 200);

  const cfg = await fetch(`${ctx.base}/config`, { headers: { 'x-bridge-token': ctx.token } });
  assert.equal((await cfg.json()).data.injection, true);
});
test('GET /inject 返回当前注入状态', async (t) => {
  const ctx = await boot(fakeSessions([]), { injectionEnabled: true });
  t.after(() => ctx.server.close());

  const empty = await (await fetch(`${ctx.base}/inject`, { headers: { 'x-bridge-token': ctx.token } })).json();
  assert.equal(empty.data.injection, true);
  assert.deepEqual(empty.data.current, []);

  await fetch(`${ctx.base}/inject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': ctx.token },
    body: JSON.stringify({ sessionId: 's1', content: '正文内容', title: 'A.md' }),
  });

  const after = await (await fetch(`${ctx.base}/inject`, { headers: { 'x-bridge-token': ctx.token } })).json();
  assert.equal(after.data.current[0].title, 'A.md');
  assert.equal(after.data.current[0].length, 4);
});

test('POST /inject/clear 清掉当前注入', async (t) => {
  const ctx = await boot(fakeSessions([]), { injectionEnabled: true });
  t.after(() => ctx.server.close());

  await fetch(`${ctx.base}/inject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': ctx.token },
    body: JSON.stringify({ sessionId: 's1', content: 'x' }),
  });
  await fetch(`${ctx.base}/inject/clear`, {
    method: 'POST',
    headers: { 'x-bridge-token': ctx.token },
  });
  const status = await (await fetch(`${ctx.base}/inject`, { headers: { 'x-bridge-token': ctx.token } })).json();
  assert.deepEqual(status.data.current, []);
});


// ── 病态请求行 ───────────────────────────────────────────────────────────
// 不需要 token，任何本机进程都能发；服务端不许因此挂掉。
function rawHttp(port, requestText) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(requestText));
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buf += chunk;
    });
    socket.on('error', () => resolve(buf));
    socket.on('close', () => resolve(buf));
    socket.setTimeout(3000, () => {
      socket.destroy();
      resolve(buf);
    });
  });
}

test('病态请求行不会打挂服务，后续请求仍然可用', async (t) => {
  const ctx = await boot(fakeSessions([]));
  t.after(() => ctx.server.close());

  const raw = await rawHttp(
    ctx.server.port,
    'GET // HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'
  );
  const statusLine = raw.split('\r\n')[0] || '(没有响应)';
  assert.match(statusLine, /^HTTP\/1\.[01] 400/, `应回 400，实际：${statusLine}`);

  const res = await fetch(`${ctx.base}/health`);
  assert.equal(res.status, 200, '服务被打挂了');
});


test('超大请求体返回 413，不是把连接掐断', async (t) => {
  const ctx = await boot(fakeSessions([]));
  t.after(() => ctx.server.close());

  const big = 'x'.repeat(2 * 1024 * 1024);
  const res = await fetch(`${ctx.base}/inject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': ctx.token },
    body: JSON.stringify({ content: big }),
  });

  assert.equal(res.status, 413, '应当回 413，而不是 ECONNRESET');
});


test('/inject/clear 收到坏 JSON 时不静默清空', async (t) => {
  const ctx = await boot(fakeSessions([{ sessionId: 's1', updatedAt: 1 }]));
  t.after(() => ctx.server.close());
  const h = { 'content-type': 'application/json', 'x-bridge-token': ctx.token };

  const put = await fetch(`${ctx.base}/inject`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ content: '要留住的注入', title: 'A.md' }),
  });
  assert.equal(put.status, 200);
  assert.equal((await (await fetch(`${ctx.base}/inject`, { headers: h })).json()).data.count, 1);

  const bad = await fetch(`${ctx.base}/inject/clear`, { method: 'POST', headers: h, body: '{bad json' });
  assert.equal(bad.status, 400, '坏请求应当 400');

  const after = (await (await fetch(`${ctx.base}/inject`, { headers: h })).json()).data.count;
  assert.equal(after, 1, '坏请求不该把已有注入清掉');
});

test('/inject 单篇超过 512KB 被拒', async (t) => {
  const ctx = await boot(fakeSessions([{ sessionId: 's1', updatedAt: 1 }]));
  t.after(() => ctx.server.close());
  const h = { 'content-type': 'application/json', 'x-bridge-token': ctx.token };

  const res = await fetch(`${ctx.base}/inject`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ content: 'a'.repeat(600 * 1024), title: 'huge.md' }),
  });

  assert.equal(res.status, 413, '单篇超过预算要拒，否则每轮提示词会被撑爆');
  assert.equal((await (await fetch(`${ctx.base}/inject`, { headers: h })).json()).data.count, 0);
});

test('/inject 候选会话没有 sessionId 时回 409，不 500', async (t) => {
  const ctx = await boot(fakeSessions([{ updatedAt: 1 }]));
  t.after(() => ctx.server.close());
  const h = { 'content-type': 'application/json', 'x-bridge-token': ctx.token };

  const res = await fetch(`${ctx.base}/inject`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ content: 'x', title: 'A.md' }),
  });

  assert.equal(res.status, 409);
});


// ── /sessions 要给 Obsidian 侧够用的信息（工作区 + 人类可读的会话名）────────
test('/sessions 带工作区与标题字段，供树形选择用', async (t) => {
  const sessions = fakeSessions([
    {
      sessionId: 'session-aaa',
      cwd: 'D:\\RAG',
      updatedAt: 5000,
      running: false,
      blank: false,
      projections: { asOfSeq: 3, values: { title: '整理知识库索引' } },
    },
    {
      sessionId: 'session-bbb',
      cwd: 'D:\\个人数据\\辞玖',
      updatedAt: 4000,
      running: true,
      blank: false,
      projections: { asOfSeq: 1, values: {} },
    },
  ]);
  const ctx = await boot(sessions);
  t.after(() => ctx.server.close());

  const body = await (await fetch(`${ctx.base}/sessions`, {
    headers: { 'x-bridge-token': ctx.token },
  })).json();

  const items = body.data.sessions;
  assert.equal(items.length, 2);

  const a = items.find((x) => x.sessionId === 'session-aaa');
  assert.equal(a.cwd, 'D:\\RAG', '要带工作区');
  assert.equal(a.title, '整理知识库索引', '投影里有标题就读出来');

  const b = items.find((x) => x.sessionId === 'session-bbb');
  assert.equal(b.title, null, '没有标题就给 null，让前端自己降级');
  assert.equal(b.running, true);
});


// ── 来源标记：从面板发来的消息要能认出来 ────────────────────────────────
test('/task 投递时给消息加 Obsidian 来源标记', async (t) => {
  const sessions = fakeSessions([{ sessionId: 's1', updatedAt: 1 }]);
  const ctx = await boot(sessions);
  t.after(() => ctx.server.close());

  const res = await fetch(`${ctx.base}/task`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': ctx.token },
    body: JSON.stringify({ message: '帮我看下这条', sessionId: 's1' }),
  });
  assert.equal(res.status, 200);

  const call = sessions.calls.find((c) => c[0] === 'prompt');
  assert.ok(call, '应当调用过 prompt');
  assert.equal(call[1].content[0].text, '【Obsidian】帮我看下这条');
});

test('已经带标记的消息不重复加', async (t) => {
  const sessions = fakeSessions([{ sessionId: 's1', updatedAt: 1 }]);
  const ctx = await boot(sessions);
  t.after(() => ctx.server.close());

  await fetch(`${ctx.base}/task`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': ctx.token },
    body: JSON.stringify({ message: '【Obsidian】已经带过了', sessionId: 's1' }),
  });
  const call = sessions.calls.find((c) => c[0] === 'prompt');
  assert.equal(call[1].content[0].text, '【Obsidian】已经带过了');
});
