// Bridge · token 生命周期（有效期 / 轮换时机 / 状态码）
const test = require('node:test');
const assert = require('node:assert/strict');
const { isExpired, shouldRotate, describeTtl, statusForError, nextRotationDelay } = require('../src/lib/token-lifecycle.js');

const DAY = 24 * 60 * 60 * 1000;

test('ttl 为 0 表示永久，永远不会过期也不用轮换', () => {
  const state = { issuedAt: 1000, ttlMs: 0, now: 10 ** 12 };
  assert.equal(isExpired(state), false);
  assert.equal(shouldRotate(state), false);
});

test('ttl 为正数，超过有效期算过期', () => {
  assert.equal(isExpired({ issuedAt: 0, ttlMs: DAY, now: DAY - 1 }), false);
  assert.equal(isExpired({ issuedAt: 0, ttlMs: DAY, now: DAY + 1 }), true);
});

test('剩余寿命不足一成时就该轮换，别等到过期才换', () => {
  // 7 天有效期：剩 16.8 小时以上不用换
  assert.equal(shouldRotate({ issuedAt: 0, ttlMs: 7 * DAY, now: 6 * DAY }), false);
  // 只剩 12 小时（< 10%）就该换
  assert.equal(shouldRotate({ issuedAt: 0, ttlMs: 7 * DAY, now: 7 * DAY - 12 * 60 * 60 * 1000 }), true);
  // 已经过期也算该换
  assert.equal(shouldRotate({ issuedAt: 0, ttlMs: DAY, now: 2 * DAY }), true);
});

test('有效期能说成人话', () => {
  assert.equal(describeTtl(0), '永久');
  assert.equal(describeTtl(7 * DAY), '7 天');
  assert.equal(describeTtl(DAY), '1 天');
  assert.equal(describeTtl(60 * 60 * 1000), '1 小时');
});

test('错误码要映射成能分辨的 HTTP 状态，不是一律 500', () => {
  assert.equal(statusForError('bad-args'), 400);
  assert.equal(statusForError('unauthorized'), 401);
  assert.equal(statusForError('token-expired'), 401);
  assert.equal(statusForError('forbidden'), 403);
  assert.equal(statusForError('file-not-found'), 404);
  assert.equal(statusForError('unknown-op'), 404);
  assert.equal(statusForError('file-exists'), 409);
  assert.equal(statusForError('no-active-editor'), 409);
  assert.equal(statusForError('unsupported'), 501);
  assert.equal(statusForError('op-failed'), 500);
  assert.equal(statusForError('随便什么新错误'), 500);
});


test('轮换用定时器而不是轮询：一次算出下次该换的时刻', () => {
  // 永久：不排（返回 null，调用方不要挂定时器）
  assert.equal(nextRotationDelay({ issuedAt: 0, ttlMs: 0, now: 1000 }), null);

  // 7 天有效期，刚签发：6.3 天后才该换（提前一成）
  const delay = nextRotationDelay({ issuedAt: 0, ttlMs: 7 * DAY, now: 0 });
  assert.equal(delay, 7 * DAY * 0.9);

  // 已经过了该换的点：立刻换（0，不是负数）
  assert.equal(nextRotationDelay({ issuedAt: 0, ttlMs: DAY, now: 5 * DAY }), 0);

  // 中途加入：按剩余时间算
  const half = nextRotationDelay({ issuedAt: 0, ttlMs: 7 * DAY, now: 3.5 * DAY });
  assert.equal(half, 7 * DAY * 0.9 - 3.5 * DAY);
});
