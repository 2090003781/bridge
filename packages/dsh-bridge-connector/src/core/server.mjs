// Bridge 连接器 · HTTP/SSE 协议层
// 只负责报文：会话清单 / 投递 / 新建会话 / 事件推送。DSH 运行时由 index.js 注入。

import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createInjectionStore } from './injection.mjs';
import { createTitleCache, createSessionFileIndex } from './session-title.mjs';
import { createWorkspaceIndex } from './workspace-index.mjs';
import { readRecentMessages } from './transcript.mjs';
import { readUsage } from './usage.mjs';
import { renderActiveNote, renderMarksLine, marksKeyOf } from './active-note.mjs';
import { createObsidianProbe, mergeActiveNote } from './obsidian-probe.mjs';

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
// 从 Obsidian 面板投递的消息打个来源标记。
// 不标的话，它在会话历史里跟 Web 上打的字一模一样，模型分不清该用哪种口径回
// （面板窄，适合短回复）。标记是真写进正文的，不是透明元数据——DSH 的 prompt 没有 source 字段。
const OBSIDIAN_TAG = '【Obsidian】';
function markSource(text) {
  const s = String(text || '');
  return s.startsWith(OBSIDIAN_TAG) ? s : OBSIDIAN_TAG + s;
}

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
    workspaceId: ws.workspace ? ws.workspace.workspaceId : null,
    workspaceTitle: ws.workspace ? ws.workspace.title : null,
    workspacePath: ws.workspace ? ws.workspace.path : null,
    archived: ws.archived,
    updatedAt: Number.isFinite(item.updatedAt) ? new Date(item.updatedAt).toISOString() : null,
  };
}


/**
 * 从审批请求里取会话 id。请求带的是 agent，而 agent.session 才是会话本身，
 * agent.sessionId 根本不存在——照它取只会拿到空串，三档就全都不生效。
 */
export function sessionIdOf(agent) {
  if (!agent) return '';
  const session = agent.session || null;
  const id = agent.sessionId || (session && (session.id || session.sessionId)) || agent.id || '';
  return String(id || '');
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
    workspaceRegistry = null,
    injectionState = { on: false },
    obsidianProbe = null,
    approvalState = null,
  } = options;

  // 审批三档（每会话）：notify 只提示 / ask 转发到面板等人点 / auto 直接放行。
  // 默认 notify：不替主人做决定。
  const APPROVAL_MODES = ['notify', 'ask', 'auto'];
  const modeState = approvalState || { modeFor: () => 'notify', setMode: () => {} };

  // 正在等审批的请求：approval/asked 进来、approval/decided 消掉。
  const pendingApprovals = new Map(); // id -> { id, sessionId, toolName, reason, at }
  // 挂起来等面板决定的请求：id -> { done }
  const pendingDecisions = new Map();

  // 「Bridge 工具」的判据：工具名去掉 mcp__<server>__ 前缀后以 obsidian_ 开头。
  // 不靠理由里出现关键字——那个会误伤，前缀是硬约束（MCP 工具表里都带）。
  function isBridgeTool(toolName) {
    const name = String(toolName || '');
    const rest = name.includes('__') ? name.slice(name.lastIndexOf('__') + 2) : name;
    return rest.startsWith('obsidian_');
  }

  // DSH 先往日志里追加 approval/asked（带真实 id）再走 waterfall，
  // 所以这时候 pendingApprovals 里已经有这一条了：用它的 id 应答，
  // 面板点下去才和 DSH 那边对得上号。抢不到才退化成自造 id。
  async function claimPending(sessionId, toolName, callId, ms) {
    const deadline = Date.now() + (Number(ms) || 0);
    for (;;) {
      let best = null;
      for (const row of pendingApprovals.values()) {
        if (!row || pendingDecisions.has(row.id)) continue;
        if (sessionId && row.sessionId !== sessionId) continue;
        if (callId && row.callId && row.callId !== callId) continue;
        if (!callId && row.toolName !== toolName) continue;
        if (!best || row.at >= best.at) best = row;
      }
      if (best) return best.id;
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const id = 'appr-' + crypto.randomBytes(6).toString('hex');
    pendingApprovals.set(id, {
      id,
      sessionId: String(sessionId || ''),
      toolName: String(toolName || ''),
      callId: String(callId || ''),
      reason: '',
      at: Date.now(),
    });
    return id;
  }

  // 投递前现查 Obsidian 的光标：本地回环一次几毫秒，比等推送精确。
  const probe = obsidianProbe || createObsidianProbe();

  const injectionStore = injections || createInjectionStore({ ttlMs: injectionTtlMs, file: injectionFile });

  // 当前打开的笔记：Obsidian 侧在切标签、改正文时推上来，
  // 目的是让 agent 不用等主人开口就知道「屏幕上这篇」是什么。
  // 只放内存：这是「此刻正在看什么」，DSH 重启后应当重新推一次；
  // 落盘只会让过期的一篇冒充当前，比没有更糟。
  const ACTIVE_NOTE_TTL_MS = 10 * 60 * 1000;
  let activeNote = null;
  const asNum = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  const asText = (v, limit) => (typeof v === 'string' && v ? v.slice(0, limit) : null);

  /** 把客户端推来的笔记元信息收成固定形状：多出来的丢掉，缺的不编。 */
  function normalizeActiveNote(payload) {
    const pos = (p) =>
      p && Number.isFinite(Number(p.line)) ? { line: asNum(p.line), ch: asNum(p.ch) } : null;
    const sel = payload.selection;
    const selection =
      sel && Number.isFinite(Number(sel.fromLine)) && Number.isFinite(Number(sel.toLine))
        ? {
            fromLine: asNum(sel.fromLine),
            fromCh: asNum(sel.fromCh),
            toLine: asNum(sel.toLine),
            toCh: asNum(sel.toCh),
            chars: asNum(sel.chars),
            preview: asText(sel.preview, 400),
          }
        : null;
    return {
      path: String(payload.path).slice(0, 400),
      absPath: asText(payload.absPath, 800),
      title: asText(payload.title, 200),
      charCount: asNum(payload.charCount),
      lineCount: asNum(payload.lineCount),
      updatedAt: asText(payload.updatedAt, 40),
      cursor: pos(payload.cursor),
      selection,
      // 客户端明确说过「没有选区」才记为 true；没说过就当不知道
      checked: payload.checked === true,
      heading: asText(payload.heading, 200),
      // 另外还开着哪几篇：只留路径字符串，最多 8 条
      others: Array.isArray(payload.others)
        ? payload.others.filter((x) => typeof x === 'string' && x).slice(0, 8)
        : [],
      // 标记：一个点（最多一个）+ 若干处区域
      point: payload.point && asNum(payload.point.line) !== null
        ? { line: asNum(payload.point.line), ch: asNum(payload.point.ch) || 0 }
        : null,
      regions: Array.isArray(payload.regions)
        ? payload.regions
            .filter(
              (r) =>
                r &&
                r.from && r.to &&
                asNum(r.from.line) !== null &&
                asNum(r.to.line) !== null
            )
            .slice(0, 8)
            .map((r) => ({
              from: { line: asNum(r.from.line), ch: asNum(r.from.ch) || 0 },
              to: { line: asNum(r.to.line), ch: asNum(r.to.ch) || 0 },
            }))
        : [],
      at: Date.now(),
    };
  }

  function activeNoteOf() {
    if (!activeNote) return null;
    if (Date.now() - activeNote.at > ACTIVE_NOTE_TTL_MS) return null;
    return activeNote;
  }

  // 同一会话里，同一篇笔记的坐标只搭一次车：
  // 每轮都重复灌一遍没有任何新信息，只会把真正要说的话挤走。
  const noteSeen = new Map(); // sessionId -> Set<path>
  // 上一轮报过的标记指纹：标记没变就不重复报，省一行提示词
  const marksSeen = new Map(); // sessionId -> string

  /** 此刻的当前笔记：现查优先，问不到就用推送缓存。任何异常都不许影响投递。 */
  async function currentNote() {
    try {
      const live = await probe.editorState();
      if (live.ok) {
        // 它明确说「没有打开的笔记」时，信它，不要用旧缓存把旧的一篇顶上来。
        if (live.data === null) return null;
        return mergeActiveNote(live.data, activeNoteOf());
      }
    } catch {
      /* 探测失败不打断投递 */
    }
    return activeNoteOf();
  }

  /** 这一轮要顺带告诉模型的「当前笔记」整篇坐标；这一篇已经给过就返回空串。 */
  function takeActiveNoteFor(sessionId, note) {
    const live = note;
    if (!live || !live.path || !sessionId) return '';
    let seen = noteSeen.get(sessionId);
    if (!seen) {
      seen = new Set();
      noteSeen.set(sessionId, seen);
    }
    if (seen.has(live.path)) return '';
    seen.add(live.path);
    return renderActiveNote(live);
  }

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

    // 工作区：Obsidian 这边新建会话要挂到某个工作区，不然 DSH 侧栏里会落进「未分组」
    if (req.method === 'GET' && path === '/workspaces') {
      if (!workspaceRegistry) {
        json(res, 200, { ok: true, data: { available: false, workspaces: [] } });
        return;
      }
      try {
        const list = typeof workspaceRegistry.list === 'function' ? workspaceRegistry.list() : [];
        const workspaces = (Array.isArray(list) ? list : []).map((w) => ({
          workspaceId: w && w.id ? String(w.id) : null,
          path: w && w.path ? String(w.path) : null,
          title: w && w.title ? String(w.title) : null,
          sessionCount: Array.isArray(w && w.sessionIds) ? w.sessionIds.length : 0,
        }));
        json(res, 200, { ok: true, data: { available: true, workspaces } });
      } catch (err) {
        json(res, 500, { ok: false, error: { code: 'workspace-list-failed', message: String(err?.message || err) } });
      }
      return;
    }

    if (req.method === 'POST' && path === '/workspace') {
      const payload = await readJsonBody(req, res);
      if (!payload) return;
      if (!workspaceRegistry || typeof workspaceRegistry.create !== 'function') {
        json(res, 501, { ok: false, error: { code: 'unsupported', message: '这个 DSH 没有工作区服务' } });
        return;
      }
      const dir = String(payload.path || '').trim();
      const title = payload.title ? String(payload.title) : undefined;
      if (!dir) {
        json(res, 400, { ok: false, error: { code: 'bad-args', message: '缺少 path' } });
        return;
      }
      try {
        const created = await workspaceRegistry.create(dir, title);
        json(res, 200, {
          ok: true,
          data: {
            workspaceId: created && created.id ? String(created.id) : null,
            path: created && created.path ? String(created.path) : dir,
            title: created && created.title ? String(created.title) : title || null,
          },
        });
      } catch (err) {
        json(res, 500, { ok: false, error: { code: 'workspace-create-failed', message: String(err?.message || err) } });
      }
      return;
    }

    if (req.method === 'POST' && path === '/session') {
      const payload = await readJsonBody(req, res);
      if (!payload) return;
      try {
        // workspaceId 和 cwd 互斥：有工作区就用工作区（它自带路径）
        const target = payload.workspaceId
          ? { workspaceId: payload.workspaceId }
          : payload.cwd
            ? { cwd: payload.cwd }
            : {};
        const created = await sessions.create({
          ...target,
          ...(payload.agentPreset ? { agentPreset: payload.agentPreset } : {}),
        });
        json(res, 200, { ok: true, data: { sessionId: created.sessionId } });
      } catch (err) {
        json(res, 500, { ok: false, error: { code: 'create-failed', message: String(err?.message || err) } });
      }
      return;
    }

    // 读会话里最近的对话：面板 reload 后靠它把消息恢复出来。
    if (req.method === 'GET' && path === '/transcript') {
      const sessionId = String(url.searchParams.get('sessionId') || '').trim();
      if (!sessionId) {
        json(res, 400, { ok: false, error: { code: 'bad-args', message: '缺少 sessionId' } });
        return;
      }
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
      const file = sessionFileOf(sessionId);
      const messages = file ? readRecentMessages(file, limit) : [];
      json(res, 200, { ok: true, data: { sessionId, messages, hasFile: Boolean(file) } });
      return;
    }

    // 当前打开的笔记：只收「坐标」，不收正文。
    // 正文交给 agent 需要时自己去读——一份实时读取的副本永远比每轮重发的旧副本准。
    if (req.method === 'POST' && path === '/active-note') {
      const payload = await readJsonBody(req, res);
      if (!payload) return;
      const notePath = payload.path ? String(payload.path) : null;
      if (!notePath) {
        activeNote = null;
        json(res, 200, { ok: true, data: { cleared: true } });
        return;
      }
      activeNote = normalizeActiveNote(payload);
      json(res, 200, {
        ok: true,
        data: {
          path: activeNote.path,
          cursor: activeNote.cursor,
          hasSelection: Boolean(activeNote.selection),
        },
      });
      return;
    }

    if (req.method === 'GET' && path === '/active-note') {
      const live = activeNoteOf();
      json(res, 200, {
        ok: true,
        data: live ? { ...live, at: new Date(live.at).toISOString() } : null,
      });
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
            // 节奏：每 every 轮带一次，共 times 次（0 = 不限期），已带 used 次
            every: Number(cur.every) || 1,
            times: Number(cur.times) || 0,
            used: Number(cur.used) || 0,
            remaining: Number(cur.remaining) || 0,
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
          // 节奏：每 every 轮带一次；times 是总次数（0 = 不限期）
          every: payload.every,
          times: payload.times,
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
        // 坐标分两种寿命：整篇的（路径/篇幅/小节）跟会话只走一趟；
        // 光标那一句每轮都走——它随时在变，而且只占一行。
        const live = await currentNote();
        // 整篇坐标每个会话每篇只搭一次车；之后只在「标记变了」时补一行。
        // 光标位置一概不看——指着哪一段由标记说。
        let noteText = takeActiveNoteFor(sessionId, live);
        if (noteText) {
          marksSeen.set(sessionId, marksKeyOf(live));
        } else {
          const markKey = live ? marksKeyOf(live) : '';
          const prev = marksSeen.get(sessionId) || '';
          if (markKey !== prev) {
            marksSeen.set(sessionId, markKey);
            noteText = renderMarksLine(live, { cleared: markKey === '' && prev !== '' });
          }
        }
        const text = noteText ? noteText + '\n\n' + markSource(message) : markSource(message);
        // 这一轮算第几轮：注入的「每 N 轮」靠它数。要在 prompt 之前加，
        // 因为系统提示词是在 prompt 里组装的。
        injectionStore.beginDelivery(sessionId);
        try {
          await sessions.prompt(
            {
              requestId,
              sessionId,
              mode: payload.mode === 'steer' ? 'steer' : 'queue',
              content: [{ type: 'text', text }],
              ...(clientTimeZone ? { clientTimeZone } : {}),
            },
            new AbortController().signal,
          );
        } catch (promptError) {
          // 没投出去：这一轮退回去，别让「每 N 轮」白走一格、也别白吃一次次数
          injectionStore.rollbackDelivery(sessionId);
          throw promptError;
        }
        injectionStore.tick(sessionId);
        json(res, 200, { ok: true, data: { sessionId, delivered: true, requestId } });
      } catch (err) {
        json(res, 500, { ok: false, error: { code: 'prompt-failed', message: String(err?.message || err) } });
      }
      return;
    }

    // 上下文占用：面板输入条上那条进度用。数据从会话日志尾部读，不打扰会话本身。
    if (req.method === 'GET' && path === '/usage') {
      const sessionId = String(url.searchParams.get('sessionId') || '').trim();
      if (!sessionId) {
        json(res, 400, { ok: false, error: { code: 'bad-args', message: '缺少 sessionId' } });
        return;
      }
      const file = sessionFileOf(sessionId);
      const usage = file ? readUsage(file) : null;
      json(res, 200, {
        ok: true,
        data: {
          sessionId,
          hasFile: Boolean(file),
          window: usage ? usage.window : null,
          used: usage ? usage.used : 0,
          percent: usage ? usage.percent : null,
          model: usage ? usage.model : null,
        },
      });
      return;
    }

    // 正在等审批的请求 + 当前档位
    if (req.method === 'GET' && path === '/approvals') {
      const sessionId = String(url.searchParams.get('sessionId') || '').trim();
      const list = [...pendingApprovals.values()].filter((x) => !sessionId || x.sessionId === sessionId);
      json(res, 200, {
        ok: true,
        data: { pending: list.map((x) => ({ ...x, answerable: pendingDecisions.has(x.id) })), mode: modeState.modeFor(sessionId), modes: APPROVAL_MODES },
      });
      return;
    }

    // 切换审批档位：notify / ask / auto
    if (req.method === 'POST' && path === '/approval/mode') {
      const payload = await readJsonBody(req, res);
      if (!payload) return;
      const sessionId = String(payload.sessionId || '').trim();
      const mode = String(payload.mode || '').trim();
      if (!sessionId) {
        json(res, 400, { ok: false, error: { code: 'bad-args', message: '缺少 sessionId' } });
        return;
      }
      if (!APPROVAL_MODES.includes(mode)) {
        json(res, 400, { ok: false, error: { code: 'bad-args', message: 'mode 只能是 ' + APPROVAL_MODES.join(' / ') } });
        return;
      }
      modeState.setMode(sessionId, mode);
      // 切到自动放行时，把这一会话已经挂着的提示清掉，别留着一条点不动的。
      if (mode === 'auto') {
        for (const [key, row] of pendingApprovals) {
          if (row && row.sessionId === sessionId) pendingApprovals.delete(key);
        }
      }
      json(res, 200, { ok: true, data: { sessionId, mode } });
      return;
    }

    // 面板上点了「允许 / 拒绝」：把挂着的那个请求放行
    if (req.method === 'POST' && path === '/approval/answer') {
      const payload = await readJsonBody(req, res);
      if (!payload) return;
      const id = String(payload.id || '').trim();
      const decision = String(payload.decision || '').trim();
      const entry = pendingDecisions.get(id);
      if (!entry) {
        if (pendingApprovals.has(id)) { json(res, 409, { ok: false, error: { code: 'not-decidable', message: '这一档没把请求交给面板，请到 DSH 窗口里批准' } }); return; }
        json(res, 404, { ok: false, error: { code: 'not-found', message: '这个审批已经处理过或超时了' } });
        return;
      }
      const outcome = decision === 'allow' ? 'allowed-once' : 'rejected';
      entry.done(outcome);
      json(res, 200, { ok: true, data: { id, outcome } });
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
        // 会话事件进来时记一笔：审批请求进表、决定出表
        noteEvent(sessionId, event) {
          try {
            const type = event && event.type;
            const data = (event && event.data) || {};
            if (type === 'approval/asked') {
              const id = String(data.id || '');
              if (!id) return true;
              // 自动放行档下，Bridge 工具的审批连痕迹都不留：不进列表、也不推给面板。
              if (isBridgeTool(data.toolName) && modeState.modeFor(String(sessionId || '')) === 'auto') return false;
              pendingApprovals.set(id, {
                id,
                sessionId: String(sessionId || ''),
                toolName: String(data.toolName || ''),
                callId: String(data.callId || ''),
                reason: String(data.reason || ''),
                at: Date.now(),
              });
              return true;
            }
            if (type === 'approval/decided') {
              const id = String(data.id || '');
              if (id) {
                pendingApprovals.delete(id);
                // 我们挂住的那条要是被别处先定了（中断/超时/别的应答者），
                // 必须立刻把 promise 结掉，否则整个 waterfall 就永远挂着。
                const held = pendingDecisions.get(id);
                if (held && typeof held.done === 'function') held.done(String(data.outcome || 'cancelled'));
                else pendingDecisions.delete(id);
              }
            }
            return true;
          } catch {
            /* 记事件绝不影响会话 */
            return true;
          }
        },
        approvals: {
          pendingFor: (sessionId) =>
            [...pendingApprovals.values()].filter((x) => !sessionId || x.sessionId === sessionId),
          modeFor: (sessionId) => modeState.modeFor(String(sessionId || '')),
          setMode: (sessionId, mode) => modeState.setMode(String(sessionId || ''), mode),
          isBridgeTool,
          /**
           * 把请求挂住、推到面板等人决定；超时就返回 null（交回下一个应答者）。
           * 返回 'allowed-once' | 'rejected' | null。
           */
          async requestDecision(sessionId, req, timeoutMs = 180000) {
            const id = await claimPending(
              String(sessionId || ''),
              String((req && req.toolName) || ''),
              req && req.callId !== void 0 ? String(req.callId) : '',
              400
            );
            return new Promise((resolve) => {
              const done = (outcome) => {
                if (!pendingDecisions.has(id)) return;
                pendingDecisions.delete(id);
                pendingApprovals.delete(id);
                clearTimeout(timer);
                broadcast(sessionId, { type: 'bridge/approval-decided', data: { id } });
                resolve(outcome);
              };
              const timer = setTimeout(() => {
                if (!pendingDecisions.has(id)) return;
                pendingDecisions.delete(id);
                pendingApprovals.delete(id);
                broadcast(sessionId, { type: 'bridge/approval-decided', data: { id, timeout: true } });
                resolve(null);
              }, Math.max(1000, Number(timeoutMs) || 180000));
              if (typeof timer.unref === 'function') timer.unref();
              pendingDecisions.set(id, { done });
              broadcast(sessionId, {
                type: 'bridge/approval-request',
                data: {
                  id,
                  answerable: true,
                  toolName: String((req && req.toolName) || ''),
                  reason: String((req && req.reason) || ''),
                },
              });
            });
          },
        },
        injections: injectionStore,
        injectionState,
        activeNote: activeNoteOf,
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