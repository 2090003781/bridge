// 从 session 日志里读最近的对话。
//
// 为什么需要：Obsidian 面板 reload 后视图重建，本地 messages 数组是空的，
// 看起来像「消息都没了」。消息其实都在 DSH 的会话日志里，读回来就行。
//
// 日志是「一个事件一个 zstd frame」拼起来的（几千帧），而且很大（当前会话 6MB+），
// 所以只读文件尾部一段，从后往前切帧，凑够 N 条就停。
import fs from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const TAIL_BYTES = 4 * 1024 * 1024;

function textOf(event) {
  if (!event || (event.type !== 'user/message' && event.type !== 'assistant/message')) return null;
  const data = event.data || {};
  const content = data.content || (data.message && data.message.content) || [];
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim();
  if (!text) return null;
  return { role: event.type === 'user/message' ? 'user' : 'assistant', text };
}

export function readRecentMessages(file, limit = 20) {
  if (!file) return [];
  const want = Math.max(1, Number(limit) || 20);
  let fd;
  try {
    const size = fs.statSync(file).size;
    const readBytes = Math.min(size, TAIL_BYTES);
    const start = size - readBytes;
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(readBytes);
    fs.readSync(fd, buf, 0, readBytes, start);

    // 从尾部往前收集帧起点
    const starts = [];
    let i = buf.length - 4;
    while (i >= 0) {
      if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) {
        starts.push(i);
        if (starts.length > want * 12 + 40) break; // 事件比消息多，留余量
      }
      i -= 1;
    }
    starts.reverse();

    const out = [];
    for (let k = starts.length - 1; k >= 0 && out.length < want; k -= 1) {
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
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        const msg = textOf(ev);
        if (msg) out.push(msg);
        if (out.length >= want) break;
      }
    }
    return out.reverse();
  } catch {
    return [];
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
