// Bridge · 会话选择树：怎么分组、当前是哪一篇
const test = require('node:test');
const assert = require('node:assert/strict');
const { tailPathOf, groupKeyOf, planTree } = require('../src/lib/session-tree.js');

const s = (over) => ({ sessionId: 's1', cwd: 'D:\\a\\b', updatedAt: '2026-11-17T10:00:00Z', ...over });

test('分组键优先用工作区标题', () => {
  assert.equal(groupKeyOf(s({ workspaceTitle: 'RAG' })), 'RAG');
});

test('旧连接器没有 workspaceTitle 字段：退回按 cwd 末两级', () => {
  assert.equal(groupKeyOf(s({ cwd: 'D:\\work\\proj' })), 'work\\proj');
  assert.equal(groupKeyOf(s({ cwd: 'E:/x/y/z' })), 'y\\z');
});

test('明确给了空标题：归到未分组，不硬编一个假名字', () => {
  assert.equal(groupKeyOf(s({ workspaceTitle: '' })), '(未分组)');
  assert.equal(groupKeyOf(null), '(未分组)');
});

test('归档的会话不进树', () => {
  const plan = planTree([s({ sessionId: 'a' }), s({ sessionId: 'b', archived: true })], 'a');
  assert.deepEqual(plan.visible.map((x) => x.sessionId), ['a']);
  assert.equal(plan.groups.size, 1);
});

test('当前会话能被找出来，并给出它所在的分组键', () => {
  const plan = planTree(
    [
      s({ sessionId: 'a', workspaceTitle: 'RAG' }),
      s({ sessionId: 'b', workspaceTitle: 'AI' }),
    ],
    'b'
  );
  assert.equal(plan.current.sessionId, 'b');
  assert.equal(plan.currentKey, 'AI');
});

test('当前会话不在列表里（被归档或删了）：current 为 null，不假装找到', () => {
  const plan = planTree([s({ sessionId: 'a', workspaceTitle: 'RAG' })], 'gone');
  assert.equal(plan.current, null);
  assert.equal(plan.currentKey, null);
});

test('没给当前会话时也返回 null', () => {
  assert.equal(planTree([s({})], null).current, null);
});

test('传入空列表 / null 都不炸', () => {
  assert.equal(planTree(null, 'x').visible.length, 0);
  assert.equal(planTree([], 'x').groups.size, 0);
});

test('路径尾巴：取最后 n 段，斜杠统一成反斜杠', () => {
  assert.equal(tailPathOf('D:/a/b/c', 1), 'c');
  assert.equal(tailPathOf('D:/a/b/c', 2), 'b\\c');
  assert.equal(tailPathOf('', 1), '(无工作区)');
});
