'use strict';
// Bridge · 审计账本（一行一次调用；旁路原则：账本写失败不阻断主流程）

function createLedger({ sink = null, now = () => new Date() } = {}) {
  function record(entry) {
    const rec = { ts: new Date(now()).toISOString(), ...entry };
    if (typeof sink === 'function') {
      try {
        sink(rec);
      } catch {
        /* 旁路：账本异常不影响调用本身 */
      }
    }
    return rec;
  }
  return { record };
}

module.exports = { createLedger };