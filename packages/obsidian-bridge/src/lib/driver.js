'use strict';
// Bridge · 驱动（对外的唯一调用面）
// list() 给操作目录；call() 执行一个操作。权限/账本/HTTP 都套在它外面。

const { createRegistry } = require('./registry.js');
const { createAiCursor } = require('./ai-cursor.js');

function createDriver(deps = {}) {
  // AI 光标是 driver 自带的状态：调用方不传就自己建一个，
  // 这样每个 driver 都有独立的 AI 光标，测试和运行时行为一致。
  const registry = createRegistry({ ...deps, aiCursor: deps.aiCursor || createAiCursor() });
  return {
    list() {
      return { ops: registry.list() };
    },
    call(opId, args) {
      return registry.call(opId, args);
    },
  };
}

module.exports = { createDriver };
