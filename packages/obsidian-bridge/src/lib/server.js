'use strict';
// Bridge · HTTP 入口
// 只监听回环；除 /health 外一律要 token；权限闸门在调用前；账本记录每次调用。

const http = require('node:http');
const crypto = require('node:crypto');
const { isExpired, statusForError } = require('./token-lifecycle.js');

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// 账本是长期留痕，正文属于用户私密内容：这些键只记长度，不记内容。
const REDACT_ARG_KEYS = new Set(['content', 'text', 'body', 'markdown', 'note', 'value', 'source']);

function summarize(args) {
  if (args === undefined) return null;
  if (args === null || typeof args !== 'object') return String(args).slice(0, 200);
  try {
    const safe = {};
    for (const [key, value] of Object.entries(args)) {
      if (REDACT_ARG_KEYS.has(key) && typeof value === 'string') safe[key] = `<${value.length} 字>`;
      else safe[key] = value;
    }
    const s = JSON.stringify(safe);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return '[unserializable]';
  }
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let failed = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        if (!failed) {
          failed = true;
          reject(Object.assign(new Error('请求体过大'), { code: 'bad-request' }));
          req.resume(); // 丢弃剩余数据，让响应能发出去
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendJson(res, status, payload) {
  json(res, status, payload);
}

function startCoreServer(opts = {}) {
  const {
    driver,
    permissions,
    ledger = null,
    token,
    tokenState = null,
    host = '127.0.0.1',
    port = 8811,
    version = '0.1.0',
    startedAt = Date.now(),
  } = opts;

  if (!driver) throw new Error('startCoreServer 需要 driver');
  if (!permissions) throw new Error('startCoreServer 需要 permissions');
  if (!token) throw new Error('startCoreServer 需要 token');

  // 当前有效的 token 与它的寿命。传 tokenState 就能支持轮换/过期，
  // 不传就是老行为：一个字符串、永不过期。
  const resolveToken = () => {
    if (typeof tokenState === 'function') {
      const value = tokenState() || {};
      return {
        token: value.token || token,
        issuedAt: Number(value.issuedAt) || 0,
        ttlMs: Number(value.ttlMs) || 0,
      };
    }
    return { token, issuedAt: 0, ttlMs: 0 };
  };

  // 请求入口全部包在兜底里：任何同步抛错或未 await 的 rejection 都不许冒到进程层
  // （http 层的 async handler 抛错 = unhandledRejection = Node 直接退出）。
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) {
        try {
          res.destroy();
        } catch {
          /* 已经断开 */
        }
        return;
      }
      sendJson(res, 500, {
        ok: false,
        error: { code: 'internal', message: String((err && err.message) || err) },
      });
    });
  });

  async function handle(req, res) {
    // 病态请求行（如 `GET //`）会让 new URL 抛 ERR_INVALID_URL；
    // 这一行在 token 校验之前，任何本机进程都能触发，所以必须自己接住。
    let url;
    try {
      url = new URL(req.url || '/', `http://${host}`);
    } catch {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '不合法的请求路径' } });
      return;
    }
    const path = url.pathname;

    if (req.method === 'GET' && path === '/health') {
      sendJson(res, 200, {
        ok: true,
        data: {
          service: 'obsidian-bridge',
          version,
          obsidian: true,
          uptimeMs: Date.now() - startedAt,
        },
      });
      return;
    }

    if (path !== '/op' && path !== '/ops') {
      sendJson(res, 404, { ok: false, error: { code: 'not-found', message: `没有这条路由：${path}` } });
      return;
    }

    const bearer = String(req.headers.authorization || '');
    const provided =
      String(req.headers['x-bridge-token'] || '') ||
      (bearer.toLowerCase().startsWith('bearer ') ? bearer.slice(7) : '');
    const auth = resolveToken();
    if (!safeEqual(provided, auth.token)) {
      sendJson(res, 401, { ok: false, error: { code: 'unauthorized', message: '缺少或错误的 token' } });
      return;
    }
    if (isExpired({ issuedAt: auth.issuedAt, ttlMs: auth.ttlMs, now: Date.now() })) {
      // 单独一个码：调用方据此重读 info.json 拿新 token，而不是以为配置错了。
      sendJson(res, 401, {
        ok: false,
        error: { code: 'token-expired', message: 'token 已过期：等 Bridge 轮换后重读 info.json' },
      });
      return;
    }

    const headerClient = String(req.headers['x-bridge-client'] || '').trim();
    const client = headerClient || 'local';

    if (req.method === 'GET' && path === '/ops') {
      sendJson(res, 200, {
        ok: true,
        data: {
          ops: driver.list().ops,
          client,
          level: permissions.levelOf(client),
          levels: permissions.LEVELS,
        },
      });
      return;
    }

    if (req.method !== 'POST' || path !== '/op') {
      sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed' } });
      return;
    }

    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: err.message } });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(raw || '{}');
    } catch {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'body 不是合法 JSON' } });
      return;
    }

    const opId = String((payload && payload.op) || '').trim();
    if (!opId) {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '缺少 op' } });
      return;
    }

    const entry = driver.list().ops.find((o) => o.id === opId);
    if (!entry) {
      sendJson(res, 404, { ok: false, error: { code: 'unknown-op', message: `未知操作：${opId}` } });
      return;
    }

    // 身份只认请求头：body 是调用方自己写的，拿它当身份等于让人自封档位。
    const effectiveClient = client;
    const level = permissions.levelOf(effectiveClient);

    if (!permissions.can(effectiveClient, entry.tier)) {
      if (ledger) {
        ledger.record({
          client: effectiveClient,
          op: opId,
          tier: entry.tier,
          ok: false,
          error: 'forbidden',
          args: summarize(payload.args),
        });
      }
      sendJson(res, 403, {
        ok: false,
        error: {
          code: 'forbidden',
          message: `档位不足：${opId} 需要 ${entry.tier}，当前 ${level}`,
          need: entry.tier,
          have: level,
        },
      });
      return;
    }

    const t0 = Date.now();
    const result = await driver.call(opId, payload.args || {});
    const ms = Date.now() - t0;

    if (ledger) {
      ledger.record({
        client: effectiveClient,
        op: opId,
        tier: entry.tier,
        ok: result.ok,
        ms,
        args: summarize(payload.args),
      });
    }

    sendJson(res, result.ok ? 200 : statusForError(result.error && result.error.code), {
      ...result,
      meta: { op: opId, tier: entry.tier, ms, client: effectiveClient },
    });
  }

  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        server,
        host,
        port: actualPort,
        url: `http://${host}:${actualPort}`,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

module.exports = { startCoreServer };