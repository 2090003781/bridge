'use strict';
// Bridge · 插件运行日志（不是操作账本）
// 记录启动/停止/重启/异常；带大小上限，超了保留后半，避免无限增长。

const fs = require('node:fs');
const path = require('node:path');

function createPluginLog({ file, maxBytes = 512 * 1024 } = {}) {
  if (!file) throw new Error('createPluginLog 需要 file');

  function ensureDir() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  function write(kind, message) {
    try {
      ensureDir();
      fs.appendFileSync(file, `${new Date().toISOString()} [${kind}] ${message}\n`, 'utf8');
      const size = fs.statSync(file).size;
      if (size > maxBytes) {
        const text = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, text.slice(-Math.floor(maxBytes / 2)), 'utf8');
      }
    } catch {
      /* 日志写失败不影响主流程 */
    }
  }

  function read(maxLines = 300) {
    try {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
      return lines.slice(-maxLines).join('\n');
    } catch {
      return '';
    }
  }

  return { write, read, file };
}

module.exports = { createPluginLog };