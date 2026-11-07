'use strict';
// Bridge · 设置归一化
// 凡是外部写进来的设置（data.json）都先过这里：非法值回默认，绝不把坏配置带进运行时。

const DEFAULTS = {
  enabled: true,
  host: '127.0.0.1',
  port: 8811,
  defaultLevel: 'read',
  token: '',
  permissions: null,
  ledger: true,
  chatSessionId: '',
  chatOpen: false,
  injectionEnabled: false,
  tokenTtl: 0,
  tokenIssuedAt: 0,
};

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const LEVELS = new Set(['read', 'write', 'trust']);

function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const port = Number.isInteger(src.port) && src.port >= 1 && src.port <= 65535 ? src.port : DEFAULTS.port;
  const host = typeof src.host === 'string' && LOOPBACK.has(src.host) ? src.host : DEFAULTS.host;
  const defaultLevel = LEVELS.has(src.defaultLevel) ? src.defaultLevel : DEFAULTS.defaultLevel;
  // token 有效期：0 = 永久；负数/垃圾值一律当永久（不放宽也不收紧）。
  const tokenTtl = Number.isFinite(src.tokenTtl) && src.tokenTtl > 0 ? src.tokenTtl : 0;
  const tokenIssuedAt = Number.isFinite(src.tokenIssuedAt) && src.tokenIssuedAt > 0 ? src.tokenIssuedAt : 0;
  const enabled = typeof src.enabled === 'boolean' ? src.enabled : DEFAULTS.enabled;
  const token = typeof src.token === 'string' ? src.token : '';
  const permissions = src.permissions && typeof src.permissions === 'object' ? src.permissions : null;
  const ledger = typeof src.ledger === 'boolean' ? src.ledger : DEFAULTS.ledger;
  const chatSessionId = typeof src.chatSessionId === 'string' ? src.chatSessionId : '';
  const chatOpen = typeof src.chatOpen === 'boolean' ? src.chatOpen : false;
  const injectionEnabled = typeof src.injectionEnabled === 'boolean' ? src.injectionEnabled : false;

  return {
    enabled,
    host,
    port,
    defaultLevel,
    token,
    permissions,
    ledger,
    chatSessionId,
    chatOpen,
    injectionEnabled,
    tokenTtl,
    tokenIssuedAt,
  };
}

// 注入开关只有一个真相源：连接器（真正执行注入的是它）。
// 本地值只是缓存，不一致时以远端为准；远端读不到（没连上/旧版本）就不许乱改本地。
function reconcileInjection({ remote, local } = {}) {
  const known = typeof remote === 'boolean';
  if (!known) return { value: local === true, changed: false, unknown: true };
  const value = remote === true;
  return { value, changed: value !== (local === true) };
}

module.exports = {
  reconcileInjection, DEFAULTS, normalizeSettings, normalizeSettingsSafe: normalizeSettings };