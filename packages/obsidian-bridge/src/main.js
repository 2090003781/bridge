'use strict';
// Bridge · Obsidian 插件入口
// 定位：独立插件，与枢阁（8790 / 8848）无任何联系，只干 Obsidian 内部能力。
// 生命周期：Obsidian 开着 = Bridge 在；服务只监听回环，除 /health 外都要 token。

const { Plugin, Notice, PluginSettingTab, Setting, Modal } = require('obsidian');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDriver } = require('./lib/driver.js');
const { createPermissions, LEVELS, LEVEL_LABEL } = require('./lib/permissions.js');
const { createLedger } = require('./lib/ledger.js');
const { startCoreServer } = require('./lib/server.js');
const { createInfoStore } = require('./lib/info.js');
const { reconcileInjection } = require('./lib/settings.js');
const { nextRotationDelay, describeTtl, TOKEN_TTL_OPTIONS } = require('./lib/token-lifecycle.js');
const { normalizeSettings } = require('./lib/settings.js');
const { BridgeChatView, VIEW_TYPE: CHAT_VIEW_TYPE } = require('./lib/chat-view.js');
const { createConnectorClient } = require('./lib/connector-client.js');
const { BridgeLogModal } = require('./lib/log-view.js');
const { createPluginLog } = require('./lib/plugin-log.js');
const { createMarkExtension, refreshAllMarkViews } = require('./lib/mark-decoration.js');
const { nextMarkState, describeMarks, marksForPath } = require('./lib/mark-store.js');

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
        return { file: activeView.file, editor: activeView.editor, focused: true };
      }
      // ② 焦点在面板/侧栏：看主编辑区最上层那篇
      const top = mainMarkdownView();
      if (top) return { file: top.file, editor: top.editor, focused: false };

      const leaves =
        typeof workspace.getLeavesOfType === 'function' ? workspace.getLeavesOfType('markdown') : [];
      // ③ 上一轮那篇还开着
      if (lastPath) {
        for (const leaf of leaves) {
          const v = leaf && leaf.view;
          if (isMdView(v) && v.file.path === lastPath) {
            return { file: v.file, editor: v.editor, focused: false };
          }
        }
      }
      // ④ 兜底：还开着的任意一篇
      for (let i = leaves.length - 1; i >= 0; i -= 1) {
        const v = leaves[i] && leaves[i].view;
        if (isMdView(v)) return { file: v.file, editor: v.editor, focused: false };
      }
      return null;
    };

    const describe = (file, editor, focused) => {
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
        // 焦点在不在编辑器里：不在的时候光标是「最后一次停的位置」，不是实时值
        focused,
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
      const note = describe(cur.file, cur.editor, cur.focused);
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