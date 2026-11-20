// Bridge · 标记集合：一个点 + 多处区域（像 Ctrl 不连续选择那样累加）
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  emptySet,
  setPoint,
  addRegion,
  removeAtCursor,
  describeSet,
  setForPath,
  withSet,
} = require('../src/lib/mark-store.js');

const pos = (line, ch = 0) => ({ line, ch });

test('打点：永远只有一个点，后打的覆盖先打的', () => {
  let s = emptySet();
  s = setPoint(s, pos(3, 4));
  assert.deepEqual(s.point, pos(3, 4));
  s = setPoint(s, pos(9, 0));
  assert.deepEqual(s.point, pos(9, 0));
  assert.equal(s.regions.length, 0, '打点不碰区域');
});

test('区域可以累加：多次选区各成一处，像 Ctrl 不连续选择', () => {
  let s = emptySet();
  s = addRegion(s, pos(1, 0), pos(2, 5));
  s = addRegion(s, pos(10, 0), pos(12, 0));
  assert.equal(s.regions.length, 2);
  assert.deepEqual(s.regions[0], { from: pos(1, 0), to: pos(2, 5) });
  assert.deepEqual(s.regions[1], { from: pos(10, 0), to: pos(12, 0) });
});

test('区域顺序反了就摆正；空选区不记', () => {
  let s = addRegion(emptySet(), pos(5, 3), pos(2, 1));
  assert.deepEqual(s.regions[0], { from: pos(2, 1), to: pos(5, 3) });
  s = addRegion(s, pos(7, 0), pos(7, 0));
  assert.equal(s.regions.length, 1, '空选区不该留下一处空标记');
});

test('同一处区域标两遍不重复', () => {
  let s = addRegion(emptySet(), pos(1, 0), pos(2, 0));
  s = addRegion(s, pos(1, 0), pos(2, 0));
  assert.equal(s.regions.length, 1);
});

test('清除指定：光标在哪处区域里就删哪处', () => {
  let s = emptySet();
  s = addRegion(s, pos(10, 0), pos(12, 0));
  s = addRegion(s, pos(30, 0), pos(31, 0));
  const r = removeAtCursor(s, pos(11, 2));
  assert.equal(r.removed, true);
  assert.equal(r.set.regions.length, 1);
  assert.deepEqual(r.set.regions[0], { from: pos(30, 0), to: pos(31, 0) });
});

test('清除指定：光标落在点标记那行，删的是点', () => {
  let s = setPoint(emptySet(), pos(5, 2));
  s = addRegion(s, pos(20, 0), pos(21, 0));
  const r = removeAtCursor(s, pos(5, 9));
  assert.equal(r.removed, true);
  assert.equal(r.set.point, null);
  assert.equal(r.set.regions.length, 1, '区域不该被误删');
});

test('清除指定：光标处没标记就什么都不删，并说清楚', () => {
  const s = addRegion(emptySet(), pos(10, 0), pos(12, 0));
  const r = removeAtCursor(s, pos(50, 0));
  assert.equal(r.removed, false);
  assert.equal(r.set.regions.length, 1);
});

test('人话描述：点、多处区域各说清楚', () => {
  assert.equal(describeSet(emptySet()), '');
  assert.equal(describeSet(setPoint(emptySet(), pos(38, 0))), '点标记第 39 行第 1 列');
  const two = addRegion(addRegion(emptySet(), pos(1, 0), pos(3, 0)), pos(10, 0), pos(10, 8));
  assert.equal(describeSet(two), '2 处区域：第 2→4 行、第 11 行');
});

test('按笔记存：换一篇各存各的，互不覆盖', () => {
  let all = [];
  all = withSet(all, 'a.md', setPoint(emptySet(), pos(1, 0)));
  all = withSet(all, 'b.md', addRegion(emptySet(), pos(2, 0), pos(3, 0)));
  assert.deepEqual(setForPath(all, 'a.md').point, pos(1, 0));
  assert.equal(setForPath(all, 'b.md').regions.length, 1);
  assert.deepEqual(setForPath(all, 'c.md'), emptySet());
});

test('整篇清空后不再留在列表里', () => {
  let all = withSet([], 'a.md', setPoint(emptySet(), pos(1, 0)));
  all = withSet(all, 'a.md', emptySet());
  assert.equal(all.length, 0, '空集合不该占一条记录');
});
