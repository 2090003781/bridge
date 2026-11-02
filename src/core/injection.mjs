// Bridge 连接器 · 当前注入（进系统提示词段，可多篇）。
//
// 两种形态：
//   ① 路径注入（首选）：只记 path + absPath，每轮组装时按 mtime/size 读磁盘最新内容。
//      笔记改了，注入跟着变——这是「实时跟随」，不是拍快照。
//   ② 纯正文（兼容老格式 / 客户端没给路径时的后备）：存什么就是什么。
//
// 落盘只存路径和元信息，不存正文：存了正文，笔记后来改了也没意义。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_FILE = path.join(os.homedir(), '.dsh-bridge', 'injections.json');
// 单篇预算：注入进系统提示词、每轮都要重发，所以必须有上限。
const DEFAULT_MAX_CHARS = 512 * 1024;

export function createInjectionStore({
  ttlMs = 0,
  now = () => Date.now(),
  maxCurrent = 10,
  file = null,
  maxContentChars = DEFAULT_MAX_CHARS,
} = {}) {
  let seq = 0;
  let current = [];
  // id -> { mtimeMs, size, text }：文件没变就不重复读盘
  const cache = new Map();

  const expiring = Number.isFinite(ttlMs) && ttlMs > 0;
  const isAlive = (item) => !expiring || now() - item.at <= ttlMs;

  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(saved.items)) {
        current = saved.items.filter((x) => x && x.id && (typeof x.content === 'string' || typeof x.path === 'string'));
      }
      if (Number.isFinite(saved.seq)) seq = Math.max(seq, Number(saved.seq));
      for (const item of current) {
        const n = Number(String(item.id).replace(/^inj-/, ''));
        if (Number.isFinite(n)) seq = Math.max(seq, n);
      }
    } catch {
      // 没有文件、或者文件坏了：从空开始，不阻断启动
    }
  }

  function persist() {
    if (!file) return;
    try {
      // 有路径的记录不带正文（正文每轮实时读）
      const items = current.map((item) => {
        if (!item.path) return item;
        const { content, ...rest } = item;
        return rest;
      });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ version: 2, seq, items }), 'utf8');
    } catch {
      // 落盘失败不该让本次会话的注入失效
    }
  }

  function clamp(text) {
    const s = String(text == null ? '' : text);
    if (s.length <= maxContentChars) return s;
    return s.slice(0, maxContentChars) + '\n\n…（已截断，原文 ' + s.length + ' 字）';
  }

  function contentOf(item) {
    if (!item.path || !item.absPath) return clamp(item.content);
    // 有路径时 content 是「附加内容」（比如 Obsidian 里选中的那一段——它不在文件里）
    const extra = typeof item.content === 'string' ? item.content.trim() : '';
    const withExtra = (body) => (extra ? body + '\n\n【选中内容】\n' + extra : body);
    const cached = cache.get(item.id);
    try {
      const st = fs.statSync(item.absPath);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return clamp(withExtra(cached.text));
      const text = fs.readFileSync(item.absPath, 'utf8');
      cache.set(item.id, { mtimeMs: st.mtimeMs, size: st.size, text });
      return clamp(withExtra(text));
    } catch {
      // 文件读不到：有旧内容就用旧内容，从没读到过就明说，别给空串假装没内容
      if (cached) return clamp(withExtra(cached.text));
      return '(文件读不到：' + item.path + ')' + (extra ? '\n\n【选中内容】\n' + extra : '');
    }
  }

  function alive() {
    if (!expiring) return current;
    const before = current.length;
    current = current.filter(isAlive);
    if (current.length !== before) persist();
    return current;
  }

  return {
    // 只产出一条记录；要不要生效由调用方 markCurrent 决定。
    add({ sessionId, content, path: notePath = null, absPath = null, title = null, kind = 'context' } = {}) {
      const sid = String(sessionId || '').trim();
      const rel = notePath ? String(notePath) : null;
      const abs = absPath ? String(absPath) : null;
      const text = typeof content === 'string' ? content : null;
      if (!sid) return null;
      // 有路径就不需要正文；没路径才要求正文
      if (!rel && (!text || !text.trim())) return null;
      seq += 1;
      const record = { id: 'inj-' + seq, sessionId: sid, title, kind, at: now() };
      if (rel) {
        record.path = rel;
        if (abs) record.absPath = abs;
        // 首次给的内容作为后备（文件被删时还能用），但不落盘
        if (text) record.content = text;
      } else {
        record.content = text;
      }
      return record;
    },

    /** 记为「当前注入」：可多篇，同标题覆盖，超出上限丢最旧。 */
    markCurrent(record) {
      if (!record) return current.map((x) => ({ ...x, content: contentOf(x) }));
      const idx = current.findIndex((x) => x.title && record.title && x.title === record.title);
      if (idx >= 0) {
        cache.delete(current[idx].id);
        current[idx] = record;
      } else current.push(record);
      if (current.length > maxCurrent) {
        const dropped = current.slice(0, current.length - maxCurrent);
        for (const d of dropped) cache.delete(d.id);
        current = current.slice(-maxCurrent);
      }
      persist();
      return current.map((x) => ({ ...x, content: contentOf(x) }));
    },

    /** 返回带正文的视图（每次调用都会检查文件有没有变）。 */
    currentItems() {
      return alive().map((item) => ({ ...item, content: contentOf(item) }));
    },

    clearCurrent(id) {
      if (id) {
        const kept = current.filter((x) => x.id !== id);
        for (const x of current) if (x.id === id) cache.delete(x.id);
        current = kept;
      } else {
        current = [];
        cache.clear();
      }
      persist();
    },
  };
}

/** 把注入记录拼成一段文本，供系统提示词段使用。 */
export function renderInjection(records) {
  if (!Array.isArray(records) || records.length === 0) return '';
  const parts = records.map((r) => {
    const head = r.title ? '【' + r.title + '】' : '【注入】';
    return head + '\n' + (r.content == null ? '' : r.content);
  });
  return [
    '[Bridge 注入] 下面是主人在 Obsidian 里的上下文（不是用户发言，按需使用）：',
    ...parts,
  ].join('\n\n');
}
