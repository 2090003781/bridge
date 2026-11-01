'use strict';
(async () => {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const mid = ++id; pending.set(mid, r); ws.send(JSON.stringify({ id: mid, method, params })); });
  await new Promise((r) => ws.addEventListener('open', r));
  const ev = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.result && res.result.exceptionDetails) return 'EXC: ' + JSON.stringify(res.result.exceptionDetails.exception?.description || res.result.exceptionDetails);
    return res.result?.result?.value;
  };
  console.log('setting default:', await ev("app.plugins.plugins['obsidian-bridge'].settings.injectionEnabled"));
  await ev("app.commands.executeCommandById('obsidian-bridge:bridge-open-chat')");
  await new Promise((r) => setTimeout(r, 2000));
  console.log('click inject:', await ev("(() => { const b = Array.from(document.querySelectorAll('.bridge-chat-header button')).find(x => x.textContent === '注入当前笔记'); if (b) { b.click(); return 'clicked'; } return 'no-btn'; })()"));
  await new Promise((r) => setTimeout(r, 800));
  console.log('system msgs:', await ev("Array.from(document.querySelectorAll('.bridge-msg-system')).map(e => e.textContent).join(' | ')"));
  ws.close();
})();