'use strict';
// Bridge · 连接器客户端（Obsidian 侧）
// 用 node:http 直连（插件跑在 Electron 渲染进程，不受页面 CORS 限制），
// 顺便避开跨源预检对连接器版本的依赖。

const http = require('node:http');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8812;
const DEFAULT_CLIENT = 'obsidian';

function nodeRequest(options) {
  const { method = 'GET', url, headers = {}, body, signal, onChunk } = options;
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: `${u.pathname}${u.search}`,
        method,
        headers,
      },
      (res) => {
        if (typeof onChunk === 'function') {
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            try {
              onChunk(chunk);
            } catch {
              /* 回调异常不打断流 */
            }
          });
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
          res.on('error', reject);
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error('aborted'));
        return;
      }
      signal.addEventListener('abort', () => req.destroy(new Error('aborted')));
    }
    if (body !== undefined && body !== null) req.write(body);
    req.end();
  });
}

function createConnectorClient(options = {}) {
  const {
    loadInfo,
    requestImpl = nodeRequest,
    timeoutMs = 15000,
    client = DEFAULT_CLIENT,
  } = options;

  if (typeof loadInfo !== 'function') throw new Error('createConnectorClient 需要 loadInfo');

  function config() {
    const raw = loadInfo();
    if (!raw || !raw.port || !raw.token) return null;
    return { host: raw.host || DEFAULT_HOST, port: Number(raw.port), token: raw.token };
  }

  function offline(message) {
    return {
      ok: false,
      error: {
        code: 'offline',
        message:
          message ||
          'DSH 连接器未就绪：确认 DSH 正在运行，并且已加载 dsh-bridge-connector（~/.dsh-bridge/connector.json 应存在）',
      },
    };
  }

  function baseUrl(cfg) {
    return `http://${cfg.host}:${cfg.port}`;
  }

  function headers(cfg) {
    return {
      'x-bridge-token': cfg.token,
      'x-bridge-client': client,
    };
  }

  async function request(pathname, reqOptions = {}) {
    const cfg = config();
    if (!cfg) return offline();

    const { method = 'GET', body, signal } = reqOptions;
    try {
      const res = await requestImpl({
        method,
        url: `${baseUrl(cfg)}${pathname}`,
        headers: { ...headers(cfg), 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        timeoutMs,
      });
      let payload = {};
      try {
        payload = JSON.parse(res.text || '{}');
      } catch {
        payload = {};
      }
      if (res.status < 200 || res.status >= 300 || payload.ok === false) {
        if (payload && payload.error) return payload;
        return { ok: false, error: { code: `http-${res.status}`, message: `HTTP ${res.status}` } };
      }
      return payload;
    } catch (err) {
      if (err && err.message === 'aborted' && signal && signal.aborted) throw err;
      return { ok: false, error: { code: 'transport', message: String((err && err.message) || err) } };
    }
  }

  return {
    info: config,
    health: () => request('/health'),
    sessions: () => request('/sessions'),
  // 读会话最近的消息：面板 reload 后靠它把消息恢复出来
  transcript: (sessionId, limit = 20) =>
    request(`/transcript?sessionId=${encodeURIComponent(sessionId)}&limit=${limit}`, { method: 'GET' }),
    createSession: (payload = {}) => request('/session', { method: 'POST', body: payload }),
    // 工作区：新建会话要挂到某个工作区，否则 DSH 侧栏里会落进「未分组」
    workspaces: () => request('/workspaces', { method: 'GET' }),
    createWorkspace: (payload) => request('/workspace', { method: 'POST', body: payload }),
    sendTask: (payload) => request('/task', { method: 'POST', body: payload }),
    inject: (payload) => request('/inject', { method: 'POST', body: payload }),
    config: () => request('/config'),
    setInjection: (on) => request('/config', { method: 'POST', body: { injection: on === true } }),
    injectStatus: () => request('/inject'),
    clearInjection: (id) => request('/inject/clear', { method: 'POST', body: id ? { id } : {} }),
    // 当前打开的笔记：推给连接器，agent 不用等主人开口就知道屏幕上是什么。
    // path 传 null = 明确告诉连接器「现在没有打开的笔记」，别让旧的那篇一直挂着。
    pushActiveNote: (payload) => request('/active-note', { method: 'POST', body: payload }),
    clearActiveNote: () => request('/active-note', { method: 'POST', body: { path: null } }),
    activeNote: () => request('/active-note', { method: 'GET' }),

    async subscribe(sessionId, onEvent, signal) {
      const cfg = config();
      if (!cfg) throw new Error('连接器未就绪');
      let buffer = '';
      const handle = (text) => {
        buffer += text;
        let split = buffer.indexOf('\n\n');
        while (split >= 0) {
          const chunk = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try {
              const parsed = JSON.parse(line.slice(5).trim());
              if (parsed && parsed.event) onEvent(parsed.event);
            } catch {
              /* 忽略坏帧 */
            }
          }
          split = buffer.indexOf('\n\n');
        }
      };

      const res = await requestImpl({
        method: 'GET',
        url: `${baseUrl(cfg)}/events?sessionId=${encodeURIComponent(sessionId)}`,
        headers: headers(cfg),
        signal,
        onChunk: handle,
      });
      if (res.status !== 200) throw new Error(`SSE 连接失败：HTTP ${res.status}`);
    },
  };
}

module.exports = { createConnectorClient, nodeRequest };