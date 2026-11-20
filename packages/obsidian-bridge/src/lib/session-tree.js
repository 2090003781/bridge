'use strict';
// Bridge · 会话选择树的分组与「当前是哪一篇」。
//
// 树默认全部收起（几十个会话全铺开会淹没工作区），所以必须显式告诉人
// 「你现在在哪一篇」：分组键抽出来、当前会话找出来，界面上才好标。

function tailPathOf(p, n = 1) {
  const parts = String(p == null ? '' : p)
    .replace(/[\\/]+$/, '')
    .split(/[\\/]+/)
    .filter(Boolean);
  return parts.slice(-Math.max(1, n)).join('\\') || '(无工作区)';
}

// 分组依据是 DSH 的工作区注册表（workspaceTitle），不是 cwd：
// 按 cwd 分会多出 DSH 界面里没有的「工作区」，两边对不上。
// 旧连接器没有这个字段时，退回按 cwd 末两级分组。
function groupKeyOf(session) {
  if (!session) return '(未分组)';
  if (session.workspaceTitle) return session.workspaceTitle;
  if (session.workspaceTitle === undefined) return tailPathOf(session.cwd, 2);
  return '(未分组)';
}

// 把会话拆成「工作区分组 + 当前是哪篇」。排序留给界面，这里只管归类和识别。
function planTree(sessions, currentId) {
  const list = Array.isArray(sessions) ? sessions.filter(Boolean) : [];
  const visible = list.filter((s) => !s.archived);
  const groups = new Map();
  for (const s of visible) {
    const key = groupKeyOf(s);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const current = currentId ? visible.find((s) => s.sessionId === currentId) || null : null;
  return {
    visible,
    groups,
    archivedCount: list.length - visible.length,
    current,
    currentKey: current ? groupKeyOf(current) : null,
  };
}

module.exports = { tailPathOf, groupKeyOf, planTree };
