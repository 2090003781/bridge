'use strict';
// Bridge · 账本读取（日志界面用）
// 账本是 JSONL：一行一次调用。这里只做解析/统计/过滤，不碰文件系统。

function computeStats(entries) {
  let ok = 0;
  let failed = 0;
  let totalMs = 0;
  const byOp = {};
  for (const e of entries) {
    if (e.ok === false) failed += 1;
    else ok += 1;
    if (typeof e.ms === 'number' && Number.isFinite(e.ms)) totalMs += e.ms;
    if (e.op) byOp[e.op] = (byOp[e.op] || 0) + 1;
  }
  const total = entries.length;
  return {
    total,
    ok,
    failed,
    avgMs: total > 0 ? Math.round(totalMs / total) : 0,
    byOp,
  };
}

function parseLedger(text, { limit = 500 } = {}) {
  const lines = String(text || '').split(/\r?\n/);
  const entries = [];
  let skipped = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (entry && typeof entry === 'object') entries.push(entry);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  const sliced = limit > 0 && entries.length > limit ? entries.slice(-limit) : entries;
  return { entries: sliced, stats: computeStats(sliced), skipped };
}

function filterEntries(entries, { onlyFailed = false, query = '' } = {}) {
  const q = String(query || '').trim().toLowerCase();
  return entries.filter((entry) => {
    if (onlyFailed && entry.ok !== false) return false;
    if (!q) return true;
    const hay = [entry.op, entry.client, entry.args, entry.error].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });
}

module.exports = { parseLedger, filterEntries, computeStats };