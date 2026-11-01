// Bridge · MCP 工具扩展（通用调用 + 编辑器 / 工作区）
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHandler } = require('../src/lib/mcp-handler.js');

function fakeCore(result) {
  const calls = [];
  return {
    calls,
    call: async (opId, args) => {
      calls.push({ opId, args });
      return typeof result === 'function' ? result(opId, args) : result;
    },
  };
}

test('工具清单包含通用调用与编辑器/工作区工具', async () => {
  const handler = createMcpHandler({ callCore: async () => ({ ok: true, data: {} }) });
  const res = await handler.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const names = res.result.tools.map((t) => t.name);

  for (const expected of [
    'obsidian_call',
    'obsidian_editor_state',
    'obsidian_editor_insert',
    'obsidian_editor_replace',
    'obsidian_editor_cursor',
    'obsidian_workspace_state',
    'obsidian_workspace_open',
  ]) {
    assert.ok(names.includes(expected), `缺少工具 ${expected}`);
  }
});

test('obsidian_call 按 op 转发到 Bridge', async () => {
  const core = fakeCore({ ok: true, data: { hello: 'world' } });
  const handler = createMcpHandler({ callCore: core.call });

  const res = await handler.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'obsidian_call', arguments: { op: 'obsidian.editor.state', args: {} } },
  });

  assert.deepEqual(core.calls[0], { opId: 'obsidian.editor.state', args: {} });
  assert.equal(res.result.isError, undefined);
});

test('obsidian_editor_insert 把 text 与 position 传过去', async () => {
  const core = fakeCore({ ok: true, data: { inserted: true } });
  const handler = createMcpHandler({ callCore: core.call });

  const res = await handler.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'obsidian_editor_insert', arguments: { text: '你好', position: 'end' } },
  });

  assert.deepEqual(core.calls[0], {
    opId: 'obsidian.editor.insert',
    args: { text: '你好', position: 'end' },
  });
  assert.equal(res.result.isError, undefined);
});

test('obsidian_workspace_open 传 path 与 mode', async () => {
  const core = fakeCore({ ok: true, data: { opened: true } });
  const handler = createMcpHandler({ callCore: core.call });

  await handler.handle({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'obsidian_workspace_open', arguments: { path: 'tmp/a.md', mode: 'preview' } },
  });

  assert.deepEqual(core.calls[0], {
    opId: 'obsidian.workspace.open',
    args: { path: 'tmp/a.md', mode: 'preview' },
  });
});