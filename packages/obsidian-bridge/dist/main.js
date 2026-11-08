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

__define('lib/chat-view.js', function (module, exports, require) {
'use strict';
// Bridge · 主面板（整合视图）
// 左 1/3：状态、功能按钮、最近操作记录；右 2/3：与 DSH 会话的对话。

const { ItemView, Notice, Modal, Setting, TFolder, MarkdownRenderer } = require('obsidian');
const fs = require('node:fs');
const { parseLedger } = __req('lib/ledger-reader.js');
const { reconcileInjection } = __req('lib/settings.js');

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

    const inputWrap = root.createDiv({ cls: 'bridge-chat-input' });
    this.inputEl = inputWrap.createEl('textarea', {
      cls: 'bridge-chat-textarea',
      attr: { placeholder: '跟 DSH 说点什么…（Enter 发送，Shift+Enter 换行）', rows: '3' },
    });
    // queue = 排队等这一轮结束；steer = 立刻打断当前这一轮
    this.steerBtn = inputWrap.createEl('button', { cls: 'bridge-chat-steer', text: '打断' });
    this.steerBtn.title = '默认排队（等这一轮结束）。点亮「打断」则立刻插进当前这一轮。';
    this.steerBtn.onClickEvent(() => {
      this.steerMode = !this.steerMode;
      this.steerBtn.toggleClass('is-on', this.steerMode);
      new Notice(this.steerMode ? '发送模式：打断当前一轮' : '发送模式：排队等待');
    });
    this.sendBtn = inputWrap.createEl('button', { cls: 'bridge-chat-send', text: '发送' });
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
      if (text) {
        this.assistantBuffer += text;
        this.render();
      }
      return;
    }
    if (type === 'turn/end') {
      if (this.assistantBuffer) {
        this.messages.push({ role: 'assistant', text: this.assistantBuffer });
        this.assistantBuffer = '';
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
    await this.deliver(parts, false);
  }

  // 真正投递：parts 多于一条时合并成一段（中间空行分隔，保留原样）
  async deliver(parts, isSteer) {
    const text = parts.join('\n');
    this.messages.push({ role: 'user', text });
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
    }
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

  render() {
    if (!this.listEl) return;
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
    this.listEl.scrollTop = this.listEl.scrollHeight;
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
      // 这个工作区下也可以直接新建（不用回面板点「新建会话」）
      const wsId = rows.find((x) => x.workspaceId)?.workspaceId || null;
      const addRow = tree.createDiv({ cls: 'bridge-tree-row bridge-tree-new' });
      addRow.style.paddingLeft = '20px';
      addRow.createSpan({ cls: 'bridge-tree-name', text: '＋ 在此工作区新建会话' });
      addRow.onClickEvent(() => {
        this.close();
        try { this.onNew(wsId); } catch { /* ignore */ }
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

function createDriver(deps = {}) {
  const registry = createRegistry(deps);
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

function requireEditor(ctx) {
  const active = activeEditor(ctx.obsidian);
  if (!active) throw opError('no-active-editor', '没有打开的 Markdown 编辑器（先在 Obsidian 里打开一篇笔记）');
  return active;
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
    summary: '当前活跃编辑器的状态：路径 / 光标 / 选区 / 行数',
    run(ctx) {
      const active = activeEditor(ctx.obsidian);
      if (!active) return { available: false, reason: 'no-active-editor' };
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
    summary: '在光标处插入文本（position=end 则追加到文末）；保留撤销栈',
    run(ctx) {
      const active = requireEditor(ctx);
      const text = ctx.args && ctx.args.text;
      if (typeof text !== 'string' || text.length === 0) throw opError('bad-args', '缺少 text');
      const ed = active.editor;
      const position = ctx.args.position === 'end' ? 'end' : 'cursor';

      if (position === 'end' && typeof ed.setCursor === 'function' && typeof ed.getLine === 'function') {
        const last = typeof ed.lastLine === 'function' ? ed.lastLine() : Math.max(0, (ed.lineCount() || 1) - 1);
        ed.setCursor({ line: last, ch: String(ed.getLine(last) || '').length });
      }

      if (typeof ed.replaceSelection === 'function') {
        ed.replaceSelection(text);
      } else if (typeof ed.setValue === 'function' && typeof ed.getValue === 'function') {
        ed.setValue(`${ed.getValue()}${text}`);
      } else {
        throw opError('unsupported', '当前编辑器不支持插入');
      }

      return {
        inserted: true,
        position,
        cursor: typeof ed.getCursor === 'function' ? ed.getCursor() : null,
      };
    },
  },
  {
    id: 'obsidian.editor.replace',
    tier: 'write',
    summary: '替换选中内容；给了 from/to 就先选中那个范围再替换',
    run(ctx) {
      const active = requireEditor(ctx);
      const text = ctx.args && ctx.args.text;
      if (typeof text !== 'string') throw opError('bad-args', '缺少 text');
      const ed = active.editor;
      const from = ctx.args.from;
      const to = ctx.args.to;
      const hadRange = Boolean(from && to && typeof ed.setSelection === 'function');
      if (hadRange) ed.setSelection(from, to);
      if (typeof ed.replaceSelection !== 'function') throw opError('unsupported', '当前编辑器不支持替换');
      ed.replaceSelection(text);
      return { replaced: true, hadRange, target: hadRange ? { from, to } : 'selection' };
    },
  },
  {
    id: 'obsidian.editor.cursor',
    tier: 'write',
    summary: '把光标移到指定行/列，并滚动到可见位置',
    run(ctx) {
      const active = requireEditor(ctx);
      const line = Number(ctx.args && ctx.args.line);
      if (!Number.isInteger(line) || line < 0) throw opError('bad-args', '缺少合法的 line（0 起）');
      const ch = Number.isInteger(ctx.args.ch) && ctx.args.ch >= 0 ? ctx.args.ch : 0;
      const ed = active.editor;
      if (typeof ed.setCursor !== 'function') throw opError('unsupported', '当前编辑器不支持定位');
      ed.setCursor({ line, ch });
      if (typeof ed.scrollIntoView === 'function') {
        ed.scrollIntoView({ from: { line, ch }, to: { line, ch } }, true);
      }
      return { cursor: { line, ch } };
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

const { Plugin, Notice, PluginSettingTab, Setting } = require('obsidian');
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

const INFO_DIR = path.join(os.homedir(), '.obsidian-bridge');
const CONNECTOR_FILE = path.join(os.homedir(), '.dsh-bridge', 'connector.json');

module.exports = class ObsidianBridgePlugin extends Plugin {
  async onload() {
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

    const driver = createDriver({ obsidian: this.app });
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
      const driver = createDriver({ obsidian: this.app });
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
