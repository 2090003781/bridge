// Bridge · MCP 桥的协议层（纯函数，可单测）
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

test('initialize 返回协议版本和服务器身份', async () => {
  const handler = createMcpHandler({ callCore: async () => ({ ok: true, data: {} }) });
  const res = await handler.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

  assert.equal(res.id, 1);
  assert.ok(res.result.protocolVersion);
  assert.equal(res.result.serverInfo.name, 'obsidian-bridge');
  assert.equal(typeof res.result.capabilities.tools, 'object');
});

test('tools/list 给出命令相关的工具', async () => {
  const handler = createMcpHandler({ callCore: async () => ({ ok: true, data: {} }) });
  const res = await handler.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

  const names = res.result.tools.map((t) => t.name);
  for (const expected of ['obsidian_health', 'obsidian_ops', 'obsidian_commands', 'obsidian_exec']) {
    assert.ok(names.includes(expected), `缺少工具 ${expected}`);
  }
  const exec = res.result.tools.find((t) => t.name === 'obsidian_exec');
  assert.deepEqual(exec.inputSchema.required, ['commandId']);
});

test('tools/call obsidian_commands 调命令清单并把结果转成文本', async () => {
  const core = fakeCore({ ok: true, data: { commands: [{ id: 'editor:toggle-bold', name: '加粗' }] } });
  const handler = createMcpHandler({ callCore: core.call });

  const res = await handler.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'obsidian_commands', arguments: {} },
  });

  assert.deepEqual(core.calls[0], { opId: 'obsidian.command.list', args: {} });
  assert.equal(res.result.isError, undefined);
  assert.match(res.result.content[0].text, /editor:toggle-bold/);
});

test('tools/call obsidian_exec 把 commandId 传给执行操作', async () => {
  const core = fakeCore({ ok: true, data: { executed: true, id: 'editor:toggle-bold' } });
  const handler = createMcpHandler({ callCore: core.call });

  const res = await handler.handle({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'obsidian_exec', arguments: { commandId: 'editor:toggle-bold' } },
  });

  assert.deepEqual(core.calls[0], {
    opId: 'obsidian.command.execute',
    args: { id: 'editor:toggle-bold' },
  });
  assert.equal(res.result.isError, undefined);
});

test('Bridge 返回失败时工具结果标 isError 并带上原因', async () => {
  const handler = createMcpHandler({
    callCore: async () => ({ ok: false, error: { code: 'forbidden', message: '档位不足' } }),
  });

  const res = await handler.handle({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'obsidian_exec', arguments: { commandId: 'x' } },
  });

  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /档位不足/);
});

test('不认识的工具返回错误结果', async () => {
  const handler = createMcpHandler({ callCore: async () => ({ ok: true, data: {} }) });
  const res = await handler.handle({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'nope', arguments: {} },
  });

  assert.equal(res.result.isError, true);
});

test('通知（没有 id）不产生响应', async () => {
  const handler = createMcpHandler({ callCore: async () => ({ ok: true, data: {} }) });
  const res = await handler.handle({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  assert.equal(res, null);
});