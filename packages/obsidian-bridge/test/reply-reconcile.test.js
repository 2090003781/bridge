// Bridge · 回复对账（兜底那条慢路）
const test = require('node:test');
const assert = require('node:assert/strict');
const { pickMissingReply, shouldReconcile } = require('../src/lib/reply-reconcile.js');

test('面板没显示过的最新回复，要补上', () => {
  const shown = [{ role: 'user', text: '你好' }];
  const transcript = [
    { role: 'user', text: '你好' },
    { role: 'assistant', text: '在的' },
  ];
  assert.deepEqual(pickMissingReply(shown, transcript), { role: 'assistant', text: '在的' });
});

test('已经显示过就不重复补', () => {
  const shown = [
    { role: 'user', text: '你好' },
    { role: 'assistant', text: '在的' },
  ];
  const transcript = [
    { role: 'user', text: '你好' },
    { role: 'assistant', text: '在的' },
  ];
  assert.equal(pickMissingReply(shown, transcript), null);
});

test('日志里还没有回复时什么都不补', () => {
  assert.equal(pickMissingReply([], [{ role: 'user', text: '你好' }]), null);
  assert.equal(pickMissingReply([], []), null);
  assert.equal(pickMissingReply(null, null), null);
});

test('空白的 assistant 消息不算回复', () => {
  const transcript = [
    { role: 'user', text: '你好' },
    { role: 'assistant', text: '   ' },
  ];
  assert.equal(pickMissingReply([], transcript), null);
});

test('取的是最后一条 assistant，不是第一条', () => {
  const transcript = [
    { role: 'assistant', text: '旧回复' },
    { role: 'user', text: '再来' },
    { role: 'assistant', text: '新回复' },
  ];
  assert.deepEqual(pickMissingReply([], transcript), { role: 'assistant', text: '新回复' });
});

test('还在跑就不插手，事件那条路可能只是慢', () => {
  assert.equal(shouldReconcile({ running: true, waiting: true, elapsedMs: 3000 }), false);
});

test('跑完了且面板还在等，就该对账', () => {
  assert.equal(shouldReconcile({ running: false, waiting: true, elapsedMs: 3000 }), true);
});

test('面板没在等时不对账', () => {
  assert.equal(shouldReconcile({ running: false, waiting: false, elapsedMs: 3000 }), false);
});

test('超过封顶时间就放弃，不无限轮询', () => {
  assert.equal(shouldReconcile({ running: false, waiting: true, elapsedMs: 200000, timeoutMs: 180000 }), false);
});

test('running 缺失时按「不确定」处理：先不插手', () => {
  // mine 找不到（会话列表还没刷新）时 running 是 undefined
  assert.equal(shouldReconcile({ running: undefined, waiting: true, elapsedMs: 3000 }), false);
});
