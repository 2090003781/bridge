'use strict';
// token 生命周期：签发时间 + 有效期（0 = 永久）。
// 轮换策略是「提前换」而不是「过期才换」：剩余寿命不足一成就换新的，
// 这样常驻调用方（MCP 桥）永远读不到已经过期的 token。

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

// 剩余寿命低于有效期的这个比例就轮换。
const ROTATE_MARGIN = 0.1;

// 设置页给的可选有效期（毫秒）。0 = 永久。
const TOKEN_TTL_OPTIONS = [
  { value: 0, label: '永久' },
  { value: 30 * DAY, label: '30 天' },
  { value: 7 * DAY, label: '7 天' },
  { value: DAY, label: '1 天' },
  { value: HOUR, label: '1 小时' },
];

function ttlIsFinite(ttlMs) {
  return Number.isFinite(ttlMs) && ttlMs > 0;
}

function isExpired({ issuedAt, ttlMs, now } = {}) {
  if (!ttlIsFinite(ttlMs)) return false;
  const born = Number(issuedAt) || 0;
  return Number(now) - born > ttlMs;
}

function shouldRotate({ issuedAt, ttlMs, now } = {}) {
  if (!ttlIsFinite(ttlMs)) return false;
  const born = Number(issuedAt) || 0;
  const remaining = born + ttlMs - Number(now);
  if (remaining <= 0) return true;
  return remaining <= ttlMs * ROTATE_MARGIN;
}

// 下一次轮换还差多少毫秒。null = 永久，不用挂定时器。
// 一次性算出来挂 setTimeout，比每隔一分钟醒来问一次省事，也不会堆积定时器。
function nextRotationDelay({ issuedAt, ttlMs, now } = {}) {
  if (!ttlIsFinite(ttlMs)) return null;
  // issuedAt 为 0 是合法值（纪元），不能当「没给」——那会把已经到期的算成还没到期。
  const rawBorn = issuedAt === undefined || issuedAt === null ? now : issuedAt;
  const born = Number(rawBorn) || 0;
  const dueAt = born + ttlMs * (1 - ROTATE_MARGIN);
  return Math.max(0, dueAt - Number(now));
}

function describeTtl(ttlMs) {
  if (!ttlIsFinite(ttlMs)) return '永久';
  const option = TOKEN_TTL_OPTIONS.find((item) => item.value === ttlMs);
  if (option) return option.label;
  if (ttlMs >= DAY) return `${Math.round(ttlMs / DAY)} 天`;
  if (ttlMs >= HOUR) return `${Math.round(ttlMs / HOUR)} 小时`;
  return `${Math.round(ttlMs / 60000)} 分钟`;
}

// 业务错误码 → HTTP 状态。调用方要能分清「我参数错了」和「服务挂了」，
// 一律 500 等于把这两件事搅在一起。
const ERROR_STATUS = {
  'bad-args': 400,
  'bad-request': 400,
  'invalid-args': 400,
  unauthorized: 401,
  'token-expired': 401,
  forbidden: 403,
  'file-not-found': 404,
  'not-found': 404,
  'unknown-op': 404,
  'file-exists': 409,
  conflict: 409,
  'no-active-editor': 409,
  unsupported: 501,
};

function statusForError(code) {
  return ERROR_STATUS[String(code || '')] || 500;
}

module.exports = { isExpired, shouldRotate, nextRotationDelay, describeTtl, statusForError, TOKEN_TTL_OPTIONS, ROTATE_MARGIN, DAY, HOUR };
