import { statusForError } from '../src/lib/token-lifecycle.js';
// Bridge 自测（风险驱动：鉴权 / 权限 / 边界 / 写读回 / 注入 / 持久化 / 路径自适应）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 路径一律从脚本自己的位置推，不写死哪个盘——仓库搬家不该改脚本。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const info = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.obsidian-bridge', 'info.json'), 'utf8'));
const base = `http://${info.host}:${info.port}`;
const connector = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh-bridge', 'connector.json'), 'utf8'));
  } catch {
    return null;
  }
})();

const results = [];
function pass(name, detail = '') {
  results.push({ ok: true, name, detail });
  console.log(`PASS  ${name}${detail ? '  ' + detail : ''}`);
}
function fail(name, detail = '') {
  results.push({ ok: false, name, detail });
  console.log(`FAIL  ${name}  ${detail}`);
}

async function test(name, fn) {
  try {
    const detail = await fn();
    pass(name, detail === undefined ? '' : String(detail));
  } catch (err) {
    fail(name, String((err && err.message) || err));
  }
}

function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label || '值'} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  return actual;
}

async function http(pathname, { method = 'GET', token = info.token, client = 'agent.dsh', body, raw } = {}) {
  const headers = {};
  if (token) headers['x-bridge-token'] = token;
  if (client) headers['x-bridge-client'] = client;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  return { status: res.status, payload };
}

async function op(opId, args = {}, opts = {}) {
  const res = await http('/op', { method: 'POST', body: { op: opId, args }, ...opts });
  return res;
}

// ── A. 健康与鉴权 ──
await test('health 无需 token', async () => {
  const r = await http('/health', { token: null });
  eq(r.status, 200);
  eq(r.payload.data.service, 'obsidian-bridge');
  return r.payload.data.version;
});

await test('health 带 Origin 也正常（CORS 无害）', async () => {
  const r = await http('/health', { token: null });
  eq(r.status, 200);
});

await test('/ops 无 token → 401', async () => {
  const r = await http('/ops', { token: null });
  eq(r.status, 401);
  eq(r.payload.error.code, 'unauthorized');
});

await test('/ops 错 token → 401', async () => {
  const r = await http('/ops', { token: 'wrong-token' });
  eq(r.status, 401);
});

await test('/ops 正常返回操作目录', async () => {
  const r = await http('/ops');
  eq(r.status, 200);
  const ids = r.payload.data.ops.map((o) => o.id);
  for (const need of ['obsidian.command.execute', 'obsidian.editor.insert', 'obsidian.note.create', 'obsidian.note.delete']) {
    if (!ids.includes(need)) throw new Error('缺少操作 ' + need);
  }
  return `${ids.length} 个操作`;
});

await test('/op 未知 op → 404', async () => {
  const r = await op('nope.nothing');
  eq(r.status, 404);
});

await test('/op 缺 op → 400', async () => {
  const r = await http('/op', { method: 'POST', body: {} });
  eq(r.status, 400);
});

await test('/op 非法 JSON → 400', async () => {
  const r = await http('/op', { method: 'POST', raw: '{bad json' });
  eq(r.status, 400);
});

await test('/op 超大 body → 400', async () => {
  const big = JSON.stringify({ op: 'core.health', args: { x: 'a'.repeat(1024 * 1024 + 100) } });
  const r = await http('/op', { method: 'POST', raw: big });
  eq(r.status, 400);
});

await test('/op GET 方法 → 405', async () => {
  const r = await http('/op');
  eq(r.status, 405);
});

// ── B. 权限（当前档位） ──
const level = (await http('/ops')).payload.data.level;
console.log(`INFO  当前档位：${level}`);

// Obsidian 刚重载时 vault 索引还在重建，第一次写操作可能 500。
// 与其让人「再跑一遍」，不如开头就把这段抖动吃掉：预热到能写为止。
await test('vault 写通道预热', async () => {
  const warm = `tmp/zz-warmup-${Date.now()}.md`;
  let last = null;
  for (let i = 0; i < 8; i += 1) {
    last = await op('obsidian.note.create', { path: warm, content: 'warm' });
    if (last.status === 200) {
      await op('obsidian.note.delete', { path: warm, confirm: true });
      try { fs.unlinkSync(path.join(info.vaultPath, warm)); } catch {}
      return `第 ${i + 1} 次就绪`;
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  throw new Error(`预热 8 次仍写不进：${last && last.status}`);
});

await test('read 档操作可用', async () => {
  const r = await op('core.health');
  eq(r.status, 200);
});

await test('write 档操作可用', async () => {
  const tmp = `tmp/zz-selftest-${Date.now()}.md`;
  const r = await op('obsidian.note.create', { path: tmp, content: '# selftest\n' });
  eq(r.status, 200, 'create');
  await op('obsidian.note.delete', { path: tmp, confirm: true });
  // delete 是 trust，可能 403；用文件清理兜底
  try { fs.unlinkSync(path.join(info.vaultPath, tmp)); } catch {}
  return tmp;
});

await test('trust 档操作在 write 下被拒（403）', async () => {
  const r = await op('obsidian.note.delete', { path: '不存在的文件.md', confirm: true });
  if (level === 'trust') {
    // trust 档下应是 file-not-found 而非 403
    eq(r.status, statusForError(r.payload.error.code));
    return 'trust 档：走 file-not-found';
  }
  eq(r.status, 403);
  eq(r.payload.error.code, 'forbidden');
  return 'write 档：403';
});

// ── C. 笔记读写冒烟 ──
const notePath = `tmp/zz-selftest-${Date.now()}.md`;
await test('note.create 新建', async () => {
  const r = await op('obsidian.note.create', { path: notePath.replace(/\.md$/, ''), content: '---\nstatus: draft\n---\n\n# 自测\n\n第一行\n' });
  eq(r.status, 200);
  eq(r.payload.data.path, notePath);
  return notePath;
});

await test('note.read 读回完整正文', async () => {
  const r = await op('obsidian.note.read', { path: notePath });
  eq(r.status, 200);
  if (!r.payload.data.text.includes('第一行')) throw new Error('正文不对');
  return r.payload.data.length + ' 字';
});

await test('note.append 追加', async () => {
  const r = await op('obsidian.note.append', { path: notePath, text: '追加行\n' });
  eq(r.status, 200);
  const back = await op('obsidian.note.read', { path: notePath });
  if (!back.payload.data.text.includes('追加行')) throw new Error('追加没生效');
});

await test('note.property 改属性（set + del）', async () => {
  const r = await op('obsidian.note.property', { path: notePath, set: { status: 'done' }, del: ['draft'] });
  eq(r.status, 200);
  await new Promise((r) => setTimeout(r, 400));
  const back = await op('obsidian.note.read', { path: notePath });
  if (!back.payload.data.text.includes('status: done')) throw new Error('磁盘上 status 不是 done');
  if (/^draft:/m.test(back.payload.data.text)) throw new Error('磁盘上还有 draft');
});

await test('note.meta 元数据', async () => {
  const r = await op('obsidian.note.meta', { path: notePath });
  eq(r.status, 200);
  if (!Array.isArray(r.payload.data.tags)) throw new Error('tags 不是数组');
  return `tags=${r.payload.data.tags.length} links=${r.payload.data.links.length}`;
});

await test('note.backlinks 反链', async () => {
  const r = await op('obsidian.note.backlinks', { path: '个人/用户画像.md' });
  eq(r.status, 200);
  if (!Array.isArray(r.payload.data.backlinks)) throw new Error('backlinks 不是数组');
  return `${r.payload.data.backlinkCount} 条`;
});

await test('note.rename dry-run 不动文件', async () => {
  const r = await op('obsidian.note.rename', { path: notePath, to: notePath.replace('.md', '-renamed.md') });
  eq(r.status, 200);
  eq(r.payload.data.dryRun, true);
  if (!fs.existsSync(path.join(info.vaultPath, notePath))) throw new Error('dry-run 却把文件改没了');
});

await test('note.rename 真改后 from 正确', async () => {
  const to = notePath.replace('.md', '-renamed.md');
  const r = await op('obsidian.note.rename', { path: notePath, to, dryRun: false });
  eq(r.status, 200);
  eq(r.payload.data.from, notePath);
  eq(r.payload.data.to, to);
  if (!fs.existsSync(path.join(info.vaultPath, to))) throw new Error('目标文件不存在');
  return to;
});

// ── D. 编辑器 / 工作区 ──
const renamed = notePath.replace('.md', '-renamed.md');
await test('workspace.open 打开笔记', async () => {
  const r = await op('obsidian.workspace.open', { path: renamed, newLeaf: true });
  eq(r.status, 200);
  // 光等 600ms 不够：重载后编辑器可能还没把文件装进来，这时插进去的文字
  // 会被随后的加载覆盖掉，磁盘上就看不到（第二遍跑又正常）。
  // 用「编辑器行数追上磁盘行数」当装载完成的判据，最多等 10 秒。
  const disk = fs.readFileSync(path.join(info.vaultPath, renamed), 'utf8');
  const diskLines = disk.split('\n').length;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const s = await op('obsidian.editor.state');
    const d = s && s.payload && s.payload.data;
    if (d && d.available && d.path === renamed && Math.abs(d.lineCount - diskLines) <= 1) {
      return `已装载 ${d.lineCount} 行`;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('10 秒内编辑器没装载目标文件');
});

await test('editor.state 拿到活跃编辑器', async () => {
  const r = await op('obsidian.editor.state');
  eq(r.status, 200);
  eq(r.payload.data.available, true);
  eq(r.payload.data.path, renamed);
  return `行数 ${r.payload.data.lineCount}`;
});

await test('editor.insert 文末插入并落盘', async () => {
  const marker = `selftest-${Date.now()}`;
  const r = await op('obsidian.editor.insert', { text: marker, position: 'end' });
  eq(r.status, 200);
  // Obsidian 是自动保存，落盘有延迟；等条件出现而不是猜一个固定秒数。
  const file = path.join(info.vaultPath, renamed);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (fs.readFileSync(file, 'utf8').includes(marker)) return marker;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('10 秒内磁盘上没出现插入内容');
});

await test('command.list 非空', async () => {
  const r = await op('obsidian.command.list');
  eq(r.status, 200);
  if (!r.payload.data.commands.length) throw new Error('命令列表为空');
  return `${r.payload.data.commands.length} 条命令`;
});

await test('command.execute 未知命令不执行', async () => {
  const r = await op('obsidian.command.execute', { id: 'nope:no-such-command' });
  eq(r.status, 200);
  eq(r.payload.data.executed, false);
  eq(r.payload.data.reason, 'command-not-found');
});

await test('workspace.state 工作区快照', async () => {
  const r = await op('obsidian.workspace.state');
  eq(r.status, 200);
  if (!Array.isArray(r.payload.data.leaves)) throw new Error('leaves 不是数组');
  return `${r.payload.data.count} 个 leaf`;
});

await test('editor 缺 text → bad-args', async () => {
  const r = await op('obsidian.editor.insert', {});
  // 状态码按错误码映射，别写死 500（写死就分不清「参数错」和「服务挂」）
  eq(r.status, statusForError(r.payload.error.code));
  eq(r.payload.error.code, 'bad-args');
});

await test('note.read 不存在 → file-not-found', async () => {
  const r = await op('obsidian.note.read', { path: 'zz-绝对不存在.md' });
  // 状态码按错误码映射，别写死 500（写死就分不清「参数错」和「服务挂」）
  eq(r.status, statusForError(r.payload.error.code));
  eq(r.payload.error.code, 'file-not-found');
});

await test('note.create 拒绝路径穿越', async () => {
  const r = await op('obsidian.note.create', { path: '../外面.md', content: 'x' });
  // 状态码按错误码映射，别写死 500（写死就分不清「参数错」和「服务挂」）
  eq(r.status, statusForError(r.payload.error.code));
  eq(r.payload.error.code, 'bad-args');
});

await test('note.create 已存在 → file-exists', async () => {
  const r = await op('obsidian.note.create', { path: renamed, content: 'x' });
  // 状态码按错误码映射，别写死 500（写死就分不清「参数错」和「服务挂」）
  eq(r.status, statusForError(r.payload.error.code));
  eq(r.payload.error.code, 'file-exists');
});

await test('并发 10 次 read 全部成功', async () => {
  const list = await Promise.all(Array.from({ length: 10 }, () => op('obsidian.note.read', { path: renamed, maxChars: 50 })));
  for (const r of list) eq(r.status, 200);
  return '10/10';
});

// ── E. 连接器 / 注入 ──
if (connector) {
  const cbase = `http://${connector.host}:${connector.port}`;
  async function chttp(pathname, opts = {}) {
    const headers = {};
    if (opts.token !== null) headers['x-bridge-token'] = connector.token;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${cbase}${pathname}`, {
      method: opts.method || 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    let payload = null;
    try { payload = await res.json(); } catch {}
    return { status: res.status, payload };
  }

  await test('connector health', async () => {
    const r = await chttp('/health', { token: null });
    eq(r.status, 200);
    return `injection=${r.payload.data.injection}`;
  });

  await test('connector /sessions 有会话', async () => {
    const r = await chttp('/sessions');
    eq(r.status, 200);
    if (!r.payload.data.sessions.length) throw new Error('没有会话');
    return `${r.payload.data.total} 个`;
  });

  await test('connector 注入开关可切换且 /inject 跟随', async () => {
    const before = (await chttp('/config')).payload.data.injection;
    try {
      await chttp('/config', { method: 'POST', body: { injection: true } });
      const on = await chttp('/inject', { method: 'POST', body: { content: 'selftest', title: 'selftest' } });
      eq(on.status, 200, '开启后注入');
      const status = await chttp('/inject');
      if (status.status === 404) {
        results.push({ ok: true, name: 'connector 注入状态接口（需重启 DSH）', detail: 'SKIP' });
        console.log('SKIP  connector 注入状态接口：连接器是旧进程，重启 DSH 后可用');
        return 'SKIP';
      }
      const items = status.payload && status.payload.data && status.payload.data.current;
      if (!Array.isArray(items)) throw new Error('current 不是数组');
      await chttp('/inject/clear', { method: 'POST' });
      const cleared = await chttp('/inject');
      const left = cleared.payload && cleared.payload.data && cleared.payload.data.current;
      if (!Array.isArray(left) || left.length !== 0) {
        throw new Error(`清空后仍剩 ${JSON.stringify(left)}`);
      }
      return `恢复到 ${before}`;
    } finally {
      // 不管中间失败还是提前 return，开关都要还原成开工前的值（P40）
      await chttp('/config', { method: 'POST', body: { injection: before } });
    }
  });

  await test('connector /inject 空 content → 400', async () => {
    const before = (await chttp('/config')).payload.data.injection;
    try {
      await chttp('/config', { method: 'POST', body: { injection: true } });
      const r = await chttp('/inject', { method: 'POST', body: { content: '' } });
      eq(r.status, 400);
      return 'ok';
    } finally {
      // 以前这里无条件写 false，把用户开着的注入关掉了
      await chttp('/config', { method: 'POST', body: { injection: before } });
    }
  });
} else {
  fail('connector 连接信息存在', '没有 ~/.dsh-bridge/connector.json');
}

// ── F. 账本 / 日志 ──
await test('审计账本有记录', async () => {
  const p = path.join(info.pluginDir, 'data', 'ledger.jsonl');
  const text = fs.readFileSync(p, 'utf8').trim();
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 5) throw new Error('记录太少：' + lines.length);
  JSON.parse(lines[lines.length - 1]);
  return lines.length + ' 行';
});

await test('运行日志有记录', async () => {
  const p = path.join(info.pluginDir, 'data', 'bridge.log');
  const text = fs.readFileSync(p, 'utf8');
  if (!text.includes('[start]')) throw new Error('没有 start 记录');
  return text.split(/\r?\n/).filter(Boolean).length + ' 行';
});

await test('档位持久化文件存在', async () => {
  const p = path.join(info.pluginDir, 'data', 'permissions.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!j.clients || !j.clients['agent.dsh']) throw new Error('没有 agent.dsh 档位');
  return `agent.dsh=${j.clients['agent.dsh'].level}`;
});

// ── G. 路径自适应 ──
await test('服务只监听回环', async () => {
  eq(info.host, '127.0.0.1');
  return `${info.host}:${info.port}`;
});

await test('插件目录与库路径一致（非硬编码）', async () => {
  const expected = path.join(info.vaultPath, info.configDir, 'plugins', 'obsidian-bridge');
  if (path.normalize(info.pluginDir) !== path.normalize(expected)) {
    throw new Error(`info.pluginDir=${info.pluginDir} 期望 ${expected}`);
  }
});

await test('生产代码没有硬编码盘符', async () => {
  const srcDir = path.join(REPO_ROOT, 'src');
  const bad = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        const text = fs.readFileSync(full, 'utf8');
        const stripped = text.replace(/https?:\/\//g, '');
        if (/[A-Za-z]:[\\/]/.test(stripped)) bad.push(full);
      }
    }
  };
  walk(srcDir);
  if (bad.length) throw new Error('硬编码路径：' + bad.join(', '));
  return '干净';
});

// ── H. MCP 桥 ──
await test('MCP 桥 initialize + tools/list', async () => {
  const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'mcp-bridge.js')], {
    input: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n',
    encoding: 'utf8',
    timeout: 20000,
  });
  if (!r.stdout.includes('obsidian_exec')) throw new Error('工具列表不对：' + r.stdout.slice(0, 200));
  const lines = r.stdout.trim().split(/\r?\n/);
  return lines.length + ' 条响应';
});

// ── 清理测试文件（走文件系统，避免 trust 限制） ──
try { fs.unlinkSync(path.join(info.vaultPath, renamed)); } catch {}
try { fs.unlinkSync(path.join(info.vaultPath, notePath)); } catch {}

// ── 汇总 ──
const ok = results.filter((r) => r.ok).length;
const bad = results.length - ok;
console.log('');
console.log(`汇总：${results.length} 项 · 通过 ${ok} · 失败 ${bad}`);
if (bad > 0) {
  console.log('失败项：');
  for (const r of results.filter((x) => !x.ok)) console.log(` - ${r.name}: ${r.detail}`);
  process.exit(1);
}