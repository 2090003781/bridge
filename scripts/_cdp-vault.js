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
  console.log('vault name:', await ev("app.vault.getName()"));
  console.log('vault base path:', await ev("app.vault.adapter.getBasePath()"));
  console.log('configDir:', await ev("app.vault.configDir"));
  console.log('window title:', await ev("document.title"));
  ws.close();
})();