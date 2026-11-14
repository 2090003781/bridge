// Bridge · AI 光标跟随文字移动
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAiCursor } = require('../src/lib/ai-cursor.js');

// 极简的 doc：够 offsetOfPos / toPos 用
function makeDoc(text) {
  const rows = text.split('\n');
  const starts = [];
  let off = 0;
  for (const row of rows) {
    starts.push(off);
    off += row.length + 1;
  }
  return {
    length: text.length,
    lines: rows.length,
    line: (n) => {
      const i = Math.min(Math.max(1, n), rows.length) - 1;
      return { number: i + 1, from: starts[i], to: starts[i] + rows[i].length };
    },
    lineAt: (pos) => {
      let i = 0;
      while (i + 1 < starts.length && starts[i + 1] <= pos) i += 1;
      return { number: i + 1, from: starts[i], to: starts[i] + rows[i].length };
    },
  };
}

// 假 ChangeSet：只实现 mapPos，delta 表示「净插入多少字符、从哪个 offset 开始」
function fakeChanges(delta, at) {
  return {
    mapPos: (pos, bias) => {
      if (pos < at) return pos;
      if (pos === at) return bias >= 0 ? pos + delta : pos;
      return pos + delta;
    },
  };
}

test('前面插了一行：AI 光标跟着下移一行，仍贴原来那段字', () => {
  const cur = createAiCursor();
  cur.move('a.md', { line: 2, ch: 3 }); // 指向第三行第 4 列

  const before = makeDoc('AAA\nBBB\nCCC\nDDD');
  const after = makeDoc('NEW\nAAA\nBBB\nCCC\nDDD');
  const ok = cur.mapThrough('a.md', before, fakeChanges(4, 0), after);

  assert.equal(ok, true);
  const r = cur.range('a.md');
  assert.deepEqual(r.from, { line: 3, ch: 3 }, '应该跟着挪到第 4 行');
});

test('改在光标后面：位置不动', () => {
  const cur = createAiCursor();
  cur.move('a.md', { line: 0, ch: 1 });
  const before = makeDoc('AAA\nBBB');
  const after = makeDoc('AAA\nBBB-加长');
  cur.mapThrough('a.md', before, fakeChanges(3, 7), after);
  assert.deepEqual(cur.range('a.md').from, { line: 0, ch: 1 });
});

test('前面删掉内容：位置前移，不会跑到字中间', () => {
  const cur = createAiCursor();
  cur.move('a.md', { line: 1, ch: 2 }); // 第二行第 3 列
  const before = makeDoc('AAA\nBBB');
  const after = makeDoc('BBB'); // 把第一行连换行删了，净 -4
  cur.mapThrough('a.md', before, fakeChanges(-4, 0), after);
  assert.deepEqual(cur.range('a.md').from, { line: 0, ch: 2 });
});

test('不是当前这一篇：一个字都不动', () => {
  const cur = createAiCursor();
  cur.move('a.md', { line: 3, ch: 1 });
  const before = makeDoc('X\nY');
  const after = makeDoc('X\nY\nZ');
  const ok = cur.mapThrough('b.md', before, fakeChanges(2, 4), after);
  assert.equal(ok, false);
  assert.deepEqual(cur.range('a.md').from, { line: 3, ch: 1 });
});

test('选区两端一起映射，范围不会反过来', () => {
  const cur = createAiCursor();
  cur.select('a.md', { line: 1, ch: 0 }, { line: 2, ch: 2 });
  const before = makeDoc('A\nBB\nCCC');
  const after = makeDoc('NEW\nA\nBB\nCCC');
  cur.mapThrough('a.md', before, fakeChanges(4, 0), after);
  const r = cur.range('a.md');
  assert.deepEqual(r.from, { line: 2, ch: 0 });
  assert.deepEqual(r.to, { line: 3, ch: 2 });
  assert.equal(r.empty, false);
});

test('缺参数时安静返回，不抛', () => {
  const cur = createAiCursor();
  cur.move('a.md', { line: 0, ch: 0 });
  assert.equal(cur.mapThrough('a.md', null, null, null), false);
  assert.equal(cur.mapThrough('a.md', makeDoc('a'), null, makeDoc('a')), false);
});
