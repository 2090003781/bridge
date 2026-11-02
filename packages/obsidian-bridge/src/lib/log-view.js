'use strict';
// Bridge · 操作记录（弹窗）
// 两个页签：操作账本 / 运行日志。从主面板的「操作记录」按钮打开。

const { Modal } = require('obsidian');
const fs = require('node:fs');
const { parseLedger, filterEntries } = require('./ledger-reader.js');

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