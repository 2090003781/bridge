'use strict';
// Bridge · 面板里把图片显示出来。
//
// markdown 的 ![alt](目标) 里，目标如果是本地绝对路径：
//   库内（在 Obsidian 库里）→ 换成库相对路径，Obsidian 自己能解析；
//   库外（比如 agent 存在临时目录的截图）→ Obsidian 不会为了一个外链去读磁盘，
//     这里把文件读成 data URL 塞进去，才真的显示得出来。
// 其余（http、data:、库内相对路径、wikilink 嵌入）原样不动。

const IMAGE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
};

// 一张图最大内联多少：再大就把面板拖住了，宁可显示成坏链让人自己去开
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

// ![alt](目标) —— 目标可以写成 <路径 带空格>
const IMAGE_RE = /!\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)\s*\)/g;

function toPosix(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/');
}

// C:\... 、d:/... 、\\server\share\... 算本地绝对路径
function isAbsoluteLocal(target) {
  const t = String(target == null ? '' : target);
  if (/^[a-zA-Z]:[\\/]/.test(t)) return true;
  if (/^\\\\/.test(t) || /^\/\//.test(t)) return true;
  return false;
}

// 绝对路径在库里面的话，返回库相对路径；不在库里返回 null
function relativeToRoot(root, absPath) {
  const r = toPosix(root).replace(/\/+$/, '').toLowerCase();
  const a = toPosix(absPath);
  if (!r || !a) return null;
  const lower = a.toLowerCase();
  if (lower === r) return '';
  if (!lower.startsWith(r + '/')) return null;
  return a.slice(r.length + 1);
}

function mimeOf(target) {
  const m = /\.([a-z0-9]+)$/i.exec(toPosix(target));
  if (!m) return null;
  return IMAGE_MIME[m[1].toLowerCase()] || null;
}

// 读成 data URL；读不到、不是图片、太大都返回 null
function dataUrlOf(target, { readFile, maxBytes }) {
  const mime = mimeOf(target);
  if (!mime || typeof readFile !== 'function') return null;
  let buf;
  try {
    buf = readFile(target);
  } catch {
    return null;
  }
  if (!buf || typeof buf.length !== 'number' || buf.length === 0) return null;
  if (buf.length > maxBytes) return null;
  return 'data:' + mime + ';base64,' + Buffer.from(buf).toString('base64');
}

// 路径里有空格要留给 <>，否则 markdown 解析到空格就断了
function linkTarget(rel) {
  return /\s/.test(rel) ? '<' + rel + '>' : rel;
}

function rewriteLocalImages(text, { vaultRoot, readFile, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const src = String(text == null ? '' : text);
  if (!src.includes('![')) return src;
  return src.replace(IMAGE_RE, (whole, alt, raw) => {
    const wrapped = raw.startsWith('<') && raw.endsWith('>');
    const target = wrapped ? raw.slice(1, -1).trim() : raw;
    if (!isAbsoluteLocal(target)) return whole;
    const rel = relativeToRoot(vaultRoot, target);
    if (rel) return '![' + alt + '](' + linkTarget(rel) + ')';
    const dataUrl = dataUrlOf(target, { readFile, maxBytes });
    if (!dataUrl) return whole;
    return '![' + alt + '](' + dataUrl + ')';
  });
}

module.exports = {
  rewriteLocalImages,
  isAbsoluteLocal,
  relativeToRoot,
  mimeOf,
  DEFAULT_MAX_BYTES,
};
