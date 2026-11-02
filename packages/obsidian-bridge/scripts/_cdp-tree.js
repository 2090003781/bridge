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
  console.log('vault md count:', await ev("app.vault.getMarkdownFiles().length"));
  console.log('root children:', await ev("JSON.stringify(app.vault.getRoot().children.map(c => c.name).slice(0, 20))"));
  console.log('file-explorer view:', await ev("!!app.workspace.getLeavesOfType('file-explorer')[0]"));
  console.log('explorer items:', await ev("document.querySelectorAll('.nav-folder-title').length"));
  console.log('explorer top folders:', await ev("JSON.stringify(Array.from(document.querySelectorAll('.nav-folder-title')).slice(0, 12).map(e => e.textContent))"));
  console.log('explorer file count:', await ev("document.querySelectorAll('.nav-file-title').length"));
  console.log('obsidian-only in tree:', await ev("!!Array.from(document.querySelectorAll('.nav-folder-title')).find(e => e.textContent.includes('obsidian-only'))"));
  ws.close();
})();