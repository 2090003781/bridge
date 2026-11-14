// Bridge · 回复进来时视口停在哪
//
// 主人想看的画面是这样：自己那句话在上面，AI 回复的开头紧接着下一行。
//
// 短消息：整条都在，停它的顶部，一眼看全。
// 长消息：整条塞不下，停到它最后两行——尾巴露出来，回复照样紧接在下面，
//        别为了看开头把回复顶出屏幕。

// 我那句话最多能占视口多少，超过了就只留尾巴
const ROOM_RATIO = 0.7;
// 长消息留几行给自己收尾
const TAIL_LINES = 2;

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// 返回要滚到的位置（相对列表顶部）；null 表示「没有回复可对齐」，交给调用方滚到底
function pickReplyAnchor({
  userTop,
  userHeight,
  assistantTop,
  viewHeight,
  lineHeight,
  tailLines = TAIL_LINES,
} = {}) {
  const a = num(assistantTop);
  // 连回复气泡都没有，就没有「回复开头」这回事
  if (a === null) return null;
  const u = num(userTop);
  // 没有我那句（比如会话刚开）：停在回复开头
  if (u === null) return a;
  // 顺序反了不硬按，停在我那句上
  if (a < u) return u;

  const h = num(userHeight);
  // 高度量不出来：按顶部对齐，别乱猜
  if (h === null) return u;
  const vh = num(viewHeight) || 0;
  // 视口有多高都不知道，就不敢把回复推到看不见的地方
  if (!vh) return a;

  // 不算长：整条给足，从顶部开始看
  if (h <= vh * ROOM_RATIO) return u;

  // 太长：只留最后两行，下面紧接着就是回复开头
  const lh = num(lineHeight);
  const tail = lh === null ? 0 : lh * (num(tailLines) || 0);
  // 尾巴比整条还高时夹回顶部，不滚到句子上面去
  return Math.max(u, u + h - tail);
}

module.exports = { pickReplyAnchor, ROOM_RATIO, TAIL_LINES };
