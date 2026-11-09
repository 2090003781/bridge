'use strict';
// Bridge · 标记的视觉层（CodeMirror 6 装饰）
//
// 为什么不改文件：标记表示「我现在想让你看这段」，是临时指示，不是笔记内容。
// 写进正文会污染原文、还会被同步出去，而且撤销起来很烦。
// 所以用 decoration —— 只在屏幕上画，文档一个字节都不动。
//
// 两种形态对应两种画法：
//   点标记   → 字缝之间插一个工字形（宽度 0，不挤开任何字）
//   范围标记 → 两端各一个工字形 + 中间文字底色（边界一眼可见）
//
// 为什么用工字 widget 而不是整行色条：整行会把人「在看哪一行」和
// 「在看行里哪一处」混为一谈；工字形落在字缝里，指哪打哪，也不遮文字。
//
// 注意：@codemirror/* 由 Obsidian 宿主提供，但不是在每个版本都保证暴露。
// 所以这里延迟 require，且失败只让「看得见」降级，不许拖垮整个插件——
// 标记本身（记位置、播报给模型）不依赖它。

let cmCache = null;

function loadCm() {
  if (cmCache) return cmCache;
  const view = require('@codemirror/view');
  const state = require('@codemirror/state');
  if (!view || !view.Decoration || !view.ViewPlugin || !state || !state.RangeSetBuilder) {
    throw new Error('宿主没有暴露 CodeMirror 的 Decoration/ViewPlugin/RangeSetBuilder');
  }
  cmCache = {
    Decoration: view.Decoration,
    ViewPlugin: view.ViewPlugin,
    WidgetType: view.WidgetType,
    RangeSetBuilder: state.RangeSetBuilder,
  };
  return cmCache;
}

/** {line,ch} → 文档偏移；行号越界就夹到边界，ch 越界夹到行尾 */
function offsetOf(doc, pos) {
  const lineNo = Math.min(Math.max(1, Number(pos.line || 0) + 1), doc.lines);
  const line = doc.line(lineNo);
  return Math.min(line.from + Math.max(0, Number(pos.ch || 0)), line.to);
}

/**
 * @param {{getMarks:()=>Array, getPath:()=>string}} deps
 * getMarks 返回 [{path, marks:[{line,ch}, …]}]，getPath 返回当前编辑器对应的文件路径
 */
function createMarkExtension({ getMarks, getPath }) {
  const { Decoration, ViewPlugin, RangeSetBuilder, WidgetType } = loadCm();
  const rangeDeco = Decoration.mark({ class: 'bridge-mark-range' });

  // 工字形光标：一个 0 宽度的行内元素，用伪元素画成上下横 + 中间竖
  class BeamWidget extends WidgetType {
    constructor(kind) {
      super();
      this.kind = kind; // 'point' | 'from' | 'to'
    }

    eq(other) {
      return other && other.kind === this.kind;
    }

    toDOM() {
      const el = document.createElement('span');
      el.className = 'bridge-mark-beam bridge-mark-beam-' + this.kind;
      el.setAttribute('aria-hidden', 'true');
      return el;
    }

    // 别抢鼠标：点它应该落到文字上，不是落到标记上
    ignoreEvent() {
      return true;
    }
  }

  const beamPoint = Decoration.widget({ widget: new BeamWidget('point'), side: 1 });
  const beamFrom = Decoration.widget({ widget: new BeamWidget('from'), side: 1 });
  const beamTo = Decoration.widget({ widget: new BeamWidget('to'), side: -1 });

  const plugin = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = this.build(view);
      }

      update(update) {
        // 每次事务都重算：标记是外部状态，CM 不知道它变了，
        // 所以外部改完标记会 dispatch 一个空事务把这里叫醒。
        this.decorations = this.build(update.view);
      }

      build(view) {
        let list = [];
        try {
          list = getMarks() || [];
        } catch {
          list = [];
        }
        const path = typeof getPath === 'function' ? getPath() : '';
        const mine = list.filter((m) => m && m.path === path && Array.isArray(m.marks) && m.marks.length);

        const items = [];
        for (const entry of mine) {
          const pts = entry.marks.slice(0, 2);
          if (pts.length === 1) {
            const at = offsetOf(view.state.doc, pts[0]);
            items.push({ from: at, to: at, deco: beamPoint, order: 0 });
          } else {
            const a = offsetOf(view.state.doc, pts[0]);
            const b = offsetOf(view.state.doc, pts[1]);
            const from = Math.min(a, b);
            const to = Math.max(a, b);
            // 同一位置不能既插 widget 又标 mark，所以空范围只画一个
            if (from === to) {
              items.push({ from, to, deco: beamPoint, order: 0 });
            } else {
              items.push({ from, to: from, deco: beamFrom, order: 0 });
              items.push({ from, to, deco: rangeDeco, order: 1 });
              items.push({ from: to, to, deco: beamTo, order: 2 });
            }
          }
        }
        // RangeSetBuilder 要求 from 递增；同位置时按 order 排（line 在 mark 之前）
        items.sort((x, y) => x.from - y.from || x.order - y.order);

        const builder = new RangeSetBuilder();
        for (const it of items) builder.add(it.from, it.to, it.deco);
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );
  return [plugin];
}

/** 标记变了之后把可见编辑器叫醒重画。没有可画的就直接跳过。 */
function refreshAllMarkViews(views) {
  for (const v of views || []) {
    try {
      if (v && typeof v.dispatch === 'function') v.dispatch({});
    } catch {
      /* 编辑器可能已经销毁 */
    }
  }
}

module.exports = { createMarkExtension, refreshAllMarkViews, offsetOf };
