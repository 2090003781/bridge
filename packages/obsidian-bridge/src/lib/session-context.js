// Bridge · 切换会话时窗口里该显示什么
//
// 面板只显示「当前绑定会话」的对话。切会话时两件事容易出错：
//   1. 上一条会话的历史请求还没回来，落到了新会话的窗口上——看起来像串台
//   2. 历史回来了，但加载期间又有新消息到，直接覆盖就把它们丢了
// 这两件事做成纯函数放这里，好测。

// 一次拉多少条历史：切过去能接上话就够，多了只是拖慢渲染。
const HISTORY_LIMIT = 10;

// 这条历史该不该落到窗口上
function transcriptState({ reqToken, curToken, reqSession, curSession } = {}) {
  // 请求发出后又切过会话（token 变了）：哪怕切回来的是同一个会话也作废，
  // 因为窗口已经按新会话重建过了
  if (reqToken !== curToken) return 'stale';
  // 会话对不上也作废；两边有一边不知道时只认 token，不无端丢历史
  if (reqSession && curSession && reqSession !== curSession) return 'stale';
  return 'apply';
}

// 历史打底；加载期间新到的消息接在后面，同一条不重复出现
function mergeTranscript({ transcript, live } = {}) {
  const out = (Array.isArray(transcript) ? transcript : []).filter(Boolean);
  const extra = (Array.isArray(live) ? live : []).filter(Boolean);
  for (const msg of extra) {
    // 只看尾部几条：同一条消息的实时版和历史版总在末尾附近
    const from = Math.max(0, out.length - 6);
    let dup = false;
    for (let i = from; i < out.length; i += 1) {
      const seen = out[i];
      if (seen && seen.role === msg.role && seen.text === msg.text) {
        dup = true;
        break;
      }
    }
    if (!dup) out.push(msg);
  }
  return out;
}

module.exports = { HISTORY_LIMIT, transcriptState, mergeTranscript };
