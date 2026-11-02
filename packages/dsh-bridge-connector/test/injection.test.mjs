// Bridge 连接器 · 当前注入（纯逻辑）
// 注：以前还测过一条「按会话排队」的通道，那条路的消费者已经删了，
// 队列只进不出会漏内存，所以连测试一起删掉——现在只有「当前注入」这一条语义。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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


// ── 落盘：注入内容要活过 DSH 重启 ────────────────────────────────────────
function tmpStateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-inject-'));
  return path.join(dir, 'injections.json');
}

test('落盘后重建 store 能读回注入内容', () => {
  const file = tmpStateFile();
  const a = createInjectionStore({ file });
  a.markCurrent(a.add({ sessionId: 's1', content: '原则区正文', title: '记忆/原则区.md' }));

  // 模拟 DSH 重启：全新 store，只给同一个文件
  const b = createInjectionStore({ file });
  const items = b.currentItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '记忆/原则区.md');
  assert.equal(items[0].content, '原则区正文');
});

test('清空后文件里也没了', () => {
  const file = tmpStateFile();
  const a = createInjectionStore({ file });
  a.markCurrent(a.add({ sessionId: 's1', content: 'x', title: 'A.md' }));
  a.clearCurrent();

  const b = createInjectionStore({ file });
  assert.equal(b.currentItems().length, 0);
});

test('删单篇只影响那一篇，其余留在文件里', () => {
  const file = tmpStateFile();
  const a = createInjectionStore({ file });
  const one = a.add({ sessionId: 's1', content: 'A', title: 'A.md' });
  a.markCurrent(one);
  a.markCurrent(a.add({ sessionId: 's1', content: 'B', title: 'B.md' }));
  a.clearCurrent(one.id);

  const b = createInjectionStore({ file });
  assert.deepEqual(b.currentItems().map((x) => x.title), ['B.md']);
});

test('文件损坏时从空开始，不抛错', () => {
  const file = tmpStateFile();
  fs.writeFileSync(file, '{broken', 'utf8');
  const store = createInjectionStore({ file });
  assert.equal(store.currentItems().length, 0);
  // 还能继续用，并且能把文件修好
  store.markCurrent(store.add({ sessionId: 's1', content: 'y', title: 'Y.md' }));
  assert.equal(createInjectionStore({ file }).currentItems().length, 1);
});

test('重启后 id 不会和旧的撞', () => {
  const file = tmpStateFile();
  const a = createInjectionStore({ file });
  const first = a.add({ sessionId: 's1', content: 'A', title: 'A.md' });
  a.markCurrent(first);

  const b = createInjectionStore({ file });
  const second = b.add({ sessionId: 's1', content: 'B', title: 'B.md' });
  assert.notEqual(second.id, first.id);
});

test('不传 file 时保持纯内存，不碰磁盘', () => {
  const store = createInjectionStore();
  store.markCurrent(store.add({ sessionId: 's1', content: 'x', title: 'A.md' }));
  assert.equal(store.currentItems().length, 1);
  assert.equal(createInjectionStore().currentItems().length, 0);
});


// ── 实时跟随：注入存路径，渲染时读磁盘最新内容 ──────────────────────────
function tmpVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vault-'));
  return dir;
}

test('注入只记路径，渲染时读到最新内容', () => {
  const vault = tmpVault();
  const note = path.join(vault, 'note.md');
  fs.writeFileSync(note, '第一版内容', 'utf8');

  const store = createInjectionStore({ file: null });
  store.markCurrent(store.add({ sessionId: 's', path: 'note.md', absPath: note, title: 'note.md' }));
  assert.equal(store.currentItems()[0].content, '第一版内容');

  fs.writeFileSync(note, '第二版内容（更长一点）', 'utf8');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(note, future, future);

  assert.equal(store.currentItems()[0].content, '第二版内容（更长一点）', '笔记改了要跟着变');
});

test('落盘记录里不带正文，只有路径', () => {
  const vault = tmpVault();
  const note = path.join(vault, 'note.md');
  fs.writeFileSync(note, '很长的正文'.repeat(100), 'utf8');
  const stateFile = path.join(vault, 'state.json');

  const store = createInjectionStore({ file: stateFile });
  store.markCurrent(store.add({ sessionId: 's', path: 'note.md', absPath: note, title: 'note.md' }));

  const raw = fs.readFileSync(stateFile, 'utf8');
  assert.ok(!raw.includes('很长的正文'), '文件里不该存正文，否则笔记改了也没意义');
  assert.ok(raw.includes('note.md'), '要存路径');
});

test('文件被删了就用最后一次读到的内容，不当成空', () => {
  const vault = tmpVault();
  const note = path.join(vault, 'gone.md');
  fs.writeFileSync(note, '删之前的内容', 'utf8');

  const store = createInjectionStore({ file: null });
  store.markCurrent(store.add({ sessionId: 's', path: 'gone.md', absPath: note, title: 'gone.md' }));
  assert.equal(store.currentItems()[0].content, '删之前的内容');

  fs.unlinkSync(note);
  assert.equal(store.currentItems()[0].content, '删之前的内容', '删了也要保留最后一次内容');
});

test('从没读到过内容的路径，标记成读不到而不是空白', () => {
  const vault = tmpVault();
  const store = createInjectionStore({ file: null });
  store.markCurrent(
    store.add({ sessionId: 's', path: 'nope.md', absPath: path.join(vault, 'nope.md'), title: 'nope.md' })
  );
  const item = store.currentItems()[0];
  assert.ok(item.content.includes('读不到'), '要明确告诉模型这里没有内容，而不是给空串');
});

test('旧的纯正文记录仍然能用（向后兼容）', () => {
  const store = createInjectionStore({ file: null });
  store.markCurrent(store.add({ sessionId: 's', content: '老格式的快照', title: 'old.md' }));
  assert.equal(store.currentItems()[0].content, '老格式的快照');
});

test('实时读到的内容超过预算会被截断', () => {
  const vault = tmpVault();
  const note = path.join(vault, 'big.md');
  fs.writeFileSync(note, 'a'.repeat(600 * 1024), 'utf8');

  const store = createInjectionStore({ file: null, maxContentChars: 512 * 1024 });
  store.markCurrent(store.add({ sessionId: 's', path: 'big.md', absPath: note, title: 'big.md' }));
  const content = store.currentItems()[0].content;
  assert.ok(content.length < 600 * 1024, '超预算要截断');
  assert.ok(content.length > 0);
});


test('有路径时，附带的选区内容拼在正文后面（选区不在文件里）', () => {
  const vault = tmpVault();
  const note = path.join(vault, 'note.md');
  fs.writeFileSync(note, '整篇正文', 'utf8');

  const store = createInjectionStore({ file: null });
  store.markCurrent(
    store.add({
      sessionId: 's',
      path: 'note.md',
      absPath: note,
      content: '这是用户选中的一段',
      title: 'note.md',
    })
  );

  const content = store.currentItems()[0].content;
  assert.ok(content.includes('整篇正文'), '正文要实时读进来');
  assert.ok(content.includes('这是用户选中的一段'), '选区也要带上');
  assert.ok(content.indexOf('整篇正文') < content.indexOf('这是用户选中的一段'), '正文在前、选区在后');
});
