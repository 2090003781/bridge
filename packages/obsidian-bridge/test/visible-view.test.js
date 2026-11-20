// Bridge · 「屏幕上那篇」到底怎么认
const test = require('node:test');
const assert = require('node:assert/strict');
const { pickVisibleView, collectVisibleViews } = require('../src/lib/visible-view.js');

const md = (path) => ({ path, editor: {}, file: { path } });
const isMd = (v) => Boolean(v && v.editor && v.file);

// 一个标签组：children + currentTab
const tabs = (views, currentTab = 0) => ({
  type: 'tabs',
  currentTab,
  children: views.map((v) => ({ type: 'leaf', view: v })),
});

const split = (...children) => ({ type: 'split', children });

test('单一标签组：认 currentTab 指的那一页，不是第一个', () => {
  const root = split(tabs([md('a.md'), md('b.md'), md('c.md')], 1));
  assert.equal(pickVisibleView(root, isMd).path, 'b.md');
});

test('currentTab 指到非 markdown：往下找，别硬塞一个看不见的', () => {
  const root = split(tabs([md('a.md'), { view: null }], 1));
  assert.equal(pickVisibleView(root, isMd), null);
});

test('两个分组：每个分组各出一个候选，优先给「活动」那个', () => {
  const c = md('c.md');
  const left = tabs([md('a.md'), md('b.md')], 1);
  const right = tabs([c], 0);
  const root = split(left, right);
  const all = collectVisibleViews(root, isMd);
  assert.deepEqual(all.map((v) => v.path), ['b.md', 'c.md']);
  // 活动视图传实例（运行时拿到的就是同一个对象），按引用认
  assert.equal(pickVisibleView(root, isMd, c).path, 'c.md');
  assert.equal(pickVisibleView(root, isMd).path, 'b.md');
});

test('嵌套分组：selected 的子树里继续按 currentTab 走', () => {
  const inner = tabs([md('x.md'), md('y.md')], 1);
  const outer = { type: 'tabs', currentTab: 0, children: [{ type: 'leaf', children: [inner] }] };
  assert.equal(pickVisibleView(split(outer), isMd).path, 'y.md');
});

test('没有 currentTab 的节点：按子节点顺序兜底', () => {
  const root = split({ type: 'leaf', view: md('only.md') });
  assert.equal(pickVisibleView(root, isMd).path, 'only.md');
});

test('空布局 / null 不炸', () => {
  assert.equal(pickVisibleView(null, isMd), null);
  assert.equal(pickVisibleView(split(), isMd), null);
  assert.deepEqual(collectVisibleViews(undefined, isMd), []);
});

test('深度有上限：太深的树不会无限往下钻', () => {
  let node = { type: 'leaf', view: md('deep.md') };
  for (let i = 0; i < 12; i += 1) node = { type: 'split', children: [node] };
  assert.equal(pickVisibleView(node, isMd), null);
});
