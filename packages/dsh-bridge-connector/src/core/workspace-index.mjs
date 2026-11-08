// DSH 的工作区注册表（~/.dsh/storages/workspace.json）。
//
// 为什么需要它：DSH 的「工作区」是用户注册出来的表，不是按会话 cwd 自动分的。
// 磁盘上有 18 个 cwd，但注册表里只有 9 个工作区——按 cwd 分组会在 Obsidian 里
// 多出一堆 DSH 界面根本没有的「工作区」。所以分组要用这张表。
//
// 读的是 DSH 内部存储格式（unit.name === 'workspace'，version 2）。
// 格式万一变了就当没有，全部落进「未分组」，不抛错、不瞎猜。
import fs from 'node:fs';

export function createWorkspaceIndex({ file, ttlMs = 60 * 1000 } = {}) {
  let cache = null;
  let builtAt = 0;

  function build() {
    const empty = { bySession: new Map(), archived: new Set(), workspaces: [] };
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return empty;
    }
    if (!data || !data.unit || data.unit.name !== 'workspace') return empty;

    const table = data.tables && data.tables.workspaces;
    // 表是「对象」：键就是 workspaceId，记录里反而不带 id
    const entries = Array.isArray(table)
      ? table.map((w, i) => {
          const id = (w && (w.id || w.workspaceId)) || i;
          return [String(id), w];
        })
      : table
        ? Object.entries(table)
        : [];
    const bySession = new Map();
    const workspaces = [];
    for (const [id, w] of entries) {
      if (!w || typeof w !== 'object') continue;
      const title = typeof w.title === 'string' && w.title.trim() ? w.title.trim() : String(w.path || '');
      const item = { workspaceId: String(id), title, path: typeof w.path === 'string' ? w.path : '' };
      workspaces.push(item);
      for (const sid of Array.isArray(w.sessionIds) ? w.sessionIds : []) {
        bySession.set(String(sid), item);
      }
    }
    const global = data.global || {};
    const archived = new Set(
      (Array.isArray(global.archivedSessionIds) ? global.archivedSessionIds : []).map(String)
    );
    return { bySession, archived, workspaces };
  }

  return function lookup(sessionId) {
    if (!cache || Date.now() - builtAt > ttlMs) {
      cache = build();
      builtAt = Date.now();
    }
    const sid = String(sessionId || '');
    return {
      workspace: cache.bySession.get(sid) || null,
      archived: cache.archived.has(sid),
    };
  };
}
