// 从 DSH 的 session 日志里读会话标题。
//
// 为什么不用 sessionController.list() 里的 projections：实测那里面没有 title
// （295 个会话全是空），标题只存在于 session 日志的 session/title 事件里。
//
// 日志是「一行事件一个 zstd frame」拼起来的，Node 的 zstdDecompressSync 只解第一帧，
// 所以这里自己按 magic 切帧、逐帧解压。标题通常在第 8~10 帧（首条消息之后立刻生成），
// 所以只读文件开头一段就够了，不用把几十 MB 全解出来。
import fs from 'node:fs';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const HEAD_BYTES = 256 * 1024; // 只读开头 256KB
const MAX_FRAMES = 600;        // 够覆盖到标题生成之后

export function readTitleFromLog(file) {
  if (!file) return null;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    const slice = buf.subarray(0, n);

    const starts = [];
    let i = 0;
    while (starts.length < MAX_FRAMES) {
      i = slice.indexOf(MAGIC, i);
      if (i === -1) break;
      starts.push(i);
      i += 4;
    }

    let title = null;
    for (let k = 0; k < starts.length; k += 1) {
      const s = starts[k];
      // 最后一帧可能被截断，跳过它
      if (k + 1 >= starts.length && n === HEAD_BYTES) break;
      const e = k + 1 < starts.length ? starts[k + 1] : n;
      let text;
      try {
        text = zstdDecompressSync(slice.subarray(s, e)).toString('utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line.includes('"type":"session/title"')) continue;
        try {
          const ev = JSON.parse(line);
          const t = ev && ev.data && ev.data.title;
          if (typeof t === 'string' && t.trim()) title = t.trim();
        } catch {
          /* 坏行跳过 */
        }
      }
    }
    return title;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** sessionId -> { mtimeMs, size, title }，文件没变就不重复解压。 */
export function createTitleCache({ maxEntries = 500 } = {}) {
  const map = new Map();
  return {
    get(sessionId, file) {
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        // 文件没了：有缓存就给缓存，没有就是 null
        const hit = map.get(sessionId);
        return hit ? hit.title : null;
      }
      const hit = map.get(sessionId);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.title;
      const title = readTitleFromLog(file);
      map.set(sessionId, { mtimeMs: st.mtimeMs, size: st.size, title });
      if (map.size > maxEntries) {
        const oldest = map.keys().next().value;
        map.delete(oldest);
      }
      return title;
    },
    clear() {
      map.clear();
    },
    size() {
      return map.size;
    },
  };
}

/**
 * sessionId → 日志文件路径。
 * 目录结构是 sessions/<cwd 编码>/<sessionId>/session.v3.jsonl.zstd，cwd 编码规则复杂
 * （盘符和分隔符变 -，中文变 ~XXXX~），与其猜不如扫一遍，然后缓存几分钟。
 */
export function createSessionFileIndex(root, { ttlMs = 5 * 60 * 1000, missCooldownMs = 60 * 1000 } = {}) {
  let map = new Map();
  let builtAt = 0;
  let lastMissAt = 0;

  function build() {
    map = new Map();
    let top = [];
    try {
      top = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      builtAt = Date.now();
      return;
    }
    for (const enc of top) {
      if (!enc.isDirectory()) continue;
      const encDir = path.join(root, enc.name);
      let sessions = [];
      try {
        sessions = fs.readdirSync(encDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const s of sessions) {
        if (!s.isDirectory()) continue;
        const file = path.join(encDir, s.name, 'session.v3.jsonl.zstd');
        try {
          if (fs.statSync(file).isFile()) map.set(s.name, file);
        } catch {
          /* 没有日志文件就跳过 */
        }
      }
    }
    builtAt = Date.now();
  }

  return function fileOf(sessionId) {
    if (!sessionId) return null;
    const now = Date.now();
    if (now - builtAt > ttlMs) build();
    if (!map.has(sessionId) && now - lastMissAt > missCooldownMs) {
      // 可能是个新会话，重建一次；但别每次请求都重建
      lastMissAt = now;
      build();
    }
    return map.get(sessionId) || null;
  };
}
