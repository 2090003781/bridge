'use strict';
// Bridge · 驱动（对外的唯一调用面）
// list() 给操作目录；call() 执行一个操作。权限/账本/HTTP 都套在它外面。

const { createRegistry } = require('./registry.js');

function createDriver(deps = {}) {
  const registry = createRegistry(deps);
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
