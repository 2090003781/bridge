// Bridge · 标记状态机
const test = require('node:test');
const assert = require('node:assert/strict');
const { nextMarkState, describeMarks, marksForPath, comparePos } = require('../src/lib/mark-store.js');

const p = (line, ch = 0) => ({ line, ch });

test('第一次按：在光标处落一个点', () => {
  const r = nextMarkState([], p(9, 4));
  assert.equal(r.mode, 'point');
  assert.deepEqual(r.marks, [p(9, 4)]);
});

test('同一个位置按两次：撤掉，不留一个看不见的标记', () => {
  const r = nextMarkState([p(9, 4)], p(9, 4));
  assert.equal(r.mode, 'empty');
  assert.deepEqual(r.marks, []);
});

test('第二次按在后面的位置：变成范围', () => {
  const r = nextMarkState([p(5, 0)], p(12, 3));
  assert.equal(r.mode, 'range');
  assert.deepEqual(r.marks, [p(5, 0), p(12, 3)]);
});

test('第二次按在前面的位置：自动摆正成 from → to', () => {
  const r = nextMarkState([p(20, 2)], p(4, 0));
  assert.deepEqual(r.marks, [p(4, 0), p(20, 2)]);
});

test('已经是范围再按：清空', () => {
  const r = nextMarkState([p(1, 0), p(5, 0)], p(30, 0));
  assert.equal(r.mode, 'empty');
  assert.deepEqual(r.marks, []);
});

test('位置无效时不乱改', () => {
  const r = nextMarkState([p(3, 0)], null);
  assert.deepEqual(r.marks, [p(3, 0)]);
});

test('描述：一个标记说行列', () => {
  assert.equal(describeMarks([p(9, 4)]), '标记在第 10 行第 5 列');
});

test('描述：范围说从哪到哪', () => {
  assert.equal(describeMarks([p(9, 0), p(20, 0)]), '标记范围第 10 → 21 行');
});

test('描述：同一行的范围不写两次行号', () => {
  assert.equal(describeMarks([p(9, 0), p(9, 5)]), '标记范围第 10 行');
});

test('没有标记时描述为空串，不留半句话', () => {
  assert.equal(describeMarks([]), '');
  assert.equal(describeMarks(null), '');
});

test('标记按文件隔离：换一篇就当没有', () => {
  const all = [{ path: 'a.md', marks: [p(1, 0)] }];
  assert.deepEqual(marksForPath(all, 'a.md'), [p(1, 0)]);
  assert.deepEqual(marksForPath(all, 'b.md'), []);
});

test('comparePos 先比行再比列', () => {
  assert.ok(comparePos(p(1, 9), p(2, 0)) < 0);
  assert.ok(comparePos(p(2, 0), p(2, 5)) < 0);
  assert.equal(comparePos(p(2, 5), p(2, 5)), 0);
});
