// Bridge · AI 自己的光标
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAiCursor } = require('../src/lib/ai-cursor.js');

const p = (line, ch = 0) => ({ line, ch });

test('新光标从行首开始，没有选区', () => {
  const cur = createAiCursor();
  const st = cur.forPath('a.md');
  assert.deepEqual(st.head, p(0, 0));
  assert.equal(st.anchor, null);
  assert.equal(cur.range('a.md').empty, true);
});

test('移动光标会清掉选区（和真实光标语义一致）', () => {
  const cur = createAiCursor();
  cur.select('a.md', p(1, 0), p(3, 0));
  assert.equal(cur.range('a.md').empty, false);
  cur.move('a.md', p(5, 2));
  assert.equal(cur.range('a.md').empty, true);
  assert.deepEqual(cur.range('a.md').from, p(5, 2));
});

test('正向选区：from < to', () => {
  const cur = createAiCursor();
  cur.select('a.md', p(2, 0), p(7, 3));
  const r = cur.range('a.md');
  assert.deepEqual(r.from, p(2, 0));
  assert.deepEqual(r.to, p(7, 3));
});

test('反向选区也摆正成 from <= to', () => {
  const cur = createAiCursor();
  cur.select('a.md', p(7, 3), p(2, 0));
  const r = cur.range('a.md');
  assert.deepEqual(r.from, p(2, 0));
  assert.deepEqual(r.to, p(7, 3));
});

test('同一位置选两次等于空选区', () => {
  const cur = createAiCursor();
  cur.select('a.md', p(3, 1), p(3, 1));
  assert.equal(cur.range('a.md').empty, true);
});

test('换一篇文件不会继承上一篇的位置', () => {
  const cur = createAiCursor();
  cur.move('a.md', p(50, 9));
  const other = cur.forPath('b.md');
  assert.deepEqual(other.head, p(0, 0));
  assert.equal(other.anchor, null);
});

test('换回来也是从头开始：它按文件归属，不缓存多篇', () => {
  const cur = createAiCursor();
  cur.move('a.md', p(50, 9));
  cur.forPath('b.md');
  const back = cur.forPath('a.md');
  assert.deepEqual(back.head, p(0, 0));
});

test('负数和非数字的位置被夹成 0，不产生非法坐标', () => {
  const cur = createAiCursor();
  cur.move('a.md', { line: -5, ch: -2 });
  assert.deepEqual(cur.range('a.md').from, p(0, 0));
  cur.move('a.md', { line: 'x', ch: null });
  assert.deepEqual(cur.range('a.md').from, p(0, 0));
});

test('快照是拷贝：外面改它不影响内部状态', () => {
  const cur = createAiCursor();
  cur.move('a.md', p(3, 4));
  const snap = cur.snapshot();
  snap.head.line = 999;
  assert.deepEqual(cur.range('a.md').from, p(3, 4));
});
