// Bridge · HTTP 入口（token + 权限 + 账本）
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { createDriver } = require('../src/lib/driver.js');
const { createPermissions } = require('../src/lib/permissions.js');
const { createLedger } = require('../src/lib/ledger.js');
const { startCoreServer } = require('../src/lib/server.js');

async function boot(options = {}) {
  const { level = 'read', token = 'test-token', tokenState = null } = options;
  const records = [];
  const executed = [];
  const permissions = createPermissions();
  if (level) permissions.setLevel('agent.dsh', level);

  const driver = createDriver({
    obsidian: {
      vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [] },
      metadataCache: {},
      commands: {
        listCommands: () => [{ id: 'editor:toggle-bold', name: '加粗', hotkeys: [] }],
        findCommand: (id) => (id === 'editor:toggle-bold' ? { id, name: '加粗' } : null),
        executeCommandById: (id) => {
          executed.push(id);
          return true;
        },
      },
    },
  });

  const ledger = createLedger({ sink: (entry) => records.push(entry) });
  const server = await startCoreServer({
    driver,
    permissions,
    ledger,
    token,
    tokenState,
    port: 0,
    host: '127.0.0.1',
  });

  return { server, base: server.url, records, executed, permissions, token };
}

function headers(token, client = 'agent.dsh') {
  return { 'content-type': 'application/json', 'x-bridge-token': token, 'x-bridge-client': client };
}

test('GET /health 不需要 token，返回服务身份', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());

  const res = await fetch(`${ctx.base}/health`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.service, 'obsidian-bridge');
});

test('POST /op 没带 token 返回 401', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());

  const res = await fetch(`${ctx.base}/op`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'obsidian.command.list', args: {} }),
  });

  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, 'unauthorized');
});

test('POST /op 带错 token 返回 401', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());

  const res = await fetch(`${ctx.base}/op`, {
    method: 'POST',
    headers: headers('wrong-token'),
    body: JSON.stringify({ op: 'obsidian.command.list', args: {} }),
  });

  assert.equal(res.status, 401);
});

test('只读档能列命令，账本记一笔', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());

  const res = await fetch(`${ctx.base}/op`, {
    method: 'POST',
    headers: headers(ctx.token),
    body: JSON.stringify({ op: 'obsidian.command.list', args: {} }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.commands[0].id, 'editor:toggle-bold');
  assert.equal(ctx.records.length, 1);
  assert.equal(ctx.records[0].op, 'obsidian.command.list');
  assert.equal(ctx.records[0].client, 'agent.dsh');
  assert.equal(ctx.records[0].ok, true);
  assert.equal(typeof ctx.records[0].ms, 'number');
});

test('只读档执行命令被拒（403），且不碰 Obsidian', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());

  const res = await fetch(`${ctx.base}/op`, {
    method: 'POST',
    headers: headers(ctx.token),
    body: JSON.stringify({ op: 'obsidian.command.execute', args: { id: 'editor:toggle-bold' } }),
  });
  const body = await res.json();

  assert.equal(res.status, 403);
  assert.equal(body.error.code, 'forbidden');
  assert.deepEqual(ctx.executed, []);
});

test('可写档能执行命令，账本记成功', async (t) => {
  const ctx = await boot({ level: 'write' });
  t.after(() => ctx.server.close());

  const res = await fetch(`${ctx.base}/op`, {
    method: 'POST',
    headers: headers(ctx.token),
    body: JSON.stringify({ op: 'obsidian.command.execute', args: { id: 'editor:toggle-bold' } }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.data.executed, true);
  assert.deepEqual(ctx.executed, ['editor:toggle-bold']);
  assert.equal(ctx.records.at(-1).tier, 'write');
});

test('未知操作返回 404', async (t) => {
  const ctx = await boot({ level: 'trust' });
  t.after(() => ctx.server.close());

  const res = await fetch(`${ctx.base}/op`, {
    method: 'POST',
    headers: headers(ctx.token),
    body: JSON.stringify({ op: 'nope.nothing', args: {} }),
  });

  assert.equal(res.status, 404);
});

test('GET /ops 返回操作目录和当前档位', async (t) => {
  const ctx = await boot({ level: 'write' });
  t.after(() => ctx.server.close());

  const res = await fetch(`${ctx.base}/ops`, { headers: headers(ctx.token) });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.ok(body.data.ops.some((o) => o.id === 'obsidian.command.execute'));
  assert.equal(body.data.client, 'agent.dsh');
  assert.equal(body.data.level, 'write');
});

// ── 病态请求行 ───────────────────────────────────────────────────────────
// 任何本机进程都能发，不需要 token；服务端不许因此挂掉。
// 必须用裸 socket，fetch 会把路径规范化掉，发不出 `GET //`。
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
  const ctx = await boot();
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


// ── 客户端身份只认请求头 ─────────────────────────────────────────────────
// 以前 body 里的 client 会盖掉 header，等于调用方自己给自己发档位。
test('body 里的 client 不能提权，身份只认请求头', async (t) => {
  const ctx = await boot({ level: 'trust' });
  t.after(() => ctx.server.close());

  const res = await fetch(`${ctx.base}/op`, {
    method: 'POST',
    headers: headers(ctx.token, 'nobody-xyz'),
    body: JSON.stringify({
      op: 'obsidian.command.execute',
      args: { id: 'editor:toggle-bold' },
      client: 'agent.dsh',
    }),
  });

  assert.equal(res.status, 403, 'body 里的 client 不该能提权');
  assert.deepEqual(ctx.executed, [], '命令不该被执行');
  assert.equal(ctx.records.at(-1).client, 'nobody-xyz', '账本要记真实请求方');
});


// ── 账本脱敏 ─────────────────────────────────────────────────────────────
test('账本不落正文，只记长度', async (t) => {
  const ctx = await boot({ level: 'write' });
  t.after(() => ctx.server.close());

  const secret = '这是一段不该进账本的私密正文';
  await fetch(`${ctx.base}/op`, {
    method: 'POST',
    headers: headers(ctx.token),
    body: JSON.stringify({ op: 'obsidian.note.append', args: { path: '项目/某篇.md', text: secret } }),
  });

  const last = ctx.records.at(-1);
  assert.ok(last, '应当记了一笔');
  assert.ok(
    !JSON.stringify(last.args || '').includes('私密正文'),
    `账本不许含正文，实际：${JSON.stringify(last.args)}`
  );
});


// ── 状态码 ───────────────────────────────────────────────────────────────
test('业务错误映射到可分辨的状态码，不再一律 500', async (t) => {
  const ctx = await boot({ level: 'trust' });
  t.after(() => ctx.server.close());

  const badArgs = await fetch(`${ctx.base}/op`, {
    method: 'POST',
    headers: headers(ctx.token),
    body: JSON.stringify({ op: 'obsidian.note.append', args: { path: '项目/a.md' } }),
  });
  assert.equal(badArgs.status, 400, '缺 text 应当是 400');

  const notFound = await fetch(`${ctx.base}/op`, {
    method: 'POST',
    headers: headers(ctx.token),
    body: JSON.stringify({ op: 'obsidian.note.read', args: { path: '项目/没有这篇.md' } }),
  });
  assert.equal(notFound.status, 404, '文件不存在应当是 404');
});

test('token 过期回 401 token-expired，客户端据此续期', async (t) => {
  const ctx = await boot({
    level: 'read',
    tokenState: () => ({ token: 'test-token', issuedAt: 1000, ttlMs: 1000 }),
  });
  t.after(() => ctx.server.close());

  const res = await fetch(`${ctx.base}/ops`, { headers: headers(ctx.token) });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, 'token-expired', '要能区分「过期」和「token 不对」');
});

test('token 没过期就正常放行', async (t) => {
  const ctx = await boot({
    level: 'read',
    tokenState: () => ({ token: 'test-token', issuedAt: Date.now(), ttlMs: 60 * 60 * 1000 }),
  });
  t.after(() => ctx.server.close());

  const res = await fetch(`${ctx.base}/ops`, { headers: headers(ctx.token) });
  assert.equal(res.status, 200);
});
