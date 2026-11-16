// Bridge · 面板显示层：挡掉不是主人敲的字，工具调用只留一句状态
const test = require('node:test');
const assert = require('node:assert/strict');
const { displayTextOf, stripInjected, isCheckpoint } = require('../src/lib/panel-text.js');

const TZ = '<time-now>当前真实时间：2026-11-16 19:55:55 周一</time-now>\nBrowser time zone for this request: Etc/GMT-8. Interpret otherwise-unqualified dates and times in this zone.\nElapsed since the preceding user message: 7m 24s.';

test('整条只有时间戳注入：不显示', () => {
  assert.equal(displayTextOf({ role: 'user', text: TZ }), null);
});

test('压缩摘要（checkpoint）：整条不显示', () => {
  const text = 'This is an automatically generated checkpoint condensing an earlier span of the conversation.\n\n## Errors and Fixes\n- 一堆细节';
  assert.equal(isCheckpoint(text), true);
  assert.equal(displayTextOf({ role: 'user', text }), null);
});

test('面板注入的坐标行剥掉，只留主人那句话', () => {
  const text = '【光标】架构说明 · 在第 127 行第 1 列 【Obsidian】E 盘里 ai 文件夹下有么有？';
  assert.equal(stripInjected(text), 'E 盘里 ai 文件夹下有么有？');
  assert.equal(displayTextOf({ role: 'user', text }), 'E 盘里 ai 文件夹下有么有？');
});

test('主人自己敲的话原样显示（不剥）', () => {
  const text = '不要改为，直接写注入方式为传递路径';
  assert.equal(displayTextOf({ role: 'user', text }), text);
});

test('时间戳 + 正文混在一起时只留正文', () => {
  const text = TZ + '\n\n帮我把这段整合一下';
  assert.equal(displayTextOf({ role: 'user', text }), '帮我把这段整合一下');
});

test('助手回复不动，只trim', () => {
  assert.equal(displayTextOf({ role: 'assistant', text: '  ## 标题\n- 项  ' }), '  ## 标题\n- 项  '.trim());
  assert.equal(displayTextOf({ role: 'assistant', text: '   ' }), null);
});

test('空消息不显示', () => {
  assert.equal(displayTextOf({ role: 'user', text: '' }), null);
  assert.equal(displayTextOf(null), null);
  assert.equal(displayTextOf({ role: 'user' }), null);
});

test('真实注入前缀【Obsidian 当前窗口】：只留主人那句话', () => {
  const text =
    '【Obsidian 当前窗口】架构说明 · 项目/仿生神经元模型/架构说明.md\n465 行\n光标在第 1 行第 1 列\n（正文未附，需要时自行读取）\n\n【Obsidian】其实一直开着\n\n<time-now>当前真实时间：2026-11-16 23:57:33</time-now>';
  assert.equal(displayTextOf({ role: 'user', text }), '其实一直开着');
});

test('主人自己提一句【Obsidian】，不能把前半句切掉', () => {
  const text = '我说【Obsidian】是插件名，不是分隔符';
  assert.equal(displayTextOf({ role: 'user', text }), text);
});

test('注入块里的换行不会把正文的空行吃掉太多', () => {
  const text = '<time-now>x</time-now>\n\n\n我的一句话';
  assert.equal(stripInjected(text), '我的一句话');
});
