// 审批：待批列表 / 三档模式 / 前缀判据 / 超时交回
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startConnector, sessionIdOf } from '../src/core/server.mjs';

async function boot(t) {
  const modes = new Map();
  const server = await startConnector({
    sessions: {
      list: async () => ({ items: [] }),
      create: async () => ({ sessionId: 's1' }),
      prompt: async () => ({ accepted: true }),
    },
    token: 'tok',
    host: '127.0.0.1',
    port: 0,
    injectionState: { on: true },
    approvalState: {
      modeFor: (sid) => modes.get(sid) || 'notify',
      setMode: (sid, mode) => modes.set(sid, mode),
    },
    injectionFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'appr-')), 'inj.json'),
    obsidianProbe: { editorState: async () => ({ ok: false }) },
  });
  t.after(() => server.close());
  return { server, base: server.url, token: 'tok' };
}

const hdr = { 'content-type': 'application/json', 'x-bridge-token': 'tok' };

test('approval/asked 进来就出现在待批列表，decided 之后消失', async (t) => {
  const ctx = await boot(t);
  ctx.server.noteEvent('s1', {
    type: 'approval/asked',
    data: { id: 'a1', toolName: 'mcp__bridge__obsidian_call', reason: '要改文件' },
  });
  let res = await fetch(`${ctx.base}/approvals?sessionId=s1`, { headers: hdr });
  let body = await res.json();
  assert.equal(body.data.pending.length, 1);
  assert.equal(body.data.pending[0].toolName, 'mcp__bridge__obsidian_call');

  ctx.server.noteEvent('s1', { type: 'approval/decided', data: { id: 'a1', outcome: 'allowed-once' } });
  res = await fetch(`${ctx.base}/approvals?sessionId=s1`, { headers: hdr });
  assert.equal((await res.json()).data.pending.length, 0);
});

test('待批列表按会话过滤', async (t) => {
  const ctx = await boot(t);
  ctx.server.noteEvent('s1', { type: 'approval/asked', data: { id: 'a1', toolName: 'x' } });
  const res = await fetch(`${ctx.base}/approvals?sessionId=s2`, { headers: hdr });
  assert.equal((await res.json()).data.pending.length, 0);
});

test('三档模式能读能切，非法值拒绝', async (t) => {
  const ctx = await boot(t);
  let res = await fetch(`${ctx.base}/approvals?sessionId=s1`, { headers: hdr });
  let body = await res.json();
  assert.equal(body.data.mode, 'notify', '默认只提示，不替人做决定');
  assert.deepEqual(body.data.modes, ['notify', 'ask', 'auto']);

  for (const mode of ['ask', 'auto', 'notify']) {
    res = await fetch(`${ctx.base}/approval/mode`, {
      method: 'POST',
      headers: hdr,
      body: JSON.stringify({ sessionId: 's1', mode }),
    });
    assert.equal((await res.json()).data.mode, mode);
    assert.equal(ctx.server.approvals.modeFor('s1'), mode);
  }

  res = await fetch(`${ctx.base}/approval/mode`, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({ sessionId: 's1', mode: '乱写' }),
  });
  assert.equal(res.status, 400);
});

test('respond 到不存在的审批：404，不假装成功', async (t) => {
  const ctx = await boot(t);
  const res = await fetch(`${ctx.base}/approval/answer`, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({ id: 'nope', decision: 'allow' }),
  });
  assert.equal(res.status, 404);
});

test('requestDecision 超时返回 null（交回下一个应答者）', async (t) => {
  const ctx = await boot(t);
  const outcome = await ctx.server.approvals.requestDecision(
    's1',
    { toolName: 'mcp__bridge__obsidian_call', reason: '改文件' },
    30
  );
  assert.equal(outcome, null);
});


test('挂起的审批用 DSH 的真实 id：同一条变成可应答，答了就放行', async (t) => {
  const ctx = await boot(t);
  ctx.server.noteEvent('s1', {
    type: 'approval/asked',
    data: { id: 'a1', toolName: 'mcp__bridge__obsidian_call', callId: 'c1' },
  });
  const pending = ctx.server.approvals.requestDecision(
    's1',
    { toolName: 'mcp__bridge__obsidian_call', callId: 'c1' },
    5000
  );
  await new Promise((r) => setTimeout(r, 60));
  const list = await (await fetch(`${ctx.base}/approvals?sessionId=s1`, { headers: hdr })).json();
  assert.equal(list.data.pending.length, 1, '不另开一条，直接用真实那条');
  assert.equal(list.data.pending[0].id, 'a1');
  assert.equal(list.data.pending[0].answerable, true);

  const res = await fetch(`${ctx.base}/approval/answer`, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({ id: 'a1', decision: 'allow' }),
  });
  assert.equal(res.status, 200);
  assert.equal(await pending, 'allowed-once', '面板的决定真的回到 DSH');
  const after = await (await fetch(`${ctx.base}/approvals?sessionId=s1`, { headers: hdr })).json();
  assert.equal(after.data.pending.length, 0);
});

test('面板点不动的审批返回 409，不假装处理过', async (t) => {
  const ctx = await boot(t);
  ctx.server.noteEvent('s1', { type: 'approval/asked', data: { id: 'b1', toolName: 'obsidian_call' } });
  const list = await (await fetch(`${ctx.base}/approvals?sessionId=s1`, { headers: hdr })).json();
  assert.equal(list.data.pending[0].answerable, false, '只提示档收集到的条目不可应答');

  const res = await fetch(`${ctx.base}/approval/answer`, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({ id: 'b1', decision: 'allow' }),
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, 'not-decidable');
});

test('会话 id 从 agent.session.id 取（请求里没有 agent.sessionId）', () => {
  assert.equal(sessionIdOf({ session: { id: 's1' } }), 's1');
  assert.equal(sessionIdOf({ sessionId: 's2' }), 's2');
  assert.equal(sessionIdOf({ id: 's3' }), 's3');
  assert.equal(sessionIdOf({}), '');
  assert.equal(sessionIdOf(null), '');
});

test('DSH 那边先定了：挂住的请求跟着结束，不会一直挂着', async (t) => {
  const ctx = await boot(t);
  ctx.server.noteEvent('s1', { type: 'approval/asked', data: { id: 'c1', toolName: 'obsidian_call' } });
  const pending = ctx.server.approvals.requestDecision('s1', { toolName: 'obsidian_call' }, 8000);
  await new Promise((r) => setTimeout(r, 60));
  ctx.server.noteEvent('s1', { type: 'approval/decided', data: { id: 'c1', outcome: 'rejected' } });
  const got = await Promise.race([pending, new Promise((r) => setTimeout(() => r('hung'), 2000))]);
  assert.equal(got, 'rejected', '被拒绝也要立刻把挂起的 promise 结掉');
});

test('自动放行档：Bridge 工具不留痕，别的工具照样提示', async (t) => {
  const ctx = await boot(t);
  await fetch(`${ctx.base}/approval/mode`, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({ sessionId: 's1', mode: 'auto' }),
  });
  const keepBridge = ctx.server.noteEvent('s1', {
    type: 'approval/asked',
    data: { id: 'auto1', toolName: 'mcp__bridge__obsidian_call' },
  });
  assert.equal(keepBridge, false, '自动放行不留痕，面板不该闪一下');
  const list = await (await fetch(`${ctx.base}/approvals?sessionId=s1`, { headers: hdr })).json();
  assert.equal(list.data.pending.length, 0);

  const keepOther = ctx.server.noteEvent('s1', {
    type: 'approval/asked',
    data: { id: 'auto2', toolName: 'pwsh' },
  });
  assert.equal(keepOther, true, '不是 Bridge 工具就照常提示');
});

test('切到自动放行会把已经挂着的条目清掉', async (t) => {
  const ctx = await boot(t);
  ctx.server.noteEvent('s1', { type: 'approval/asked', data: { id: 'x1', toolName: 'mcp__bridge__obsidian_call' } });
  assert.equal(ctx.server.approvals.pendingFor('s1').length, 1);
  await fetch(`${ctx.base}/approval/mode`, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({ sessionId: 's1', mode: 'auto' }),
  });
  assert.equal(ctx.server.approvals.pendingFor('s1').length, 0);
});
test('只认带 obsidian_ 前缀的工具，不靠理由里的关键字', async (t) => {
  const ctx = await boot(t);
  const isBridge = ctx.server.approvals.isBridgeTool;
  assert.equal(isBridge('mcp__bridge__obsidian_call'), true);
  assert.equal(isBridge('obsidian_exec'), true);
  assert.equal(isBridge('mcp__其他__obsidian_editor_insert'), true);
  assert.equal(isBridge('pwsh'), false);
  assert.equal(isBridge('mcp__brain__brain_ops'), false);
  assert.equal(isBridge('写文件的理由里提到 obsidian'), false, '理由不算数，只看工具名');
  assert.equal(isBridge(''), false);
});
