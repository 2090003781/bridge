// Bridge 连接器 · 投递前现查 Obsidian 的编辑状态。
//
// 为什么不全靠推送：推送由「切标签 / 改正文」触发，最快也有几秒延迟。
// 而「主人发这句话的时候在看哪一段」，问一次本地回环就能拿到最准的——
// 实测 35~45ms，感觉不到。
//
// 查的不是「焦点在哪」：在 Bridge 面板里打字时，焦点在输入框上。
// 查的是「屏幕上那篇还开着的笔记 + 光标最后停在哪」。
//
// 现查失败（Obsidian 没开、插件在重启）不报错也不阻塞：
// 退回推送缓存，再拿不到就当没有，绝不拖慢投递。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_INFO = path.join(os.homedir(), '.obsidian-bridge', 'info.json');
// Obsidian 侧一次 editor.state 是纯内存读取，实测 35~45ms；
// 900ms 只是「它卡住了我别跟着卡」的上限。
const DEFAULT_TIMEOUT_MS = 900;
const INFO_TTL_MS = 5000;

const asNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

const baseName = (p) => {
  const s = String(p || '');
  const cut = s.split('/').pop() || s;
  return cut.replace(/\.md$/i, '');
};

/** Obsidian 的 {from:{line,ch}, to:{line,ch}, text, length} → 内部形状 */
export function toSelection(sel) {
  if (!sel || !sel.from || !sel.to) return null;
  const fromLine = asNum(sel.from.line);
  const toLine = asNum(sel.to.line);
  if (fromLine === null || toLine === null) return null;
  return {
    fromLine,
    fromCh: asNum(sel.from.ch),
    toLine,
    toCh: asNum(sel.to.ch),
    chars: asNum(sel.length),
    preview: typeof sel.text === 'string' ? sel.text.slice(0, 400) : null,
  };
}

export function createObsidianProbe({
  infoFile = DEFAULT_INFO,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  let cached = null; // { at, info }

  function readInfo() {
    const t = now();
    if (cached && t - cached.at < INFO_TTL_MS) return cached.info;
    try {
      const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
      if (!info || !info.port || !info.token) return null;
      cached = { at: t, info };
      return info;
    } catch {
      return null;
    }
  }

  async function call(op, args = {}) {
    const info = readInfo();
    if (!info) return { ok: false, error: { code: 'offline', message: 'Obsidian 没开或 Bridge 插件未启用' } };
    const host = info.host || '127.0.0.1';
    if (typeof fetchImpl !== 'function') {
      return { ok: false, error: { code: 'no-fetch', message: '当前运行环境没有 fetch' } };
    }
    try {
      const res = await fetchImpl(`http://${host}:${info.port}/op`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-bridge-token': info.token,
          'x-bridge-client': 'dsh-bridge-connector',
        },
        body: JSON.stringify({ op, args }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return await res.json();
    } catch (err) {
      return { ok: false, error: { code: 'transport', message: String((err && err.message) || err) } };
    }
  }

  /**
   * 此刻屏幕上那篇笔记的状态。
   * 返回 { ok, data } —— data 为 null 表示 Obsidian 明确说「没有打开的笔记」；
   * ok:false 表示问不到（没开、超时、被拒），调用方自己决定回落。
   */
  async function editorState() {
    const payload = await call('obsidian.editor.state', {});
    if (!payload || payload.ok === false) {
      return { ok: false, error: (payload && payload.error) || { code: 'unknown', message: '查询失败' } };
    }
    const d = payload.data;
    if (!d || d.available !== true || !d.path) return { ok: true, data: null };
    return {
      ok: true,
      data: {
        path: String(d.path),
        mode: d.mode ? String(d.mode) : null,
        // focused=false：焦点不在编辑器里（在面板输入框上），
        // 光标是主人最后一次停在那里的位置，仍然指得出他在看哪一段。
        focused: d.focused !== false,
        cursor: d.cursor && asNum(d.cursor.line) !== null
          ? { line: asNum(d.cursor.line), ch: asNum(d.cursor.ch) }
          : null,
        selection: toSelection(d.selection),
        lineCount: asNum(d.lineCount),
      },
    };
  }

  return { editorState, readInfo, call };
}

/**
 * 把「现查」和「推送缓存」合成一条当前笔记记录。
 * 现查的位置更准，所以以它为准；同属一篇时，用缓存补它拿不到的东西（字数、小节、修改时间）。
 */
export function mergeActiveNote(live, pushed) {
  if (live) {
    const same = pushed && pushed.path === live.path ? pushed : null;
    return {
      ...(same || {}),
      path: live.path,
      title: (same && same.title) || baseName(live.path) || null,
      cursor: live.cursor,
      // focused=false：焦点不在编辑器里，光标是「最后一次停的位置」
      focused: live.focused !== false,
      // 现查有选区就用现查的；它明确说没有，就用缓存的说法（缓存查过才敢说「没有」）
      selection: live.selection || (same ? same.selection : null) || null,
      lineCount: live.lineCount ?? (same ? same.lineCount : null) ?? null,
      charCount: same ? same.charCount : null,
      heading: same ? same.heading : null,
      updatedAt: same ? same.updatedAt : null,
      others: same && Array.isArray(same.others) ? same.others : [],
      marks: same && Array.isArray(same.marks) ? same.marks : [],
      checked: same ? same.checked === true : false,
      at: Date.now(),
    };
  }
  return pushed || null;
}
