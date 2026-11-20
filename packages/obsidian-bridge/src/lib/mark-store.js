'use strict';
// Bridge · 标记集合：一个点 + 多处区域
//
// 用途：指着给 agent 看。记号只在内存里——它表示「此刻我想让你看这里」，
// 不是笔记内容，不该写进文件，也不该关了 Obsidian 还留着假装有效。
//
// 形状：
//   point   —— 最多一个，打点就是挪这一个，不会越点越多
//   regions —— 可以累加，像 Ctrl 不连续选择那样一处一处标
// 清除分两种：清掉光标处那一处；或者把当前这篇全清掉。

const emptySet = () => ({ point: null, regions: [] });

const norm = (p) =>
  p && Number.isFinite(p.line) ? { line: p.line, ch: Number.isFinite(p.ch) ? p.ch : 0 } : null;

/** 位置比较：先比行，再比列。 */
function comparePos(a, b) {
  if (!a || !b) return 0;
  if (a.line !== b.line) return a.line < b.line ? -1 : 1;
  if ((a.ch || 0) !== (b.ch || 0)) return (a.ch || 0) < (b.ch || 0) ? -1 : 1;
  return 0;
}

const isEmpty = (set) => !set || (!set.point && (!set.regions || set.regions.length === 0));

/** 打点：覆盖已有的点，不动区域。 */
function setPoint(set, pos) {
  const base = set || emptySet();
  return { point: norm(pos), regions: (base.regions || []).slice() };
}

/** 加一处区域：顺序摆正、空选区丢弃、重复的不再加。 */
function addRegion(set, from, to) {
  const base = set || emptySet();
  const a = norm(from);
  const b = norm(to);
  const regions = (base.regions || []).slice();
  if (!a || !b) return { point: base.point || null, regions };
  const first = comparePos(a, b) <= 0 ? a : b;
  const second = comparePos(a, b) <= 0 ? b : a;
  if (comparePos(first, second) === 0) return { point: base.point || null, regions };
  const dup = regions.some((r) => comparePos(r.from, first) === 0 && comparePos(r.to, second) === 0);
  if (!dup) regions.push({ from: first, to: second });
  return { point: base.point || null, regions };
}

const inside = (r, p) => comparePos(r.from, p) <= 0 && comparePos(p, r.to) <= 0;
const onLine = (r, p) => p.line >= r.from.line && p.line <= r.to.line;

/** 清除光标处那一处：先看区域（光标在范围内，或同一行），再看点（同一行即算）。 */
function removeAtCursor(set, pos) {
  const base = set || emptySet();
  const p = norm(pos);
  const regions = (base.regions || []).slice();
  if (!p) return { set: { point: base.point || null, regions }, removed: false };
  let idx = regions.findIndex((r) => inside(r, p));
  if (idx < 0) idx = regions.findIndex((r) => onLine(r, p));
  if (idx >= 0) {
    regions.splice(idx, 1);
    return { set: { point: base.point || null, regions }, removed: true };
  }
  if (base.point && base.point.line === p.line) {
    return { set: { point: null, regions }, removed: true };
  }
  return { set: { point: base.point || null, regions }, removed: false };
}

const humanLine = (n) => (Number.isFinite(n) ? Number(n) + 1 : '?');

/** 人话描述：Notice、状态栏、日志共用。 */
function describeSet(set) {
  if (!set) return '';
  const out = [];
  if (set.point) {
    out.push('点标记第 ' + humanLine(set.point.line) + ' 行第 ' + ((set.point.ch || 0) + 1) + ' 列');
  }
  const parts = (set.regions || []).map((r) => {
    const a = humanLine(r.from.line);
    const b = humanLine(r.to.line);
    return a === b ? '第 ' + a + ' 行' : '第 ' + a + '→' + b + ' 行';
  });
  if (parts.length) out.push(parts.length + ' 处区域：' + parts.join('、'));
  return out.join('；');
}

/** 从「整份标记表」里取某篇的集合。 */
function setForPath(all, path) {
  if (!Array.isArray(all)) return emptySet();
  const hit = all.find((m) => m && m.path === path);
  if (!hit) return emptySet();
  const regions = Array.isArray(hit.regions)
    ? hit.regions
        .filter((r) => r && r.from && r.to)
        .map((r) => ({
          from: { line: r.from.line, ch: Number(r.from.ch) || 0 },
          to: { line: r.to.line, ch: Number(r.to.ch) || 0 },
        }))
    : [];
  return {
    point: hit.point ? { line: hit.point.line, ch: Number(hit.point.ch) || 0 } : null,
    regions,
  };
}

/** 把某篇的集合写回「整份标记表」；空集合就把这条记录去掉。 */
function withSet(all, path, set) {
  const rest = (Array.isArray(all) ? all : []).filter((m) => m && m.path !== path);
  if (!path || isEmpty(set)) return rest;
  return rest.concat([{ path, point: set.point || null, regions: (set.regions || []).slice() }]);
}

module.exports = {
  emptySet,
  isEmpty,
  setPoint,
  addRegion,
  removeAtCursor,
  describeSet,
  setForPath,
  withSet,
  comparePos,
};
