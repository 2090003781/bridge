'use strict';
// Bridge · 主面板（整合视图）
// 左 1/3：状态、功能按钮、最近操作记录；右 2/3：与 DSH 会话的对话。

const { ItemView, Notice, Modal, Setting, TFolder, MarkdownRenderer } = require('obsidian');
const fs = require('node:fs');
const { parseLedger } = require('./ledger-reader.js');
const { reconcileInjection } = require('./settings.js');
const { pickReplyAnchor } = require('./scroll-anchor.js');
const { HISTORY_LIMIT, transcriptState, mergeTranscript } = require('./session-context.js');
const { rewriteLocalImages } = require('./image-embed.js');
const { displayTextOf } = require('./panel-text.js');
const { tailPathOf, planTree } = require('./session-tree.js');

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
    // 每切一次会话 +1：历史请求靠它认住自己属于哪一次切换
    this._switchToken = 0;
    this.ac = null;
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

    // 不做定时轮询：窗口拿回焦点时对一次账（注入开关变了、或者断线期间漏了事件）
    this.registerDomEvent(window, 'focus', () => {
      this.refreshRemoteState();
    });

    await this.ensureSession();
    this.refreshRemoteState();
  }

  onClose() {
    if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = null; }
    // 用户主动关掉面板：下次启动别再自己弹出来
    this.plugin.settings.chatOpen = false;
    this.plugin.persistSettings();
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

  // 切会话要换掉的不只是 id：窗口里的消息、流式缓冲、合并盒、
  // 上一条会话的补回复轮询，全属于旧会话，一样都不该留在新会话里。
  bindSession(sessionId) {
    this.sessionId = sessionId;
    this.plugin.settings.chatSessionId = sessionId;
    this.plugin.saveSettings();
    this._switchToken += 1;
    this.stashPendingIntoInput();
    this.messages = [];
    this.assistantBuffer = '';
    // 切过去就该看到最新那几条，而不是停在旧会话滚到的位置
    this._stickToBottom = true;
    this._renderAnchor = 'bottom';
    this.render();
    this.setStatus('已连接');
    this.refreshLocalState();
    this.connect();
    this.loadHistory();
  }

  // 合并盒（攒着还没发的那几条）在切会话时清掉，但话得留着：
  // 放回输入框，既不会丢，也不会误发到刚切过去的会话里。
  stashPendingIntoInput() {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (!this.pending.length) return;
    const text = this.pending.join('\n');
    this.pending = [];
    if (!this.inputEl) return;
    const current = String(this.inputEl.value || '');
    this.inputEl.value = current.trim() ? current + '\n' + text : text;
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

  // 把会话里最近的消息读回来：面板自己不存历史，消息都在 DSH 那边。
  // 切会话后也是靠它把窗口换成新会话的上下文，所以每次绑定都重拉一次，
  // 并用切换序号认住「这次请求属于哪一次切换」——迟到的结果直接丢掉，
  // 否则慢半拍的上一条会话历史会盖到新会话的窗口上。
  async loadHistory() {
    if (!this.sessionId) return;
    const token = this._switchToken;
    const sessionId = this.sessionId;
    try {
      const res = await this.plugin.connector().transcript(sessionId, HISTORY_LIMIT);
      if (!res || res.ok !== true) return;
      const verdict = transcriptState({
        reqToken: token,
        curToken: this._switchToken,
        reqSession: sessionId,
        curSession: this.sessionId,
      });
      if (verdict !== 'apply') return;
      const items = (res.data && res.data.messages) || [];
      // 日志里有什么拿什么：这一轮还没答完也没关系，
      // 答完的内容会照常走事件补进来
      const history = items.map((m) => ({ role: m.role, text: m.text }));
      // 加载期间可能已经有新消息到了（自己刚发的、事件推来的）：
      // 历史打底，把它们接在后面，同一条不重复
      this.messages = mergeTranscript({ transcript: history, live: this.messages });
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
            // 断线期间漏了什么不知道，重连后拉一次最近的消息兜住
            this.loadHistory();
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
      if (this.assistantBuffer) {
        this.messages.push({ role: 'assistant', text: this.assistantBuffer });
        this.assistantBuffer = '';
        this._renderAnchor = 'reply';
      }
      this.render();
      this.setStatus('就绪');
      return;
    }
    if (type === 'tool-call') {
      // 工具名一次一换、跳得厉害；状态行只留一句「执行中」
      this.setStatus('执行中…');
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

  // 注入面板里选的节奏：每几轮带一次、一共带几次
  cadenceOfInject() {
    const s = this.plugin.settings || {};
    const every = Number(s.injectEvery);
    const times = Number(s.injectTimes);
    return {
      every: Number.isFinite(every) && every >= 1 ? Math.min(99, Math.floor(every)) : 1,
      times: Number.isFinite(times) && times > 0 ? Math.min(99, Math.floor(times)) : 0,
    };
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
        // 节奏：每 every 轮带一次；times 一共带几次（0 = 不限期）
        ...this.cadenceOfInject(),
      });
      if (res && res.ok) {
        const extra = selection ? `（另附选中 ${selection.length} 字）` : '';
        const { every, times } = this.cadenceOfInject();
        const life =
          (every === 1 ? '每轮都带' : `每 ${every} 轮带一次`) +
          (times === 0 ? '，不限次数' : `，共 ${times} 次`);
        this.pushSystem(`已注入《${file.path}》${extra}——${life}，实时跟随磁盘内容。`);
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

  // 渲染用的基准路径：相对图片、相对附件按「正在看的那篇」解析。
  // 空字符串会让相对路径全部解析失败，图就显示不出来。
  sourcePathForRender() {
    try {
      const file = this.app.workspace.getActiveFile();
      if (file && file.path) return file.path;
    } catch {
      /* 没有活动文件就退回库根 */
    }
    return '';
  }

  // 库外的本地绝对路径（agent 存的截图之类）Obsidian 不会自己去读，
  // 先读成 data URL 再交给渲染器，图才真的显示出来。
  prepareMarkdown(text) {
    const body = String(text || '');
    try {
      return rewriteLocalImages(body, {
        vaultRoot: this.app.vault.adapter.getBasePath(),
        readFile: (target) => fs.readFileSync(target),
      });
    } catch {
      return body;
    }
  }

  // Obsidian 自带渲染器；失败就退回纯文本，不能让一条消息把面板弄崩。
  renderMarkdown(el, text) {
    const body = String(text || '');
    try {
      MarkdownRenderer.render(this.app, this.prepareMarkdown(body), el, this.sourcePathForRender(), this);
    } catch {
      el.setText(body);
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
      // 时间戳、坐标行、压缩摘要这些不是主人敲的字：剥掉，剥空了就不占位
      const shown = displayTextOf(msg);
      if (!shown) continue;
      const el = this.listEl.createDiv({ cls: `bridge-msg bridge-msg-${msg.role}` });
      // 助手回复按 Markdown 渲染（代码块、列表、图片），用户自己的话保持纯文本
      if (msg.role === 'assistant') this.renderMarkdown(el, shown);
      else el.setText(shown);
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

    const cadence = this.view.cadenceOfInject();
    const describeEvery = (n) => (n === 1 ? '每轮都带' : '每 ' + n + ' 轮带一次');
    const describeTimes = (n) => (n === 0 ? '不限期' : '共 ' + n + ' 次');
    let everyInput = null;
    let timesInput = null;
    let everyDrop = null;
    let timesDrop = null;

    new Setting(c)
      .setName('注入间隔')
      .setDesc('每几轮带一次。正文会跟着系统提示词重发，间隔越大越省上下文')
      .addDropdown((dd) => {
        everyDrop = dd;
        return dd
          .addOption('1', '每轮都带')
          .addOption('2', '每 2 轮')
          .addOption('3', '每 3 轮')
          .addOption('5', '每 5 轮')
          .addOption('custom', '自定义…')
          .setValue([1, 2, 3, 5].includes(cadence.every) ? String(cadence.every) : 'custom')
          .onChange(async (v) => {
            if (v === 'custom') {
              // 框里已经有数就别覆盖它（那是主人刚敲的）
              if (everyInput && !String(everyInput.getValue() || '').trim()) {
                everyInput.setValue(String(cadence.every > 1 ? cadence.every : 3));
              }
              return;
            }
            this.plugin.settings.injectEvery = Number(v) || 1;
            if (everyInput) everyInput.setValue('');
            await this.plugin.saveSettings();
            new Notice('注入间隔：' + describeEvery(this.plugin.settings.injectEvery));
          });
      })
      .addText((txt) => {
        everyInput = txt;
        txt.setPlaceholder('自定义 1-99').onChange(async (raw) => {
          const s = String(raw == null ? '' : raw).trim();
          if (!s) return;
          // 手动填了数就说明用的是自定义档位，左边的下拉跟着切过去
          if (everyDrop) everyDrop.setValue('custom');
          const n = Number(s);
          this.plugin.settings.injectEvery = Number.isFinite(n) && n >= 1 ? Math.min(99, Math.floor(n)) : 1;
          await this.plugin.saveSettings();
          new Notice('注入间隔：' + describeEvery(this.plugin.settings.injectEvery));
        });
      });

    new Setting(c)
      .setName('注入次数')
      .setDesc('一共带几次；0 或留空表示不限期（手动清除为止）')
      .addDropdown((dd) => {
        timesDrop = dd;
        return dd
          .addOption('0', '不限期')
          .addOption('1', '只带 1 次')
          .addOption('3', '共 3 次')
          .addOption('5', '共 5 次')
          .addOption('custom', '自定义…')
          .setValue([0, 1, 3, 5].includes(cadence.times) ? String(cadence.times) : 'custom')
          .onChange(async (v) => {
            if (v === 'custom') {
              if (timesInput && !String(timesInput.getValue() || '').trim()) {
                timesInput.setValue(String(cadence.times > 0 ? cadence.times : 3));
              }
              return;
            }
            this.plugin.settings.injectTimes = Number(v) || 0;
            if (timesInput) timesInput.setValue('');
            await this.plugin.saveSettings();
            new Notice('注入次数：' + describeTimes(this.plugin.settings.injectTimes));
          });
      })
      .addText((txt) => {
        timesInput = txt;
        txt.setPlaceholder('自定义 0-99').onChange(async (raw) => {
          const s = String(raw == null ? '' : raw).trim();
          if (!s) return;
          // 手动填了数就说明用的是自定义档位，左边的下拉跟着切过去
          if (timesDrop) timesDrop.setValue('custom');
          const n = Number(s);
          this.plugin.settings.injectTimes = Number.isFinite(n) && n > 0 ? Math.min(99, Math.floor(n)) : 0;
          await this.plugin.saveSettings();
          new Notice('注入次数：' + describeTimes(this.plugin.settings.injectTimes));
        });
      });

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
        // 旧版连接器回执里没有 turns 字段：说明「带几轮」在那边不生效，
        // 界面得直说，不然你以为只带一次、其实每轮都在发。
        const cadenceKnown = items.every((x) => Object.prototype.hasOwnProperty.call(x, 'every'));
        if (this.injectedEl) {
          this.injectedEl.empty();
          if (items.length === 0) {
            this.injectedEl.setText('已注入：无');
          } else {
            this.injectedEl.createDiv({
              cls: 'bridge-line',
              text: `已注入 ${items.length} 篇：` + (cadenceKnown ? '' : '（连接器未升级，节奏不生效）'),
            });
            for (const item of items) {
              const row = this.injectedEl.createDiv({ cls: 'bridge-injected-item' });
              row.createSpan({
                cls: 'bridge-injected-name',
                text:
                  `《${item.title || '（无标题）'}》 · ${item.length} 字` +
                  (Number(item.every) > 1 ? ` · 每 ${item.every} 轮` : '') +
                  (Number(item.times) > 0 ? ` · 剩 ${Math.max(0, Number(item.remaining) || 0)} 次` : ''),
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

// 会话名优先用 DSH 的标题；没有就降级成「目录 · 时间 · 短 id」——总比一串 uuid 强。
function sessionLabel(s) {
  if (s && s.title) return s.title;
  const when = s && s.updatedAt ? new Date(s.updatedAt) : null;
  const stamp = when && !Number.isNaN(when.getTime())
    ? `${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')} ` +
      `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
    : '';
  return [tailPathOf(s && s.cwd, 1), stamp, String((s && s.sessionId) || '').slice(-6)].filter(Boolean).join(' · ');
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
    // 但当前会话所在的那个必须展开——不然你根本看不见自己在哪一篇。
    const plan = planTree(this.sessions, this.currentId);
    if (plan.currentKey) this.expanded.add(plan.currentKey);
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
    const plan = planTree(this.sessions, this.currentId);
    const { groups, visible, archivedCount } = plan;
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
        // 和选择笔记一样用行内标记，当前会话加个圆点，不另起一行文字说明
        if (active) row.createSpan({ cls: 'bridge-tree-dot', text: '●' });
        row.createSpan({ cls: 'bridge-tree-name', text: sessionLabel(s) });
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