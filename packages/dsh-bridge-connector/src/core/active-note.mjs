// Bridge 连接器 · 当前窗口那篇笔记 —— 只报坐标，不塞正文。
//
// 为什么不塞全文：笔记切换很频繁，一篇几千字塞进系统提示词，
// 每轮都要重发一遍，既贵、又把真正要说的话挤掉；而且模型拿到的是一份
// 可能已经过期的副本，比「知道它在哪、自己去读」更容易出错。
//
// 这里回答四件事：当前窗口是哪一篇、多大、光标在哪、那一节叫什么。
// 措辞按「简洁到能一眼扫完」为准——这些东西每轮都要占提示词。

const MAX_SELECTION_PREVIEW = 240;
const MAX_HEADING = 120;

function flat(text) {
  return String(text == null ? '' : text)
    .replace(/\r/g, '')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cut(text, limit) {
  const s = flat(text);
  if (s.length <= limit) return s;
  return s.slice(0, limit) + '…';
}

// 行号对外一律从 1 数起：模型和主人看到的都是「第 N 行」。
const humanLine = (n) => (Number.isFinite(n) ? Number(n) + 1 : null);

const shortName = (note) => cut(note.title || note.path, 60);

/** 光标那一句：直接说在第几行第几列。 */
function cursorPhrase(note, withPrefix = true) {
  const cursor = note.cursor;
  if (!cursor || !Number.isFinite(cursor.line)) return '光标位置未知';
  const where = '在第 ' + humanLine(cursor.line) + ' 行';
  let out = (withPrefix ? '光标' : '') + where;
  if (Number.isFinite(cursor.ch)) out += '第 ' + (Number(cursor.ch) + 1) + ' 列';
  return out;
}

/** 标记那一句：一个说点，两个说范围。没有标记就不说。 */
function marksPhrase(note) {
  const marks = Array.isArray(note.marks) ? note.marks : [];
  if (!marks.length) return '';
  if (marks.length === 1) {
    const m = marks[0];
    return '标记第 ' + humanLine(m.line) + ' 行第 ' + ((m.ch || 0) + 1) + ' 列';
  }
  const a = humanLine(marks[0].line);
  const b = humanLine(marks[1].line);
  return '标记第 ' + a + (a === b ? ' 行' : ' → ' + b + ' 行');
}

/** 选区那一句：有就报范围和字数，确认过没有就说没有。 */
function selectionPhrase(note) {
  const sel = note.selection;
  if (sel && Number.isFinite(sel.fromLine) && Number.isFinite(sel.toLine)) {
    const a = humanLine(sel.fromLine);
    const b = humanLine(sel.toLine);
    let out = '选中第 ' + a + (a === b ? '' : '→' + b) + ' 行';
    if (Number.isFinite(sel.chars) && sel.chars > 0) out += '（' + sel.chars + ' 字）';
    if (sel.preview) out += '：「' + cut(sel.preview, MAX_SELECTION_PREVIEW) + '」';
    return out;
  }
  return note.checked ? '没有选中文字' : '';
}

/**
 * 整篇的坐标。同一会话里同一篇只给一次，所以可以稍微多说两句。
 * 没有笔记时返回空串。
 */
export function renderActiveNote(note) {
  if (!note || !note.path) return '';

  const name = shortName(note);
  const pathText = flat(note.path);
  const out = ['【Obsidian 当前窗口】' + (name === pathText ? name : name + ' · ' + pathText)];

  const facts = [];
  if (Number.isFinite(note.charCount) && note.charCount > 0) facts.push(note.charCount + ' 字');
  if (Number.isFinite(note.lineCount) && note.lineCount > 0) facts.push(note.lineCount + ' 行');
  if (note.updatedAt) facts.push('改于 ' + String(note.updatedAt));
  if (facts.length) out.push(facts.join(' / '));

  let where = cursorPhrase(note);
  if (note.heading) where += '，小节「' + cut(note.heading, MAX_HEADING) + '」';
  out.push(where);

  const sel = selectionPhrase(note);
  if (sel) out.push(sel);

  const mk = marksPhrase(note);
  if (mk) out.push(mk);

  if (Array.isArray(note.others) && note.others.length) {
    const head = note.others.slice(0, 5).map((x) => flat(x));
    const more = note.others.length > head.length ? ' 等 ' + note.others.length + ' 篇' : '';
    out.push('另外开着：' + head.join('、') + more);
  }

  out.push('（正文未附，需要时自行读取）');
  return out.join('\n');
}

/**
 * 光标那一行 —— 每轮都带，因为「在看哪一段」随时会变，而它只占一行。
 * 拿不到就明说拿不到，不沉默：沉默会让人以为我看得见。
 */
export function renderCursorLine(note) {
  if (!note || !note.path) return '【光标】没有打开的笔记';

  // 【光标】已经说明了主语，这里不再重复「光标」两个字
  const parts = [shortName(note), cursorPhrase(note, false)];
  if (note.heading) parts.push('小节「' + cut(note.heading, MAX_HEADING) + '」');
  const sel = selectionPhrase(note);
  if (sel) parts.push(sel);
  const mk = marksPhrase(note);
  if (mk) parts.push(mk);

  return '【光标】' + parts.join(' · ');
}
