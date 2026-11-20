// 上下文占用：窗口可能记在日志很靠前的位置，尾部找不到就补扫头部（带缓存）
import fs from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const TAIL_BYTES = 2 * 1024 * 1024;
const HEAD_BYTES = 1024 * 1024;
const FULL_SCAN_LIMIT = 12 * 1024 * 1024;

// 文件 -> { mtimeMs, size, window, model }：窗口值一整个会话都不变，扫一次就够
const windowCache = new Map();
// 文件 -> { size, mtimeMs, result }：同一份文件状态，直接给上次的结果
const usageCache = new Map();

export function percentOf(used, window) {
  const w = Number(window);
  const u = Number(used);
  if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(u)) return null;
  const p = (u / w) * 100;
  return Math.round(Math.max(0, Math.min(100, p)) * 10) / 10;
}

function frameStarts(buf) {
  const starts = [];
  for (let i = 0; i <= buf.length - 4; i += 1) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
      starts.push(i);
    }
  }
  return starts;
}

function* frames(buf) {
  const starts = frameStarts(buf);
  for (let k = 0; k < starts.length; k += 1) {
    const s = starts[k];
    const e = k + 1 < starts.length ? starts[k + 1] : buf.length;
    let text;
    try {
      text = zstdDecompressSync(buf.subarray(s, e)).toString('utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line);
      } catch {
        /* 半行跳过 */
      }
    }
  }
}

function readRange(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

function scanBuffer(buf) {
  let window = null;
  let model = null;
  let used = null;
  for (const ev of frames(buf)) {
    const data = ev.data || {};
    if (window === null && ev.type === 'request/context' && Number.isFinite(Number(data.contextWindow))) {
      window = Number(data.contextWindow);
      if (typeof data.model === 'string') model = data.model;
    }
    // 用量是「最近一次请求」的：后面来的覆盖前面的
    if (ev.type === 'assistant/message' && data.usage) {
      const u = data.usage;
      const input = Number(u.inputTokens) || 0;
      const cached = Number(u.cacheReadTokens) || 0;
      if (input || cached) used = input + cached;
    }
  }
  return { window, model, used };
}

function windowFromFile(file, size, mtimeMs) {
  const cached = windowCache.get(file);
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached;
  // 先看头 1MB（request/context 一般很早就记下了），不够再把整份扫一遍
  let hit = scanBuffer(readRange(file, 0, Math.min(size, HEAD_BYTES)));
  if (hit.window === null && size > HEAD_BYTES && size <= FULL_SCAN_LIMIT) {
    hit = scanBuffer(readRange(file, 0, size));
  }
  const entry = { size, mtimeMs, window: hit.window, model: hit.model };
  if (entry.window !== null) windowCache.set(file, entry);
  return entry;
}

export function readUsage(file) {
  if (!file) return null;
  let size;
  let mtimeMs;
  try {
    const st = fs.statSync(file);
    size = st.size;
    mtimeMs = st.mtimeMs;
    if (size === 0) return null;
  } catch {
    return null;
  }

  const cachedUsage = usageCache.get(file);
  if (cachedUsage && cachedUsage.size === size && cachedUsage.mtimeMs === mtimeMs) return cachedUsage.result;

  const tailLength = Math.min(size, TAIL_BYTES);
  const tail = scanBuffer(readRange(file, size - tailLength, tailLength));

  let window = tail.window;
  let model = tail.model;
  if (window === null) {
    const head = windowFromFile(file, size, mtimeMs);
    window = head.window;
    model = model || head.model;
  }

  const used = tail.used === null ? 0 : tail.used;
  const result = { window, model, used, percent: percentOf(used, window) };
  if (usageCache.size > 64) usageCache.clear();
  usageCache.set(file, { size, mtimeMs, result });
  return result;
}
