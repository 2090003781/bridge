'use strict';
// Bridge · 「屏幕上那篇」到底怎么认。
//
// 以前走的是「活动 leaf」（焦点历史）：焦点跑丢到面板输入框之后，
// 它记的还是你上次点过的那一页，和眼睛看到的那一页可能不是同一篇。
// 这里改成看「标签组当前选中的那一页」——眼睛看到什么就是什么；
// 多个分组时再用活动视图做首选，二者一致时没有区别。

const MAX_DEPTH = 8;

// 每个分组只取「当前选中」的那一页；分组之间各出一个候选
function collectVisibleViews(node, isWanted, out = [], depth = 0) {
  if (!node || depth > MAX_DEPTH || typeof isWanted !== 'function') return out;
  if (node.view && isWanted(node.view)) {
    out.push(node.view);
    return out;
  }
  const children = Array.isArray(node.children) ? node.children : [];
  if (typeof node.currentTab === 'number' && children.length) {
    collectVisibleViews(children[node.currentTab], isWanted, out, depth + 1);
    return out;
  }
  for (const child of children) collectVisibleViews(child, isWanted, out, depth + 1);
  return out;
}

function pickVisibleView(root, isWanted, preferred = null) {
  const all = collectVisibleViews(root, isWanted);
  if (!all.length) return null;
  if (preferred && all.includes(preferred)) return preferred;
  return all[0];
}

module.exports = { pickVisibleView, collectVisibleViews, MAX_DEPTH };
