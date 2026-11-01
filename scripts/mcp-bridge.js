#!/usr/bin/env node
'use strict';
// Bridge · DSH 侧 MCP 桥（stdio）
// 读 ~/.obsidian-bridge/info.json 找插件端口与 token，把 MCP 工具调用转成插件 HTTP 请求。
// 只往 stdout 写 JSON-RPC，日志一律走 stderr。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { createMcpHandler } = require('../src/lib/mcp-handler.js');

const INFO_FILE = process.env.BRIDGE_INFO || path.join(os.homedir(), '.obsidian-bridge', 'info.json');
const CLIENT = process.env.BRIDGE_CLIENT || 'agent.dsh';
const TIMEOUT_MS = Number(process.env.BRIDGE_TIMEOUT_MS || 60000);

function readInfo() {
  try {
    return JSON.parse(fs.readFileSync(INFO_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function offline() {
  return {
    ok: false,
    error: {
      code: 'offline',
      message: 'Bridge 未运行：先打开 Obsidian，并确认「Bridge」插件已启用（状态栏应显示「Bridge :端口」）',
    },
  };
}

async function httpJson(pathname, options = {}) {
  const once = async () => {
    const info = readInfo();
    if (!info || !info.port || !info.token) return offline();
    const host = info.host || '127.0.0.1';
    try {
      const res = await fetch(`http://${host}:${info.port}${pathname}`, {
        ...options,
        headers: {
          'content-type': 'application/json',
          'x-bridge-token': info.token,
          'x-bridge-client': CLIENT,
          ...(options.headers || {}),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return await res.json();
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'transport',
          message: `连不上 Bridge（${host}:${info.port}）：${String((err && err.message) || err)}`,
        },
      };
    }
  };

  const first = await once();
  // token 已过期/刚轮换的窗口：这次读到的是旧 token，重读 info.json 再来一次。
  // 这种请求在验 token 阶段就被拒了、根本没执行，所以重试不会造成重复写入。
  if (first && first.ok === false && first.error && first.error.code === 'token-expired') {
    return once();
  }
  return first;
}

async function callCore(opId, args) {
  return httpJson('/op', { method: 'POST', body: JSON.stringify({ op: opId, args: args || {} }) });
}

async function listOps() {
  return httpJson('/ops', { method: 'GET' });
}

const handler = createMcpHandler({ callCore, listOps });

process.stdout.on('error', () => {});
process.on('uncaughtException', (err) => {
  process.stderr.write(`[obsidian-bridge] uncaught: ${String((err && err.stack) || err)}\n`);
});

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();
rl.on('close', () => {
  process.exitCode = 0;
});

rl.on('line', (line) => {
  const text = String(line || '').trim();
  if (!text) return;
  queue = queue.then(async () => {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
      return;
    }
    try {
      const res = await handler.handle(msg);
      if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
    } catch (err) {
      process.stderr.write(`[obsidian-bridge] handler error: ${String((err && err.stack) || err)}\n`);
    }
  });
});

process.stderr.write(`[obsidian-bridge] MCP bridge ready (info=${INFO_FILE}, client=${CLIENT})\n`);