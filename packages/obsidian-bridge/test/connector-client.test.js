// Bridge · 连接器客户端（Obsidian 侧）
const test = require('node:test');
const assert = require('node:assert/strict');
const { createConnectorClient } = require('../src/lib/connector-client.js');

function fakeTransport(handler) {
  const calls = [];
  return {
    calls,
    requestImpl: async (opts) => {
      calls.push(opts);
      return handler(opts, calls.length);
    },
  };
}

test('请求带 token 与 client 标识', async () => {
  const t = fakeTransport(() => ({ status: 200, text: '{"ok":true,"data":{"sessions":[]}}' }));
  const client = createConnectorClient({
    loadInfo: () => ({ host: '127.0.0.1', port: 8812, token: 'tk' }),
    requestImpl: t.requestImpl,
  });

  await client.sessions();

  assert.equal(t.calls[0].url, 'http://127.0.0.1:8812/sessions');
  assert.equal(t.calls[0].headers['x-bridge-token'], 'tk');
  assert.equal(t.calls[0].headers['x-bridge-client'], 'obsidian');
});

test('sendTask 把 message 与 sessionId 送出去', async () => {
  const t = fakeTransport(() => ({ status: 200, text: '{"ok":true,"data":{"delivered":true}}' }));
  const client = createConnectorClient({
    loadInfo: () => ({ host: '127.0.0.1', port: 8812, token: 'tk' }),
    requestImpl: t.requestImpl,
  });

  const res = await client.sendTask({ message: '你好', sessionId: 's1' });

  assert.equal(res.ok, true);
  assert.equal(t.calls[0].url, 'http://127.0.0.1:8812/task');
  const body = JSON.parse(t.calls[0].body);
  assert.equal(body.message, '你好');
  assert.equal(body.sessionId, 's1');
});

test('没有连接器信息时返回 offline，不发请求', async () => {
  const t = fakeTransport(() => {
    throw new Error('不该被调用');
  });
  const client = createConnectorClient({ loadInfo: () => null, requestImpl: t.requestImpl });

  const res = await client.health();
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'offline');
  assert.equal(t.calls.length, 0);
});

test('SSE 解析：多个 data 块按顺序回调', async () => {
  const chunks = [
    ': connected s1\n\n',
    'data: {"event":{"type":"turn/start"}}\n\n',
    'data: {"event":{"type":"assistant/message","data":{"message":{"content":[{"type":"text","text":"好"}]}}}}\n\n',
  ];
  const t = fakeTransport((opts) => {
    for (const c of chunks) opts.onChunk(c);
    return { status: 200 };
  });
  const client = createConnectorClient({
    loadInfo: () => ({ host: '127.0.0.1', port: 8812, token: 'tk' }),
    requestImpl: t.requestImpl,
  });

  const seen = [];
  const ac = new AbortController();
  await client.subscribe('s1', (event) => seen.push(event.type), ac.signal);

  assert.deepEqual(seen, ['turn/start', 'assistant/message']);
});

test('SSE 分块边界被正确拼接', async () => {
  const chunks = ['data: {"event":{"ty', 'pe":"turn/end"}}\n\n'];
  const t = fakeTransport((opts) => {
    for (const c of chunks) opts.onChunk(c);
    return { status: 200 };
  });
  const client = createConnectorClient({
    loadInfo: () => ({ host: '127.0.0.1', port: 8812, token: 'tk' }),
    requestImpl: t.requestImpl,
  });

  const seen = [];
  await client.subscribe('s1', (event) => seen.push(event.type), new AbortController().signal);
  assert.deepEqual(seen, ['turn/end']);
});

test('SSE 的 URL 带 sessionId', async () => {
  const t = fakeTransport(() => ({ status: 200 }));
  const client = createConnectorClient({
    loadInfo: () => ({ host: '127.0.0.1', port: 8812, token: 'tk' }),
    requestImpl: t.requestImpl,
  });

  await client.subscribe('session-abc/1', () => {}, new AbortController().signal);
  assert.equal(t.calls[0].url, 'http://127.0.0.1:8812/events?sessionId=session-abc%2F1');
});
test('inject 把内容与标题送到 /inject', async () => {
  const t = fakeTransport(() => ({ status: 200, text: '{"ok":true,"data":{"queued":true,"pending":1}}' }));
  const client = createConnectorClient({
    loadInfo: () => ({ host: '127.0.0.1', port: 8812, token: 'tk' }),
    requestImpl: t.requestImpl,
  });

  const res = await client.inject({ sessionId: 's1', content: '正文', title: 'A.md' });
  assert.equal(res.ok, true);
  assert.equal(t.calls[0].url, 'http://127.0.0.1:8812/inject');
  assert.deepEqual(JSON.parse(t.calls[0].body), { sessionId: 's1', content: '正文', title: 'A.md' });
});
test('config / setInjection 走 /config', async () => {
  const t = fakeTransport((opts) => ({ status: 200, text: '{"ok":true,"data":{"injection":true}}' }));
  const client = createConnectorClient({
    loadInfo: () => ({ host: '127.0.0.1', port: 8812, token: 'tk' }),
    requestImpl: t.requestImpl,
  });

  await client.setInjection(true);
  assert.equal(t.calls[0].url, 'http://127.0.0.1:8812/config');
  assert.equal(t.calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(t.calls[0].body), { injection: true });

  await client.config();
  assert.equal(t.calls[1].method, 'GET');
});
test('injectStatus / clearInjection 走 /inject', async () => {
  const t = fakeTransport((opts) => ({ status: 200, text: '{"ok":true,"data":{"current":null}}' }));
  const client = createConnectorClient({
    loadInfo: () => ({ host: '127.0.0.1', port: 8812, token: 'tk' }),
    requestImpl: t.requestImpl,
  });

  await client.injectStatus();
  assert.equal(t.calls[0].url, 'http://127.0.0.1:8812/inject');
  assert.equal(t.calls[0].method, 'GET');

  await client.clearInjection();
  assert.equal(t.calls[1].url, 'http://127.0.0.1:8812/inject/clear');
  assert.equal(t.calls[1].method, 'POST');
});
