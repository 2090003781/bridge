'use strict';
// Bridge · 主面板（整合视图）
// 左 1/3：状态、功能按钮、最近操作记录；右 2/3：与 DSH 会话的对话。

const { ItemView, Notice, Modal, Setting, TFolder, MarkdownRenderer } = require('obsidian');
const fs = require('node:fs');
const { parseLedger } = require('./ledger-reader.js');
const { reconcileInjection } = require('./settings.js');

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
    }).open();
  }

  async createAndBind() {
    const client = this.plugin.connector();
    if (!client.info()) {
      this.pushSystem('连接器未就绪，无法新建会话。');
      return;
    }
    const base = this.app.vault.adapter.getBasePath();
    const created = await client.createSession(base ? { cwd: base } : {});
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
        this.setStatus('连接断开：' + String((err && err.message) || err));
      });
  }

  disconnect() {
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
    this.messages.push({ role: 'user', text });
    this.inputEl.value = '';
    this.render();
    this.setStatus('发送中…');
    const res = await this.plugin.connector().sendTask({ message: text, sessionId: this.sessionId });
    if (!res || res.ok !== true) {
      const raw = (res && res.error && res.error.message) || '发送失败';
      this.setStatus('发送失败');
      if (/resume failed|not found/i.test(raw)) {
        // 典型情况：会话被删了，或者它当初用的 agent preset 已经不存在
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
  constructor(app, sessions, currentId, onPick) {
    super(app);
    this.sessions = sessions || [];
    this.currentId = currentId || null;
    this.onPick = onPick;
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
      }
    }
  }
}

module.exports = { BridgeChatView, VIEW_TYPE, NoteTreePickerModal, InjectionPanelModal, SessionTreeModal };