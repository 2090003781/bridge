'use strict';
// Bridge · 面板回复对账
//
// 事件（SSE）是快路，但会丢：断线、重连窗口、那一轮压根没产生文本、
// 或者事件名/结构变了。丢了之后面板就永远停在「思考中…」，看起来就是
// 「agent 没回我」。
//
// 这里给一条慢路：只问会话真相（/sessions 的 running + /transcript 的消息），
// 不看事件。只要那一轮真的跑完了，回复就能被捞出来补上。
// 纯函数，不碰网络，好测。

/** 面板里已经显示过的 assistant 文本集合（用来判断「这条补过没有」） */
function shownAssistantTexts(shown) {
  const set = new Set();
  for (const m of Array.isArray(shown) ? shown : []) {
    if (m && m.role === 'assistant' && typeof m.text === 'string') set.add(m.text);
  }
  return set;
}

/**
 * 该不该把某条回复补到面板上。
 * @param {Array} shown     面板已显示的消息（{role,text}）
 * @param {Array} transcript 会话日志里的最近消息（{role,text}）
 * @returns {{role:string,text:string}|null} 要补的那条；没得补就 null
 */
function pickMissingReply(shown, transcript) {
  const list = Array.isArray(transcript) ? transcript : [];
  const last = [...list]
    .reverse()
    .find((m) => m && m.role === 'assistant' && typeof m.text === 'string' && m.text.trim());
  if (!last) return null;
  if (shownAssistantTexts(shown).has(last.text)) return null;
  return { role: 'assistant', text: last.text };
}

/**
 * 现在该不该去对账。
 * @param {{running:boolean, waiting:boolean, elapsedMs:number, timeoutMs?:number}} input
 */
function shouldReconcile({ running, waiting, elapsedMs, timeoutMs = 180000 } = {}) {
  if (waiting !== true) return false;
  if (!Number.isFinite(elapsedMs) || elapsedMs > timeoutMs) return false;
  // 只有「明确已经停了」才对账：
  // running=true（还在跑，事件可能只是慢）和 undefined（会话列表还没刷新，
  // 查不到等于不知道）都不插手，免得误判成跑完、把机会让给一条旧回复。
  return running === false;
}

module.exports = { pickMissingReply, shouldReconcile };
