'use strict';
// Bridge · MCP 桥协议层（纯函数）
// 只负责 JSON-RPC 报文 ↔ Bridge 操作；真正的 HTTP 调用由 scripts/mcp-bridge.js 注入。

const PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'obsidian_health',
    description: '查看 Bridge 是否在运行（Obsidian 是否开着、服务版本、命令数）',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'obsidian_ops',
    description: '列出 Bridge 的全部操作入口与当前档位（read / write / trust）',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'obsidian_call',
    description: '通用调用：按操作 id 调 Bridge 操作目录里的任意操作，args 原样传入',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', description: '操作 id，例如 obsidian.editor.state' },
        args: { type: 'object', description: '该操作的参数对象' },
      },
      required: ['op'],
      additionalProperties: false,
    },
  },
  {
    name: 'obsidian_commands',
    description: '列出 Obsidian 命令面板里的全部命令；可用 query 按 id 或名称过滤',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '按命令 id 或名称过滤（不填则全部）' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'obsidian_exec',
    description: '执行一条 Obsidian 命令（命令面板里的任意命令），返回是否真的执行了以及命令名称',
    inputSchema: {
      type: 'object',
      properties: {
        commandId: { type: 'string', description: '命令 id，例如 editor:toggle-bold / workspace:split-vertical' },
      },
      required: ['commandId'],
      additionalProperties: false,
    },
  },
  {
    name: 'obsidian_editor_state',
    description:
      '屏幕上那篇笔记的状态：路径 / 光标最后位置 / 选区 / 行数 / 是否在有焦点的编辑器里。焦点跑到别处（比如 Bridge 面板）时也照样返回。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'obsidian_editor_insert',
    description: '在光标处插入文本（position=end 追加到文末），保留撤销栈',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要插入的文本' },
        position: { type: 'string', enum: ['cursor', 'end'], description: 'cursor=光标处（默认），end=文末' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'obsidian_editor_replace',
    description:
      '替换 AI 自己的选区。两种用法：① 直接带 from/to 指定范围；② 先 obsidian_editor_aiCursor 选一段再调用（不带 from/to）。两种都不会动你的光标。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '替换成什么' },
        // from/to 必须写全 properties：只写 type:'object' 的话，
        // 部分 MCP 客户端会当成空对象传过来，参数在客户端就被吞掉了
        // （表现是「明明给了坐标却报没有选中内容」）。
        from: {
          type: 'object',
          description: '起位置',
          properties: { line: { type: 'integer', description: '行，0 起' }, ch: { type: 'integer', description: '列，0 起' } },
          required: ['line'],
          additionalProperties: false,
        },
        to: {
          type: 'object',
          description: '止位置',
          properties: { line: { type: 'integer', description: '行，0 起' }, ch: { type: 'integer', description: '列，0 起' } },
          required: ['line'],
          additionalProperties: false,
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'obsidian_editor_aiCursor',
    description:
      'AI 自己的光标与选区：读位置、移动、选中一段、收起选区。完全不碰用户的光标。插入/替换前通常要先用它指定位置。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '库内路径；省略则取屏幕上那篇' },
        line: { type: 'integer', description: '移动光标到这一行（0 起）' },
        ch: { type: 'integer', description: '列（0 起）' },
        select: { type: 'object', description: '选中一段 {from:{line,ch}, to:{line,ch}}' },
        collapse: { type: 'boolean', description: 'true = 取消选区，只留插入点' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'obsidian_editor_cursor',
    description: '把光标移到指定行/列并滚动到可见位置（line 从 0 起）',
    inputSchema: {
      type: 'object',
      properties: {
        line: { type: 'integer', description: '行号，0 起' },
        ch: { type: 'integer', description: '列号，默认 0' },
      },
      required: ['line'],
      additionalProperties: false,
    },
  },
  {
    name: 'obsidian_workspace_state',
    description: '工作区快照：活跃文件 + 所有打开的标签（类型 / 路径 / 模式）',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'obsidian_workspace_open',
    description: '打开一篇笔记（可新标签 newLeaf / 分屏 split / 指定 mode=source|preview）',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '库内路径，例如 tmp/a.md' },
        mode: { type: 'string', enum: ['source', 'preview'], description: '打开模式' },
        newLeaf: { type: 'boolean', description: '新标签打开' },
        split: { type: 'boolean', description: '分屏打开' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
];

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toContent(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function toToolError(res) {
  const err = (res && res.error) || {};
  const text = `错误 [${err.code || 'unknown'}] ${err.message || '调用失败'}`;
  return { isError: true, content: [{ type: 'text', text }] };
}

function badArgs(message) {
  return { isError: true, content: [{ type: 'text', text: `错误 [bad-args] ${message}` }] };
}

function pick(args, keys) {
  const out = {};
  for (const key of keys) {
    if (args && args[key] !== undefined) out[key] = args[key];
  }
  return out;
}

function createMcpHandler({ callCore, listOps, serverVersion = '0.1.0' } = {}) {
  if (typeof callCore !== 'function') throw new Error('createMcpHandler 需要 callCore');

  async function simple(opId, args) {
    const res = await callCore(opId, args || {});
    return res.ok ? toContent(res.data) : toToolError(res);
  }

  async function callTool(name, args) {
    if (name === 'obsidian_health') return simple('core.health', {});
    if (name === 'obsidian_ops') {
      const res = typeof listOps === 'function' ? await listOps() : { ok: true, data: { ops: [] } };
      return res.ok ? toContent(res.data) : toToolError(res);
    }
    if (name === 'obsidian_call') {
      const op = String((args && args.op) || '').trim();
      if (!op) return badArgs('缺少 op');
      return simple(op, (args && args.args) || {});
    }
    if (name === 'obsidian_commands') {
      const res = await callCore('obsidian.command.list', {});
      if (!res.ok) return toToolError(res);
      const query = String((args && args.query) || '').trim().toLowerCase();
      const commands = (res.data.commands || []).filter(
        (c) => !query || String(c.id).toLowerCase().includes(query) || String(c.name).toLowerCase().includes(query),
      );
      return toContent({ total: commands.length, commands });
    }
    if (name === 'obsidian_exec') {
      const commandId = String((args && args.commandId) || '').trim();
      if (!commandId) return badArgs('缺少 commandId');
      return simple('obsidian.command.execute', { id: commandId });
    }
    if (name === 'obsidian_editor_state') return simple('obsidian.editor.state', {});
    if (name === 'obsidian_editor_insert') {
      const text = String((args && args.text) || '');
      if (!text) return badArgs('缺少 text');
      return simple('obsidian.editor.insert', pick(args, ['text', 'position']));
    }
    if (name === 'obsidian_editor_replace') {
      if (typeof (args && args.text) !== 'string') return badArgs('缺少 text');
      return simple('obsidian.editor.replace', pick(args, ['text', 'from', 'to']));
    }
    if (name === 'obsidian_editor_aiCursor') {
      return simple('obsidian.editor.aiCursor', pick(args, ['path', 'line', 'ch', 'select', 'collapse']));
    }
    if (name === 'obsidian_editor_cursor') {
      if (!Number.isInteger(args && args.line)) return badArgs('缺少 line（整数）');
      return simple('obsidian.editor.cursor', pick(args, ['line', 'ch']));
    }
    // 不依赖编辑器焦点的写入：按 path + 行号范围改文件。
    // 主人在 Bridge 面板打字时 editor.* 会 no-active-editor，这条路随时可用。
    if (name === 'obsidian_workspace_state') return simple('obsidian.workspace.state', {});
    if (name === 'obsidian_workspace_open') {
      const path = String((args && args.path) || '').trim();
      if (!path) return badArgs('缺少 path');
      return simple('obsidian.workspace.open', pick(args, ['path', 'mode', 'newLeaf', 'split']));
    }
    return { isError: true, content: [{ type: 'text', text: `错误 [unknown-tool] 没有这个工具：${name}` }] };
  }

  return {
    tools: TOOLS,
    async handle(msg) {
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
        return rpcError(null, -32600, 'Invalid Request');
      }
      const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
      const id = hasId ? msg.id : null;
      const method = String(msg.method || '');

      if (!hasId) return null;

      switch (method) {
        case 'initialize':
          return ok(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'obsidian-bridge', version: serverVersion },
          });
        case 'ping':
          return ok(id, {});
        case 'tools/list':
          return ok(id, { tools: TOOLS });
        case 'tools/call': {
          const name = msg.params && msg.params.name;
          const args = (msg.params && msg.params.arguments) || {};
          try {
            return ok(id, await callTool(name, args));
          } catch (err) {
            return ok(id, {
              isError: true,
              content: [{ type: 'text', text: `错误 [transport] ${String((err && err.message) || err)}` }],
            });
          }
        }
        default:
          return rpcError(id, -32601, `Method not found: ${method}`);
      }
    },
  };
}

module.exports = { createMcpHandler, PROTOCOL_VERSION, TOOLS };