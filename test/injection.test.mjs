// Bridge 连接器 · 当前注入（纯逻辑）
// 注：以前还测过一条「按会话排队」的通道，那条路的消费者已经删了，
// 队列只进不出会漏内存，所以连测试一起删掉——现在只有「当前注入」这一条语义。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInjectionStore } from '../src/core/injection.mjs';

test('空内容与空会话被拒绝', () => {
  const store = createInjectionStore();
  assert.equal(store.add({ sessionId: 's1', content: '   ' }), null);
  assert.equal(store.add({ sessionId: '', content: 'x' }), null);
});

test('add 只是造记录，不许自己往内存里攒', () => {
  const store = createInjectionStore();
  for (let i = 0; i < 200; i += 1) store.add({ sessionId: 's1', content: 'x' + i });
  assert.equal(store.currentItems().length, 0, '没人 markCurrent 就不该留下任何东西');
});

test('markCurrent 之后才出现在当前注入里', () => {
  const store = createInjectionStore();
  const rec = store.add({ sessionId: 's1', content: '笔记 A', title: 'A.md' });
  assert.equal(store.currentItems().length, 0);
  store.markCurrent(rec);
  assert.equal(store.currentItems()[0].content, '笔记 A');
});

test('多篇并存：同标题覆盖、不同标题累加', () => {
  const store = createInjectionStore();
  store.markCurrent(store.add({ sessionId: 's1', content: 'A 正文', title: 'A.md' }));
  store.markCurrent(store.add({ sessionId: 's1', content: 'B 正文', title: 'B.md' }));
  assert.equal(store.currentItems().length, 2);
  store.markCurrent(store.add({ sessionId: 's1', content: 'A 新正文', title: 'A.md' }));
  const items = store.currentItems();
  assert.equal(items.length, 2);
  assert.equal(items.find((x) => x.title === 'A.md').content, 'A 新正文');
});

test('当前注入有上限，超出丢最旧', () => {
  const store = createInjectionStore({ maxCurrent: 2 });
  for (const n of ['A', 'B', 'C']) {
    store.markCurrent(store.add({ sessionId: 's1', content: n, title: n + '.md' }));
  }
  assert.deepEqual(store.currentItems().map((x) => x.title), ['B.md', 'C.md']);
});

test('clearCurrent 支持删单篇与清空', () => {
  const store = createInjectionStore();
  const a = store.add({ sessionId: 's1', content: 'A', title: 'A.md' });
  const b = store.add({ sessionId: 's1', content: 'B', title: 'B.md' });
  store.markCurrent(a);
  store.markCurrent(b);
  store.clearCurrent(a.id);
  assert.equal(store.currentItems().length, 1);
  store.clearCurrent();
  assert.equal(store.currentItems().length, 0);
});

test('默认不过期：一年后还在', () => {
  let now = 1000;
  const store = createInjectionStore({ now: () => now });
  store.markCurrent(store.add({ sessionId: 's1', content: 'A', title: 'A.md' }));
  now = 1000 + 365 * 24 * 60 * 60 * 1000;
  assert.equal(store.currentItems().length, 1);
});

test('显式给 ttlMs 仍会过期（能力保留）', () => {
  let now = 1000;
  const store = createInjectionStore({ ttlMs: 100, now: () => now });
  store.markCurrent(store.add({ sessionId: 's1', content: 'A', title: 'A.md' }));
  assert.equal(store.currentItems().length, 1);
  now = 1200;
  assert.equal(store.currentItems().length, 0);
});
