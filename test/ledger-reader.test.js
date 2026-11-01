// Bridge · 账本读取（日志界面用）
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLedger, filterEntries } = require('../src/lib/ledger-reader.js');

const SAMPLE = [
  '{"ts":"2026-10-25T10:00:00.000Z","client":"agent.dsh","op":"obsidian.command.list","tier":"read","ok":true,"ms":2,"args":"{}"}',
  '{"ts":"2026-10-25T10:01:00.000Z","client":"agent.dsh","op":"obsidian.note.read","tier":"read","ok":true,"ms":8,"args":"{\\"path\\":\\"a.md\\"}"}',
  '{"ts":"2026-10-25T10:02:00.000Z","client":"agent.dsh","op":"obsidian.note.delete","tier":"trust","ok":false,"ms":1,"args":"{\\"path\\":\\"b.md\\"}"}',
].join('\n');

test('解析 JSONL：返回条目与统计', () => {
  const r = parseLedger(SAMPLE);
  assert.equal(r.entries.length, 3);
  assert.equal(r.stats.total, 3);
  assert.equal(r.stats.ok, 2);
  assert.equal(r.stats.failed, 1);
  assert.equal(r.stats.avgMs, 4);
});

test('坏行被跳过并计数', () => {
  const r = parseLedger(SAMPLE + '\nnot-json\n');
  assert.equal(r.entries.length, 3);
  assert.equal(r.skipped, 1);
});

test('limit 取最后 N 条（时间顺序保持）', () => {
  const r = parseLedger(SAMPLE, { limit: 2 });
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].op, 'obsidian.note.read');
  assert.equal(r.entries[1].op, 'obsidian.note.delete');
});

test('按操作统计次数', () => {
  const r = parseLedger(SAMPLE);
  assert.equal(r.stats.byOp['obsidian.note.delete'], 1);
});

test('过滤：只看失败', () => {
  const { entries } = parseLedger(SAMPLE);
  const out = filterEntries(entries, { onlyFailed: true });
  assert.equal(out.length, 1);
  assert.equal(out[0].op, 'obsidian.note.delete');
});

test('过滤：关键字匹配 op / args / client', () => {
  const { entries } = parseLedger(SAMPLE);
  assert.equal(filterEntries(entries, { query: 'note.read' }).length, 1);
  assert.equal(filterEntries(entries, { query: 'b.md' }).length, 1);
  assert.equal(filterEntries(entries, { query: 'agent.dsh' }).length, 3);
});

test('空账本不报错', () => {
  const r = parseLedger('');
  assert.deepEqual(r.entries, []);
  assert.equal(r.stats.total, 0);
  assert.equal(r.stats.avgMs, 0);
});