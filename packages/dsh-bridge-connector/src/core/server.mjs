// Bridge 连接器 · HTTP/SSE 协议层
// 只负责报文：会话清单 / 投递 / 新建会话 / 事件推送。DSH 运行时由 index.js 注入。

import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createInjectionStore } from './injection.mjs';
import { createTitleCache, createSessionFileIndex } from './session-title.mjs';
import { createWorkspaceIndex } from './workspace-index.mjs';

// DSH 的工作区注册表：分组要用它，否则会多出 DSH 界面里没有的「工作区」
const WORKSPACE_STORE = path.join(os.homedir(), '.dsh', 'storages', 'workspace.json');
const workspaceOf = createWorkspaceIndex({ file: WORKSPACE_STORE });

// 会话标题缓存与日志索引（全进程共用，避免每次列表都重扫）
const titleCache = createTitleCache();
const SESSIONS_ROOT = process.env.DSH_SESSIONS_DIR || path.join(os.homedir(), '.dsh', 'sessions');
const sessionFileOf = createSessionFileIndex(SESSIONS_ROOT);

const PROTOCOL = 'obsidian-bridge/1';
// 单篇注入上限：注入进系统提示词、每轮都重发，所以必须有长度预算。
const MAX_INJECT_CONTENT = 512 * 1024;

// Obsidian 的页面源是 app://obsidian.md，跨源请求要先过预检。token 仍保护每个调用。
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-bridge-token, x-bridge-client',
  'access-control-max-age': '600',
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...CORS_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

// 统一读 JSON body：超限回 413、坏 JSON 回 400，不再让连接被掐断。
// 返回 null 表示已经回过错误响应，调用方直接 return。
async function readJsonBody(req, res, limit) {
  let raw;
  try {
    raw = await readBody(req, limit);
  } catch (err) {
    if (err && err.code === 'PAYLOAD_TOO_LARGE') {
      json(res, 413, { ok: false, error: { code: 'payload-too-large', message: '请求体过大' } });
    } else {
      json(res, 400, { ok: false, error: { code: 'bad-request', message: '读取请求体失败' } });
    }
  }
  if (raw === undefined) return null;
  try {
    return JSON.parse(raw || '{}');
  } catch {
    json(res, 400, { ok: false, error: { code: 'bad-request', message: 'body 不是合法 JSON' } });
    return null;
  }
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        // 不能 destroy：连接掐断了就没法回 413，调用方只会看到 ECONNRESET。
        // 后面的数据照收照丢，交给上层把错误回给客户端。
        tooLarge = true;
        chunks.length = 0;
        const err = new Error('请求体过大');
        err.code = 'PAYLOAD_TOO_LARGE';
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

// 客户端列表要显示「人话」：工作区 + 会话标题。
// 标题来自 DSH 的 title 投影（首条人类消息前几个词，或 LLM 生成），
// 投影里没有就返回 null，让前端自己降级成「目录名 · 时间」。
function pickTitle(item, fileOf) {
  // 1) 投影里有没有（DSH 若将来填了就直接用，最快）
  const values = item && item.projections && item.projections.values;
  if (values && typeof values === 'object') {
    for (const key of ['title', 'sessionTitle', 'displayTitle']) {
      if (typeof values[key] === 'string' && values[key].trim()) return values[key].trim();
    }
  }
  // 2) 投影里没有（实测 295 个会话全是空），去 session 日志里读 session/title 事件
  if (typeof fileOf === 'function') {
    const file = fileOf(item && item.sessionId);
    if (file) return titleCache.get(item.sessionId, file);
  }
  return null;
}

function publicSession(item, fileOf) {
  const ws = workspaceOf(item && item.sessionId);
  return {
    sessionId: item.sessionId,
    cwd: item.cwd ?? null,
    running: item.running === true,
    blank: item.blank === true,
    parentSessionId: item.parentSessionId ?? null,
    title: pickTitle(item, fileOf),
    // 分组依据：DSH 注册表里的工作区名；没注册的归「未分组」
    workspaceTitle: ws.workspace ? ws.workspace.title : null,
    workspacePath: ws.workspace ? ws.workspace.path : null,
    archived: ws.archived,
    updatedAt: Number.isFinite(item.updatedAt) ? new Date(item.updatedAt).toISOString() : null,
  };
}


export function startConnector(options) {
  const {
    sessions,
    token,
    host = '127.0.0.1',
    port = 8812,
    clientTimeZone,
    requestIdPrefix = 'bridge',
    injections = null,
    injectionTtlMs = 0,
    injectionFile = null,
    injectionState = { on: false },
  } = options;

  const injectionStore = injections || createInjectionStore({ ttlMs: injectionTtlMs, file: injectionFile });

  if (!sessions) throw new Error('startConnector 需要 sessions（sessionController）');
  if (!token) throw new Error('startConnector 需要 token');

  /** sessionId -> Set<res> */
  const subscribers = new Map();

  function broadcast(sessionId, event) {
    if (!sessionId) return;
    const set = subscribers.get(sessionId);
    if (!set || set.size === 0) return;
    const payload = `data: ${JSON.stringify({ protocol: PROTOCOL, sessionId, event })}\n\n`;
    for (const res of set) {
      try {
        res.write(payload);
      } catch {
        /* 单个订阅者写失败不影响别人 */
      }
    }
  }

  function pickRecent(items) {
    if (!items.length) return null;
    return [...items].sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))[0];
  }

  // 请求入口全部包在兜底里：HTTP 层的 async handler 抛错 = unhandledRejection = 整个 DSH 退出。
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
      json(res, 500, {
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
      json(res, 400, { ok: false, error: { code: 'bad-request', message: '不合法的请求路径' } });
      return;
    }
    const path = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (req.method === 'GET' && path === '/health') {
      json(res, 200, { ok: true, data: { service: 'dsh-bridge-connector', protocol: PROTOCOL, subscribers: subscribers.size, injection: injectionState.on === true } });
      return;
    }

    const provided =
      String(req.headers['x-bridge-token'] || '') ||
      String(url.searchParams.get('token') || '');
    if (!safeEqual(provided, token)) {
      json(res, 401, { ok: false, error: { code: 'unauthorized', message: '缺少或错误的 token' } });
      return;
    }

    if (path === '/config') {
      if (req.method === 'GET') {
        json(res, 200, { ok: true, data: { injection: injectionState.on === true } });
        return;
      }
      if (req.method === 'POST') {
        const payload = await readJsonBody(req, res);
        if (!payload) return;
        if (typeof payload.injection === 'boolean') injectionState.on = payload.injection;
        json(res, 200, { ok: true, data: { injection: injectionState.on === true } });
        return;
      }
      json(res, 405, { ok: false, error: { code: 'method-not-allowed' } });
      return;
    }

    if (req.method === 'GET' && path === '/sessions') {
      try {
        const value = await sessions.list({}, new AbortController().signal);
        const items = Array.isArray(value?.items) ? value.items : [];
        // 标题要解压日志读，几百个会话全读会卡住首屏；
      // 所以只给最近活跃的 60 个读标题，剩下的前端降级成「目录 · 时间 · 短 id」。
      const byRecent = [...items].sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
      const TITLE_LIMIT = 60;
      const sorted = byRecent.map((item, idx) =>
        publicSession(item, idx < TITLE_LIMIT ? sessionFileOf : null)
      );
        json(res, 200, { ok: true, data: { total: sorted.length, sessions: sorted } });
      } catch (err) {
        json(res, 500, { ok: false, error: { code: 'list-failed', message: String(err?.message || err) } });
      }
      return;
    }

    if (req.method === 'POST' && path === '/session') {
      const payload = await readJsonBody(req, res);
      if (!payload) return;
      try {
        const created = await sessions.create({ ...(payload.cwd ? { cwd: payload.cwd } : {}), ...(payload.agentPreset ? { agentPreset: payload.agentPreset } : {}) });
        json(res, 200, { ok: true, data: { sessionId: created.sessionId } });
      } catch (err) {
        json(res, 500, { ok: false, error: { code: 'create-failed', message: String(err?.message || err) } });
      }
      return;
    }

    if (req.method === 'GET' && path === '/inject') {
      const items = injectionStore.currentItems();
      json(res, 200, {
        ok: true,
        data: {
          injection: injectionState.on === true,
          count: items.length,
          current: items.map((cur) => ({
            id: cur.id,
            title: cur.title || null,
            at: new Date(cur.at).toISOString(),
            length: cur.content.length,
          })),
        },
      });
      return;
    }

    if (req.method === 'POST' && path === '/inject/clear') {
      // 坏 JSON 不许当成「清空全部」：以前这里静默吞掉解析错误，一次手抖就清光注入。
      const payload = await readJsonBody(req, res);
      if (!payload) return;
      injectionStore.clearCurrent(payload && payload.id ? String(payload.id) : null);
      json(res, 200, { ok: true, data: { cleared: true, remaining: injectionStore.currentItems().length } });
      return;
    }

    if (req.method === 'POST' && path === '/inject') {
      if (injectionState.on !== true) {
        json(res, 409, { ok: false, error: { code: 'injection-disabled', message: '注入未启用：连接器配置 injection: true 后才可用' } });
        return;
      }
      const payload = await readJsonBody(req, res);
      if (!payload) return;
      // 优先收路径：注入存路径、每轮实时读盘，笔记改了注入就跟着变。
      // 没有路径时才退回「纯正文快照」（老客户端 / 别处塞内容）。
      const notePath = payload.path ? String(payload.path) : null;
      const absPath = payload.absPath ? String(payload.absPath) : null;
      const content = String(payload.content || '');
      if (!notePath && !content.trim()) {
        json(res, 400, { ok: false, error: { code: 'bad-args', message: '缺少 path 或 content' } });
        return;
      }
      if (content.length > MAX_INJECT_CONTENT) {
        json(res, 413, { ok: false, error: { code: 'payload-too-large', message: `单篇超过 ${MAX_INJECT_CONTENT} 字符` } });
        return;
      }
      try {
        let sessionId = String(payload.sessionId || '').trim();
        if (!sessionId) {
          const value = await sessions.list({}, new AbortController().signal);
          const items = Array.isArray(value?.items) ? value.items : [];
          const recent = pickRecent(items);
          if (!recent) {
            json(res, 409, { ok: false, error: { code: 'no-session', message: '没有可注入的会话' } });
            return;
          }
          if (!recent.sessionId) {
            json(res, 409, { ok: false, error: { code: 'no-session', message: '没有可注入的会话' } });
            return;
          }
          sessionId = String(recent.sessionId).trim();
        }
        const record = injectionStore.add({
          sessionId,
          content,
          path: notePath,
          absPath,
          title: payload.title ? String(payload.title) : null,
          kind: payload.kind ? String(payload.kind) : 'context',
        });
        if (!record) {
          json(res, 400, { ok: false, error: { code: 'bad-args', message: '注入内容或会话无效' } });
          return;
        }
        injectionStore.markCurrent(record);
        json(res, 200, {
          ok: true,
          data: { queued: true, id: record.id, sessionId, count: injectionStore.currentItems().length },
        });
      } catch (err) {
        json(res, 500, { ok: false, error: { code: 'inject-failed', message: String(err?.message || err) } });
      }
      return;
    }

    if (req.method === 'POST' && path === '/task') {
      const payload = await readJsonBody(req, res);
      if (!payload) return;
      const message = String(payload.message || '');
      if (!message.trim()) {
        json(res, 400, { ok: false, error: { code: 'bad-args', message: '缺少 message' } });
        return;
      }
      try {
        let sessionId = String(payload.sessionId || '').trim();
        if (!sessionId) {
          if (payload.newSession === true) {
            const created = await sessions.create({ ...(payload.cwd ? { cwd: payload.cwd } : {}) });
            sessionId = created.sessionId;
          } else {
            const value = await sessions.list({}, new AbortController().signal);
            const items = Array.isArray(value?.items) ? value.items : [];
            const recent = pickRecent(items);
            if (!recent) {
              json(res, 409, { ok: false, error: { code: 'no-session', message: '没有可投递的会话；先建一个（newSession=true）' } });
              return;
            }
            sessionId = recent.sessionId;
          }
        }
        const requestId = `${requestIdPrefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        await sessions.prompt(
          {
            requestId,
            sessionId,
            mode: payload.mode === 'steer' ? 'steer' : 'queue',
            content: [{ type: 'text', text: message }],
            ...(clientTimeZone ? { clientTimeZone } : {}),
          },
          new AbortController().signal,
        );
        json(res, 200, { ok: true, data: { sessionId, delivered: true, requestId } });
      } catch (err) {
        json(res, 500, { ok: false, error: { code: 'prompt-failed', message: String(err?.message || err) } });
      }
      return;
    }

    if (req.method === 'GET' && path === '/events') {
      const sessionId = String(url.searchParams.get('sessionId') || '').trim();
      if (!sessionId) {
        json(res, 400, { ok: false, error: { code: 'bad-args', message: '缺少 sessionId' } });
        return;
      }
      res.writeHead(200, {
        ...CORS_HEADERS,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(`: connected ${sessionId}\n\n`);
      const set = subscribers.get(sessionId) || new Set();
      subscribers.set(sessionId, set);
      set.add(res);
      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          /* ignore */
        }
      }, 15000);
      const cleanup = () => {
        clearInterval(ping);
        set.delete(res);
        if (set.size === 0) subscribers.delete(sessionId);
      };
      req.on('close', cleanup);
      res.on('close', cleanup);
      return;
    }

    json(res, 404, { ok: false, error: { code: 'not-found', message: `没有这条路由：${path}` } });
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        server,
        host,
        port: actualPort,
        url: `http://${host}:${actualPort}`,
        broadcast,
        injections: injectionStore,
        injectionState,
        close: () =>
          new Promise((done) => {
            for (const set of subscribers.values()) {
              for (const res of set) {
                try {
                  res.end();
                } catch {
                  /* ignore */
                }
              }
            }
            subscribers.clear();
            server.close(() => done());
          }),
      });
    });
  });
}