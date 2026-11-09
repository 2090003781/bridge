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

test('篇幅、修改时间、光标、小节都写出来', () => {
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
  // 行号对外从 1 数起
  assert.match(text, /光标在第 100 行第 5 列/);
  assert.match(text, /，小节「## 2\.4 点亮判据」/);
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


// ── 光标那一行：每轮都带，所以必须短、必须永远有个说法 ──
import { renderCursorLine } from '../src/core/active-note.mjs';

test('光标行写明位置和小节', () => {
  const line = renderCursorLine({
    path: '项目/架构说明.md',
    title: '架构说明',
    lineCount: 201,
    cursor: { line: 99, ch: 4 },
    heading: '## 2.4 点亮判据',
    checked: true,
  });
  assert.match(line, /^【光标】架构说明/);
  assert.match(line, /在第 100 行第 5 列/);
  assert.match(line, /小节「## 2\.4 点亮判据」/);
  assert.match(line, /没有选中文字/);
  assert.ok(line.split('\n').length === 1, '必须是一行，不能撑开');
});

test('有选区就说选着哪几行', () => {
  const line = renderCursorLine({
    path: 'a.md',
    cursor: { line: 9, ch: 0 },
    selection: { fromLine: 8, fromCh: 0, toLine: 12, toCh: 3, chars: 36 },
    checked: true,
  });
  assert.match(line, /选中第 9→13 行（36 字）/);
  assert.doesNotMatch(line, /没有选中文字/);
});

test('拿不到光标就明说拿不到，不沉默', () => {
  const line = renderCursorLine({ path: 'a.md', cursor: null, checked: true });
  assert.match(line, /光标位置未知/);
});

test('没有打开的笔记也说一声', () => {
  assert.match(renderCursorLine(null), /没有打开的笔记/);
  assert.match(renderCursorLine({}), /没有打开的笔记/);
});


// ── 焦点跑了之后：说的是「最后停在哪」，不是「现在在哪」 ──
test('焦点不在编辑器时，措辞改成「最后停在那」，并说明原因', () => {
  const text = renderActiveNote({
    path: 'a.md',
    lineCount: 100,
    cursor: { line: 49, ch: 2 },
    focused: false,
    checked: true,
  });
  assert.match(text, /光标最后处在第 50 行/);
  assert.match(text, /焦点不在编辑器里/);
});

test('焦点在编辑器里就用现在时，不要多余的解释', () => {
  const text = renderActiveNote({ path: 'a.md', cursor: { line: 0, ch: 0 }, focused: true });
  assert.match(text, /光标在第 1 行/);
  assert.doesNotMatch(text, /最后处在/);
  assert.doesNotMatch(text, /焦点不在编辑器里/);
});

test('另外还开着的笔记会列出来，让他知道还有别的参考物', () => {
  const text = renderActiveNote({ path: 'a.md', cursor: { line: 0, ch: 0 }, others: ['b.md', 'c.md'] });
  assert.match(text, /另外开着：b\.md、c\.md/);
});

test('没有别的笔记时就不提这一句', () => {
  const text = renderActiveNote({ path: 'a.md', cursor: { line: 0, ch: 0 }, others: [] });
  assert.doesNotMatch(text, /另外开着/);
});

test('光标行也遵守同一套措辞', () => {
  const line = renderCursorLine({ path: 'a.md', cursor: { line: 9, ch: 0 }, focused: false, checked: true });
  assert.match(line, /最后处在第 10 行/);
  assert.match(line, /焦点不在编辑器里/);
});

test('光标行在焦点正常时不加那句', () => {
  const line = renderCursorLine({ path: 'a.md', cursor: { line: 9, ch: 0 }, focused: true, checked: true });
  assert.doesNotMatch(line, /焦点不在编辑器里/);
  assert.doesNotMatch(line, /最后处在/);
});


// ── 临时标记：代替「指着某一段问你」 ──
test('一个标记说清楚落在哪一行哪一列', () => {
  const text = renderActiveNote({ path: 'a.md', cursor: { line: 0, ch: 0 }, marks: [{ line: 9, ch: 4 }] });
  assert.match(text, /标记第 10 行第 5 列/);
});

test('两个标记说成范围', () => {
  const text = renderActiveNote({
    path: 'a.md',
    cursor: { line: 0, ch: 0 },
    marks: [{ line: 9, ch: 0 }, { line: 20, ch: 0 }],
  });
  assert.match(text, /标记第 10 → 21 行/);
});

test('同一行的范围不写两遍行号', () => {
  const text = renderActiveNote({
    path: 'a.md',
    cursor: { line: 0, ch: 0 },
    marks: [{ line: 9, ch: 0 }, { line: 9, ch: 6 }],
  });
  assert.match(text, /标记第 10 行/);
  assert.doesNotMatch(text, /→/);
});

test('没有标记时一个字都不提', () => {
  const text = renderActiveNote({ path: 'a.md', cursor: { line: 0, ch: 0 }, marks: [] });
  assert.doesNotMatch(text, /标记/);
});

test('每轮那行也带标记', () => {
  const line = renderCursorLine({ path: 'a.md', title: 'A', cursor: { line: 2, ch: 0 }, marks: [{ line: 15, ch: 0 }] });
  assert.match(line, /标记第 16 行/);
});
