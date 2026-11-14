'use strict';
// Bridge · AI 自己的光标
//
// 主人有一个光标，AI 需要一个自己的：位置、选区、能往里插字、能选中一段。
// 但它和主人的那个**完全隔离**：
//   · 不读主人的光标（所以主人把光标停在哪都不影响 AI 的判断）
//   · 不动主人的光标（改动走 CM6 的 changes，不发 selection）
//   · 不显示（纯状态，没有任何装饰）
//
// 光标按文件归属：AI 在 A 篇操作完又去 B 篇，B 篇的光标从行首开始，
// 不会把 A 篇的位置硬套过去。

/** 位置比较：先比行，再比列。 */
function comparePos(a, b) {
  if (a.line !== b.line) return a.line - b.line;
  return (a.ch || 0) - (b.ch || 0);
}

const norm = (p) => ({
  line: Math.max(0, Math.floor(Number(p && p.line) || 0)),
  ch: Math.max(0, Math.floor(Number(p && p.ch) || 0)),
});

function createAiCursor() {
  const state = { path: null, head: norm({}), anchor: null };

  /** 取某篇的 AI 光标；换了一篇就从行首重来，不继承上一篇的位置。 */
  function forPath(path) {
    if (state.path !== path) {
      state.path = path;
      state.head = norm({});
      state.anchor = null;
    }
    return state;
  }

  /** 移动光标（同时清掉选区，和真实光标的语义一致）。 */
  function move(path, pos) {
    const st = forPath(path);
    st.head = norm(pos);
    st.anchor = null;
    return snapshot(st);
  }

  /** 选中一段：anchor 是起点，head 是终点（可以是反向选，from/to 会摆正）。 */
  function select(path, from, to) {
    const st = forPath(path);
    st.anchor = norm(from);
    st.head = norm(to);
    return snapshot(st);
  }

  /** 取消选区，只留插入点。 */
  function collapse(path) {
    const st = forPath(path);
    st.anchor = null;
    return snapshot(st);
  }

  /** 当前范围：from / to 已摆正，empty 表示没选中东西。 */
  function range(path) {
    const st = forPath(path);
    if (!st.anchor) return { from: st.head, to: st.head, empty: true };
    const a = st.anchor;
    const b = st.head;
    return comparePos(a, b) <= 0
      ? { from: a, to: b, empty: a.line === b.line && a.ch === b.ch }
      : { from: b, to: a, empty: a.line === b.line && a.ch === b.ch };
  }

  /**
   * 别人改了文档后，把自己的位置映射到新坐标上 —— 这样文字挪动时
   * 光标仍然贴着原来那段字，不会莫名其妙落在别的字中间。
   *
   * @param {string} path      当前编辑的是哪一篇（不是这一篇就不动）
   * @param {object} startDoc  改动前的文档（用来把 line/ch 转 offset）
   * @param {object} changes   CM6 ChangeSet
   * @param {object} newDoc    改动后的文档（用来把 offset 转回 line/ch）
   * @param {'before'|'after'|'nearest'} assoc 位置正好落在改动边界上时往哪边靠
   */
  function mapThrough(path, startDoc, changes, newDoc, assoc = 'after') {
    if (state.path !== path) return false;
    if (!startDoc || !changes || !newDoc) return false;

    const toOffset = (doc, pos) => {
      const n = Math.min(Math.max(1, Math.floor(pos.line) + 1), doc.lines);
      const l = doc.line(n);
      return Math.min(l.from + Math.max(0, Math.floor(pos.ch || 0)), l.to);
    };
    const toPos = (doc, offset) => {
      const at = Math.max(0, Math.min(offset, doc.length));
      const l = doc.lineAt(at);
      return { line: l.number - 1, ch: at - l.from };
    };

    // assoc: 1 = 右偏（改动插在我前面时我往后让），-1 = 左偏
    const bias = assoc === 'before' ? -1 : 1;
    const nextHead = toPos(newDoc, changes.mapPos(toOffset(startDoc, state.head), bias));
    const nextAnchor = state.anchor
      ? toPos(newDoc, changes.mapPos(toOffset(startDoc, state.anchor), bias))
      : null;

    state.head = nextHead;
    state.anchor = nextAnchor;
    return true;
  }

  function snapshot(st = state) {
    return {
      path: st.path,
      head: { ...st.head },
      anchor: st.anchor ? { ...st.anchor } : null,
      selection: st.anchor ? range(st.path) : null,
    };
  }

  return { state, forPath, move, select, collapse, range, snapshot, mapThrough };
}

module.exports = { createAiCursor };
