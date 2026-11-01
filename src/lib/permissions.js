'use strict';
// Bridge · 权限（三档，按客户端记档）
// 规则：read < write < trust，累积释放；模块默认 read（安全兜底），插件运行时按设置传 write。

const LEVELS = ['read', 'write', 'trust'];
const ORDER = { read: 0, write: 1, trust: 2 };
const LEVEL_LABEL = { read: '只读', write: '可写', trust: '相信' };

function createPermissions({ state = {}, defaultLevel = 'read', onSave = null } = {}) {
  const seed = state && typeof state === 'object' ? state : {};
  const clients = { ...(seed.clients || {}) };
  let fallback = ORDER[defaultLevel] !== undefined ? defaultLevel : 'read';

  function levelOf(client) {
    const rec = clients[client];
    return rec && ORDER[rec.level] !== undefined ? rec.level : fallback;
  }

  function snapshot() {
    return { version: 1, defaultLevel: fallback, clients: { ...clients } };
  }

  function persist() {
    if (typeof onSave === 'function') onSave(snapshot());
  }

  function assertLevel(level) {
    if (ORDER[level] === undefined) {
      throw new Error(`非法档位：${level}（只认 read / write / trust）`);
    }
    return level;
  }

  return {
    LEVELS,
    LEVEL_LABEL,
    levelOf,
    snapshot,
    can(client, opTier) {
      const need = ORDER[opTier];
      if (need === undefined) return false;
      return ORDER[levelOf(client)] >= need;
    },
    setLevel(client, level) {
      if (!client || typeof client !== 'string') throw new Error('缺少客户端标识');
      assertLevel(level);
      clients[client] = { level, updatedAt: new Date().toISOString() };
      persist();
      return level;
    },
    setDefault(level) {
      fallback = assertLevel(level);
      persist();
      return fallback;
    },
    list() {
      return Object.entries(clients).map(([client, rec]) => ({
        client,
        level: rec.level,
        updatedAt: rec.updatedAt || null,
      }));
    },
  };
}

module.exports = { createPermissions, LEVELS, ORDER, LEVEL_LABEL };