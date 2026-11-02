'use strict';
// Bridge · 服务信息文件
// 插件启动时把「端口 / token / pid / 库名」写到 ~/.obsidian-bridge/info.json，
// MCP 桥按这个文件找人，不硬编码端口。

const fs = require('node:fs');
const path = require('node:path');

function createInfoStore({ dir }) {
  const file = path.join(dir, 'info.json');
  return {
    dir,
    file,
    write(data) {
      fs.mkdirSync(dir, { recursive: true });
      const payload = { ...data, updatedAt: new Date().toISOString() };
      fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
      return payload;
    },
    read() {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return null;
      }
    },
    clear() {
      try {
        fs.unlinkSync(file);
      } catch {
        /* 不存在就算了 */
      }
    },
  };
}

module.exports = { createInfoStore };