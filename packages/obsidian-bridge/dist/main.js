'use strict';
// 由 scripts/build.js 生成，不要手改。
const __nativeRequire = require;
const __mods = Object.create(null);
function __define(id, fn) { __mods[id] = { fn, loaded: false, exports: {} }; }
function __req(id) {
  const m = __mods[id];
  if (!m) return __nativeRequire(id);
  if (!m.loaded) { m.loaded = true; m.fn(m, m.exports, __req); }
  return m.exports;
}

__define('lib/ai-cursor-sync.js', function (module, exports, require) {
'use strict';
// Bridge · 让 AI 光标跟着文字走
//
// 主人改文档（插入、删除、换行）之后，AI 光标原来那个 {line,ch} 就指到别处去了。
// 这里在每次文档变化时把 AI 光标映射到新坐标上，让它继续贴着原来那段字。
//
// 关键：AI 自己的改动要跳过映射。AI 改完已经自己算准了新位置，
// 如果同步器再映射一次，就会多挪一截（双重移动）。
// 用 transaction annotation 区分「谁改的」。

let cmCache = null;
function loadCm() {
  if (cmCache) return cmCache;
  const view = require('@codemirror/view');
  const state = require('@codemirror/state');
  if (!view || !view.ViewPlugin || !state || !state.Annotation) {
    throw new Error('宿主没有暴露 CodeMirror 的 ViewPlugin/Annotation');
  }
  cmCache = { ViewPlugin: view.ViewPlugin, Annotation: state.Annotation };
  return cmCache;
}

/** 打上这个标记的 transaction 表示「这次是 AI 改的，别映射」 */
let aiEditAnnotation = null;

function getAiEditAnnotation() {
  if (!aiEditAnnotation) {
    const { Annotation } = loadCm();
    aiEditAnnotation = Annotation.define();
  }
  return aiEditAnnotation;
}

/**
 * 这次文档变化该不该让 AI 光标跟着映射？
 * 只有当变化里没有「AI 自己改的」标记时才映射——否则 AI 刚算准的位置会被再挪一次。
 * 抽成纯函数是为了能单测：ViewPlugin 本体依赖 CodeMirror，本机没有那个包。
 */
function shouldMapThrough(update, aiEditAnnotation) {
  if (!update || update.docChanged !== true) return false;
  for (const tr of update.transactions || []) {
    if (tr && typeof tr.annotation === 'function' && tr.annotation(aiEditAnnotation)) return false;
  }
  return true;
}

/**
 * @param {{getAiCursor:()=>any, resolvePath:(cmView:any)=>string|null}} deps
 */
function createAiCursorSync({ getAiCursor, resolvePath }) {
  const { ViewPlugin } = loadCm();
  const aiEdit = getAiEditAnnotation();

  const plugin = ViewPlugin.fromClass(
    class {
      update(u) {
        if (!shouldMapThrough(u, aiEdit)) return;
        let cur = null;
        try {
          cur = getAiCursor();
        } catch {
          cur = null;
        }
        if (!cur || typeof cur.mapThrough !== 'function') return;
        let path = null;
        try {
          path = resolvePath(u.view);
        } catch {
          path = null;
        }
        if (!path) return;
        cur.mapThrough(path, u.startState.doc, u.changes, u.state.doc, 'after');
      }
    },
  );
  return [plugin];
}

module.exports = { createAiCursorSync, getAiEditAnnotation, shouldMapThrough };

});
__define('lib/ai-cursor.js', function (module, exports, require) {
'use strict';
// Bridge · AI 自己的光标
//
// 主人有一个光标，AI 需要一个自己的：位置、选区、能往里插字、能选中一段。
// 但它和主人的那个**完全隔离**：
//   · 不读主人的光标（所以主人把光标停在哪都不影响 AI 的判断）
//   · 不动主人的光标（改动走 CM6 的 changes，不发 selection）
//   · 不显示（纯状态，没有任何装饰）
//
// 光标按文件归属：AI 在 A 篇操作完又去 B 篇，B 篇的光标从行首开始，
// 不会把 A 篇的位置硬套过去。

/** 位置比较：先比行，再比列。 */
function comparePos(a, b) {
  if (a.line !== b.line) return a.line - b.line;
  return (a.ch || 0) - (b.ch || 0);
}

const norm = (p) => ({
  line: Math.max(0, Math.floor(Number(p && p.line) || 0)),
  ch: Math.max(0, Math.floor(Number(p && p.ch) || 0)),
});

function createAiCursor() {
  const state = { path: null, head: norm({}), anchor: null };

  /** 取某篇的 AI 光标；换了一篇就从行首重来，不继承上一篇的位置。 */
  function forPath(path) {
    if (state.path !== path) {
      state.path = path;
      state.head = norm({});
      state.anchor = null;
    }
    return state;
  }

  /** 移动光标（同时清掉选区，和真实光标的语义一致）。 */
  function move(path, pos) {
    const st = forPath(path);
    st.head = norm(pos);
    st.anchor = null;
    return snapshot(st);
  }

  /** 选中一段：anchor 是起点，head 是终点（可以是反向选，from/to 会摆正）。 */
  function select(path, from, to) {
    const st = forPath(path);
    st.anchor = norm(from);
    st.head = norm(to);
    return snapshot(st);
  }

  /** 取消选区，只留插入点。 */
  function collapse(path) {
    const st = forPath(path);
    st.anchor = null;
    return snapshot(st);
  }

  /** 当前范围：from / to 已摆正，empty 表示没选中东西。 */
  function range(path) {
    const st = forPath(path);
    if (!st.anchor) return { from: st.head, to: st.head, empty: true };
    const a = st.anchor;
    const b = st.head;
    return comparePos(a, b) <= 0
      ? { from: a, to: b, empty: a.line === b.line && a.ch === b.ch }
      : { from: b, to: a, empty: a.line === b.line && a.ch === b.ch };
  }

  /**
   * 别人改了文档后，把自己的位置映射到新坐标上 —— 这样文字挪动时
   * 光标仍然贴着原来那段字，不会莫名其妙落在别的字中间。
   *
   * @param {string} path      当前编辑的是哪一篇（不是这一篇就不动）
   * @param {object} startDoc  改动前的文档（用来把 line/ch 转 offset）
   * @param {object} changes   CM6 ChangeSet
   * @param {object} newDoc    改动后的文档（用来把 offset 转回 line/ch）
   * @param {'before'|'after'|'nearest'} assoc 位置正好落在改动边界上时往哪边靠
   */
  function mapThrough(path, startDoc, changes, newDoc, assoc = 'after') {
    if (state.path !== path) return false;
    if (!startDoc || !changes || !newDoc) return false;

    const toOffset = (doc, pos) => {
      const n = Math.min(Math.max(1, Math.floor(pos.line) + 1), doc.lines);
      const l = doc.line(n);
      return Math.min(l.from + Math.max(0, Math.floor(pos.ch || 0)), l.to);
    };
    const toPos = (doc, offset) => {
      const at = Math.max(0, Math.min(offset, doc.length));
      const l = doc.lineAt(at);
      return { line: l.number - 1, ch: at - l.from };
    };

    // assoc: 1 = 右偏（改动插在我前面时我往后让），-1 = 左偏
    const bias = assoc === 'before' ? -1 : 1;
    const nextHead = toPos(newDoc, changes.mapPos(toOffset(startDoc, state.head), bias));
    const nextAnchor = state.anchor
      ? toPos(newDoc, changes.mapPos(toOffset(startDoc, state.anchor), bias))
      : null;

    state.head = nextHead;
    state.anchor = nextAnchor;
    return true;
  }

  function snapshot(st = state) {
    return {
      path: st.path,
      head: { ...st.head },
      anchor: st.anchor ? { ...st.anchor } : null,
      selection: st.anchor ? range(st.path) : null,
    };
  }

  return { state, forPath, move, select, collapse, range, snapshot, mapThrough };
}

module.exports = { createAiCursor };

});
__define('lib/chat-view.js', function (module, exports, require) {
'use strict';
// Bridge · 主面板（整合视图）
// 左 1/3：状态、功能按钮、最近操作记录；右 2/3：与 DSH 会话的对话。

const { ItemView, Notice, Modal, Setting, TFolder, MarkdownRenderer } = require('obsidian');
const fs = require('node:fs');
const { parseLedger } = __req('lib/ledger-reader.js');
const { reconcileInjection } = __req('lib/settings.js');
const { pickMissingReply, shouldReconcile } = __req('lib/reply-reconcile.js');
const { pickReplyAnchor } = __req('lib/scroll-anchor.js');

const VIEW_TYPE = 'bridge-chat';
const RECENT_LIMIT = 15;

function shortTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

class BridgeChatView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.messages = [];
    this.assistantBuffer = '';
    this.steerMode = false; // false = 排队等这一轮结束；true = 打断当前一轮
    this.pending = [];      // 合并盒：连发的消息先攒在这里
    this.pendingTimer = null;
    this.mergeWindowMs = 1500; // 最后一次输入后等这么久再合并发出
    this.sessionId = null;
    this.ac = null;
    this.sideTimer = null;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return 'Bridge';
  }

  getIcon() {
    return 'message-square';
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('bridge-panel');

    const main = root.createDiv({ cls: 'bridge-panel-main' });
    this.sideEl = main.createDiv({ cls: 'bridge-panel-side' });
    this.chatEl = main.createDiv({ cls: 'bridge-panel-chat' });

    this.renderSide();
    this.renderChat();

    this.sideTimer = setInterval(() => this.refreshRemoteState(), 5000);

    await this.ensureSession();
    this.refreshRemoteState();
  }

  onClose() {
    if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = null; }
    if (this._lineTimer) { clearInterval(this._lineTimer); this._lineTimer = null; }
    // 用户主动关掉面板：下次启动别再自己弹出来
    this.plugin.settings.chatOpen = false;
    this.plugin.persistSettings();
    if (this.sideTimer) {
      clearInterval(this.sideTimer);
      this.sideTimer = null;
    }
    this.disconnect();
  }

  // ── 左栏：状态 / 按钮 / 操作记录 ────────────────────────────
  renderSide() {
    const side = this.sideEl;
    side.empty();

    const grid = side.createDiv({ cls: 'bridge-actions' });
    const levelBtn = grid.createEl('button', { cls: 'bridge-action-btn bridge-level-btn', text: '档位 —' });
    this.levelBtn = levelBtn;
    levelBtn.onClickEvent(() => {
      const perms = this.plugin.permissions;
      if (!perms) {
        new Notice('Bridge 服务未运行');
        return;
      }
      const order = ['read', 'write', 'trust'];
      const cur = perms.levelOf('agent.dsh');
      const next = order[(order.indexOf(cur) + 1) % order.length];
      try {
        perms.setLevel('agent.dsh', next);
        new Notice(`DSH 档位：${next}`);
      } catch (err) {
        new Notice(String((err && err.message) || err));
      }
      this.refreshLevel();
    });
    this.refreshLevel();
    const addBtn = (label, fn) => {
      const b = grid.createEl('button', { cls: 'bridge-action-btn', text: label });
      b.onClickEvent(fn);
      return b;
    };
    addBtn('注入', () => this.openInjectionPanel());
    addBtn('复制 token', () => this.plugin.copyToken());
    addBtn('选择会话', () => this.openSessionPicker());
    addBtn('新建会话', () => this.createAndBind());
    addBtn('操作记录', () => this.plugin.openLog());
  }

  refreshLevel() {
    if (!this.levelBtn) return;
    const perms = this.plugin.permissions;
    this.levelBtn.setText(`档位 ${perms ? perms.levelOf('agent.dsh') : '—'}`);
    this.levelBtn.disabled = !perms;
  }

  refreshLocalState() {
    this.refreshLevel();
    if (!this.metaEl) return;    const core = this.plugin.core;
    const parts = [core ? `Bridge ${core.port}` : 'Bridge 未运行', this.sessionId ? `会话 ${this.sessionId.slice(0, 12)}` : '未绑定会话'];
    this.metaEl.setText(parts.join(' · '));
    this.metaEl.toggleClass('is-off', !core);
  }

  refreshRemoteState() {
    if (!this.metaEl) return;
    const local = this.plugin.settings.injectionEnabled === true;
    this.plugin
      .connector()
      .config()
      .then((res) => {
        if (!this.metaEl) return;
        const core = this.plugin.core;
        const parts = [core ? `Bridge ${core.port}` : 'Bridge 未运行', this.sessionId ? `会话 ${this.sessionId.slice(0, 12)}` : '未绑定会话'];
        if (!res || res.ok !== true) parts.push(`注入 ${local ? '开' : '关'}（连接器离线）`);
        else parts.push(`注入 ${res.data.injection ? '开' : '关'}`);
        this.metaEl.setText(parts.join(' · '));
        this.metaEl.toggleClass('is-off', !core);
      })
      .catch(() => {});
  }

  // ── 右栏：对话 ────────────────────────────────────────────
  renderChat() {
    const root = this.chatEl;
    root.empty();

    const header = root.createDiv({ cls: 'bridge-chat-header' });
    this.statusEl = header.createSpan({ cls: 'bridge-chat-status', text: '连接中…' });
    this.sessionEl = header.createSpan({ cls: 'bridge-chat-session', text: '' });
    this.metaEl = root.createDiv({ cls: 'bridge-meta', text: '' });

    this.listEl = root.createDiv({ cls: 'bridge-chat-list' });
    // 是否贴着底部，由「用户自己的滚动」决定，而不是每次重建后再算一遍——
    // 重建那一刻 scrollHeight 还没稳定，算出来的值经常是错的，于是又把人拽到底下。
    this._stickToBottom = true;
    this.listEl.addEventListener('scroll', () => {
      this._stickToBottom = this.isAtBottom();
      this.updateJumpButton();
    });

    // 输入区做成一个整体：上面是输入框，下面一条工具条，靠右排「回底 / 打断 / 发送」
    const inputWrap = root.createDiv({ cls: 'bridge-composer' });
    this.inputEl = inputWrap.createEl('textarea', {
      cls: 'bridge-chat-textarea',
      attr: { placeholder: '跟 DSH 说点什么…（Enter 发送，Shift+Enter 换行）', rows: '3' },
    });
    const bar = inputWrap.createDiv({ cls: 'bridge-composer-bar' });

    // 回到底部：一开始禁用，往上翻历史时才亮起来
    this.jumpEl = bar.createEl('button', { cls: 'bridge-composer-btn bridge-jump-bottom', text: '↓' });
    this.jumpEl.title = '回到最底下';
    this.jumpEl.onClickEvent(() => {
      this.scrollToBottom();
      this.updateJumpButton();
    });

    // queue = 排队等这一轮结束；steer = 立刻打断当前这一轮
    this.steerBtn = bar.createEl('button', { cls: 'bridge-composer-btn bridge-chat-steer', text: '打断' });
    this.steerBtn.title = '默认排队（等这一轮结束）。点亮「打断」则立刻插进当前这一轮。';
    this.steerBtn.onClickEvent(() => {
      this.steerMode = !this.steerMode;
      this.steerBtn.toggleClass('is-on', this.steerMode);
      new Notice(this.steerMode ? '发送模式：打断当前一轮' : '发送模式：排队等待');
    });
    this.sendBtn = bar.createEl('button', { cls: 'bridge-composer-btn bridge-chat-send', text: '发送' });
    this.sendBtn.onClickEvent(() => this.send());
    this.inputEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        this.send();
      }
    });

    this.render();
  }

  setStatus(text) {
    if (this.statusEl) this.statusEl.setText(text);
  }

  async ensureSession() {
    const client = this.plugin.connector();
    // 面板一打开就把库目录注册成工作区（后台跑，不阻塞）：
    // 否则从这建的会话在 DSH 侧栏里会一直落进「未分组」。
    if (this.plugin.connector().info()) this.ensureWorkspace().catch(() => {});

    if (!client.info()) {
      this.setStatus('DSH 连接器未就绪');
      this.pushSystem('没有找到 ~/.dsh-bridge/connector.json：确认 DSH 正在运行，并且 dsh-bridge-connector 已加载。');
      return;
    }

    const previous = this.plugin.settings.chatSessionId || '';
    if (previous) {
      // 复用之前先确认它还活着：DSH 那边会删会话、清理归档，
      // 存着的 id 可能是死的，直接绑定会在第一次发送时才炸（resume failed）。
      const alive = await this.sessionExists(previous);
      if (alive) {
        this.bindSession(previous);
        return;
      }
      this.plugin.settings.chatSessionId = '';
      await this.plugin.saveSettings();
      this.pushSystem(
        `上次的会话已经不存在了（${previous.slice(0, 12)}…）。` +
          '点上面「选择会话」挑一个，或者「新建会话」。'
      );
      this.setStatus('未绑定会话');
      return;
    }
    await this.createAndBind();
  }

  // 会话还在不在？读不到列表时不乱判（返回 true，让真正的发送去报错）
  async sessionExists(sessionId) {
    const res = await this.plugin.connector().sessions();
    if (!res || res.ok !== true) return true;
    const items = (res.data && res.data.sessions) || [];
    return items.some((s) => s && s.sessionId === sessionId);
  }

  bindSession(sessionId) {
    this.sessionId = sessionId;
    this.plugin.settings.chatSessionId = sessionId;
    this.plugin.saveSettings();
    this.messages = [];
    this.render();
    this.setStatus('已连接');
    this.refreshLocalState();
    this.connect();
    this.loadHistory();
  }

  // 拉会话列表 → 弹树（工作区 → 会话），选中就绑定
  async openSessionPicker() {
    const client = this.plugin.connector();
    if (!client.info()) {
      this.pushSystem('连接器未就绪，读不到会话列表。');
      return;
    }
    const res = await client.sessions();
    if (!res || res.ok !== true) {
      this.pushSystem('读会话列表失败：' + ((res && res.error && res.error.message) || '未知原因'));
      return;
    }
    const items = (res.data && res.data.sessions) || [];
    if (!items.length) {
      this.pushSystem('DSH 那边还没有会话。');
      return;
    }
    new SessionTreeModal(this.app, items, this.sessionId, (sessionId) => {
      this.bindSession(sessionId);
      new Notice('已切换会话');
      }, (workspaceId) => {
        this.createAndBind(workspaceId);
      }).open();
  }

  // 确保当前库目录在 DSH 里是一个工作区：没有就注册一个（标题用库名）。
  // 不注册的话，从面板新建的会话在 DSH 侧栏里会落进「未分组」。
  async ensureWorkspace() {
    try {
      const base = this.app.vault.adapter.getBasePath();
      if (!base) return null;
      const client = this.plugin.connector();
      const res = await client.workspaces();
      if (!res || res.ok !== true) return null;
      if (res.data && res.data.available === false) return null;
      const norm = (v) => String(v || '').replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
      const hit = (res.data.workspaces || []).find((w) => norm(w.path) === norm(base));
      if (hit) return hit.workspaceId;
      const created = await client.createWorkspace({ path: base, title: this.app.vault.getName() });
      if (created && created.ok) return created.data.workspaceId;
      return null;
    } catch {
      return null;
    }
  }

  async createAndBind(targetWorkspaceId = null) {
    const client = this.plugin.connector();
    if (!client.info()) {
      this.pushSystem('连接器未就绪，无法新建会话。');
      return;
    }
    const base = this.app.vault.adapter.getBasePath();
    // 指定了工作区就用它；否则落到 Obsidian 自己的工作区（库目录）
    const workspaceId = targetWorkspaceId || (await this.ensureWorkspace());
    // workspaceId 和 cwd 只能二选一（DSH 会直接拒），工作区自带路径
    const created = await client.createSession(
      workspaceId ? { workspaceId } : base ? { cwd: base } : {}
    );
    if (!created || created.ok !== true) {
      this.pushSystem('新建会话失败：' + ((created && created.error && created.error.message) || '未知原因'));
      return;
    }
    this.bindSession(created.data.sessionId);
    new Notice('已新建 Bridge 会话');
  }

  // reload 后把会话里最近的消息读回来：面板自己不存历史，消息都在 DSH 那边
  async loadHistory() {
    if (!this.sessionId) return;
    try {
      const res = await this.plugin.connector().transcript(this.sessionId, 20);
      if (!res || res.ok !== true) return;
      const items = (res.data && res.data.messages) || [];
      if (!items.length) return;
      // 载入期间用户可能已经发过消息，别覆盖掉
      if (this.messages.length > 0) return;
      this.messages = items.map((m) => ({ role: m.role, text: m.text }));
      this.render();
    } catch {
      /* 读历史失败不影响发消息 */
    }
  }

  connect() {
    this.disconnect();
    const client = this.plugin.connector();
    const ac = new AbortController();
    this.ac = ac;
    client
      .subscribe(this.sessionId, (event) => this.onEvent(event), ac.signal)
      .catch((err) => {
        if (ac.signal.aborted) return;
        // DSH 一重启，connector 进程重建，SSE 就断了。以前这里只是把状态改成
        // 「连接断开」然后什么都不做——面板从此收不到任何回复。现在自动重连。
        this.setStatus('连接断开，3 秒后重连…');
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          if (this.ac === ac && !ac.signal.aborted && this.sessionId) {
            this.setStatus('重连中…');
            this.connect();
          }
        }, 3000);
      });
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ac) {
      try {
        this.ac.abort();
      } catch {
        /* ignore */
      }
      this.ac = null;
    }
  }

  onEvent(event) {
    const type = event && event.type;
    if (type === 'turn/start') {
      this.assistantBuffer = '';
      this.setStatus('思考中…');
      return;
    }
    if (type === 'assistant/message') {
      const content = (event.data && event.data.message && event.data.message.content) || [];
      const text = Array.isArray(content)
        ? content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('')
        : '';
      // 按行排队吐出来：一次全出现会让人分不清「刚出来的」和「早就在那儿的」
      if (text) {
        this.assistantBuffer = (this.assistantBuffer || '') + text;
        this._renderAnchor = 'reply';
        this.render();
      }
      return;
    }
    if (type === 'turn/end') {
      // 事件到了就是快路通了，兜底可以退休
      this.stopReplyWatch();
      if (this.assistantBuffer) {
        this.messages.push({ role: 'assistant', text: this.assistantBuffer });
        this.assistantBuffer = '';
        this._renderAnchor = 'reply';
      }
      this.render();
      this.setStatus('就绪');
      this.refreshRecent();
      return;
    }
    if (type === 'tool-call') {
      const name = event.data && (event.data.name || (event.data.toolCall && event.data.toolCall.name));
      if (name) this.setStatus('执行：' + name);
    }
  }

  async send() {
    const text = String((this.inputEl && this.inputEl.value) || '').trim();
    if (!text) return;
    if (!this.sessionId) {
      new Notice('还没有绑定会话');
      return;
    }
    this.inputEl.value = '';
    // 打断模式：语义就是「立刻插进去」，不合并
    if (this.steerMode) {
      await this.deliver([text], true);
      return;
    }
    // 排队模式：先进合并盒，最后一次输入后静默 1.5 秒才真发出去
    this.pending.push(text);
    // 收纳期间也要看得见：攒着不发不等于消失，否则主人以为消息丢了
    this.render();
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      this.flushPending();
    }, this.mergeWindowMs);
    this.setStatus(`待发送（${this.pending.length} 条，停 ${Math.round(this.mergeWindowMs / 1000)} 秒后合并）…`);
  }

  // 把合并盒里的几条拼成一条发出去
  async flushPending() {
    if (!this.pending.length) return;
    const parts = this.pending.slice();
    this.pending = [];
    this.render();
    await this.deliver(parts, false);
  }

  // 真正投递：parts 多于一条时合并成一段（中间空行分隔，保留原样）
  async deliver(parts, isSteer) {
    const text = parts.join('\n');
    this.messages.push({ role: 'user', text });
    // 自己刚发了话，理应跟到底部看回复
    this._stickToBottom = true;
    this.render();
    this.setStatus(isSteer ? '发送中…' : '排队中…');
    const res = await this.plugin.connector().sendTask({
      message: text,
      sessionId: this.sessionId,
      mode: isSteer ? 'steer' : 'queue',
    });
    if (!res || res.ok !== true) {
      this.stopReplyWatch();
      const raw = (res && res.error && res.error.message) || '发送失败';
      this.setStatus('发送失败');
      if (/resume failed|not found/i.test(raw)) {
        this.pushSystem(
          `这个会话已经用不了了：${raw.slice(0, 140)}\n` +
            '点上面「选择会话」换一个，或者「新建会话」。'
        );
      } else {
        this.pushSystem(raw);
      }
      return;
    }
    // 投出去了：状态往前推一格，别一直停在「排队中」——那是在等投递，不是等回复。
    this.setStatus('已发出，等待回复…');
    // 起一条慢路兜底。SSE 断线、事件漏收、或者那一轮压根没产生文本，
    // 面板都会永远停在「思考中…」，看起来就是「agent 没回我」。
    this.startReplyWatch();
  }

  // 投递后的对账：只问会话真相（/sessions 的 running + /transcript 的消息），
  // 不看事件。只要那一轮真的跑完了，回复就能被捞出来补上。
  startReplyWatch() {
    this.stopReplyWatch();
    const startedAt = Date.now();
    this._waitingReply = true;
    this.replyWatchTimer = setInterval(async () => {
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs > 180000) {
        this.stopReplyWatch();
        return;
      }
      let running;
      try {
        const list = await this.plugin.connector().sessions();
        const items = (list && list.data && list.data.sessions) || [];
        const mine = items.find((x) => x && x.sessionId === this.sessionId);
        running = mine ? mine.running : undefined;
      } catch {
        running = undefined;
      }
      if (!shouldReconcile({ running, waiting: this._waitingReply === true, elapsedMs })) return;
      try {
        const t = await this.plugin.connector().transcript(this.sessionId, 6);
        const msgs = (t && t.data && t.data.messages) || [];
        const missing = pickMissingReply(this.messages, msgs);
        if (missing) {
          this.messages.push(missing);
          this.render();
          this.plugin.logEvent('chat', '事件没到，按会话日志补了一条回复');
        }
        this.setStatus('就绪');
        this.stopReplyWatch();
      } catch {
        /* 下一拍再试 */
      }
    }, 3000);
    this.register(() => this.stopReplyWatch());
  }

  stopReplyWatch() {
    if (this.replyWatchTimer) {
      clearInterval(this.replyWatchTimer);
      this.replyWatchTimer = null;
    }
    this._waitingReply = false;
  }

  openInjectionPanel() {
    new InjectionPanelModal(this.app, this.plugin, this).open();
  }

  // ── 注入 ─────────────────────────────────────────────────
  pickNote() {
    if (!this.plugin.settings.injectionEnabled) {
      this.pushSystem('注入已关闭。到 设置 → 社区插件 → Bridge 里打开「启用注入」。');
      return;
    }
    new NoteTreePickerModal(this.app, (file) => {
      this.injectFile(file);
    }).open();
  }

  async injectCurrentNote() {
    if (!this.plugin.settings.injectionEnabled) {
      this.pushSystem('注入已关闭。到 设置 → 社区插件 → Bridge 里打开「启用注入」。');
      return;
    }
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      this.pushSystem('当前没有打开的笔记。');
      return;
    }
    const activeView = this.app.workspace.activeLeaf && this.app.workspace.activeLeaf.view;
    const editor = activeView && activeView.editor;
    const selection = editor && typeof editor.getSelection === 'function' ? editor.getSelection() : '';
    await this.injectFile(file, selection);
  }

  async injectFile(file, selection = '') {
    if (!this.sessionId) {
      this.pushSystem('还没有绑定会话。');
      return;
    }
    try {
      // 只送路径，不送正文：连接器每轮自己去读磁盘，笔记改了注入就跟着变。
      // 未保存的改动本来就不该被注入——读到的是磁盘上的那一份。
      const base = this.app.vault.adapter.getBasePath();
      const absPath = base ? String(base).replace(/[\\/]+$/, '') + '/' + file.path : null;
      const res = await this.plugin.connector().inject({
        sessionId: this.sessionId,
        path: file.path,
        absPath,
        content: selection || '',
        title: file.path,
        kind: 'note',
      });
      if (res && res.ok) {
        const extra = selection ? `（另附选中 ${selection.length} 字）` : '';
        this.pushSystem(`已注入《${file.path}》${extra}——实时跟随磁盘内容，笔记改了下一轮就跟着变。`);
        this.refreshRemoteState();
      } else {
        this.pushSystem('注入失败：' + ((res && res.error && res.error.message) || '未知原因'));
      }
    } catch (err) {
      this.pushSystem('注入失败：' + String((err && err.message) || err));
    }
  }

  pushSystem(text) {
    this.messages.push({ role: 'system', text });
    this.render();
  }

  // Obsidian 自带渲染器；失败就退回纯文本，不能让一条消息把面板弄崩。
  renderMarkdown(el, text) {
    try {
      MarkdownRenderer.render(this.app, String(text || ''), el, '', this);
    } catch {
      el.setText(String(text || ''));
    }
  }

  // 是否已经贴在最底下（往上翻看历史时不该被拽回来）
  isAtBottom() {
    const el = this.listEl;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  scrollToBottom() {
    const el = this.listEl;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  // 元素相对列表内容的位置和高度。用 rect 差值算，不受 offsetParent 影响。
  rectInList(node) {
    const el = this.listEl;
    if (!el || !node) return null;
    const nr = node.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    return { top: nr.top - er.top + el.scrollTop, height: nr.height };
  }

  // 一行有多高：优先用计算样式；拿到 "normal" 就按字号估。
  lineHeightOf(node) {
    try {
      const cs = window.getComputedStyle(node);
      const lh = parseFloat(cs.lineHeight);
      if (Number.isFinite(lh) && lh > 0) return lh;
      const fs = parseFloat(cs.fontSize);
      if (Number.isFinite(fs) && fs > 0) return fs * 1.6;
    } catch {
      /* 拿不到就算了，锚点会退回气泡底部 */
    }
    return null;
  }

  // 让最后一条 AI 回复紧贴着我说的那句话出现：
  // 短消息从它顶部看起，长消息只留最后两行——回复的开头始终紧接在下面。
  // 具体算法见 scroll-anchor.js。
  scrollToReplyAnchor() {
    const el = this.listEl;
    if (!el) return;
    const kids = Array.from(el.children || []);
    let assistantTop = null;
    let userNode = null;
    let seenReply = false;
    for (let i = kids.length - 1; i >= 0; i -= 1) {
      const node = kids[i];
      if (!node.classList) continue;
      if (!seenReply) {
        if (node.classList.contains('bridge-msg-assistant')) {
          assistantTop = this.rectInList(node)?.top ?? null;
          seenReply = true;
        }
        continue;
      }
      // 回复上面最近的那句我说的话（待发气泡在回复后面，不会走到这里）
      if (node.classList.contains('bridge-msg-user')) {
        userNode = node;
        break;
      }
    }
    const userRect = userNode ? this.rectInList(userNode) : null;
    const target = pickReplyAnchor({
      userTop: userRect ? userRect.top : null,
      userHeight: userRect ? userRect.height : null,
      assistantTop,
      viewHeight: el.clientHeight,
      lineHeight: userNode ? this.lineHeightOf(userNode) : null,
    });
    // 没有可对齐的回复（比如刚打开会话）：还是滚到底
    if (target === null) {
      this.scrollToBottom();
      return;
    }
    el.scrollTop = Math.max(0, target);
  }

  updateJumpButton() {
    if (!this.jumpEl) return;
    // 在工具条里，不靠隐藏来腾位置——那样按钮会跳来跳去；
    // 改成「不可用」：位置固定，只是变灰
    const away = !this.isAtBottom();
    this.jumpEl.toggleClass('is-disabled', !away);
    this.jumpEl.title = away ? '回到最底下' : '已经在最底下了';
  }

  render() {
    if (!this.listEl) return;
    // 渲染前先记住有没有贴在底部：新消息进来时，
    // 正在往上翻的人不该被拽到底下，什么也没看清
    const stick = this._stickToBottom !== false;
    const keepTop = this.listEl.scrollTop;
    this.listEl.empty();
    for (const msg of this.messages) {
      const el = this.listEl.createDiv({ cls: `bridge-msg bridge-msg-${msg.role}` });
      // 助手回复按 Markdown 渲染（代码块、列表、粗体），用户自己的话保持纯文本
      if (msg.role === 'assistant') this.renderMarkdown(el, msg.text);
      else el.setText(msg.text);
    }
    if (this.assistantBuffer) {
      const el = this.listEl.createDiv({ cls: 'bridge-msg bridge-msg-assistant bridge-msg-streaming' });
      this.renderMarkdown(el, this.assistantBuffer);
    }
    // 合并盒里还攒着的：按顺序摆出来，标成「待发」，
    // 让主人知道这几句还没出去、还会合并成一条
    if (this.pending.length) {
      for (const text of this.pending) {
        const el = this.listEl.createDiv({ cls: 'bridge-msg bridge-msg-user bridge-msg-pending' });
        el.setText(text);
      }
    }
    if (stick) {
      // 刚发完自己的话就是要看自己的话（bottom）；
      // AI 回复进来则停在回复开头（reply），不让长回复把人带到底下。
      if (this._renderAnchor === 'reply') this.scrollToReplyAnchor();
      else this.scrollToBottom();
    } else {
      this.listEl.scrollTop = keepTop;
    }
    this._renderAnchor = 'bottom';
    this.updateJumpButton();
  }
}

class InjectionPanelModal extends Modal {
  constructor(app, plugin, view) {
    super(app);
    this.plugin = plugin;
    this.view = view;
  }

  onOpen() {
    this.modalEl.addClass('bridge-inject-modal');
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  render() {
    const c = this.contentEl;
    c.empty();
    c.createEl('h3', { text: '注入' });
    c.createEl('p', {
      text: '把笔记内容送进 DSH 的系统提示词段（不进对话历史）。开关与 DSH 连接器双向同步。',
      cls: 'setting-item-description',
    });
    this.statusEl = c.createDiv({ cls: 'bridge-line', text: '读取中…' });
    this.injectedEl = c.createDiv({ cls: 'bridge-injected-list', text: '已注入：—' });

    new Setting(c)
      .setName('启用注入')
      .setDesc('关闭时不注册上下文段，DSH 不会看到任何注入内容')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.injectionEnabled).onChange(async (v) => {
          this.plugin.settings.injectionEnabled = v;
          await this.plugin.saveSettings();
          const res = await this.plugin.connector().setInjection(v);
          new Notice(res && res.ok ? (v ? '注入已开启（已同步）' : '注入已关闭（已同步）') : '本地已切换；连接器未同步');
          this.refreshStatus();
        }),
      );

    new Setting(c)
      .addButton((b) =>
        b.setButtonText('注入当前笔记').setCta().onClick(async () => {
          await this.view.injectCurrentNote();
          this.refreshStatus();
        }),
      )
      .addButton((b) =>
        b.setButtonText('选择笔记…').onClick(() => {
          new NoteTreePickerModal(this.app, async (file) => {
            await this.view.injectFile(file);
            this.refreshStatus();
          }).open();
        }),
      )
      .addButton((b) =>
        b.setButtonText('清除注入').onClick(async () => {
          const res = await this.plugin.connector().clearInjection();
          new Notice(res && res.ok ? '已清除注入' : '清除失败');
          this.refreshStatus();
        }),
      );

    this.syncOnce();
    this.refreshStatus();
  }

  syncOnce() {
    // 连接器是唯一真相源：面板只读它、把本地缓存对齐过去。
    // 以前这里是反方向（本地 → 连接器），结果设置页和面板谁后开谁赢，
    // 会静默改掉主人刚设的开关。
    if (this._synced) return;
    this._synced = true;
    const client = this.plugin.connector();
    if (!client.info()) return;
    client
      .config()
      .then(async (res) => {
        if (!res || res.ok !== true) return;
        const state = reconcileInjection({
          remote: res.data && res.data.injection,
          local: this.plugin.settings.injectionEnabled,
        });
        if (state.changed) {
          this.plugin.settings.injectionEnabled = state.value;
          await this.plugin.saveSettings();
        }
        this.refreshStatus();
      })
      .catch(() => {});
  }

  refreshStatus() {
    const client = this.plugin.connector();
    if (!client.info()) {
      if (this.statusEl) this.statusEl.setText('连接器：离线');
      return;
    }
    client
      .injectStatus()
      .then((res) => {
        if (!this.statusEl) return;
        if (!res || res.ok !== true) {
          this.statusEl.setText('读不到注入状态');
          return;
        }
        const on = res.data.injection === true;
        const cur = res.data.current;
        this.statusEl.setText(`连接器：${on ? '开' : '关'}`);
        const items = Array.isArray(cur) ? cur : cur ? [cur] : [];
        if (this.injectedEl) {
          this.injectedEl.empty();
          if (items.length === 0) {
            this.injectedEl.setText('已注入：无');
          } else {
            this.injectedEl.createDiv({ cls: 'bridge-line', text: `已注入 ${items.length} 篇：` });
            for (const item of items) {
              const row = this.injectedEl.createDiv({ cls: 'bridge-injected-item' });
              row.createSpan({
                cls: 'bridge-injected-name',
                text: `《${item.title || '（无标题）'}》 · ${item.length} 字`,
              });
              const x = row.createEl('button', {
                cls: 'bridge-injected-x',
                text: '×',
                attr: { 'aria-label': '移除这篇', title: '移除这篇' },
              });
              x.onClickEvent(async () => {
                await this.plugin.connector().clearInjection(item.id);
                this.refreshStatus();
              });
            }
            const clearAll = this.injectedEl.createEl('button', {
              cls: 'bridge-injected-clearall',
              text: '全部清除',
            });
            clearAll.onClickEvent(async () => {
              const res = await this.plugin.connector().clearInjection();
              new Notice(res && res.ok ? '已清除全部注入' : '清除失败');
              this.refreshStatus();
            });
          }
        }
      })
      .catch(() => {
        if (this.statusEl) this.statusEl.setText('读不到注入状态');
      });
  }
}

class NoteTreePickerModal extends Modal {
  constructor(app, onPick) {
    super(app);
    this.onPick = onPick;
    this.expanded = new Set();
    this.selectedPath = null;
  }

  onOpen() {
    this.modalEl.addClass('bridge-tree-modal');
    const active = this.app.workspace.getActiveFile();
    if (active) {
      this.selectedPath = active.path;
      let parent = active.parent;
      while (parent) {
        if (parent.path && parent.path !== '/') this.expanded.add(parent.path);
        parent = parent.parent;
      }
    }
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  render() {
    const c = this.contentEl;
    c.empty();
    c.createEl('h3', { text: '选择要注入的笔记' });
    const hint = c.createDiv({ cls: 'setting-item-description', text: '文件夹可展开/收起；点笔记即注入。' });
    this.treeEl = c.createDiv({ cls: 'bridge-tree' });
    const root = this.app.vault.getRoot();
    this.renderFolder(root, this.treeEl, 0);
  }

  sortedChildren(folder) {
    const items = Array.isArray(folder.children) ? [...folder.children] : [];
    return items.sort((a, b) => {
      const af = a instanceof TFolder ? 0 : 1;
      const bf = b instanceof TFolder ? 0 : 1;
      if (af !== bf) return af - bf;
      return String(a.name).localeCompare(String(b.name), 'zh');
    });
  }

  renderFolder(folder, parentEl, depth) {
    for (const child of this.sortedChildren(folder)) {
      if (child instanceof TFolder) {
        const open = this.expanded.has(child.path);
        const row = parentEl.createDiv({ cls: 'bridge-tree-row bridge-tree-folder' });
        row.style.paddingLeft = depth * 14 + 'px';
        row.createSpan({ cls: 'bridge-tree-arrow', text: open ? '▾' : '▸' });
        row.createSpan({ cls: 'bridge-tree-name', text: child.name });
        row.onClickEvent(() => {
          if (open) this.expanded.delete(child.path);
          else this.expanded.add(child.path);
          this.render();
        });
        if (open) this.renderFolder(child, parentEl, depth + 1);
        continue;
      }
      if (String(child.extension || '').toLowerCase() !== 'md') continue;
      const selected = child.path === this.selectedPath;
      const row = parentEl.createDiv({
        cls: 'bridge-tree-row bridge-tree-file' + (selected ? ' is-selected' : ''),
      });
      row.style.paddingLeft = depth * 14 + 16 + 'px';
      row.createSpan({ cls: 'bridge-tree-name', text: child.basename || child.name });
      row.onClickEvent(() => {
        this.close();
        try {
          this.onPick(child);
        } catch {
          /* 回调异常不外抛 */
        }
      });
    }
  }
}

// ── 会话选择树（工作区 → 会话）────────────────────────────

function tailPath(p, n = 1) {
  const parts = String(p || '').replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean);
  return parts.slice(-n).join('\\') || '(无工作区)';
}

// 会话名优先用 DSH 的标题；没有就降级成「目录 · 时间 · 短 id」——总比一串 uuid 强。
function sessionLabel(s) {
  if (s && s.title) return s.title;
  const when = s && s.updatedAt ? new Date(s.updatedAt) : null;
  const stamp = when && !Number.isNaN(when.getTime())
    ? `${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')} ` +
      `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
    : '';
  return [tailPath(s && s.cwd, 1), stamp, String((s && s.sessionId) || '').slice(-6)].filter(Boolean).join(' · ');
}

class SessionTreeModal extends Modal {
  constructor(app, sessions, currentId, onPick, onNew) {
    super(app);
    this.sessions = sessions || [];
    this.currentId = currentId || null;
    this.onPick = onPick;
    this.onNew = onNew || (() => {});
    this.expanded = new Set();
  }

  onOpen() {
    this.modalEl.addClass('bridge-tree-modal');
    // 默认全部收起：某个工作区可能有几十个会话，一展开就把其他工作区
    // 全挤到滚动区下面，看起来像「只有几个工作区」。要点哪个再展开哪个。
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  render() {
    const c = this.contentEl;
    c.empty();
    c.createEl('h3', { text: '选择 DSH 会话' });
    // 分组依据是 DSH 的工作区注册表（不是会话的 cwd）：
    // 按 cwd 分会多出 DSH 界面里根本没有的「工作区」，两边对不上。
    // 归档会话在 DSH 里也不显示，这里一并过滤。
    const visible = this.sessions.filter((s) => !s.archived);
    const groups = new Map();
    for (const s of visible) {
      // workspaceTitle 是新连接器给的字段；旧连接器没有这个字段时
      // 退回按 cwd 分组，免得升级顺序不同就全落进「未分组」。
      const key =
        s.workspaceTitle ||
        (s.workspaceTitle === undefined ? tailPath(s.cwd, 2) : '(未分组)');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    const archivedCount = this.sessions.length - visible.length;
    c.createDiv({
      cls: 'setting-item-description',
      text:
        `共 ${groups.size} 个工作区 · ${visible.length} 个会话` +
        (archivedCount ? `（已隐藏 ${archivedCount} 个归档）` : '') +
        '。点工作区展开，点会话切换。',
    });
    const latestOf = (list) => Math.max(0, ...list.map((x) => Date.parse(x.updatedAt) || 0));
    const ordered = [...groups.entries()].sort((a, b) => latestOf(b[1]) - latestOf(a[1]));

    const tree = c.createDiv({ cls: 'bridge-tree' });
    for (const [cwd, list] of ordered) {
      const rows = [...list].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
      const open = this.expanded.has(cwd);
      const head = tree.createDiv({ cls: 'bridge-tree-row bridge-tree-folder' });
      head.createSpan({ cls: 'bridge-tree-arrow', text: open ? '▾' : '▸' });
      const hasCurrent = rows.some((s) => s.sessionId === this.currentId);
      head.createSpan({ cls: 'bridge-tree-name', text: `${cwd}（${rows.length}）${hasCurrent ? ' · 当前' : ''}` });
      head.onClickEvent(() => {
        if (this.expanded.has(cwd)) this.expanded.delete(cwd);
        else this.expanded.add(cwd);
        this.render();
      });
      if (!open) continue;
      // 这个工作区下也可以直接新建（不用回面板点「新建会话」）
      const wsId = rows.find((x) => x.workspaceId)?.workspaceId || null;
      const addRow = tree.createDiv({ cls: 'bridge-tree-row bridge-tree-new' });
      addRow.style.paddingLeft = '20px';
      addRow.createSpan({ cls: 'bridge-tree-name', text: '＋ 在此工作区新建会话' });
      addRow.onClickEvent(() => {
        this.close();
        try { this.onNew(wsId); } catch { /* ignore */ }
      });
      for (const s of rows) {
        const active = s.sessionId === this.currentId;
        const row = tree.createDiv({
          cls: 'bridge-tree-row bridge-tree-file' + (active ? ' is-selected' : ''),
        });
        row.style.paddingLeft = '16px';
        row.createSpan({ cls: 'bridge-tree-name', text: (active ? '● ' : '') + sessionLabel(s) });
        row.onClickEvent(() => {
          this.close();
          try {
            this.onPick(s.sessionId);
          } catch {
            /* 回调异常不外抛 */
          }
        });
      }
    }
  }
}

module.exports = { BridgeChatView, VIEW_TYPE, NoteTreePickerModal, InjectionPanelModal, SessionTreeModal };
});
__define('lib/connector-client.js', function (module, exports, require) {
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
});
__define('lib/driver.js', function (module, exports, require) {
'use strict';
// Bridge · 驱动（对外的唯一调用面）
// list() 给操作目录；call() 执行一个操作。权限/账本/HTTP 都套在它外面。

const { createRegistry } = __req('lib/registry.js');
const { createAiCursor } = __req('lib/ai-cursor.js');

function createDriver(deps = {}) {
  // AI 光标是 driver 自带的状态：调用方不传就自己建一个，
  // 这样每个 driver 都有独立的 AI 光标，测试和运行时行为一致。
  const registry = createRegistry({ ...deps, aiCursor: deps.aiCursor || createAiCursor() });
  return {
    list() {
      return { ops: registry.list() };
    },
    call(opId, args) {
      return registry.call(opId, args);
    },
  };
}

module.exports = { createDriver };

});
__define('lib/info.js', function (module, exports, require) {
'use strict';
// Bridge · 服务信息文件
// 插件启动时把「端口 / token / pid / 库名」写到 ~/.obsidian-bridge/info.json，
// MCP 桥按这个文件找人，不硬编码端口。

const fs = require('node:fs');
const path = require('node:path');

function createInfoStore({ dir }) {
  const file = path.join(dir, 'info.json');
  return {
    dir,
    file,
    write(data) {
      fs.mkdirSync(dir, { recursive: true });
      const payload = { ...data, updatedAt: new Date().toISOString() };
      fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
      return payload;
    },
    read() {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return null;
      }
    },
    clear() {
      try {
        fs.unlinkSync(file);
      } catch {
        /* 不存在就算了 */
      }
    },
  };
}

module.exports = { createInfoStore };
});
__define('lib/ledger-reader.js', function (module, exports, require) {
'use strict';
// Bridge · 账本读取（日志界面用）
// 账本是 JSONL：一行一次调用。这里只做解析/统计/过滤，不碰文件系统。

function computeStats(entries) {
  let ok = 0;
  let failed = 0;
  let totalMs = 0;
  const byOp = {};
  for (const e of entries) {
    if (e.ok === false) failed += 1;
    else ok += 1;
    if (typeof e.ms === 'number' && Number.isFinite(e.ms)) totalMs += e.ms;
    if (e.op) byOp[e.op] = (byOp[e.op] || 0) + 1;
  }
  const total = entries.length;
  return {
    total,
    ok,
    failed,
    avgMs: total > 0 ? Math.round(totalMs / total) : 0,
    byOp,
  };
}

function parseLedger(text, { limit = 500 } = {}) {
  const lines = String(text || '').split(/\r?\n/);
  const entries = [];
  let skipped = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (entry && typeof entry === 'object') entries.push(entry);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  const sliced = limit > 0 && entries.length > limit ? entries.slice(-limit) : entries;
  return { entries: sliced, stats: computeStats(sliced), skipped };
}

function filterEntries(entries, { onlyFailed = false, query = '' } = {}) {
  const q = String(query || '').trim().toLowerCase();
  return entries.filter((entry) => {
    if (onlyFailed && entry.ok !== false) return false;
    if (!q) return true;
    const hay = [entry.op, entry.client, entry.args, entry.error].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });
}

module.exports = { parseLedger, filterEntries, computeStats };
});
__define('lib/ledger.js', function (module, exports, require) {
'use strict';
// Bridge · 审计账本（一行一次调用；旁路原则：账本写失败不阻断主流程）

function createLedger({ sink = null, now = () => new Date() } = {}) {
  function record(entry) {
    const rec = { ts: new Date(now()).toISOString(), ...entry };
    if (typeof sink === 'function') {
      try {
        sink(rec);
      } catch {
        /* 旁路：账本异常不影响调用本身 */
      }
    }
    return rec;
  }
  return { record };
}

module.exports = { createLedger };
});
__define('lib/log-view.js', function (module, exports, require) {
'use strict';
// Bridge · 操作记录（弹窗）
// 两个页签：操作账本 / 运行日志。从主面板的「操作记录」按钮打开。

const { Modal } = require('obsidian');
const fs = require('node:fs');
const { parseLedger, filterEntries } = __req('lib/ledger-reader.js');

const LEDGER_LIMIT = 500;

function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

class BridgeLogModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.tab = 'ledger';
    this.query = '';
    this.onlyFailed = false;
  }

  onOpen() {
    this.modalEl.addClass('bridge-log-modal');
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  render() {
    const root = this.contentEl;
    root.empty();
    root.addClass('bridge-log');

    const bar = root.createDiv({ cls: 'bridge-log-bar' });
    const ledgerTab = bar.createEl('button', { text: '操作账本', cls: 'bridge-log-tab' });
    ledgerTab.onClickEvent(() => {
      this.tab = 'ledger';
      this.render();
    });
    const runtimeTab = bar.createEl('button', { text: '运行日志', cls: 'bridge-log-tab' });
    runtimeTab.onClickEvent(() => {
      this.tab = 'runtime';
      this.render();
    });
    ledgerTab.toggleClass('is-active', this.tab === 'ledger');
    runtimeTab.toggleClass('is-active', this.tab === 'runtime');

    bar.createSpan({ cls: 'bridge-log-spacer' });
    const refreshBtn = bar.createEl('button', { text: '刷新', cls: 'bridge-log-small' });
    refreshBtn.onClickEvent(() => this.render());

    if (this.tab === 'ledger') {
      const tools = root.createDiv({ cls: 'bridge-log-tools' });
      this.statsEl = tools.createSpan({ cls: 'bridge-log-stats', text: '' });
      this.searchEl = tools.createEl('input', {
        cls: 'bridge-log-search',
        attr: { placeholder: '搜操作 / 客户端 / 参数…', value: this.query },
      });
      this.searchEl.addEventListener('input', () => {
        this.query = this.searchEl.value;
        this.renderLedger();
      });
      const failBtn = tools.createEl('button', { text: this.onlyFailed ? '只看失败：开' : '只看失败：关', cls: 'bridge-log-small' });
      failBtn.onClickEvent(() => {
        this.onlyFailed = !this.onlyFailed;
        this.render();
      });
      this.listEl = root.createDiv({ cls: 'bridge-log-list' });
      this.renderLedger();
    } else {
      const tools = root.createDiv({ cls: 'bridge-log-tools' });
      this.statsEl = tools.createSpan({ cls: 'bridge-log-stats', text: '运行日志' });
      const clearBtn = tools.createEl('button', { text: '清空', cls: 'bridge-log-small' });
      clearBtn.onClickEvent(() => {
        try {
          fs.writeFileSync(this.plugin.logPath(), '', 'utf8');
          this.render();
        } catch (err) {
          this.statsEl.setText('清空失败：' + String((err && err.message) || err));
        }
      });
      this.listEl = root.createDiv({ cls: 'bridge-log-runtime' });
      this.renderRuntime();
    }
  }

  renderLedger() {
    if (!this.listEl) return;
    let text = '';
    try {
      text = fs.readFileSync(this.plugin.ledgerPath(), 'utf8');
    } catch {
      text = '';
    }
    const parsed = parseLedger(text, { limit: LEDGER_LIMIT });
    const entries = filterEntries(parsed.entries, { onlyFailed: this.onlyFailed, query: this.query });
    const s = parsed.stats;
    if (this.statsEl) {
      this.statsEl.setText(
        `共 ${s.total} 条 · 成功 ${s.ok} · 失败 ${s.failed} · 平均 ${s.avgMs}ms` +
          (parsed.skipped ? ` · 坏行 ${parsed.skipped}` : '') +
          (entries.length !== parsed.entries.length ? ` · 筛出 ${entries.length}` : ''),
      );
    }

    this.listEl.empty();
    if (entries.length === 0) {
      this.listEl.createDiv({ cls: 'bridge-log-empty', text: '还没有记录。' });
      return;
    }
    for (const entry of [...entries].reverse()) {
      const row = this.listEl.createDiv({ cls: `bridge-log-row ${entry.ok === false ? 'is-failed' : ''}` });
      row.createSpan({ cls: 'bridge-log-time', text: formatTime(entry.ts) });
      row.createSpan({ cls: 'bridge-log-client', text: entry.client || '—' });
      row.createSpan({ cls: 'bridge-log-op', text: entry.op || '—' });
      row.createSpan({ cls: 'bridge-log-tier', text: entry.tier || '—' });
      row.createSpan({ cls: 'bridge-log-result', text: entry.ok === false ? '失败' : '成功' });
      row.createSpan({ cls: 'bridge-log-ms', text: typeof entry.ms === 'number' ? `${entry.ms}ms` : '—' });
      if (entry.args) row.createSpan({ cls: 'bridge-log-args', text: String(entry.args).slice(0, 160) });
    }
  }

  renderRuntime() {
    if (!this.listEl) return;
    const text = this.plugin.pluginLog ? this.plugin.pluginLog.read(400) : '';
    this.listEl.empty();
    if (!text) {
      this.listEl.createDiv({ cls: 'bridge-log-empty', text: '运行日志为空。' });
      return;
    }
    this.listEl.createEl('pre', { cls: 'bridge-log-pre', text });
  }
}

module.exports = { BridgeLogModal };
});
__define('lib/mark-decoration.js', function (module, exports, require) {
'use strict';
// Bridge · 标记的视觉层（CodeMirror 6 装饰）
//
// 为什么不改文件：标记表示「我现在想让你看这段」，是临时指示，不是笔记内容。
// 写进正文会污染原文、还会被同步出去，而且撤销起来很烦。
// 所以用 decoration —— 只在屏幕上画，文档一个字节都不动。
//
// 两种形态对应两种画法：
//   点标记   → 字缝之间插一个工字形（宽度 0，不挤开任何字）
//   范围标记 → 两端各一个工字形 + 中间文字底色（边界一眼可见）
//
// 为什么用工字 widget 而不是整行色条：整行会把人「在看哪一行」和
// 「在看行里哪一处」混为一谈；工字形落在字缝里，指哪打哪，也不遮文字。
//
// 注意：@codemirror/* 由 Obsidian 宿主提供，但不是在每个版本都保证暴露。
// 所以这里延迟 require，且失败只让「看得见」降级，不许拖垮整个插件——
// 标记本身（记位置、播报给模型）不依赖它。

let cmCache = null;

function loadCm() {
  if (cmCache) return cmCache;
  const view = require('@codemirror/view');
  const state = require('@codemirror/state');
  if (!view || !view.Decoration || !view.ViewPlugin || !state || !state.RangeSetBuilder) {
    throw new Error('宿主没有暴露 CodeMirror 的 Decoration/ViewPlugin/RangeSetBuilder');
  }
  cmCache = {
    Decoration: view.Decoration,
    ViewPlugin: view.ViewPlugin,
    WidgetType: view.WidgetType,
    RangeSetBuilder: state.RangeSetBuilder,
  };
  return cmCache;
}

/** {line,ch} → 文档偏移；行号越界就夹到边界，ch 越界夹到行尾 */
function offsetOf(doc, pos) {
  const lineNo = Math.min(Math.max(1, Number(pos.line || 0) + 1), doc.lines);
  const line = doc.line(lineNo);
  return Math.min(line.from + Math.max(0, Number(pos.ch || 0)), line.to);
}

/**
 * @param {{getMarks:()=>Array, getPath:()=>string}} deps
 * getMarks 返回 [{path, marks:[{line,ch}, …]}]，getPath 返回当前编辑器对应的文件路径
 */
function createMarkExtension({ getMarks, getPath }) {
  const { Decoration, ViewPlugin, RangeSetBuilder, WidgetType } = loadCm();
  const rangeDeco = Decoration.mark({ class: 'bridge-mark-range' });

  // 工字形光标：一个 0 宽度的行内元素，用伪元素画成上下横 + 中间竖
  class BeamWidget extends WidgetType {
    constructor(kind) {
      super();
      this.kind = kind; // 'point' | 'from' | 'to'
    }

    eq(other) {
      return other && other.kind === this.kind;
    }

    toDOM() {
      const el = document.createElement('span');
      el.className = 'bridge-mark-beam bridge-mark-beam-' + this.kind;
      el.setAttribute('aria-hidden', 'true');
      return el;
    }

    // 别抢鼠标：点它应该落到文字上，不是落到标记上
    ignoreEvent() {
      return true;
    }
  }

  const beamPoint = Decoration.widget({ widget: new BeamWidget('point'), side: 1 });
  const beamFrom = Decoration.widget({ widget: new BeamWidget('from'), side: 1 });
  const beamTo = Decoration.widget({ widget: new BeamWidget('to'), side: -1 });

  const plugin = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = this.build(view);
      }

      update(update) {
        // 每次事务都重算：标记是外部状态，CM 不知道它变了，
        // 所以外部改完标记会 dispatch 一个空事务把这里叫醒。
        this.decorations = this.build(update.view);
      }

      build(view) {
        let list = [];
        try {
          list = getMarks() || [];
        } catch {
          list = [];
        }
        const path = typeof getPath === 'function' ? getPath() : '';
        const mine = list.filter((m) => m && m.path === path && Array.isArray(m.marks) && m.marks.length);

        const items = [];
        for (const entry of mine) {
          const pts = entry.marks.slice(0, 2);
          if (pts.length === 1) {
            const at = offsetOf(view.state.doc, pts[0]);
            items.push({ from: at, to: at, deco: beamPoint, order: 0 });
          } else {
            const a = offsetOf(view.state.doc, pts[0]);
            const b = offsetOf(view.state.doc, pts[1]);
            const from = Math.min(a, b);
            const to = Math.max(a, b);
            // 同一位置不能既插 widget 又标 mark，所以空范围只画一个
            if (from === to) {
              items.push({ from, to, deco: beamPoint, order: 0 });
            } else {
              items.push({ from, to: from, deco: beamFrom, order: 0 });
              items.push({ from, to, deco: rangeDeco, order: 1 });
              items.push({ from: to, to, deco: beamTo, order: 2 });
            }
          }
        }
        // RangeSetBuilder 要求 from 递增；同位置时按 order 排（line 在 mark 之前）
        items.sort((x, y) => x.from - y.from || x.order - y.order);

        const builder = new RangeSetBuilder();
        for (const it of items) builder.add(it.from, it.to, it.deco);
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );
  return [plugin];
}

/** 标记变了之后把可见编辑器叫醒重画。没有可画的就直接跳过。 */
function refreshAllMarkViews(views) {
  for (const v of views || []) {
    try {
      if (v && typeof v.dispatch === 'function') v.dispatch({});
    } catch {
      /* 编辑器可能已经销毁 */
    }
  }
}

module.exports = { createMarkExtension, refreshAllMarkViews, offsetOf };

});
__define('lib/mark-store.js', function (module, exports, require) {
'use strict';
// Bridge · 临时标记
//
// 只有一种标记，靠按几次分形态：
//   第 1 次 → 一个点（我在这）
//   第 2 次 → 从第一个点到第二个点的范围（这段）
//   第 3 次 → 清空，重新开始
// 这样只要一个快捷键就够，不用记「打点」和「清空」是两个键。
//
// 标记只在内存里：它表示「此刻我想让你看这里」，不是笔记内容，
// 不该写进文件，也不该关了 Obsidian 还留着假装有效。

/** 位置比较：先比行，再比列。 */
function comparePos(a, b) {
  if (!a || !b) return 0;
  if (a.line !== b.line) return a.line - b.line;
  return (a.ch || 0) - (b.ch || 0);
}

const samePos = (a, b) => Boolean(a && b && a.line === b.line && (a.ch || 0) === (b.ch || 0));

/**
 * 按下标记键之后标记变成什么样。
 * @param {Array} current 当前标记（[] / [点] / [from,to]）
 * @param {{line:number,ch:number}} position 光标位置
 * @returns {{marks:Array, mode:'empty'|'point'|'range'}}
 */
function nextMarkState(current, position) {
  const list = Array.isArray(current) ? current.filter((p) => p && Number.isFinite(p.line)) : [];
  if (!position || !Number.isFinite(position.line)) return { marks: list, mode: modeOf(list) };

  if (list.length === 0) return { marks: [position], mode: 'point' };

  if (list.length === 1) {
    // 同一个位置点两次：当成「我改主意了」，直接撤掉
    if (samePos(list[0], position)) return { marks: [], mode: 'empty' };
    const [from, to] = comparePos(list[0], position) <= 0 ? [list[0], position] : [position, list[0]];
    return { marks: [from, to], mode: 'range' };
  }

  // 已经是范围：再按就是清空
  return { marks: [], mode: 'empty' };
}

function modeOf(marks) {
  const list = Array.isArray(marks) ? marks : [];
  if (list.length === 0) return 'empty';
  return list.length >= 2 ? 'range' : 'point';
}

/** 给人看的一句话：标记在哪。没有标记时返回空串。 */
function describeMarks(marks) {
  const list = Array.isArray(marks) ? marks : [];
  if (!list.length) return '';
  if (list.length === 1) return '标记在第 ' + (list[0].line + 1) + ' 行第 ' + ((list[0].ch || 0) + 1) + ' 列';
  const a = list[0];
  const b = list[1];
  const head = '标记范围第 ' + (a.line + 1);
  const tail = (b.line + 1) + ' 行';
  return head + (a.line === b.line ? ' 行' : ' → ' + tail);
}

/** 标记还在不在这篇里（换了文件就当没有）。 */
function marksForPath(all, path) {
  if (!Array.isArray(all)) return [];
  const hit = all.find((m) => m && m.path === path);
  return hit && Array.isArray(hit.marks) ? hit.marks : [];
}

module.exports = { nextMarkState, describeMarks, marksForPath, comparePos, modeOf };

});
__define('lib/permissions.js', function (module, exports, require) {
'use strict';
// Bridge · 权限（三档，按客户端记档）
// 规则：read < write < trust，累积释放；模块默认 read（安全兜底），插件运行时按设置传 write。

const LEVELS = ['read', 'write', 'trust'];
const ORDER = { read: 0, write: 1, trust: 2 };
const LEVEL_LABEL = { read: '只读', write: '可写', trust: '相信' };

function createPermissions({ state = {}, defaultLevel = 'read', onSave = null } = {}) {
  const seed = state && typeof state === 'object' ? state : {};
  const clients = { ...(seed.clients || {}) };
  let fallback = ORDER[defaultLevel] !== undefined ? defaultLevel : 'read';

  function levelOf(client) {
    const rec = clients[client];
    return rec && ORDER[rec.level] !== undefined ? rec.level : fallback;
  }

  function snapshot() {
    return { version: 1, defaultLevel: fallback, clients: { ...clients } };
  }

  function persist() {
    if (typeof onSave === 'function') onSave(snapshot());
  }

  function assertLevel(level) {
    if (ORDER[level] === undefined) {
      throw new Error(`非法档位：${level}（只认 read / write / trust）`);
    }
    return level;
  }

  return {
    LEVELS,
    LEVEL_LABEL,
    levelOf,
    snapshot,
    can(client, opTier) {
      const need = ORDER[opTier];
      if (need === undefined) return false;
      return ORDER[levelOf(client)] >= need;
    },
    setLevel(client, level) {
      if (!client || typeof client !== 'string') throw new Error('缺少客户端标识');
      assertLevel(level);
      clients[client] = { level, updatedAt: new Date().toISOString() };
      persist();
      return level;
    },
    setDefault(level) {
      fallback = assertLevel(level);
      persist();
      return fallback;
    },
    list() {
      return Object.entries(clients).map(([client, rec]) => ({
        client,
        level: rec.level,
        updatedAt: rec.updatedAt || null,
      }));
    },
  };
}

module.exports = { createPermissions, LEVELS, ORDER, LEVEL_LABEL };
});
__define('lib/plugin-log.js', function (module, exports, require) {
'use strict';
// Bridge · 插件运行日志（不是操作账本）
// 记录启动/停止/重启/异常；带大小上限，超了保留后半，避免无限增长。

const fs = require('node:fs');
const path = require('node:path');

function createPluginLog({ file, maxBytes = 512 * 1024 } = {}) {
  if (!file) throw new Error('createPluginLog 需要 file');

  function ensureDir() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  function write(kind, message) {
    try {
      ensureDir();
      fs.appendFileSync(file, `${new Date().toISOString()} [${kind}] ${message}\n`, 'utf8');
      const size = fs.statSync(file).size;
      if (size > maxBytes) {
        const text = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, text.slice(-Math.floor(maxBytes / 2)), 'utf8');
      }
    } catch {
      /* 日志写失败不影响主流程 */
    }
  }

  function read(maxLines = 300) {
    try {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
      return lines.slice(-maxLines).join('\n');
    } catch {
      return '';
    }
  }

  return { write, read, file };
}

module.exports = { createPluginLog };
});
__define('lib/registry.js', function (module, exports, require) {
'use strict';
// Bridge · 操作注册表
// 每个操作 = 一个入口：id / tier（read|write|trust）/ summary / run(ctx)
// run 只通过注入的 obsidian（真实 app 或 fake）碰 Obsidian，便于脱离 Obsidian 测试。

function opError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function activeEditor(obsidian) {
  const ws = obsidian && obsidian.workspace;
  if (!ws) return null;
  const leaf = ws.activeLeaf;
  const view = leaf && leaf.view;
  if (!view || !view.editor) return null;
  return { view, editor: view.editor, file: view.file || null };
}

// 「屏幕上那一篇」不一定有焦点：在主面板里打字时，焦点在输入框上，
// activeLeaf 就是面板本身，而不是笔记。这时候要找还开着的 Markdown 视图——
// 主人刚从那一篇切过来，它才是他在看的东西，光标是他离开时停的地方。
// 写操作仍然只认 activeEditor：没有焦点就不该替他改。
function screenEditor(obsidian) {
  const ws = obsidian && obsidian.workspace;
  if (!ws) return null;
  const active = activeEditor(obsidian);
  if (active && active.file) return { ...active, focused: true };

  // 走主编辑区的 active leaf，而不是 getLeavesOfType 的末位——
  // 后者把后台标签也算进来，顺序还不是 z 序，可能拿到看不见的那篇。
  const hits = [];
  const walk = (node, depth) => {
    if (!node || depth > 8) return;
    if (typeof node.getActiveLeaf === 'function') {
      const leaf = node.getActiveLeaf();
      const v = leaf && leaf.view;
      if (v && v.editor && v.file) hits.push(v);
    }
    for (const child of node.children || []) walk(child, depth + 1);
  };
  try {
    walk(ws.rootSplit, 0);
  } catch {
    /* 布局在重建 */
  }
  if (hits[0]) return { view: hits[0], editor: hits[0].editor, file: hits[0].file, focused: false };

  // 兜底：至少还有开着的 markdown
  const leaves = typeof ws.getLeavesOfType === 'function' ? ws.getLeavesOfType('markdown') : [];
  for (let i = leaves.length - 1; i >= 0; i -= 1) {
    const v = leaves[i] && leaves[i].view;
    if (v && v.editor && v.file) return { view: v, editor: v.editor, file: v.file, focused: false };
  }
  return null;
}

// 找某篇笔记对应的 CodeMirror EditorView。
//
// 只认「屏幕上最上层那篇」：AI 协同编辑只对主人正在看的那篇生效。
// 改一篇他看不见的东西（藏在别的标签里、或者压根没打开），出了问题他都不知道；
// 那种情况该走文件方式（明着告诉他是文件改动），而不是悄悄改编辑器缓冲。
function viewOfFile(obsidian, filePath) {
  const top = screenEditor(obsidian);
  if (!top || !top.file || !top.file.path) return null;
  if (top.file.path !== filePath) return null;
  const ed = top.view && top.view.editor;
  if (!ed || !ed.cm || typeof ed.cm.dispatch !== 'function') return null;
  return ed.cm;
}

// 行/列 → 文档 offset。
// 越界不再静默夹取：改到文末却不报错，是最容易让人以为「改成功了」的坑。
// 返回 { offset, clipped }，由调用方决定要不要报错。
function offsetOfPos(doc, pos) {
  const line = Math.max(0, Math.floor(Number(pos && pos.line) || 0));
  const ch = Math.max(0, Math.floor(Number(pos && pos.ch) || 0));
  const clipped = line + 1 > doc.lines;
  const n = Math.min(line + 1, doc.lines);
  const l = doc.line(n);
  const offset = Math.min(l.from + ch, l.to);
  return { offset, clipped, actual: { line: n - 1, ch: offset - l.from } };
}

/** 取 offset，越界就报错（不再假装修剪成功）。 */
function requireOffset(doc, pos, label) {
  const r = offsetOfPos(doc, pos);
  if (r.clipped) {
    throw opError(
      'bad-args',
      `${label} 超出了文档范围：这篇只有 ${doc.lines} 行`,
    );
  }
  return r.offset;
}

/** 目标笔记：给了 path 就用它，没给就用「屏幕上那篇」——editor.* 系列原来就是这么默认的。 */
function targetPath(ctx, args) {
  const given = String((args && args.path) || '').trim();
  if (given) return given;
  const view = screenEditor(ctx.obsidian);
  if (view && view.file && view.file.path) return view.file.path;
  throw opError('bad-args', '缺少 path，而且屏幕上没有打开的笔记');
}

/** 拿 AI 自己的光标；driver 没给就当没有（降级成只按坐标改）。 */
function aiCursorOf(ctx) {
  const cur = ctx && ctx.aiCursor;
  if (!cur || typeof cur.forPath !== 'function') {
    throw opError('unsupported', 'AI 光标未初始化（driver 没注入）');
  }
  return cur;
}

/**
 * 把某篇的编辑器缓冲立刻写盘。
 * Obsidian 自己也会存，但有延迟（实测改完到文件同步有几秒）。
 * AI 改完顺手存一下，文件系统那边立刻就能读到新内容，
 * 省得「Obsidian 门」和「文件本体」两种读法打架。
 * 存不进去不报错：说明这篇可能没开，那就等 Obsidian 自己存。
 */
async function saveDoc(obsidian, filePath) {
  try {
    const ws = obsidian && obsidian.workspace;
    if (!ws || typeof ws.getLeavesOfType !== 'function') return false;
    for (const leaf of ws.getLeavesOfType('markdown') || []) {
      const v = leaf && leaf.view;
      if (!v || !v.file || v.file.path !== filePath) continue;
      if (typeof v.save !== 'function') continue;
      await v.save();
      return true;
    }
  } catch {
    /* 存失败就是还没存，不影响这次改动本身 */
  }
  return false;
}

/** 把「AI 正在改这篇」抛给界面（driver 注入的回调）；没有界面就安静跳过。 */
function notifyAiEdit(ctx, phase, filePath) {
  const fn = ctx && ctx.onAiEdit;
  if (typeof fn !== 'function') return;
  try {
    fn(phase, filePath);
  } catch {
    /* 界面出问题不该打断写入 */
  }
}

/** 改文档时打上「AI 自己改的」标记：光标同步器看到就跳过映射，避免双重移动。 */
function dispatchAiEdit(view, changes) {
  let annotations = null;
  try {
    const { getAiEditAnnotation } = __req('lib/ai-cursor-sync.js');
    annotations = getAiEditAnnotation().of(true);
  } catch {
    annotations = null;
  }
  if (!annotations) {
    view.dispatch({ changes });
    return;
  }
  view.dispatch({ changes, annotations });
}

/** 把 AI 光标前进到某个 offset 对应的行列。 */
function syncAiCursor(cur, filePath, doc, offset) {
  const line = doc.lineAt(Math.max(0, Math.min(offset, doc.length)));
  cur.move(filePath, { line: line.number - 1, ch: offset - line.from });
}


const OPS = [
  {
    id: 'core.health',
    tier: 'read',
    summary: 'Bridge 自身健康信息（版本 / 运行时长 / Obsidian 是否在）',
    run(ctx) {
      return {
        service: 'obsidian-bridge',
        version: '0.1.0',
        now: new Date().toISOString(),
        obsidian: Boolean(ctx.obsidian && ctx.obsidian.commands),
        commandCount: ctx.obsidian && ctx.obsidian.commands ? (ctx.obsidian.commands.listCommands() || []).length : 0,
      };
    },
  },
  {
    id: 'obsidian.command.list',
    tier: 'read',
    summary: '列出 Obsidian 命令面板里的全部命令（id / 名称 / 快捷键）',
    run(ctx) {
      const list = ctx.obsidian.commands.listCommands() || [];
      return {
        commands: list.map((c) => ({
          id: c.id,
          name: c.name,
          hotkeys: Array.isArray(c.hotkeys) ? c.hotkeys : [],
        })),
      };
    },
  },
  {
    id: 'obsidian.command.execute',
    tier: 'write',
    summary: '执行命令面板里的任意命令（按 id）；返回是否真的执行了',
    run(ctx) {
      const id = String((ctx.args && ctx.args.id) || '').trim();
      if (!id) throw opError('bad-args', '缺少参数 id');
      const commands = ctx.obsidian.commands;
      let found = null;
      if (typeof commands.findCommand === 'function') {
        found = commands.findCommand(id);
        if (!found) return { executed: false, reason: 'command-not-found', id };
      }
      const executed = commands.executeCommandById(id) === true;
      return {
        executed,
        reason: executed ? null : 'not-runnable',
        id,
        name: found ? found.name : null,
      };
    },
  },
  {
    id: 'obsidian.editor.state',
    tier: 'read',
    summary: '屏幕上那篇笔记：路径 / 光标最后位置 / 选区 / 行数（焦点不在编辑器里也照样算）',
    run(ctx) {
      const active = screenEditor(ctx.obsidian);
      if (!active) return { available: false, reason: 'no-open-note' };
      const ed = active.editor;
      const cursor = typeof ed.getCursor === 'function' ? ed.getCursor() : null;
      const selected = typeof ed.getSelection === 'function' ? ed.getSelection() : '';
      let from = null;
      let to = null;
      if (selected && typeof ed.listSelections === 'function') {
        const first = ed.listSelections()[0];
        if (first) {
          from = first.anchor || null;
          to = first.head || null;
        }
      }
      return {
        available: true,
        path: active.file ? active.file.path : null,
        mode: active.view.getMode ? active.view.getMode() : null,
        // focused=false：这不是焦点所在的编辑器（比如焦点在 Bridge 面板输入框里），
        // 光标是主人最后一次停在那里的位置，仍然说明他在看哪一段。
        focused: active.focused !== false,
        cursor,
        selection: selected
          ? { text: selected.length > 2000 ? `${selected.slice(0, 2000)}…` : selected, length: selected.length, from, to }
          : null,
        lineCount: typeof ed.lineCount === 'function' ? ed.lineCount() : null,
      };
    },
  },
  {
    id: 'obsidian.editor.insert',
    tier: 'write',
    summary: '在 AI 自己的光标处插入文本（不动你的光标；position=end 追加到文末；改完立刻落盘）',
    async run(ctx) {
      const text = ctx.args && ctx.args.text;
      if (typeof text !== 'string' || text.length === 0) throw opError('bad-args', '缺少 text');
      const file = resolveFile(ctx, targetPath(ctx, ctx.args));
      const view = viewOfFile(ctx.obsidian, file.path);
      if (!view) {
        throw opError(
          'no-editor-open',
          '这一篇不是屏幕上最上层那篇，AI 协同编辑只对那一篇生效。' +
            '先 obsidian.workspace.open 把它打开并切到最上层；或者用文件方式（obsidian.note.append 等）。',
        );
      }
      const cur = aiCursorOf(ctx);
      const doc = view.state.doc;

      let at;
      if (ctx.args.position === 'end') {
        at = doc.length;
      } else {
        const st = cur.forPath(file.path);
        // AI 光标是按文件归属的：换了一篇就会重置成 {0,0}。
        // 这时候直接插会静默写进文首——主人在中途切了笔记就会写错文件。
        // 所以宁可报错，让他先用 editor.aiCursor 指定位置。
        if (!st.path || st.path !== file.path || (st.head.line === 0 && st.head.ch === 0 && !st.anchor)) {
          throw opError(
            'no-ai-cursor',
            'AI 光标不在这一篇的指定位置上。先调 editor.aiCursor 设 line/ch（或 position:"end"），' +
              '否则会写到文首——那几乎一定不是你想要的。',
          );
        }
        at = requireOffset(doc, st.head, 'AI 光标位置');
      }

      // 只发 changes：AI 的字插进去，你的光标按逻辑位置自己维护，不被搬动
      notifyAiEdit(ctx, 'editing', file.path);
      dispatchAiEdit(view, { from: at, to: at, insert: text });
      syncAiCursor(cur, file.path, view.state.doc, at + text.length);
      // 默认立刻落盘：文件系统那边马上能读到，两种读法不会撞版本
      const saved = ctx.args.save === false ? false : await saveDoc(ctx.obsidian, file.path);
      notifyAiEdit(ctx, saved ? 'saved' : 'done', file.path);

      return {
        inserted: true,
        mode: ctx.args.position === 'end' ? 'end' : 'ai-cursor',
        at,
        saved,
        aiCursor: cur.snapshot(),
      };
    },
  },
  {
    id: 'obsidian.editor.replace',
    tier: 'write',
    summary: '替换 AI 自己选中的范围（不动你的光标和选区）；可用 from/to 先改选；改完立刻落盘',
    async run(ctx) {
      const text = ctx.args && ctx.args.text;
      if (typeof text !== 'string') throw opError('bad-args', '缺少 text');
      const file = resolveFile(ctx, targetPath(ctx, ctx.args));
      const view = viewOfFile(ctx.obsidian, file.path);
      if (!view) {
        throw opError(
          'no-editor-open',
          '这一篇不是屏幕上最上层那篇，AI 协同编辑只对那一篇生效。' +
            '先 obsidian.workspace.open 把它打开并切到最上层；或者用文件方式。',
        );
      }
      const cur = aiCursorOf(ctx);
      const doc = view.state.doc;

      // 给了 from/to 就先把 AI 的选区挪过去（只改 AI 的，不碰你的）
      if (ctx.args.from && ctx.args.to) cur.select(file.path, ctx.args.from, ctx.args.to);
      const r = cur.range(file.path);

      const from = requireOffset(doc, r.from, '替换起点');
      const to = requireOffset(doc, r.to, '替换终点');
      if (r.empty) {
        throw opError('empty-selection', 'AI 没有选中任何内容：先 editor.aiCursor 选一段，或者带 from/to');
      }

      notifyAiEdit(ctx, 'editing', file.path);
      dispatchAiEdit(view, { from, to, insert: text });
      syncAiCursor(cur, file.path, view.state.doc, from + text.length);
      const saved = ctx.args.save === false ? false : await saveDoc(ctx.obsidian, file.path);
      notifyAiEdit(ctx, saved ? 'saved' : 'done', file.path);

      return { replaced: true, from: r.from, to: r.to, saved, aiCursor: cur.snapshot() };
    },
  },
  {
    id: 'obsidian.editor.cursor',
    tier: 'write',
    summary: '移动 AI 自己的光标（不显示、不动你的；之后的 editor.* 都基于它）',
    run(ctx) {
      const file = resolveFile(ctx, targetPath(ctx, ctx.args));
      const cur = aiCursorOf(ctx);
      const line = Number(ctx.args && ctx.args.line);
      if (!Number.isInteger(line) || line < 0) throw opError('bad-args', '缺少合法的 line（0 起）');
      const ch = Number.isInteger(ctx.args.ch) && ctx.args.ch >= 0 ? ctx.args.ch : 0;
      const st = cur.move(file.path, { line, ch });
      return {
        moved: true,
        path: file.path,
        aiCursor: st,
        note: '移动的是 AI 自己的光标，你的光标没有被移动',
      };
    },
  },
  {
    id: 'obsidian.editor.aiCursor',
    tier: 'write',
    summary: 'AI 自己的光标：读当前位置，或选一段（select / collapse）。和你的光标完全隔离',
    run(ctx) {
      const file = resolveFile(ctx, targetPath(ctx, ctx.args));
      const cur = aiCursorOf(ctx);
      const args = ctx.args || {};

      if (args.select && args.select.from && args.select.to) {
        cur.select(file.path, args.select.from, args.select.to);
      } else if (args.collapse === true) {
        cur.collapse(file.path);
      } else if (Number.isInteger(args.line)) {
        cur.move(file.path, { line: args.line, ch: args.ch });
      }

      const st = cur.forPath(file.path);
      return {
        path: file.path,
        aiCursor: st,
        selection: cur.range(file.path),
        note: 'AI 的光标/选区，不会和你的互相影响',
      };
    },
  },
  {
    id: 'obsidian.workspace.state',
    tier: 'read',
    summary: '工作区快照：活跃文件 + 所有打开的标签（类型 / 路径 / 模式）',
    run(ctx) {
      const ws = ctx.obsidian.workspace;
      const leaves = [];
      if (ws && typeof ws.iterateAllLeaves === 'function') {
        ws.iterateAllLeaves((leaf) => {
          const view = (leaf && leaf.view) || {};
          leaves.push({
            id: leaf.id || null,
            type: view.getViewType ? view.getViewType() : null,
            path: view.file && view.file.path ? view.file.path : null,
            mode: view.getMode ? view.getMode() : null,
            active: leaf === ws.activeLeaf,
          });
        });
      }
      const activeFile = ws && ws.getActiveFile ? ws.getActiveFile() : null;
      return {
        activePath: activeFile && activeFile.path ? activeFile.path : null,
        leaves,
        count: leaves.length,
      };
    },
  },
  {
    id: 'obsidian.workspace.open',
    tier: 'write',
    summary: '在工作区打开一篇笔记（可新标签 / 分屏 / 指定源码或阅读模式）',
    async run(ctx) {
      const path = String((ctx.args && ctx.args.path) || '').trim();
      if (!path) throw opError('bad-args', '缺少 path');
      const vault = ctx.obsidian.vault;
      const file = vault && vault.getAbstractFileByPath ? vault.getAbstractFileByPath(path) : null;
      if (!file) throw opError('file-not-found', `找不到笔记：${path}`);
      const ws = ctx.obsidian.workspace;
      if (!ws || typeof ws.getLeaf !== 'function') throw opError('unsupported', '当前工作区不支持打开');

      const kind = ctx.args.split ? 'split' : ctx.args.newLeaf ? 'tab' : false;
      const leaf = ws.getLeaf(kind);
      const openOpts = ctx.args.mode ? { state: { mode: ctx.args.mode } } : undefined;
      await leaf.openFile(file, openOpts);
      if (typeof ws.revealLeaf === 'function' && ctx.args.reveal !== false) ws.revealLeaf(leaf);

      return { opened: true, path, mode: ctx.args.mode || null, newLeaf: Boolean(kind) };
    },
  },
  {
    id: 'obsidian.note.read',
    tier: 'read',
    summary: '按库内路径读正文（走 Obsidian 缓存读取；可 maxChars 截断）',
    async run(ctx) {
      const file = resolveFile(ctx, ctx.args && ctx.args.path);
      const text = await readText(ctx, file);
      const maxChars = Number.isInteger(ctx.args.maxChars) && ctx.args.maxChars > 0 ? ctx.args.maxChars : 0;
      const truncated = maxChars > 0 && text.length > maxChars;
      return {
        path: file.path,
        text: truncated ? text.slice(0, maxChars) : text,
        length: text.length,
        truncated,
      };
    },
  },
  {
    id: 'obsidian.note.meta',
    tier: 'read',
    summary: '笔记元数据：frontmatter / 标签 / 出链 / 嵌入 / 标题 / 反链来源（走 Obsidian 缓存）',
    run(ctx) {
      const file = resolveFile(ctx, ctx.args && ctx.args.path);
      const cache = fileCache(ctx, file);
      const tags = (Array.isArray(cache.tags) ? cache.tags : [])
        .map((t) => (t && t.tag) || null)
        .filter(Boolean);
      const links = (Array.isArray(cache.links) ? cache.links : []).map((l) => ({
        link: l.link,
        original: l.original,
      }));
      const embeds = (Array.isArray(cache.embeds) ? cache.embeds : []).map((e) => e.link);
      const headings = (Array.isArray(cache.headings) ? cache.headings : []).map((h) => ({
        heading: h.heading,
        level: h.level,
        line: h.position && h.position.start ? h.position.start.line : null,
      }));
      const backlinks = backlinkEntries(ctx, file).map(([p]) => p).sort();
      return {
        path: file.path,
        frontmatter: cache.frontmatter || null,
        tags,
        links,
        embeds,
        headings,
        backlinks,
        stat: {
          mtime: file.stat && file.stat.mtime ? file.stat.mtime : null,
          size: file.stat && file.stat.size ? file.stat.size : null,
        },
      };
    },
  },
  {
    id: 'obsidian.note.backlinks',
    tier: 'read',
    summary: '反链：谁引用了这一篇（含未解析引用），带次数与出链对照',
    run(ctx) {
      const file = resolveFile(ctx, ctx.args && ctx.args.path);
      const cache = fileCache(ctx, file);
      const outgoing = (Array.isArray(cache.links) ? cache.links : []).map((l) => l.link);
      const backlinks = backlinkEntries(ctx, file)
        .map(([path, refs]) => ({ path, count: Array.isArray(refs) ? refs.length : 0 }))
        .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
      return { path: file.path, outgoing, backlinks, backlinkCount: backlinks.length };
    },
  },

  {
    id: 'obsidian.note.create',
    tier: 'write',
    summary: '新建笔记（默认 .md；已存在则拒绝覆盖）',
    async run(ctx) {
      const path = normalizeNotePath(ctx.args && ctx.args.path);
      if (!path) throw opError('bad-args', '缺少合法的 path（不允许 .. 跳出库）');
      const vault = ctx.obsidian.vault;
      if (vault.getAbstractFileByPath(path)) throw opError('file-exists', `已存在：${path}`);
      const content = typeof ctx.args.content === 'string' ? ctx.args.content : '';
      await ensureParentFolders(vault, path);
      const file = await vault.create(path, content);
      return { created: true, path: file && file.path ? file.path : path, length: content.length };
    },
  },
  {
    id: 'obsidian.note.append',
    tier: 'write',
    summary: '在笔记末尾追加一段（不动原有内容）',
    async run(ctx) {
      // 先验参数再看文件：参数错了就该报参数错，不能因为路径也不存在而报成「文件不存在」。
      const text = typeof (ctx.args && ctx.args.text) === 'string' ? ctx.args.text : '';
      if (!text) throw opError('bad-args', '缺少 text');
      const file = resolveFile(ctx, ctx.args && ctx.args.path);
      const vault = ctx.obsidian.vault;
      if (typeof vault.append !== 'function') throw opError('unsupported', '当前库不支持追加');
      await vault.append(file, text);
      return { appended: true, path: file.path, added: text.length };
    },
  },
  {
    id: 'obsidian.note.property',
    tier: 'write',
    summary: '改 frontmatter 属性：set 合并 / del 删除（走 processFrontMatter，类型安全）',
    async run(ctx) {
      const file = resolveFile(ctx, ctx.args && ctx.args.path);
      const set = ctx.args.set && typeof ctx.args.set === 'object' ? ctx.args.set : {};
      const del = Array.isArray(ctx.args.del) ? ctx.args.del.map(String) : [];
      if (!Object.keys(set).length && del.length === 0) throw opError('bad-args', '至少要给 set 或 del');
      // frontmatter 的键来自调用方，__proto__ 这类键写进去会改原型而不是加属性。
      const dangerous = Object.keys(set).filter((key) => PROTOTYPE_KEYS.has(key));
      const dangerousDel = del.filter((key) => PROTOTYPE_KEYS.has(key));
      if (dangerous.length || dangerousDel.length) throw opError('bad-args', `不接受的属性名：${[...dangerous, ...dangerousDel].join(', ')}`);
      const fm = ctx.obsidian.fileManager;
      if (!fm || typeof fm.processFrontMatter !== 'function') throw opError('unsupported', '当前库不支持改属性');
      const before = {};
      const after = {};
      await fm.processFrontMatter(file, (data) => {
        for (const key of Object.keys(set)) {
          before[key] = data[key];
          data[key] = set[key];
          after[key] = data[key];
        }
        for (const key of del) {
          before[key] = data[key];
          delete data[key];
        }
      });
      return { path: file.path, changed: true, set, del, before, after };
    },
  },
  {
    id: 'obsidian.note.rename',
    tier: 'write',
    summary: '改名/移动笔记；默认 dryRun 只报会影响哪些引用，dryRun=false 才真改（Obsidian 自动修链接）',
    async run(ctx) {
      const file = resolveFile(ctx, ctx.args && ctx.args.path);
      const to = normalizeNotePath(ctx.args && ctx.args.to);
      if (!to) throw opError('bad-args', '缺少合法的 to（不允许 .. 跳出库）');
      const references = backlinkEntries(ctx, file).map(([p, refs]) => ({
        path: p,
        count: Array.isArray(refs) ? refs.length : 0,
      }));
      const affected = references.length;
      if (ctx.args.dryRun !== false) {
        return { dryRun: true, from: file.path, to, affected, references };
      }
      const fm = ctx.obsidian.fileManager;
      if (!fm || typeof fm.renameFile !== 'function') throw opError('unsupported', '当前库不支持改名');
      const from = file.path; // Obsidian 会在 renameFile 里就地改 file.path，先记下来
      await fm.renameFile(file, to);
      return { dryRun: false, renamed: true, from, to, affected };
    },
  },
  {
    id: 'obsidian.note.delete',
    tier: 'trust',
    summary: '删除笔记（走系统回收站，可恢复；必须 confirm:true）',
    async run(ctx) {
      if (ctx.args.confirm !== true) throw opError('bad-args', '删除需要 confirm:true');
      const file = resolveFile(ctx, ctx.args && ctx.args.path);
      const fm = ctx.obsidian.fileManager;
      if (fm && typeof fm.trashFile === 'function') {
        await fm.trashFile(file);
      } else if (ctx.obsidian.vault && typeof ctx.obsidian.vault.trash === 'function') {
        await ctx.obsidian.vault.trash(file, true);
      } else {
        throw opError('unsupported', '当前库不支持回收站删除');
      }
      return { deleted: true, path: file.path, recoverable: true };
    },
  },

  {
    id: 'obsidian.workspace.tab',
    tier: 'write',
    summary: '标签控制：activate/close 指定笔记的标签，next/previous 循环切换',
    run(ctx) {
      const ws = ctx.obsidian.workspace;
      const action = String((ctx.args && ctx.args.action) || 'activate');
      if (action === 'next' || action === 'previous' || action === 'prev') {
        const cmd = action === 'next' ? 'workspace:next-tab' : 'workspace:previous-tab';
        const executed = ctx.obsidian.commands.executeCommandById(cmd) === true;
        return { action, executed };
      }
      const path = String((ctx.args && ctx.args.path) || '').trim();
      if (!path) throw opError('bad-args', '缺少 path');
      const leaf = findLeafByPath(ws, path);
      if (!leaf) throw opError('leaf-not-found', `没有打开的标签：${path}`);
      if (action === 'activate') {
        if (typeof ws.setActiveLeaf !== 'function') throw opError('unsupported', '当前工作区不支持激活');
        ws.setActiveLeaf(leaf, { focus: ctx.args.focus !== false });
        if (typeof ws.revealLeaf === 'function') ws.revealLeaf(leaf);
        return { action, path, activated: true };
      }
      if (action === 'close') {
        if (typeof leaf.detach !== 'function') throw opError('unsupported', '当前工作区不支持关闭');
        leaf.detach();
        return { action, path, closed: true };
      }
      throw opError('bad-args', `不支持的 action：${action}（activate / close / next / previous）`);
    },
  },
  {
    id: 'obsidian.workspace.view',
    tier: 'write',
    summary: '打开侧栏视图（图谱/反链/大纲/搜索/标签等）；已开则复用',
    async run(ctx) {
      const type = String((ctx.args && ctx.args.type) || '').trim();
      if (!type) throw opError('bad-args', '缺少 type');
      const ws = ctx.obsidian.workspace;
      const existing = typeof ws.getLeavesOfType === 'function' ? ws.getLeavesOfType(type) : [];
      if (existing && existing.length) {
        if (typeof ws.revealLeaf === 'function') ws.revealLeaf(existing[0]);
        if (typeof ws.setActiveLeaf === 'function') ws.setActiveLeaf(existing[0], { focus: true });
        return { type, opened: true, reused: true };
      }
      const side = ctx.args.side === 'left' ? 'left' : 'right';
      const getLeaf = side === 'left' ? ws.getLeftLeaf : ws.getRightLeaf;
      if (typeof getLeaf !== 'function') throw opError('unsupported', '当前工作区不支持侧栏');
      const leaf = getLeaf.call(ws, false);
      if (!leaf || typeof leaf.setViewState !== 'function') throw opError('unsupported', '打不开侧栏视图');
      await leaf.setViewState({ type, active: true });
      if (typeof ws.revealLeaf === 'function') ws.revealLeaf(leaf);
      return { type, opened: true, reused: false, side };
    },
  },
  {
    id: 'obsidian.workspace.layout',
    tier: 'write',
    summary: '布局：get 导出当前布局 JSON；set 应用布局 JSON',
    async run(ctx) {
      const ws = ctx.obsidian.workspace;
      const action = String((ctx.args && ctx.args.action) || 'get');
      if (action === 'get') {
        if (typeof ws.getLayout !== 'function') throw opError('unsupported', '当前工作区不支持导出布局');
        return { layout: ws.getLayout() };
      }
      if (action === 'set') {
        const layout = ctx.args && ctx.args.layout;
        if (!layout || typeof layout !== 'object') throw opError('bad-args', '缺少 layout 对象');
        if (typeof ws.changeLayout !== 'function') throw opError('unsupported', '当前工作区不支持应用布局');
        await ws.changeLayout(layout);
        return { applied: true };
      }
      throw opError('bad-args', `不支持的 action：${action}（get / set）`);
    },
  },

  {
    id: 'obsidian.query',
    tier: 'read',
    summary: '全库结构化查询（目录 / 多标签 / 多属性 / 文件名关键字 / 时间范围），只返回索引信息，不含正文',
    run(ctx) {
      const args = ctx.args || {};
      const files = ctx.obsidian.vault.getMarkdownFiles() || [];
      const folder = normalizeFolder(args.folder);
      const tags = Array.isArray(args.tags) ? args.tags.map(normalizeTag).filter(Boolean) : [];
      const props = Array.isArray(args.props) ? args.props : [];
      const nameWords = Array.isArray(args.nameContains)
        ? args.nameContains.filter(Boolean).map(String)
        : args.nameContains
          ? [String(args.nameContains)]
          : [];
      const after = parseTimeArg(args.mtimeAfter, 'mtimeAfter');
      const before = parseTimeArg(args.mtimeBefore, 'mtimeBefore');
      const limit = clampInt(args.limit, 1, 500, 100);
      const include = new Set(Array.isArray(args.include) ? args.include : ['tags', 'frontmatter', 'headings']);
      const mc = ctx.obsidian.metadataCache;

      const matched = [];
      for (const file of files) {
        const p = String(file.path || '');
        if (folder && !(p === folder || p.startsWith(folder + '/'))) continue;
        const mtime = file.stat && file.stat.mtime ? file.stat.mtime : null;
        if (after !== null && (mtime === null || mtime < after)) continue;
        if (before !== null && (mtime === null || mtime > before)) continue;
        const name = file.basename || p.replace(/^.*\//, '').replace(/\.md$/i, '');
        if (nameWords.length && !nameWords.every((w) => name.includes(w))) continue;

        let cache = {};
        try {
          cache = (mc && mc.getFileCache && mc.getFileCache(file)) || {};
        } catch {
          cache = {};
        }

        if (tags.length) {
          const have = new Set((cache.tags || []).map((t) => normalizeTag(t && t.tag)).filter(Boolean));
          if (!tags.every((t) => have.has(t))) continue;
        }
        if (props.length) {
          const fm = cache.frontmatter || {};
          const ok = props.every((pr) => {
            const key = String((pr && pr.key) || '');
            if (!key || !(key in fm)) return false;
            if (pr.value === undefined) return true;
            return valueMatches(fm[key], pr.value);
          });
          if (!ok) continue;
        }
        matched.push({ file, cache, name, mtime });
      }

      const items = matched.slice(0, limit).map(({ file, cache, name, mtime }) => {
        const item = {
          path: file.path,
          name,
          mtime: mtime ? new Date(mtime).toISOString() : null,
          size: file.stat && file.stat.size ? file.stat.size : null,
        };
        if (include.has('tags')) item.tags = (cache.tags || []).map((t) => (t && t.tag) || '').filter(Boolean);
        if (include.has('frontmatter')) item.frontmatter = cache.frontmatter || null;
        if (include.has('headings')) {
          item.headings = (cache.headings || []).map((h) => ({ heading: h.heading, level: h.level }));
        }
        if (include.has('links')) item.links = (cache.links || []).map((l) => l.link);
        return item;
      });

      return { total: matched.length, returned: items.length, limit, items };
    },
  },
  {
    id: 'obsidian.search',
    tier: 'read',
    summary: '全库关键字搜索：文件名 + 正文（多关键字 AND），返回命中行片段，不返回整篇',
    async run(ctx) {
      const query = String((ctx.args && ctx.args.query) || '').trim();
      const words = query.split(/\s+/).filter(Boolean);
      if (words.length === 0) throw opError('bad-args', '缺少 query');
      const lowerWords = words.map((w) => w.toLowerCase());
      const scope = ctx.args.scope === 'name' ? 'name' : ctx.args.scope === 'content' ? 'content' : 'both';
      const folder = normalizeFolder(ctx.args.folder);
      const limit = clampInt(ctx.args.limit, 1, 200, 50);
      const contextChars = clampInt(ctx.args.contextChars, 20, 400, 80);
      const timeBudget = clampInt(ctx.args.timeBudgetMs, 500, 20000, 6000);

      const files = (ctx.obsidian.vault.getMarkdownFiles() || []).filter((f) => {
        if (!folder) return true;
        const p = String(f.path || '');
        return p === folder || p.startsWith(folder + '/');
      });

      const started = Date.now();
      const results = [];
      const CONCURRENCY = 8;

      for (let i = 0; i < files.length; i += CONCURRENCY) {
        if (Date.now() - started > timeBudget) break;
        const batch = files.slice(i, i + CONCURRENCY);
        const found = await Promise.all(
          batch.map(async (file) => {
            const name = file.basename || String(file.path || '').replace(/^.*\//, '').replace(/\.md$/i, '');
            const lowerName = name.toLowerCase();
            const nameHit = lowerWords.every((w) => lowerName.includes(w));
            if (scope === 'name') return nameHit ? { path: file.path, name, score: 2, matches: [] } : null;
            if (scope === 'both' && nameHit) return { path: file.path, name, score: 3, matches: [] };

            let text = '';
            try {
              text = await readText(ctx, file);
            } catch {
              return null;
            }
            const lower = text.toLowerCase();
            if (!lowerWords.every((w) => lower.includes(w))) return null;

            const matches = [];
            const lines = text.split('\n');
            for (let li = 0; li < lines.length && matches.length < 3; li += 1) {
              const line = lines[li];
              const low = line.toLowerCase();
              if (lowerWords.every((w) => low.includes(w))) {
                matches.push({ line: li + 1, snippet: line.trim().slice(0, contextChars) });
              }
            }
            if (matches.length === 0) {
              const idx = lower.indexOf(lowerWords[0]);
              const lineNo = text.slice(0, Math.max(0, idx)).split('\n').length;
              matches.push({
                line: lineNo,
                snippet: text.slice(Math.max(0, idx - 20), idx + contextChars).replace(/\s+/g, ' ').trim(),
              });
            }
            return { path: file.path, name, score: nameHit ? 3 : 1, matches };
          }),
        );
        for (const item of found) if (item) results.push(item);
        if (results.length >= limit * 3) break;
      }

      results.sort((a, b) => b.score - a.score || String(a.path).localeCompare(String(b.path)));
      const items = results.slice(0, limit);
      return {
        total: results.length,
        returned: items.length,
        limit,
        query: words,
        scope,
        elapsedMs: Date.now() - started,
        items,
      };
    },
  },
];


const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// 时间参数：给了但解析不出来就是参数错，不许悄悄当成“没给”而返回全库。
function parseTimeArg(value, name) {
  if (value === undefined || value === null || value === '') return null;
  const ms = Date.parse(String(value));
  if (!Number.isFinite(ms)) throw opError('bad-args', `${name} 不是合法时间：${value}`);
  return ms;
}

// 真实的 vault.create 不会替你建父目录，缺目录时直接抛 ENOENT。
// 所以建笔记前把缺的层级逐级补上；createFolder 撞已存在就跳过（并发下正常）。
async function ensureParentFolders(vault, path) {
  const parts = String(path).split('/').slice(0, -1);
  if (!parts.length) return;
  if (typeof vault.createFolder !== 'function') return;
  let cur = '';
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    if (vault.getAbstractFileByPath(cur)) continue;
    try {
      await vault.createFolder(cur);
    } catch (err) {
      if (!vault.getAbstractFileByPath(cur)) throw err;
    }
  }
}

function resolveFile(ctx, path) {
  const p = String(path || '').trim();
  if (!p) throw opError('bad-args', '缺少 path');
  const vault = ctx.obsidian && ctx.obsidian.vault;
  const file = vault && vault.getAbstractFileByPath ? vault.getAbstractFileByPath(p) : null;
  if (!file) throw opError('file-not-found', `找不到笔记：${p}`);
  return file;
}

async function readText(ctx, file) {
  const vault = ctx.obsidian && ctx.obsidian.vault;
  const reader = vault && (vault.cachedRead || vault.read);
  if (typeof reader !== 'function') return '';
  const text = await reader.call(vault, file);
  return typeof text === 'string' ? text : '';
}

function fileCache(ctx, file) {
  const mc = ctx.obsidian && ctx.obsidian.metadataCache;
  try {
    return (mc && mc.getFileCache && mc.getFileCache(file)) || {};
  } catch {
    return {};
  }
}

function backlinkEntries(ctx, file) {
  // Obsidian 不同版本返回 Record 或 Map，统一成 [path, refs][]。
  const mc = ctx.obsidian && ctx.obsidian.metadataCache;
  try {
    const res = mc && mc.getBacklinksForFile ? mc.getBacklinksForFile(file) : null;
    const data = res && res.data;
    if (!data) return [];
    if (typeof data.entries === 'function') {
      return Array.from(data.entries()).map(([p, refs]) => [p, Array.isArray(refs) ? refs : []]);
    }
    return Object.entries(data).map(([p, refs]) => [p, Array.isArray(refs) ? refs : []]);
  } catch {
    return [];
  }
}


function normalizeNotePath(raw) {
  let p = String(raw || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!p || p.includes('..') || p.startsWith('.')) return null;
  if (!/\.[a-z0-9]+$/i.test(p)) p += '.md';
  return p;
}


function findLeafByPath(ws, path) {
  let found = null;
  if (!ws || typeof ws.iterateAllLeaves !== 'function') return null;
  ws.iterateAllLeaves((leaf) => {
    if (found) return;
    const view = leaf && leaf.view;
    const p = view && view.file && view.file.path;
    if (p && p === path) found = leaf;
  });
  return found;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeFolder(value) {
  return String(value || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

function normalizeTag(value) {
  return String(value || '').trim().replace(/^#/, '').toLowerCase();
}

function valueMatches(actual, expected) {
  if (Array.isArray(actual)) return actual.some((x) => valueMatches(x, expected));
  if (actual === expected) return true;
  return String(actual).toLowerCase() === String(expected).toLowerCase();
}
function createRegistry(deps) {
  const byId = new Map(OPS.map((op) => [op.id, op]));

  return {
    list() {
      return OPS.map(({ id, tier, summary }) => ({ id, tier, summary }));
    },
    get(opId) {
      return byId.get(opId) || null;
    },
    async call(opId, args, callCtx = {}) {
      const op = byId.get(opId);
      if (!op) {
        return { ok: false, error: { code: 'unknown-op', message: `未知操作：${opId}` } };
      }
      try {
        const data = await op.run({ ...deps, args: args || {}, ...callCtx });
        return { ok: true, data: data === undefined ? null : data };
      } catch (err) {
        return {
          ok: false,
          error: { code: err.code || 'op-failed', message: String((err && err.message) || err) },
        };
      }
    },
  };
}

module.exports = { createRegistry, OPS };
});
__define('lib/reply-reconcile.js', function (module, exports, require) {
'use strict';
// Bridge · 面板回复对账
//
// 事件（SSE）是快路，但会丢：断线、重连窗口、那一轮压根没产生文本、
// 或者事件名/结构变了。丢了之后面板就永远停在「思考中…」，看起来就是
// 「agent 没回我」。
//
// 这里给一条慢路：只问会话真相（/sessions 的 running + /transcript 的消息），
// 不看事件。只要那一轮真的跑完了，回复就能被捞出来补上。
// 纯函数，不碰网络，好测。

/** 面板里已经显示过的 assistant 文本集合（用来判断「这条补过没有」） */
function shownAssistantTexts(shown) {
  const set = new Set();
  for (const m of Array.isArray(shown) ? shown : []) {
    if (m && m.role === 'assistant' && typeof m.text === 'string') set.add(m.text);
  }
  return set;
}

/**
 * 该不该把某条回复补到面板上。
 * @param {Array} shown     面板已显示的消息（{role,text}）
 * @param {Array} transcript 会话日志里的最近消息（{role,text}）
 * @returns {{role:string,text:string}|null} 要补的那条；没得补就 null
 */
function pickMissingReply(shown, transcript) {
  const list = Array.isArray(transcript) ? transcript : [];
  const last = [...list]
    .reverse()
    .find((m) => m && m.role === 'assistant' && typeof m.text === 'string' && m.text.trim());
  if (!last) return null;
  if (shownAssistantTexts(shown).has(last.text)) return null;
  return { role: 'assistant', text: last.text };
}

/**
 * 现在该不该去对账。
 * @param {{running:boolean, waiting:boolean, elapsedMs:number, timeoutMs?:number}} input
 */
function shouldReconcile({ running, waiting, elapsedMs, timeoutMs = 180000 } = {}) {
  if (waiting !== true) return false;
  if (!Number.isFinite(elapsedMs) || elapsedMs > timeoutMs) return false;
  // 只有「明确已经停了」才对账：
  // running=true（还在跑，事件可能只是慢）和 undefined（会话列表还没刷新，
  // 查不到等于不知道）都不插手，免得误判成跑完、把机会让给一条旧回复。
  return running === false;
}

module.exports = { pickMissingReply, shouldReconcile };

});
__define('lib/scroll-anchor.js', function (module, exports, require) {
// Bridge · 回复进来时视口停在哪
//
// 主人想看的画面是这样：自己那句话在上面，AI 回复的开头紧接着下一行。
//
// 短消息：整条都在，停它的顶部，一眼看全。
// 长消息：整条塞不下，停到它最后两行——尾巴露出来，回复照样紧接在下面，
//        别为了看开头把回复顶出屏幕。

// 我那句话最多能占视口多少，超过了就只留尾巴
const ROOM_RATIO = 0.7;
// 长消息留几行给自己收尾
const TAIL_LINES = 2;

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// 返回要滚到的位置（相对列表顶部）；null 表示「没有回复可对齐」，交给调用方滚到底
function pickReplyAnchor({
  userTop,
  userHeight,
  assistantTop,
  viewHeight,
  lineHeight,
  tailLines = TAIL_LINES,
} = {}) {
  const a = num(assistantTop);
  // 连回复气泡都没有，就没有「回复开头」这回事
  if (a === null) return null;
  const u = num(userTop);
  // 没有我那句（比如会话刚开）：停在回复开头
  if (u === null) return a;
  // 顺序反了不硬按，停在我那句上
  if (a < u) return u;

  const h = num(userHeight);
  // 高度量不出来：按顶部对齐，别乱猜
  if (h === null) return u;
  const vh = num(viewHeight) || 0;
  // 视口有多高都不知道，就不敢把回复推到看不见的地方
  if (!vh) return a;

  // 不算长：整条给足，从顶部开始看
  if (h <= vh * ROOM_RATIO) return u;

  // 太长：只留最后两行，下面紧接着就是回复开头
  const lh = num(lineHeight);
  const tail = lh === null ? 0 : lh * (num(tailLines) || 0);
  // 尾巴比整条还高时夹回顶部，不滚到句子上面去
  return Math.max(u, u + h - tail);
}

module.exports = { pickReplyAnchor, ROOM_RATIO, TAIL_LINES };

});
__define('lib/server.js', function (module, exports, require) {
'use strict';
// Bridge · HTTP 入口
// 只监听回环；除 /health 外一律要 token；权限闸门在调用前；账本记录每次调用。

const http = require('node:http');
const crypto = require('node:crypto');
const { isExpired, statusForError } = __req('lib/token-lifecycle.js');

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
});
__define('lib/settings.js', function (module, exports, require) {
'use strict';
// Bridge · 设置归一化
// 凡是外部写进来的设置（data.json）都先过这里：非法值回默认，绝不把坏配置带进运行时。

const DEFAULTS = {
  enabled: true,
  host: '127.0.0.1',
  port: 8811,
  defaultLevel: 'read',
  token: '',
  permissions: null,
  ledger: true,
  chatSessionId: '',
  chatOpen: false,
  injectionEnabled: false,
  tokenTtl: 0,
  tokenIssuedAt: 0,
};

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const LEVELS = new Set(['read', 'write', 'trust']);

function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const port = Number.isInteger(src.port) && src.port >= 1 && src.port <= 65535 ? src.port : DEFAULTS.port;
  const host = typeof src.host === 'string' && LOOPBACK.has(src.host) ? src.host : DEFAULTS.host;
  const defaultLevel = LEVELS.has(src.defaultLevel) ? src.defaultLevel : DEFAULTS.defaultLevel;
  // token 有效期：0 = 永久；负数/垃圾值一律当永久（不放宽也不收紧）。
  const tokenTtl = Number.isFinite(src.tokenTtl) && src.tokenTtl > 0 ? src.tokenTtl : 0;
  const tokenIssuedAt = Number.isFinite(src.tokenIssuedAt) && src.tokenIssuedAt > 0 ? src.tokenIssuedAt : 0;
  const enabled = typeof src.enabled === 'boolean' ? src.enabled : DEFAULTS.enabled;
  const token = typeof src.token === 'string' ? src.token : '';
  const permissions = src.permissions && typeof src.permissions === 'object' ? src.permissions : null;
  const ledger = typeof src.ledger === 'boolean' ? src.ledger : DEFAULTS.ledger;
  const chatSessionId = typeof src.chatSessionId === 'string' ? src.chatSessionId : '';
  const chatOpen = typeof src.chatOpen === 'boolean' ? src.chatOpen : false;
  const injectionEnabled = typeof src.injectionEnabled === 'boolean' ? src.injectionEnabled : false;

  return {
    enabled,
    host,
    port,
    defaultLevel,
    token,
    permissions,
    ledger,
    chatSessionId,
    chatOpen,
    injectionEnabled,
    tokenTtl,
    tokenIssuedAt,
  };
}

// 注入开关只有一个真相源：连接器（真正执行注入的是它）。
// 本地值只是缓存，不一致时以远端为准；远端读不到（没连上/旧版本）就不许乱改本地。
function reconcileInjection({ remote, local } = {}) {
  const known = typeof remote === 'boolean';
  if (!known) return { value: local === true, changed: false, unknown: true };
  const value = remote === true;
  return { value, changed: value !== (local === true) };
}

module.exports = {
  reconcileInjection, DEFAULTS, normalizeSettings, normalizeSettingsSafe: normalizeSettings };
});
__define('lib/token-lifecycle.js', function (module, exports, require) {
'use strict';
// token 生命周期：签发时间 + 有效期（0 = 永久）。
// 轮换策略是「提前换」而不是「过期才换」：剩余寿命不足一成就换新的，
// 这样常驻调用方（MCP 桥）永远读不到已经过期的 token。

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

// 剩余寿命低于有效期的这个比例就轮换。
const ROTATE_MARGIN = 0.1;

// 设置页给的可选有效期（毫秒）。0 = 永久。
const TOKEN_TTL_OPTIONS = [
  { value: 0, label: '永久' },
  { value: 30 * DAY, label: '30 天' },
  { value: 7 * DAY, label: '7 天' },
  { value: DAY, label: '1 天' },
  { value: HOUR, label: '1 小时' },
];

function ttlIsFinite(ttlMs) {
  return Number.isFinite(ttlMs) && ttlMs > 0;
}

function isExpired({ issuedAt, ttlMs, now } = {}) {
  if (!ttlIsFinite(ttlMs)) return false;
  const born = Number(issuedAt) || 0;
  return Number(now) - born > ttlMs;
}

function shouldRotate({ issuedAt, ttlMs, now } = {}) {
  if (!ttlIsFinite(ttlMs)) return false;
  const born = Number(issuedAt) || 0;
  const remaining = born + ttlMs - Number(now);
  if (remaining <= 0) return true;
  return remaining <= ttlMs * ROTATE_MARGIN;
}

// 下一次轮换还差多少毫秒。null = 永久，不用挂定时器。
// 一次性算出来挂 setTimeout，比每隔一分钟醒来问一次省事，也不会堆积定时器。
function nextRotationDelay({ issuedAt, ttlMs, now } = {}) {
  if (!ttlIsFinite(ttlMs)) return null;
  // issuedAt 为 0 是合法值（纪元），不能当「没给」——那会把已经到期的算成还没到期。
  const rawBorn = issuedAt === undefined || issuedAt === null ? now : issuedAt;
  const born = Number(rawBorn) || 0;
  const dueAt = born + ttlMs * (1 - ROTATE_MARGIN);
  return Math.max(0, dueAt - Number(now));
}

function describeTtl(ttlMs) {
  if (!ttlIsFinite(ttlMs)) return '永久';
  const option = TOKEN_TTL_OPTIONS.find((item) => item.value === ttlMs);
  if (option) return option.label;
  if (ttlMs >= DAY) return `${Math.round(ttlMs / DAY)} 天`;
  if (ttlMs >= HOUR) return `${Math.round(ttlMs / HOUR)} 小时`;
  return `${Math.round(ttlMs / 60000)} 分钟`;
}

// 业务错误码 → HTTP 状态。调用方要能分清「我参数错了」和「服务挂了」，
// 一律 500 等于把这两件事搅在一起。
const ERROR_STATUS = {
  'bad-args': 400,
  'bad-request': 400,
  'invalid-args': 400,
  unauthorized: 401,
  'token-expired': 401,
  forbidden: 403,
  'file-not-found': 404,
  'not-found': 404,
  'unknown-op': 404,
  'file-exists': 409,
  conflict: 409,
  'no-active-editor': 409,
  unsupported: 501,
};

function statusForError(code) {
  return ERROR_STATUS[String(code || '')] || 500;
}

module.exports = { isExpired, shouldRotate, nextRotationDelay, describeTtl, statusForError, TOKEN_TTL_OPTIONS, ROTATE_MARGIN, DAY, HOUR };

});
__define('main.js', function (module, exports, require) {
'use strict';
// Bridge · Obsidian 插件入口
// 定位：独立插件，与枢阁（8790 / 8848）无任何联系，只干 Obsidian 内部能力。
// 生命周期：Obsidian 开着 = Bridge 在；服务只监听回环，除 /health 外都要 token。

const { Plugin, Notice, PluginSettingTab, Setting, Modal } = require('obsidian');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDriver } = __req('lib/driver.js');
const { createPermissions, LEVELS, LEVEL_LABEL } = __req('lib/permissions.js');
const { createLedger } = __req('lib/ledger.js');
const { startCoreServer } = __req('lib/server.js');
const { createInfoStore } = __req('lib/info.js');
const { reconcileInjection } = __req('lib/settings.js');
const { nextRotationDelay, describeTtl, TOKEN_TTL_OPTIONS } = __req('lib/token-lifecycle.js');
const { normalizeSettings } = __req('lib/settings.js');
const { BridgeChatView, VIEW_TYPE: CHAT_VIEW_TYPE } = __req('lib/chat-view.js');
const { createConnectorClient } = __req('lib/connector-client.js');
const { BridgeLogModal } = __req('lib/log-view.js');
const { createPluginLog } = __req('lib/plugin-log.js');
const { createMarkExtension, refreshAllMarkViews } = __req('lib/mark-decoration.js');
const { nextMarkState, describeMarks, marksForPath } = __req('lib/mark-store.js');
const { createAiCursor } = __req('lib/ai-cursor.js');
const { createAiCursorSync } = __req('lib/ai-cursor-sync.js');

const INFO_DIR = path.join(os.homedir(), '.obsidian-bridge');
const CONNECTOR_FILE = path.join(os.homedir(), '.dsh-bridge', 'connector.json');

module.exports = class ObsidianBridgePlugin extends Plugin {
  async onload() {
    try {
      await this._onload();
    } catch (err) {
      const detail = String((err && err.stack) || err);
      try {
        fs.writeFileSync(
          path.join(os.tmpdir(), 'bridge-onload-error.txt'),
          new Date().toISOString() + '\n' + detail,
          'utf8',
        );
      } catch {
        /* 连错误都写不下去就只能靠下面这条 Notice 了 */
      }
      new Notice('Bridge 加载失败：' + detail.split('\n')[0], 15000);
      throw err;
    }
  }

  async _onload() {
    this.settings = normalizeSettings(await this.loadData());
    this.core = null;
    this.permissions = null;
    this.startedAt = null;
    this.lastError = null;

    this.infoStore = createInfoStore({ dir: INFO_DIR });
    this.pluginLog = createPluginLog({ file: this.logPath() });

    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass('obsidian-bridge-status');
    this.statusBar.style.cursor = 'pointer';
    this.statusBar.onClickEvent(() => this.restartCore(true));

    this.addCommand({
      id: 'bridge-restart',
      name: '重启 Bridge 服务',
      callback: () => this.restartCore(true),
    });
    this.addCommand({
      id: 'bridge-toggle',
      name: '启动 / 停止 Bridge 服务',
      callback: () => (this.core ? this.stopCore() : this.startCore()),
    });
    this.addCommand({
      id: 'bridge-copy-token',
      name: '复制 Bridge token',
      callback: () => this.copyToken(),
    });
    this.addCommand({
      id: 'bridge-command-count',
      name: '统计可执行命令数量',
      callback: () => this.showCommandCount(),
    });

    this.registerView(CHAT_VIEW_TYPE, (leaf) => new BridgeChatView(leaf, this));
    this.addRibbonIcon('message-square', 'Bridge 对话', () => this.activateChat());
    this.addCommand({ id: 'bridge-open-chat', name: '打开 Bridge 对话', callback: () => this.activateChat() });

    this.addSettingTab(new BridgeSettingTab(this, this.app));

    // 标记：只在屏幕上画（CodeMirror 装饰），文档一个字节都不动。
    // 装饰层拿不到就降级——标记本身的记录和播报不依赖它，别为了「看得见」
    // 把整个插件搞挂（那样连命令都注册不上）。
    // AI 自己的光标：位置和选区都存这儿，不显示、不碰主人的
    this.aiCursor = createAiCursor();

    // 主人改文字时，AI 光标跟着那段字挪，不会落到别的字中间。
    // 拿不到 CodeMirror 就跳过——光标不跟随只是不够聪明，不该拖垮插件。
    try {
      this.registerEditorExtension(
        createAiCursorSync({
          getAiCursor: () => this.aiCursor,
          resolvePath: (cmView) => this.pathOfEditorView(cmView),
        }),
      );
    } catch (err) {
      this.logEvent('ai-cursor', '跟随同步不可用：' + String((err && err.message) || err));
    }

    this._marks = [];
    this._markVisible = false;
    try {
      this.registerEditorExtension(
        createMarkExtension({
          getMarks: () => this._marks,
          getPath: () => {
            const file = this.app.workspace.getActiveFile();
            return file ? file.path : '';
          },
        }),
      );
      this._markVisible = true;
    } catch (err) {
      this.logEvent('mark', '装饰层不可用，标记只能靠状态栏和播报：' + String((err && err.message) || err));
    }
    this.addCommand({
      id: 'bridge-mark-here',
      name: '标记：标记这里（再按变范围，第三次清除）',
      hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'm' }],
      callback: () => this.toggleMark(),
    });
    this.addCommand({
      id: 'bridge-mark-clear',
      name: '标记：清除全部',
      callback: () => this.clearMarks(),
    });

    // 右键菜单：比快捷键顺手，不用记键。光标停在哪就标哪。
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu) => {
        menu.addItem((item) =>
          item
            .setTitle('Bridge：标记这里（再点一次成范围）')
            .setIcon('highlighter')
            .onClick(() => this.toggleMark()),
        );
        menu.addItem((item) =>
          item.setTitle('Bridge：清除标记').setIcon('eraser').onClick(() => this.clearMarks()),
        );
      }),
    );

    // 当前打开的笔记：持续推给连接器，让 agent 不用等主人开口就知道屏幕上是什么。
    this.trackActiveNote();

    // 上次面板是开着的就自动恢复：改代码后 reload、或者重启 Obsidian，
    // 侧栏那个视图会被一起收掉，不该让主人每次都手动点回来。
    if (this.settings.chatOpen) {
      // onLayoutReady 在有些 reload 场景下不会再来一次（布局早就 ready 了），
      // 所以直接延迟开：给 Obsidian 留出重建右侧栏的时间。
      const timer = setTimeout(() => {
        this.activateChat();
      }, 1500);
      this.register(() => clearTimeout(timer));
    }

    // token 轮换不是轮询：一次性算好下次该换的时刻，挂一个 setTimeout。
    // 提前一成换，常驻的 MCP 桥下一次读 info.json 就拿到新的。
    this.register(() => this.cancelTokenRotation());
    this.scheduleTokenRotation();

    if (this.settings.enabled) {
      await this.startCore({ quiet: true });
    } else {
      this.renderStatus();
    }
  }

  onunload() {
    this.stopCore({ quiet: true });
  }

  connector() {
    if (!this._connector) {
      this._connector = createConnectorClient({
        loadInfo: () => {
          try {
            return JSON.parse(fs.readFileSync(CONNECTOR_FILE, 'utf8'));
          } catch {
            return null;
          }
        },
      });
    }
    return this._connector;
  }

  // 当前打开的笔记 —— 推给连接器，agent 那边就能直接读到「屏幕上这一篇」。
  // 内容取编辑器缓冲（getValue），所以还没保存的改动也在里面，这正是要的效果。
  // AI 每完成一次编辑，在状态栏亮一下「AI 编辑完成」，几秒后自己消失。
  // 不带文件名、不带时间：主人只要知道「刚才那下是 AI 动的」就够了，
  // 加东西反而要读。连续操作就把计时器重置，一直是亮着的。
  onAiEdit(phase) {
    try {
      if (phase === 'editing') return; // AI 不是逐字打字，没有「编辑中」这个阶段
      if (!this.aiStatusEl) {
        this.aiStatusEl = this.addStatusBarItem();
        this.aiStatusEl.addClass('bridge-ai-status');
      }
      this.aiStatusEl.setText('AI 编辑完成');
      this.aiStatusEl.style.display = '';
      if (this._aiNoticeTimer) clearTimeout(this._aiNoticeTimer);
      this._aiNoticeTimer = setTimeout(() => {
        this._aiNoticeTimer = null;
        if (this.aiStatusEl) {
          this.aiStatusEl.setText('');
          this.aiStatusEl.style.display = 'none';
        }
      }, 1500);
    } catch {
      /* 状态栏出问题不该打断写入 */
    }
  }

  // 某个 CodeMirror 视图对应哪篇笔记（同步器要用它确认是哪一篇）
  pathOfEditorView(cmView) {
    try {
      const leaves = this.app.workspace.getLeavesOfType('markdown') || [];
      for (const leaf of leaves) {
        const v = leaf && leaf.view;
        if (v && v.editor && v.editor.cm === cmView) return v.file ? v.file.path : null;
      }
    } catch {
      /* 布局在重建 */
    }
    return null;
  }

  // 屏幕上那篇笔记（不看焦点）：焦点在面板输入框时 activeLeaf 是面板，
  // 所以要先看活跃编辑器，没有就问布局「哪个 markdown 标签活着」。
  topMarkdownView() {
    const ws = this.app.workspace;
    const isMd = (v) => Boolean(v && v.file && v.editor && typeof v.editor.getValue === 'function');
    const active = ws.activeLeaf && ws.activeLeaf.view;
    if (isMd(active)) return active;

    const hits = [];
    const walk = (node, depth) => {
      if (!node || depth > 8) return;
      if (typeof node.getActiveLeaf === 'function') {
        const leaf = node.getActiveLeaf();
        if (leaf && isMd(leaf.view)) hits.push(leaf.view);
      }
      for (const child of node.children || []) walk(child, depth + 1);
    };
    try {
      walk(ws.rootSplit, 0);
    } catch {
      /* 布局还在重建 */
    }
    if (hits[0]) return hits[0];

    const leaves = typeof ws.getLeavesOfType === 'function' ? ws.getLeavesOfType('markdown') : [];
    for (let i = leaves.length - 1; i >= 0; i -= 1) {
      const v = leaves[i] && leaves[i].view;
      if (isMd(v)) return v;
    }
    return null;
  }

  // 标记：一个快捷键搞定「点 → 范围 → 清空」三种结果，不用记两个键。
  toggleMark() {
    const view = this.topMarkdownView();
    const file = view && view.file;
    const editor = view && view.editor;
    if (!file || !editor) {
      new Notice('没有打开的笔记，先点开一篇再标记');
      return;
    }
    const cursor = typeof editor.getCursor === 'function' ? editor.getCursor() : null;
    const current = marksForPath(this._marks, file.path);
    const next = nextMarkState(current, cursor);
    const kept = this._marks.filter((m) => m.path !== file.path);
    if (next.marks.length) kept.push({ path: file.path, marks: next.marks });
    this._marks = kept;
    this.refreshMarkViews();
    const desc = describeMarks(next.marks);
    new Notice(desc || '标记已清除');
    this.renderMarkStatus();
    // 标记变了立刻告诉连接器，别等下一次切换
    if (typeof this._flushActiveNote === 'function') this._flushActiveNote();
  }

  clearMarks() {
    this._marks = [];
    this.refreshMarkViews();
    this.renderMarkStatus();
    new Notice('标记已清除');
    if (typeof this._flushActiveNote === 'function') this._flushActiveNote();
  }

  // 标记是外部状态，CodeMirror 不知道它变了：dispatch 一个空事务把装饰层叫醒
  refreshMarkViews() {
    const views = [];
    const leaves =
      typeof this.app.workspace.getLeavesOfType === 'function'
        ? this.app.workspace.getLeavesOfType('markdown')
        : [];
    for (const leaf of leaves) {
      const v = leaf && leaf.view;
      if (v && v.editor && v.editor.cm) views.push(v.editor.cm);
    }
    refreshAllMarkViews(views);
  }

  renderMarkStatus() {
    if (!this.markStatusEl) this.markStatusEl = this.addStatusBarItem();
    const view = this.topMarkdownView();
    const file = view && view.file;
    const marks = file ? marksForPath(this._marks, file.path) : [];
    this.markStatusEl.setText(describeMarks(marks));
    this.markStatusEl.style.display = marks.length ? '' : 'none';
  }

  // 当前打开的笔记 —— 只推「坐标」，不推正文。
  // 模型要知道的是：在看哪一篇、多大、光标停在第几行哪一节、有没有选中东西。
  // 这些几十个字就够；正文它自己去读，读到的才是最新的那份。
  trackActiveNote() {
    let lastKey = null;
    // 上一轮推上去的是哪一篇：焦点跑掉、布局也找不到时，用它兜底
    let lastPath = null;
    let timer = null;
    let inflight = false;
    this._activeNoteWarned = false;

    const pad = (n) => String(n).padStart(2, '0');
    const stamp = (ms) => {
      const d = new Date(ms);
      return (
        d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
        ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
      );
    };
    // 光标所在的最近一节标题：从光标所在行往上找第一个 # 开头的行
    const headingAt = (text, line) => {
      const rows = String(text || '').split('\n');
      for (let i = Math.min(line, rows.length - 1); i >= 0; i -= 1) {
        const m = /^(#{1,6})\s+(.+)$/.exec(rows[i]);
        if (m) return m[1] + ' ' + m[2].trim();
      }
      return null;
    };

    const isMdView = (v) =>
      Boolean(
        v &&
          v.file &&
          v.editor &&
          typeof v.editor.getValue === 'function' &&
          (!v.file.extension || v.file.extension === 'md'),
      );

    // 主编辑区（不含左右侧栏）里当前激活的 Markdown 视图。
    // 「屏幕上那篇」不一定有焦点：在面板输入框里打字时，activeLeaf 就是面板本身，
    // 所以焦点不可靠；这里直接问布局「哪个 markdown 标签现在是活的」。
    const mainMarkdownView = () => {
      const ws = this.app.workspace;
      const hits = [];
      const walk = (node, depth) => {
        if (!node || depth > 8) return;
        if (typeof node.getActiveLeaf === 'function') {
          const leaf = node.getActiveLeaf();
          if (leaf && isMdView(leaf.view)) hits.push(leaf.view);
        }
        for (const child of node.children || []) walk(child, depth + 1);
      };
      try {
        walk(ws.rootSplit, 0);
      } catch {
        /* 布局还在重建 */
      }
      return hits[0] || null;
    };

    const readActive = () => {
      const workspace = this.app.workspace;
      const activeView = workspace.activeLeaf && workspace.activeLeaf.view;
      // ① 焦点就在编辑器里：最准
      if (isMdView(activeView)) {
        return { file: activeView.file, editor: activeView.editor };
      }
      // ② 焦点在面板/侧栏：看主编辑区最上层那篇
      const top = mainMarkdownView();
      if (top) return { file: top.file, editor: top.editor };

      const leaves =
        typeof workspace.getLeavesOfType === 'function' ? workspace.getLeavesOfType('markdown') : [];
      // ③ 上一轮那篇还开着
      if (lastPath) {
        for (const leaf of leaves) {
          const v = leaf && leaf.view;
          if (isMdView(v) && v.file.path === lastPath) {
            return { file: v.file, editor: v.editor };
          }
        }
      }
      // ④ 兜底：还开着的任意一篇
      for (let i = leaves.length - 1; i >= 0; i -= 1) {
        const v = leaves[i] && leaves[i].view;
        if (isMdView(v)) return { file: v.file, editor: v.editor };
      }
      return null;
    };

    const describe = (file, editor) => {
      let text = '';
      try {
        text = editor.getValue();
      } catch {
        text = '';
      }
      const cursor = typeof editor.getCursor === 'function' ? editor.getCursor() : null;
      let selText = '';
      try {
        selText = typeof editor.getSelection === 'function' ? editor.getSelection() : '';
      } catch {
        selText = '';
      }
      let selection = null;
      if (selText) {
        const from = typeof editor.getCursor === 'function' ? editor.getCursor('from') : cursor;
        const to = typeof editor.getCursor === 'function' ? editor.getCursor('to') : cursor;
        if (from && to) {
          selection = {
            fromLine: from.line,
            fromCh: from.ch,
            toLine: to.line,
            toCh: to.ch,
            chars: selText.length,
            // 只给开头一段：知道选的是哪块就够，全文它自己会去取
            preview: selText.slice(0, 300),
          };
        }
      }
      const mtime = file.stat && file.stat.mtime ? file.stat.mtime : null;
      const base = this.app.vault.adapter.getBasePath() || '';
      // 另外还开着哪几篇：让他知道我可能有别的参考物，而不是只有这一篇
      const leaves =
        typeof this.app.workspace.getLeavesOfType === 'function'
          ? this.app.workspace.getLeavesOfType('markdown')
          : [];
      const others = leaves
        .map((leaf) => leaf && leaf.view && leaf.view.file && leaf.view.file.path)
        .filter((x) => x && x !== file.path);
      return {
        path: file.path,
        absPath: base ? path.join(base, file.path) : null,
        title: file.basename,
        charCount: text.length,
        lineCount:
          typeof editor.lineCount === 'function' ? editor.lineCount() : text.split('\n').length,
        updatedAt: mtime ? stamp(mtime) : null,
        cursor: cursor ? { line: cursor.line, ch: cursor.ch } : null,
        selection,
        heading: cursor ? headingAt(text, cursor.line) : null,
        others: others.slice(0, 8),
        // 当前这篇上的临时标记（最多两个：点 / 范围）
        marks: marksForPath(this._marks, file.path).slice(0, 2),
        // 明确告诉连接器「选区这事我查过了」，免得它把「不知道」说成「没有」
        checked: true,
      };
    };

    const keyOf = (d) =>
      [
        d.path,
        d.cursor ? d.cursor.line + ':' + d.cursor.ch : '',
        d.selection ? d.selection.chars : '',
        d.charCount,
        d.updatedAt,
      ].join('|');

    const flush = async (force) => {
      if (inflight) return;
      const cur = readActive();
      if (!cur) {
        // 一篇 Markdown 都没开着（全关了）：才清空，
        // 否则上一篇会一直挂在提示词里冒充「当前」。
        // 注意「焦点跑到面板上」不算——那篇还开着，人还在看它。
        if (lastKey !== null) {
          lastKey = null;
          inflight = true;
          try {
            await this.connector().clearActiveNote();
            this.logEvent('active-note', '清空当前笔记（切到了没有正文的视图）');
          } catch {
            /* 连接器没起来不刷屏 */
          } finally {
            inflight = false;
          }
        }
        return;
      }
      const note = describe(cur.file, cur.editor);
      const key = keyOf(note);
      if (!force && key === lastKey) return;
      lastKey = key;
      inflight = true;
      try {
        const res = await this.connector().pushActiveNote(note);
        if (res && res.ok === false) throw new Error((res.error && res.error.message) || '推送失败');
        this._activeNoteWarned = false;
        lastPath = note.path;
      } catch (err) {
        // 只报第一次：同一句失败反复刷日志没有信息量
        if (!this._activeNoteWarned) {
          this._activeNoteWarned = true;
          this.logEvent('active-note', '同步当前笔记失败：' + String((err && err.message) || err));
        }
      } finally {
        inflight = false;
      }
    };

    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        flush(false);
      }, 1200);
    };

    this.registerEvent(this.app.workspace.on('active-leaf-change', () => flush(true)));
    this.registerEvent(this.app.workspace.on('file-open', () => flush(true)));
    this.registerEvent(this.app.workspace.on('editor-change', () => schedule()));
    this.registerEvent(this.app.vault.on('rename', () => schedule()));
    this.registerEvent(this.app.vault.on('delete', () => schedule()));

    // 光标不在这里轮询：投递那一刻连接器会现查一次，比轮询准、也省得后台一直动。
    // 这里只负责「切到哪一篇、改了什么」这类真正在变的信息。
    this.register(() => {
      if (timer) clearTimeout(timer);
      try {
        this.connector().clearActiveNote();
      } catch {
        /* 卸载阶段连接器可能已经关了 */
      }
    });
    // 让标记之类的动作能立刻触发一次推送，不用等下一个事件
    this._flushActiveNote = () => flush(true);

    // 启动时先报一次：面板可能还要等 1.5 秒才开，但坐标现在就能给
    const kick = setTimeout(() => flush(true), 1200);
    this.register(() => clearTimeout(kick));
  }

  async activateChat() {
    // 记下「面板是开着的」，reload / 重启后能自动恢复
    if (!this.settings.chatOpen) {
      this.settings.chatOpen = true;
      this.persistSettings();
    }
    const { workspace } = this.app;
    // 只留侧栏一个实例：主区域里的旧实例关掉，避免出现两套面板
    for (const leaf of workspace.getLeavesOfType(CHAT_VIEW_TYPE)) {
      const root = typeof leaf.getRoot === 'function' ? leaf.getRoot() : null;
      if (root === workspace.rootSplit) leaf.detach();
    }
    let leaf = workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) || workspace.getLeaf('tab');
      await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
    // 面板可能是以前就加载过的（onOpen 那时连接可能正好失败），
    // 每次打开顺手重连一次，保证 SSE 订阅是活的。
    const view = leaf.view;
    if (view && typeof view.connect === 'function' && view.sessionId) {
      try { view.connect(); } catch { /* 重连失败会被状态栏接住 */ }
    }
  }

  permissionsPath() {
    return path.join(this.pluginDir(), 'data', 'permissions.json');
  }

  readPermissionsState() {
    try {
      return JSON.parse(fs.readFileSync(this.permissionsPath(), 'utf8'));
    } catch {
      return this.settings.permissions || {};
    }
  }
  logPath() {
    return path.join(this.pluginDir(), 'data', 'bridge.log');
  }

  logEvent(kind, message) {
    if (this.pluginLog) this.pluginLog.write(kind, message);
  }

  openLog() {
    new BridgeLogModal(this.app, this).open();
  }

  pluginDir() {
    try {
      const base = this.app.vault.adapter.getBasePath();
      const configDir = this.app.vault.configDir || '.obsidian';
      return path.join(base, configDir, 'plugins', this.manifest.id);
    } catch {
      return this.manifest.dir || __dirname;
    }
  }

  ledgerPath() {
    return path.join(this.pluginDir(), 'data', 'ledger.jsonl');
  }

  async persistSettings() {
    await this.saveData(this.settings);
  }

  // info.json 是调用方（MCP 桥）唯一读 token 的地方，启动和轮换都得写同一份内容，
  // 所以只有这一个构造点，避免两处字段漂移。
  infoPayload() {
    return {
      service: 'obsidian-bridge',
      version: this.manifest.version,
      host: this.settings.host,
      port: this.core ? this.core.port : this.settings.port,
      token: this.settings.token,
      pid: process.pid,
      vault: this.app.vault.getName(),
      vaultPath: this.app.vault.adapter.getBasePath() || null,
      configDir: this.app.vault.configDir || '.obsidian',
      pluginDir: this.pluginDir(),
      startedAt: new Date(this.startedAt || Date.now()).toISOString(),
    };
  }

  cancelTokenRotation() {
    if (this._tokenTimer) {
      clearTimeout(this._tokenTimer);
      this._tokenTimer = null;
    }
  }

  // 按当前有效期算出「下次该换」的时刻，只挂一个定时器。
  // 不用「每分钟醒来问一次」的轮询：那种写法要一直维护上次检查到哪，还会堆积定时器。
  scheduleTokenRotation() {
    this.cancelTokenRotation();
    const delay = nextRotationDelay({
      issuedAt: this.settings.tokenIssuedAt,
      ttlMs: this.settings.tokenTtl,
      now: Date.now(),
    });
    if (delay === null) return; // 永久：不排定时器
    this._tokenTimer = setTimeout(async () => {
      this._tokenTimer = null;
      await this.rotateToken({ quiet: true });
      this.scheduleTokenRotation(); // 换完按新签发时间排下一次
    }, Math.max(1000, delay));
  }

  // 轮换不重启服务：server 端是按 tokenState 实时取的，
  // 换完 token 立刻生效，已经在用的会话不会被打断。
  async rotateToken({ quiet = false } = {}) {
    this.settings.token = crypto.randomBytes(24).toString('hex');
    this.settings.tokenIssuedAt = Date.now();
    await this.persistSettings();
    if (this.core) this.infoStore.write(this.infoPayload());
    this.logEvent('token', `token 已轮换（有效期 ${describeTtl(this.settings.tokenTtl)}）`);
    if (!quiet) new Notice('Bridge token 已轮换');
  }

  async startCore({ quiet = false } = {}) {
    if (this.core) return;
    if (!this.settings.token) {
      this.settings.token = crypto.randomBytes(24).toString('hex');
      this.settings.tokenIssuedAt = Date.now();
      await this.persistSettings();
    }

    const permissions = createPermissions({
      state: this.readPermissionsState(),
      defaultLevel: this.settings.defaultLevel,
      onSave: (snap) => {
        // 档位必须同步落盘：异步 saveData 遇到快速重启会丢最后一次改动。
        try {
          const file = this.permissionsPath();
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, JSON.stringify(snap, null, 2), 'utf8');
        } catch {
          /* 写不了文件也不能阻断切换 */
        }
        this.settings.permissions = snap;
        this.persistSettings();
      },    });
    this.permissions = permissions;

    const driver = createDriver({
      obsidian: this.app,
      aiCursor: this.aiCursor,
      onAiEdit: (phase, filePath) => this.onAiEdit(phase, filePath),
    });
    const ledgerPath = this.ledgerPath();
    const ledger = createLedger({
      sink: (entry) => {
        if (!this.settings.ledger) return;
        try {
          fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
          fs.appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`, 'utf8');
        } catch {
          /* 旁路：账本失败不影响调用 */
        }
      },
    });

    try {
      this.core = await startCoreServer({
        driver,
        permissions,
        ledger,
        token: this.settings.token,
        // 传函数而不是快照：轮换后不用重启服务，下一次请求就按新 token 判。
        tokenState: () => ({
          token: this.settings.token,
          issuedAt: this.settings.tokenIssuedAt,
          ttlMs: this.settings.tokenTtl,
        }),
        host: this.settings.host,
        port: this.settings.port,
        version: this.manifest.version,
      });
      this.startedAt = Date.now();
      this.lastError = null;
      this.infoStore.write(this.infoPayload());
      this.logEvent('start', `Bridge 启动 ${this.core.url}（端口 ${this.core.port}）`);
      if (!quiet) new Notice(`Bridge 已启动：${this.core.url}`);
    } catch (err) {
      this.core = null;
      this.lastError = String((err && err.message) || err);
      this.logEvent('error', `Bridge 启动失败：${this.lastError}`);
      if (!quiet) new Notice(`Bridge 启动失败：${this.lastError}`);
    }
    this.renderStatus();
  }

  async stopCore({ quiet = false } = {}) {
    if (this.core) {
      try {
        await this.core.close();
      } catch {
        /* 关不掉也要把状态清干净 */
      }
      this.core = null;
    }
    this.startedAt = null;
    this.logEvent('stop', 'Bridge 已停止');
    try {
      this.infoStore.clear();
    } catch {
      /* 旁路 */
    }
    this.renderStatus();
    if (!quiet) new Notice('Bridge 已停止');
  }

  async restartCore(quiet = false) {
    await this.stopCore({ quiet: true });
    await this.startCore({ quiet: true });
    new Notice(this.core ? `Bridge 已重启：${this.core.url}` : `Bridge 重启失败：${this.lastError || '未知原因'}`);
  }

  renderStatus() {
    if (!this.statusBar) return;
    if (this.core) {
      this.statusBar.setText(`Bridge :${this.core.port}`);
      this.statusBar.setAttribute('aria-label', `Bridge 运行中：${this.core.url}`);
      this.statusBar.style.color = '';
    } else {
      this.statusBar.setText('Bridge off');
      this.statusBar.setAttribute('aria-label', this.lastError ? `Bridge 未运行：${this.lastError}` : 'Bridge 未运行');
      this.statusBar.style.color = 'var(--text-faint)';
    }
  }

  async copyToken() {
    try {
      await navigator.clipboard.writeText(this.settings.token || '');
      new Notice('Bridge token 已复制');
    } catch {
      new Notice('复制失败，请在设置页手动复制');
    }
  }

  showCommandCount() {
    try {
      const list = this.app.commands.listCommands() || [];
      new Notice(`Obsidian 当前有 ${list.length} 条命令可执行`);
    } catch (err) {
      new Notice(`统计失败：${String((err && err.message) || err)}`);
    }
  }

  async saveSettings() {
    await this.persistSettings();
  }
};

class BridgeSettingTab extends PluginSettingTab {
  constructor(plugin, app) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // 把 hotkey 数组格式化成给人看的字符串（Mod 按平台显示成 Cmd / Ctrl）
  formatHotkeys(list) {
    return (Array.isArray(list) ? list : [])
      .map((h) =>
        h && Array.isArray(h.modifiers) && h.key
          ? h.modifiers
              .map((m) => (m === 'Mod' ? (process.platform === 'darwin' ? 'Cmd' : 'Ctrl') : m))
              .concat(String(h.key).toUpperCase())
              .join('+')
          : '',
      )
      .filter(Boolean)
      .join(' / ');
  }

  // 快捷键行：长相和 Obsidian「设置 → 快捷键」里那一行一样
  // （列出已绑定的键、+ 添加、点键删除），但数据读写的是 hotkeyManager 本身。
  // 所以这里改的 = 快捷键页里看到的 = 实际生效的，三处同一个真相，
  // 冲突检测也仍然归 Obsidian 管。
  addHotkeySetting(containerEl, { commandId, name, desc, defaults }) {
    const mgr = this.app.hotkeyManager;
    const available = mgr && typeof mgr.setHotkeys === 'function';
    const host = containerEl.createDiv({ cls: 'bridge-hotkey-host' });

    const readCurrent = () => {
      try {
        return available && typeof mgr.getHotkeys === 'function' ? mgr.getHotkeys(commandId) || [] : [];
      } catch {
        return [];
      }
    };

    const write = (list) => {
      try {
        mgr.setHotkeys(commandId, list);
        return true;
      } catch (err) {
        new Notice('写入快捷键失败：' + String((err && err.message) || err));
        return false;
      }
    };

    const redraw = () => {
      host.empty();
      const setting = new Setting(host).setName(name);
      const list = readCurrent();
      const label = this.formatHotkeys(list);
      setting.setDesc(desc + '　已绑定：' + (label || '无'));

      // 版本不支持写快捷键：只给一个跳转
      if (!available) {
        setting.addButton((b) =>
          b.setButtonText('去「设置 → 快捷键」').onClick(() => {
            try {
              this.app.setting.open();
              this.app.setting.openTabById('hotkeys');
            } catch {
              /* 界面结构变了就只提示 */
            }
          }),
        );
        return;
      }

      // 只允许一个快捷键（master 的要求）：多余的清掉，只留第一个
      if (list.length > 1) {
        write([list[0]]);
      }

      // 录制靠一个只读输入框：点它有焦点，keydown 一定收得到。
      // 之前试过在设置页挂 document 监听、又试过弹 Modal，都没收到按键——
      // 焦点不在自己手上时按键会被别处吃掉。输入框不会有这个问题。
      let pending = null;
      setting.addText((text) => {
        text.setPlaceholder('点这里，然后按组合键');
        text.inputEl.readOnly = true;
        text.inputEl.addEventListener('keydown', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          if (ev.key === 'Escape') {
            pending = null;
            text.setValue('');
            return;
          }
          const mods = [];
          if (ev.ctrlKey || ev.metaKey) mods.push('Mod');
          if (ev.shiftKey) mods.push('Shift');
          if (ev.altKey) mods.push('Alt');
          if (['Control', 'Shift', 'Alt', 'Meta', 'OS'].includes(ev.key)) {
            // 只按修饰键也给回显，让人确认识别到了
            text.setValue(mods.length ? this.formatHotkeys([{ modifiers: mods, key: '' }]).replace(/\+$/, '+ …') : '');
            return;
          }
          const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
          pending = { modifiers: mods, key };
          text.setValue(this.formatHotkeys([pending]));
        });
      });
      setting.addButton((btn) =>
        btn.setButtonText('设为').setCta().onClick(() => {
          if (!pending) {
            new Notice('先在左边的框里按一个组合键');
            return;
          }
          // 只留这一个：替换，不追加
          if (write([pending])) {
            new Notice('标记快捷键已设为 ' + this.formatHotkeys([pending]));
            redraw();
          }
        }),
      );

      // 清除
      setting.addExtraButton((btn) =>
        btn
          .setIcon('trash-2')
          .setTooltip('清除快捷键')
          .onClick(() => {
            if (write([])) {
              new Notice('标记快捷键已清除');
              redraw();
            }
          }),
      );

      // 恢复默认
      setting.addExtraButton((btn) =>
        btn
          .setIcon('rotate-ccw')
          .setTooltip('恢复默认（Ctrl/Cmd+Shift+M）')
          .onClick(() => {
            if (write(defaults)) {
              new Notice('已恢复默认快捷键');
              redraw();
            }
          }),
      );
    };

    redraw();
  }
  display() {
    const { containerEl } = this;
    const plugin = this.plugin;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Bridge' });
    containerEl.createEl('p', {
      text: '把 Obsidian 内部能力（命令面板等）作为本地 Bridge 暴露给 DSH 与 agent。只监听回环，除健康检查外都要 token。',
      cls: 'setting-item-description',
    });

    const runtime = plugin.core
      ? `运行中 · ${plugin.core.url} · 已运行 ${Math.round((Date.now() - (plugin.startedAt || Date.now())) / 1000)} 秒`
      : plugin.lastError
        ? `未运行 · ${plugin.lastError}`
        : '未运行';

    new Setting(containerEl).setName('服务状态').setDesc(runtime);

    // 标记快捷键：这里读写的是 Obsidian 的 hotkeyManager 本身，
    // 不自己存一份——设置页改的、快捷键页看到的、实际生效的，三处同一个真相。
    this.addHotkeySetting(containerEl, {
      commandId: 'obsidian-bridge:bridge-mark-here',
      name: '标记快捷键',
      desc: '在光标处打标记；再按一次成范围，第三次清除。',
      defaults: [{ modifiers: ['Mod', 'Shift'], key: 'm' }],
    });

    new Setting(containerEl)
      .setName('启用 Bridge 服务')
      .setDesc('关闭后 Obsidian 启动时不自动起服务，可用命令面板手动启动。')
      .addToggle((toggle) =>
        toggle.setValue(plugin.settings.enabled).onChange(async (value) => {
          plugin.settings.enabled = value;
          await plugin.saveSettings();
          if (value && !plugin.core) await plugin.startCore({ quiet: true });
          if (!value && plugin.core) await plugin.stopCore({ quiet: true });
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName('端口')
      .setDesc('只允许回环地址。改完点重启生效。')
      .addText((text) =>
        text
          .setPlaceholder('8811')
          .setValue(String(plugin.settings.port))
          .onChange(async (value) => {
            const n = Number.parseInt(value, 10);
            if (Number.isInteger(n) && n >= 1 && n <= 65535) {
              plugin.settings.port = n;
              await plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName('默认档位')
      .setDesc('没有单独记档的客户端按这个档位。read=只读，write=可执行命令，trust=全开。')
      .addDropdown((dd) => {
        for (const level of LEVELS) dd.addOption(level, `${level}（${LEVEL_LABEL[level] || level}）`);
        dd.setValue(plugin.settings.defaultLevel).onChange(async (value) => {
          plugin.settings.defaultLevel = value;
          await plugin.saveSettings();
          if (plugin.permissions) plugin.permissions.setDefault(value);
        });
      });

    new Setting(containerEl)
      .setName('访问 token')
      .setDesc(plugin.settings.token ? `${plugin.settings.token.slice(0, 8)}…${plugin.settings.token.slice(-4)}（本机 MCP 桥自动读取）` : '尚未生成')
      .addButton((btn) =>
        btn.setButtonText('复制').onClick(() => plugin.copyToken()),
      )
      .addButton((btn) =>
        btn.setButtonText('立即轮换').onClick(async () => {
          await plugin.rotateToken();
          plugin.scheduleTokenRotation();
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName('token 有效期')
      .setDesc(
        `${describeTtl(plugin.settings.tokenTtl)} · 到期前自动轮换（提前换，调用方读不到过期的）` +
          (plugin.settings.tokenIssuedAt
            ? ` · 本轮签发于 ${new Date(plugin.settings.tokenIssuedAt).toLocaleString()}`
            : ' · 还没记录签发时间，下一轮定时检查会补上'),
      )
      .addDropdown((dd) => {
        for (const option of TOKEN_TTL_OPTIONS) dd.addOption(String(option.value), option.label);
        dd.setValue(String(plugin.settings.tokenTtl || 0));
        dd.onChange(async (value) => {
          plugin.settings.tokenTtl = Number(value) || 0;
          // 从「永久」改成有限期时补一次签发时间，否则会被判成早就该轮换。
          if (plugin.settings.tokenTtl > 0 && !plugin.settings.tokenIssuedAt) {
            plugin.settings.tokenIssuedAt = Date.now();
          }
          await plugin.saveSettings();
          plugin.scheduleTokenRotation();
          new Notice(`token 有效期：${describeTtl(plugin.settings.tokenTtl)}`);
          this.display();
        });
      });

    containerEl.createEl('h3', { text: '客户端权限（目前只联动 DSH）' });
    const clients = new Set(['agent.dsh']);
    if (plugin.permissions) {
      for (const rec of plugin.permissions.list()) clients.add(rec.client);
    }
    for (const client of clients) {
      const current = plugin.permissions ? plugin.permissions.levelOf(client) : plugin.settings.defaultLevel;
      new Setting(containerEl)
        .setName(client)
        .setDesc(`当前：${current}（${LEVEL_LABEL[current] || current}）`)
        .addDropdown((dd) => {
          for (const level of LEVELS) dd.addOption(level, `${level}（${LEVEL_LABEL[level] || level}）`);
          dd.setValue(current).onChange((value) => {
            if (!plugin.permissions) {
              new Notice('服务未运行，先启动 Bridge');
              return;
            }
            plugin.permissions.setLevel(client, value);
            this.display();
          });
        });
    }

    containerEl.createEl('h3', { text: '操作目录' });
    if (plugin.core) {
      // 这里是 SettingTab，this 不是插件：用 plugin.* 才是对的。
      // 之前写成 this.aiCursor 拿到 undefined，被 driver 的兜底悄悄盖掉了。
      const driver = createDriver({
        obsidian: plugin.app,
        aiCursor: plugin.aiCursor,
        onAiEdit: (phase, filePath) => plugin.onAiEdit(phase, filePath),
      });
      for (const op of driver.list().ops) {
        containerEl.createEl('p', {
          text: `${op.id} · ${op.tier} · ${op.summary}`,
          cls: 'setting-item-description',
        });
      }
    } else {
      containerEl.createEl('p', {
        text: '服务未运行，启动后可在这里看到完整操作目录。',
        cls: 'setting-item-description',
      });
    }

    containerEl.createEl('h3', { text: 'DSH 对话面板' });
    new Setting(containerEl)
      .setName('会话')
      .setDesc(
        plugin.settings.chatSessionId
          ? `上次：${plugin.settings.chatSessionId.slice(0, 12)}（打开面板时可选择新建或复用）`
          : '还没有会话；打开面板时会新建',
      )
      .addButton((btn) => btn.setButtonText('打开面板').onClick(() => plugin.activateChat()));

    new Setting(containerEl)
      .setName('运行日志')
      .setDesc(plugin.logPath())
      .addButton((btn) => btn.setButtonText('打开日志').onClick(() => plugin.openLog()));

    const injectionSetting = new Setting(containerEl)
      .setName('启用注入')
      .setDesc('连接器是唯一真相源；连不上时开关不会假装切换')
      .addToggle((toggle) =>
        toggle.setValue(plugin.settings.injectionEnabled).onChange(async (value) => {
          // 先说服连接器，成功了才写本地；失败就把开关拨回去，
          // 不留「本地写着开、实际没开」这种界面和真相不一致的状态。
          const res = await plugin.connector().setInjection(value);
          if (!res || res.ok !== true) {
            toggle.setValue(!value);
            new Notice('注入没有切换：连接器未响应（DSH 未运行或连接器版本过旧）');
            return;
          }
          plugin.settings.injectionEnabled = value;
          await plugin.saveSettings();
          new Notice(value ? '注入已开启' : '注入已关闭');
          this.display();
        }),
      );

    // 以连接器为真相源：进入设置页时读一次，不一致就对齐本地
    plugin
      .connector()
      .config()
      .then(async (res) => {
        if (!res || res.ok !== true) {
          injectionSetting.setDesc('连接器离线（DSH 未运行或版本过旧），开关实际状态未知');
          return;
        }
        const state = reconcileInjection({
          remote: res.data && res.data.injection,
          local: plugin.settings.injectionEnabled,
        });
        injectionSetting.setDesc(
          `连接器：${state.value ? '开' : '关'}` + (state.changed ? '（本地缓存已按连接器对齐）' : ''),
        );
        if (state.changed) {
          plugin.settings.injectionEnabled = state.value;
          await plugin.saveSettings();
        }
      })
      .catch(() => {});

    containerEl.createEl('h3', { text: '审计账本' });
    containerEl.createEl('p', {
      text: plugin.ledgerPath(),
      cls: 'setting-item-description',
    });
    new Setting(containerEl)
      .setName('记录调用账本')
      .setDesc('每次操作一行 JSONL（谁 / 什么操作 / 成功失败 / 耗时）。')
      .addToggle((toggle) =>
        toggle.setValue(plugin.settings.ledger).onChange(async (value) => {
          plugin.settings.ledger = value;
          await plugin.saveSettings();
        }),
      );
  }
}
});
module.exports = __req('main.js');
