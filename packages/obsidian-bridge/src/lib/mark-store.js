'use strict';
// Bridge · 临时标记
//
// 只有一种标记，靠按几次分形态：
//   第 1 次 → 一个点（我在这）
//   第 2 次 → 从第一个点到第二个点的范围（这段）
//   第 3 次 → 清空，重新开始
// 这样只要一个快捷键就够，不用记「打点」和「清空」是两个键。
//
// 标记只在内存里：它表示「此刻我想让你看这里」，不是笔记内容，
// 不该写进文件，也不该关了 Obsidian 还留着假装有效。

/** 位置比较：先比行，再比列。 */
function comparePos(a, b) {
  if (!a || !b) return 0;
  if (a.line !== b.line) return a.line - b.line;
  return (a.ch || 0) - (b.ch || 0);
}

const samePos = (a, b) => Boolean(a && b && a.line === b.line && (a.ch || 0) === (b.ch || 0));

/**
 * 按下标记键之后标记变成什么样。
 * @param {Array} current 当前标记（[] / [点] / [from,to]）
 * @param {{line:number,ch:number}} position 光标位置
 * @returns {{marks:Array, mode:'empty'|'point'|'range'}}
 */
function nextMarkState(current, position) {
  const list = Array.isArray(current) ? current.filter((p) => p && Number.isFinite(p.line)) : [];
  if (!position || !Number.isFinite(position.line)) return { marks: list, mode: modeOf(list) };

  if (list.length === 0) return { marks: [position], mode: 'point' };

  if (list.length === 1) {
    // 同一个位置点两次：当成「我改主意了」，直接撤掉
    if (samePos(list[0], position)) return { marks: [], mode: 'empty' };
    const [from, to] = comparePos(list[0], position) <= 0 ? [list[0], position] : [position, list[0]];
    return { marks: [from, to], mode: 'range' };
  }

  // 已经是范围：再按就是清空
  return { marks: [], mode: 'empty' };
}

function modeOf(marks) {
  const list = Array.isArray(marks) ? marks : [];
  if (list.length === 0) return 'empty';
  return list.length >= 2 ? 'range' : 'point';
}

/** 给人看的一句话：标记在哪。没有标记时返回空串。 */
function describeMarks(marks) {
  const list = Array.isArray(marks) ? marks : [];
  if (!list.length) return '';
  if (list.length === 1) return '标记在第 ' + (list[0].line + 1) + ' 行第 ' + ((list[0].ch || 0) + 1) + ' 列';
  const a = list[0];
  const b = list[1];
  const head = '标记范围第 ' + (a.line + 1);
  const tail = (b.line + 1) + ' 行';
  return head + (a.line === b.line ? ' 行' : ' → ' + tail);
}

/** 标记还在不在这篇里（换了文件就当没有）。 */
function marksForPath(all, path) {
  if (!Array.isArray(all)) return [];
  const hit = all.find((m) => m && m.path === path);
  return hit && Array.isArray(hit.marks) ? hit.marks : [];
}

module.exports = { nextMarkState, describeMarks, marksForPath, comparePos, modeOf };
