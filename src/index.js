// Bridge 连接器 · DSH 侧 cordis 插件
// ① 起回环端点：Obsidian 面板收发消息 / 排队注入
// ② 把「当前注入」拼成系统提示词段 bridge:context（每轮重新组装，不进对话历史）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { startConnector } from './core/server.mjs';
import { renderInjection } from './core/injection.mjs';
import { createStateStore } from './core/state.mjs';

export const name = 'bridge-connector';
export const inject = ['sessionController'];

const DIR = path.join(os.homedir(), '.dsh-bridge');
const INFO_FILE = path.join(DIR, 'connector.json');

function loadToken() {
  try {
    const j = JSON.parse(fs.readFileSync(INFO_FILE, 'utf8'));
    if (typeof j.token === 'string' && j.token.length >= 16) return j.token;
  } catch {
    /* 没有就生成 */
  }
  return crypto.randomBytes(24).toString('hex');
}

function writeInfo(data) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(INFO_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    /* 写不了文件不影响服务 */
  }
}

function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

export async function apply(ctx, config = {}) {
  const basePort = Number(config.port) || 8812;
  const host = '127.0.0.1';
  const token = config.token || loadToken();
  // 注入开关的真相顺序：上次运行时的状态 → 配置默认。
  // 只读配置的话，用户在面板上开的开关会在 DSH 重启后悄悄回落成配置值。
  const stateStore = createStateStore();
  const savedState = stateStore.load();
  let injectionOn = savedState.injection === null ? config.injection === true : savedState.injection;
  const injectionState = {
    get on() {
      return injectionOn;
    },
    set on(value) {
      injectionOn = value === true;
      stateStore.save({ injection: injectionOn });
    },
  };

  let server = null;
  let lastError = null;
  for (let offset = 0; offset < 5; offset += 1) {
    try {
      server = await startConnector({
        sessions: ctx.sessionController,
        token,
        host,
        port: basePort + offset,
        clientTimeZone: localTimeZone(),
        injectionTtlMs: Number(config.injectionTtlMs) || undefined,
        injectionState,
      });
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!server) {
    ctx.logger?.warn?.(`[bridge-connector] 启动失败：${String(lastError?.message || lastError)}`);
    return;
  }

  // ② 注入点：系统提示词段 bridge:context（开关：config.injection === true）
  {
    try {
      ctx.inject(['systemPrompt'], (promptCtx) => {
        try {
          promptCtx.systemPrompt.section({
            name: 'bridge:context',
            order: 250,
            text: () => {
              if (injectionState.on !== true) return '';
              const items = server.injections.currentItems();
              return items.length ? renderInjection(items) : '';
            },
          });
          ctx.logger?.info?.('[bridge-connector] 注入已启用，注册 bridge:context');
        } catch (error) {
          ctx.logger?.warn?.(`[bridge-connector] 注册上下文段失败：${String(error?.message || error)}`);
        }
      });
    } catch (error) {
      ctx.logger?.warn?.(`[bridge-connector] systemPrompt 服务不可用：${String(error?.message || error)}`);
    }
  }

  ctx.on('session/event', (session, event) => {
    try {
      server.broadcast(session?.id, event);
    } catch {
      /* 监听器绝不打断会话 */
    }
  });

  writeInfo({
    service: 'dsh-bridge-connector',
    host,
    port: server.port,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });

  ctx.logger?.info?.(`[bridge-connector] listening ${server.url}（token 已写入 ${INFO_FILE}）`);

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      try {
        server.close();
      } catch {
        /* ignore */
      }
    });
  }
}