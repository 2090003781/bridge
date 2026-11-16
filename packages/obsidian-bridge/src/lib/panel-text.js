'use strict';
// Bridge · 面板显示层：挡掉不是主人敲的字。
//
// 会话日志里混着三类注入内容，它们都长得像「用户消息」：
//   1. <time-now> 时间戳 + 时区 + 间隔 这一坨（有的整条消息只有它）
//   2. 注入的坐标行：【光标】… 【Obsidian】<真正的话>
//   3. 上下文压缩出来的 checkpoint 摘要（几千字，全是给模型看的）
// 前两类剥掉（剥空了就不显示这条），摘要整条不显示。

const CHECKPOINT_RE = /^\s*This is an automatically generated checkpoint/i;
const TIME_BLOCK_RE = /<time-now>[\s\S]*?<\/time-now>/gi;
const TZ_LINE_RE = /^Browser time zone for this request:.*$/gim;
const ELAPSED_LINE_RE = /^Elapsed since the preceding user message:.*$/gim;
// 面板注入的坐标和正文之间的分隔标记
const BODY_MARKER = '【Obsidian】';
// 出现在分隔标记之前、说明这一段是注入内容的开头
const INJECT_HEADS = ['【光标】', '【Obsidian 当前窗口】'];

function looksInjected(head) {
  const h = String(head == null ? '' : head).trim();
  if (!h) return true;
  if (INJECT_HEADS.some((m) => h.startsWith(m))) return true;
  // 时间戳可能被排在正文后面，只要出现过就说明这条带注入
  return h.includes('<time-now>');
}

function isCheckpoint(text) {
  return CHECKPOINT_RE.test(String(text == null ? '' : text));
}

// 剥掉注入部分，留下主人真正说的话
function stripInjected(text) {
  let s = String(text == null ? '' : text);
  const at = s.indexOf(BODY_MARKER);
  // 标记之前长成注入的样子才当分隔符；主人自己在正文里提一句
  // 「【Obsidian】」不该被切掉前半句
  if (at >= 0 && looksInjected(s.slice(0, at))) {
    s = s.slice(at + BODY_MARKER.length);
  }
  s = s.replace(TIME_BLOCK_RE, '').replace(TZ_LINE_RE, '').replace(ELAPSED_LINE_RE, '');
  return s.trim();
}

// 这条消息该显示什么；null 表示整条不显示
function displayTextOf(message) {
  if (!message) return null;
  const text = String(message.text == null ? '' : message.text);
  if (message.role === 'user') {
    // 摘要整条藏掉：它是给模型看的，主人要看的是对话
    if (isCheckpoint(text)) return null;
    const shown = stripInjected(text);
    return shown ? shown : null;
  }
  // 助手的回复原样交给渲染器（只是去掉首尾空白），空的就不占位
  const trimmed = text.trim();
  return trimmed ? trimmed : null;
}

module.exports = { displayTextOf, stripInjected, isCheckpoint };
