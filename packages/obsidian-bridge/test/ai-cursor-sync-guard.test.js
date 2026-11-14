// Bridge · 跟随同步的守卫（这是审查发现的覆盖缺口）
// 变异验证过：把它改成恒 true，下面第一条就会红。
const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldMapThrough } = require('../src/lib/ai-cursor-sync.js');

const AI = Symbol('aiEdit');

const tr = (isAi) => ({ annotation: (a) => (isAi && a === AI ? true : undefined) });

test('AI 自己改的：不映射（否则位置会被挪两次）', () => {
  assert.equal(shouldMapThrough({ docChanged: true, transactions: [tr(true)] }, AI), false);
});

test('用户改的：要映射', () => {
  assert.equal(shouldMapThrough({ docChanged: true, transactions: [tr(false)] }, AI), true);
});

test('一次更新里混着 AI 和用户的改动：任一是 AI 就整批不映射', () => {
  assert.equal(shouldMapThrough({ docChanged: true, transactions: [tr(false), tr(true)] }, AI), false);
});

test('文档没变就不映射', () => {
  assert.equal(shouldMapThrough({ docChanged: false, transactions: [tr(false)] }, AI), false);
});

test('缺字段时安静返回 false，不抛', () => {
  assert.equal(shouldMapThrough(null, AI), false);
  assert.equal(shouldMapThrough({}, AI), false);
  assert.equal(shouldMapThrough({ docChanged: true }, AI), true);
});
