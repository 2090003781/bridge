'use strict';
// Bridge · Obsidian 插件入口
// 定位：独立插件，与枢阁（8790 / 8848）无任何联系，只干 Obsidian 内部能力。
// 生命周期：Obsidian 开着 = Bridge 在；服务只监听回环，除 /health 外都要 token。

const { Plugin, Notice, PluginSettingTab, Setting } = require('obsidian');
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
      this.app.workspace.onLayoutReady(() => {
        this.activateChat();
      });
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