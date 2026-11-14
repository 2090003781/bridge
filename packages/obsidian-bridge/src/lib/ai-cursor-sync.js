'use strict';
// Bridge · 让 AI 光标跟着文字走
//
// 主人改文档（插入、删除、换行）之后，AI 光标原来那个 {line,ch} 就指到别处去了。
// 这里在每次文档变化时把 AI 光标映射到新坐标上，让它继续贴着原来那段字。
//
// 关键：AI 自己的改动要跳过映射。AI 改完已经自己算准了新位置，
// 如果同步器再映射一次，就会多挪一截（双重移动）。
// 用 transaction annotation 区分「谁改的」。

let cmCache = null;
function loadCm() {
  if (cmCache) return cmCache;
  const view = require('@codemirror/view');
  const state = require('@codemirror/state');
  if (!view || !view.ViewPlugin || !state || !state.Annotation) {
    throw new Error('宿主没有暴露 CodeMirror 的 ViewPlugin/Annotation');
  }
  cmCache = { ViewPlugin: view.ViewPlugin, Annotation: state.Annotation };
  return cmCache;
}

/** 打上这个标记的 transaction 表示「这次是 AI 改的，别映射」 */
let aiEditAnnotation = null;

function getAiEditAnnotation() {
  if (!aiEditAnnotation) {
    const { Annotation } = loadCm();
    aiEditAnnotation = Annotation.define();
  }
  return aiEditAnnotation;
}

/**
 * 这次文档变化该不该让 AI 光标跟着映射？
 * 只有当变化里没有「AI 自己改的」标记时才映射——否则 AI 刚算准的位置会被再挪一次。
 * 抽成纯函数是为了能单测：ViewPlugin 本体依赖 CodeMirror，本机没有那个包。
 */
function shouldMapThrough(update, aiEditAnnotation) {
  if (!update || update.docChanged !== true) return false;
  for (const tr of update.transactions || []) {
    if (tr && typeof tr.annotation === 'function' && tr.annotation(aiEditAnnotation)) return false;
  }
  return true;
}

/**
 * @param {{getAiCursor:()=>any, resolvePath:(cmView:any)=>string|null}} deps
 */
function createAiCursorSync({ getAiCursor, resolvePath }) {
  const { ViewPlugin } = loadCm();
  const aiEdit = getAiEditAnnotation();

  const plugin = ViewPlugin.fromClass(
    class {
      update(u) {
        if (!shouldMapThrough(u, aiEdit)) return;
        let cur = null;
        try {
          cur = getAiCursor();
        } catch {
          cur = null;
        }
        if (!cur || typeof cur.mapThrough !== 'function') return;
        let path = null;
        try {
          path = resolvePath(u.view);
        } catch {
          path = null;
        }
        if (!path) return;
        cur.mapThrough(path, u.startState.doc, u.changes, u.state.doc, 'after');
      }
    },
  );
  return [plugin];
}

module.exports = { createAiCursorSync, getAiEditAnnotation, shouldMapThrough };
