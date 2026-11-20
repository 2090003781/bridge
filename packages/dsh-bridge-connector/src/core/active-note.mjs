// Bridge 连接器 · 当前窗口那篇笔记 —— 只报坐标，不塞正文。
//
// 为什么不塞全文：笔记切换很频繁，一篇几千字塞进系统提示词，
// 每轮都要重发一遍，既贵、又把真正要说的话挤掉；而且模型拿到的是一份
// 可能已经过期的副本，比「知道它在哪、自己去读」更容易出错。
//
// 这里回答三件事：当前窗口是哪一篇、多大、有没有用标记指着哪里。
// 光标位置一概不报——指着哪一段由标记（Ctrl/Cmd+Shift+M 打的工字形）来说，
// 光标是「打字的地方」，不是「想让你看的地方」，混在一起只会误判。
// 措辞按「简洁到能一眼扫完」为准——这些东西每轮都要占提示词。

const MAX_SELECTION_PREVIEW = 240;

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

/**
 * 标记那一句：一个点 + 若干处区域，各说各的；都没有就不说。
 * 点 → 「标记第 N 行第 M 列」；区域 → 「区域 2 处：第 2→4 行、第 11 行」
 */
function marksPhrase(note) {
  const out = [];
  const p = note.point;
  if (p && Number.isFinite(p.line)) {
    out.push('标记第 ' + humanLine(p.line) + ' 行第 ' + ((Number(p.ch) || 0) + 1) + ' 列');
  }
  const regions = (Array.isArray(note.regions) ? note.regions : []).filter(
    (r) => r && r.from && Number.isFinite(r.from.line) && r.to && Number.isFinite(r.to.line)
  );
  if (regions.length) {
    const each = regions.map((r) => {
      const a = humanLine(r.from.line);
      const b = humanLine(r.to.line);
      return a === b ? '第 ' + a + ' 行' : '第 ' + a + '→' + b + ' 行';
    });
    out.push('区域 ' + regions.length + ' 处：' + each.join('、'));
  }
  return out.join('；');
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
 * 标记那一行 —— 只在真指着什么的时候才带：有标记，或者有一段明确选中。
 * 什么都没指就不出声（连「没有标记」都不说，省得每轮占一行）。
 */
export function renderMarksLine(note, { cleared = false } = {}) {
  if (!note || !note.path) return '';
  const parts = [];
  if (cleared) {
    parts.push('标记已清除');
  } else {
    // 只报「指着哪」：没选中就是不提，不像整篇块那样还要说明「没有选中」
    if (note.selection) {
      const sel = selectionPhrase(note);
      if (sel) parts.push(sel);
    }
    const mk = marksPhrase(note);
    if (mk) parts.push(mk);
  }
  if (!parts.length) return '';
  return '【标记】' + [shortName(note)].concat(parts).join(' · ');
}

/** 标记（含选区）的指纹：用来判断「这一轮要不要再报一次」；什么都没指就是空串。 */
export function marksKeyOf(note) {
  if (!note || !note.path) return '';
  const parts = [];
  if (note.point && Number.isFinite(note.point.line)) {
    parts.push('p' + note.point.line + ':' + (Number(note.point.ch) || 0));
  }
  for (const r of Array.isArray(note.regions) ? note.regions : []) {
    if (!r || !r.from || !r.to) continue;
    parts.push(
      'r' + r.from.line + ':' + (Number(r.from.ch) || 0) + '-' + r.to.line + ':' + (Number(r.to.ch) || 0)
    );
  }
  const markKey = parts.join(',');
  const sel = note.selection;
  const selKey =
    sel && Number.isFinite(sel.fromLine) && Number.isFinite(sel.toLine)
      ? sel.fromLine + ':' + (Number(sel.fromCh) || 0) + '-' + sel.toLine + ':' + (Number(sel.toCh) || 0)
      : '';
  if (!markKey && !selKey) return '';
  return markKey + '|' + selKey;
}
