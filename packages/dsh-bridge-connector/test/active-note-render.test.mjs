// Bridge 连接器 · 「当前打开的笔记」渲染
// 判据：只给坐标和定位，正文必须明确说「不在这里」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderActiveNote } from '../src/core/active-note.mjs';

test('没有笔记时不产出任何文本', () => {
  assert.equal(renderActiveNote(null), '');
  assert.equal(renderActiveNote({}), '');
  assert.equal(renderActiveNote({ path: '' }), '');
});

test('只有路径也能看懂，并且明确说不带正文', () => {
  const text = renderActiveNote({ path: '日记/今天.md' });
  assert.match(text, /【Obsidian 当前窗口】日记\/今天\.md/);
  assert.match(text, /正文未附/);
});

test('篇幅和修改时间写出来，光标和小节一概不提', () => {
  const text = renderActiveNote({
    path: '项目/架构说明.md',
    title: '架构说明',
    charCount: 7083,
    lineCount: 201,
    updatedAt: '2026-11-08 19:42',
    cursor: { line: 99, ch: 4 },
    heading: '## 2.4 点亮判据',
  });

  assert.match(text, /架构说明/);
  assert.match(text, /7083 字 \/ 201 行/);
  assert.match(text, /改于 2026-11-08 19:42/);
  // 光标位置彻底不报了：指着哪一句交给标记
  assert.doesNotMatch(text, /光标/);
  assert.doesNotMatch(text, /小节/);
  assert.doesNotMatch(text, /第 100 行/);
});

test('选区有范围、字数、开头预览', () => {
  const text = renderActiveNote({
    path: 'a.md',
    lineCount: 50,
    cursor: { line: 9, ch: 0 },
    selection: { fromLine: 8, fromCh: 0, toLine: 12, toCh: 3, chars: 36, preview: '这一段被选中了' },
  });

  assert.match(text, /选中第 9→13 行（36 字）/);
  assert.match(text, /：「这一段被选中了」/);
});

test('同一行内的选区只说一行', () => {
  const text = renderActiveNote({
    path: 'a.md',
    cursor: { line: 2, ch: 5 },
    selection: { fromLine: 2, fromCh: 0, toLine: 2, toCh: 5, chars: 5 },
  });
  assert.match(text, /选中第 3 行/);
  assert.doesNotMatch(text, /→/);
});

test('确认过没有选区时明说，不让人误以为漏了', () => {
  const text = renderActiveNote({ path: 'a.md', cursor: { line: 0, ch: 0 }, checked: true });
  assert.match(text, /没有选中文字/);
});

test('没确认过就不提选区，不编造', () => {
  const text = renderActiveNote({ path: 'a.md', cursor: { line: 0, ch: 0 } });
  assert.doesNotMatch(text, /没有选中文字/);
  assert.doesNotMatch(text, /有选区/);
});

test('超长标题和预览被截断，不把提示词撑爆', () => {
  const long = '很长的标题'.repeat(100);
  const text = renderActiveNote({
    path: 'a.md',
    title: long,
    heading: long,
    cursor: { line: 1, ch: 0 },
    selection: { fromLine: 1, toLine: 2, chars: 900, preview: long },
  });
  assert.ok(text.length < 900, 'total length should stay small, got ' + text.length);
  assert.match(text, /…/);
});

test('路径里的换行和多余空白被压平，不破坏提示词结构', () => {
  const text = renderActiveNote({ path: 'a\nb  c.md' });
  assert.match(text, /【Obsidian 当前窗口】a b c\.md/);
});


// ── 标记那一行：只有真指着什么才带，且必须短 ──
import { renderMarksLine, marksKeyOf } from '../src/core/active-note.mjs';

test('有标记就报一行，没有就不说', () => {
  const withMark = renderMarksLine({
    path: '项目/架构说明.md',
    title: '架构说明',
    regions: [{ from: { line: 33, ch: 120 }, to: { line: 33, ch: 151 } }],
  });
  assert.match(withMark, /^【标记】架构说明/);
  assert.match(withMark, /区域 1 处：第 34 行/);
  assert.doesNotMatch(withMark, /光标/);

  assert.equal(renderMarksLine({ path: 'a.md', regions: [] }), '');
  assert.equal(renderMarksLine({ path: 'a.md' }), '');
});

test('点标记和区域可以同时存在，各报各的', () => {
  const line = renderMarksLine({
    path: 'a.md',
    title: 'A',
    point: { line: 4, ch: 0 },
    regions: [
      { from: { line: 9, ch: 0 }, to: { line: 11, ch: 0 } },
      { from: { line: 20, ch: 0 }, to: { line: 21, ch: 0 } },
    ],
  });
  assert.match(line, /标记第 5 行第 1 列/);
  assert.match(line, /区域 2 处：第 10→12 行、第 21→22 行/);
});

test('标记行不再带光标，也不带小节', () => {
  const line = renderMarksLine({
    path: 'a.md',
    title: 'A',
    cursor: { line: 2, ch: 0 },
    heading: '## 某节',
    point: { line: 15, ch: 0 },
  });
  assert.match(line, /标记第 16 行/);
  assert.doesNotMatch(line, /光标/);
  assert.doesNotMatch(line, /小节/);
  assert.ok(line.split('\n').length === 1, '必须是一行');
});

test('有选区也算「指着一段」，跟着标记一起说', () => {
  const line = renderMarksLine({
    path: 'a.md',
    selection: { fromLine: 8, fromCh: 0, toLine: 12, toCh: 3, chars: 36 },
    checked: true,
  });
  assert.match(line, /选中第 9→13 行（36 字）/);
});

test('标记被清掉时明说一句，别让人以为还指着', () => {
  const line = renderMarksLine({ path: 'a.md', title: 'A', regions: [] }, { cleared: true });
  assert.match(line, /^【标记】A/);
  assert.match(line, /标记已清除/);
});

test('没有笔记时不出声', () => {
  assert.equal(renderMarksLine(null), '');
  assert.equal(renderMarksLine({}), '');
});

test('只有选区没有标记：指纹也不为空，也要报一次', () => {
  const key = marksKeyOf({
    path: 'a.md',
    regions: [],
    selection: { fromLine: 1, fromCh: 0, toLine: 2, toCh: 3 },
  });
  assert.notEqual(key, '');
  assert.notEqual(
    key,
    marksKeyOf({ path: 'a.md', regions: [], selection: { fromLine: 5, fromCh: 0, toLine: 6, toCh: 0 } })
  );
});

test('标记指纹：同样的标记指纹相同，换行就不同', () => {
  const a = marksKeyOf({ path: 'a.md', point: { line: 1, ch: 0 } });
  const b = marksKeyOf({ path: 'a.md', point: { line: 1, ch: 0 } });
  const c = marksKeyOf({ path: 'a.md', point: { line: 2, ch: 0 } });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(marksKeyOf({ path: 'a.md', regions: [] }), '');
  // 区域换了也算变
  const r1 = marksKeyOf({ path: 'a.md', regions: [{ from: { line: 1, ch: 0 }, to: { line: 2, ch: 0 } }] });
  const r2 = marksKeyOf({ path: 'a.md', regions: [{ from: { line: 1, ch: 0 }, to: { line: 3, ch: 0 } }] });
  assert.notEqual(r1, r2);
});


test('另外还开着的笔记会列出来，让他知道还有别的参考物', () => {
  const text = renderActiveNote({ path: 'a.md', cursor: { line: 0, ch: 0 }, others: ['b.md', 'c.md'] });
  assert.match(text, /另外开着：b\.md、c\.md/);
});

test('没有别的笔记时就不提这一句', () => {
  const text = renderActiveNote({ path: 'a.md', cursor: { line: 0, ch: 0 }, others: [] });
  assert.doesNotMatch(text, /另外开着/);
});


// ── 临时标记：代替「指着某一段问你」 ──
test('一个标记说清楚落在哪一行哪一列', () => {
  const text = renderActiveNote({ path: 'a.md', point: { line: 9, ch: 4 } });
  assert.match(text, /标记第 10 行第 5 列/);
});

test('两个标记说成范围', () => {
  const text = renderActiveNote({
    path: 'a.md',
    regions: [{ from: { line: 9, ch: 0 }, to: { line: 20, ch: 0 } }],
  });
  assert.match(text, /区域 1 处：第 10→21 行/);
});

test('同一行的范围不写两遍行号', () => {
  const text = renderActiveNote({
    path: 'a.md',
    regions: [{ from: { line: 9, ch: 0 }, to: { line: 9, ch: 6 } }],
  });
  assert.match(text, /区域 1 处：第 10 行/);
  assert.doesNotMatch(text, /→/);
});

test('没有标记时一个字都不提', () => {
  const text = renderActiveNote({ path: 'a.md', regions: [] });
  assert.doesNotMatch(text, /标记/);
});

test('标记行也带标记', () => {
  const line = renderMarksLine({ path: 'a.md', title: 'A', point: { line: 15, ch: 0 } });
  assert.match(line, /标记第 16 行/);
});
