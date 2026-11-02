'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const REPO_ROOT = path.resolve(__dirname, '..');

const servers = [
  { name: 'win11vm', cmd: 'C:\\Python311\\python.exe', args: ['E:/VMs/_tools/vm_mcp.py'], cwd: 'E:/VMs/_tools' },
  { name: 'web-search-safe', cmd: 'C:\\Program Files\\nodejs\\node.exe', args: ['D:\\qq-bridge\\src\\mcp-web-search-safe.js'], cwd: 'D:\\qq-bridge' },
  { name: 'bridge', cmd: 'C:\\Program Files\\nodejs\\node.exe', args: [path.join(REPO_ROOT, 'scripts', 'mcp-bridge.js')], cwd: REPO_ROOT },
];

function timeOne(s) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(s.cmd, s.args, { cwd: s.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buf = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try { child.kill(); } catch {}
      resolve({ name: s.name, ms: Date.now() - t0, ...result });
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout-30s' }), 30000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1 && msg.result) {
            clearTimeout(timer);
            finish({ ok: true, server: msg.result.serverInfo && msg.result.serverInfo.name });
            return;
          }
        } catch {}
      }
    });
    child.on('error', (err) => { clearTimeout(timer); finish({ ok: false, reason: String(err.message || err) }); });
    child.on('exit', (code) => { if (!done) { clearTimeout(timer); finish({ ok: false, reason: 'exited-' + code }); } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'timing', version: '0' } } }) + '\n');
  });
}

(async () => {
  for (const s of servers) {
    const r = await timeOne(s);
    console.log(`${r.ok ? '✅' : '❌'} ${r.name}: ${r.ms}ms ${r.ok ? 'server=' + (r.server || '?') : '(' + r.reason + ')'}`);
  }
})();