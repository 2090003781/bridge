// 注入的节奏：每几轮带一次、一共带几次
//
// 注入的正文每轮都会跟着系统提示词重发，所以两件事决定它吃多少上下文：
//   every —— 每几轮带一次（1 = 每次都带）
//   times —— 一共带几次（0 = 不限期，直到手动清除）
// 这两个值都收在 1..99；非法值按「不改变现状」处理。
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvery, normalizeTimes, isDue, describeCadence } from '../src/core/injection-schedule.mjs';

test('间隔归一化：默认每次，1..99，垃圾值回默认', () => {
  assert.equal(normalizeEvery(undefined), 1);
  assert.equal(normalizeEvery(1), 1);
  assert.equal(normalizeEvery(3), 3);
  assert.equal(normalizeEvery(0), 1);
  assert.equal(normalizeEvery(-2), 1);
  assert.equal(normalizeEvery(2.9), 2);
  assert.equal(normalizeEvery(1000), 99);
  assert.equal(normalizeEvery('x'), 1);
});

test('次数归一化：默认不限期，0 就是不限期，正数 1..99', () => {
  assert.equal(normalizeTimes(undefined), 0);
  assert.equal(normalizeTimes(0), 0);
  assert.equal(normalizeTimes(-1), 0);
  assert.equal(normalizeTimes(1), 1);
  assert.equal(normalizeTimes(5.7), 5);
  assert.equal(normalizeTimes(1000), 99);
});

test('每轮都带：每一轮都是到期的', () => {
  const base = { every: 1, times: 0, used: 0, startRound: 1 };
  assert.equal(isDue({ ...base, round: 1 }), true);
  assert.equal(isDue({ ...base, round: 2 }), true);
  assert.equal(isDue({ ...base, round: 9 }), true);
});

test('每 3 轮带一次：注入那轮带，之后第 4、7 轮再带', () => {
  const base = { every: 3, times: 0, used: 0, startRound: 1 };
  assert.equal(isDue({ ...base, round: 1 }), true);
  assert.equal(isDue({ ...base, round: 2 }), false);
  assert.equal(isDue({ ...base, round: 3 }), false);
  assert.equal(isDue({ ...base, round: 4 }), true);
  assert.equal(isDue({ ...base, round: 7 }), true);
});

test('一共 2 次：带满两次之后再也不带', () => {
  const base = { every: 1, times: 2, startRound: 1 };
  assert.equal(isDue({ ...base, used: 0, round: 1 }), true);
  assert.equal(isDue({ ...base, used: 1, round: 2 }), true);
  assert.equal(isDue({ ...base, used: 2, round: 3 }), false);
});

test('间隔和次数一起用：每 2 轮、一共 2 次', () => {
  const base = { every: 2, times: 2, startRound: 1 };
  assert.equal(isDue({ ...base, used: 0, round: 1 }), true);
  assert.equal(isDue({ ...base, used: 1, round: 2 }), false);
  assert.equal(isDue({ ...base, used: 1, round: 3 }), true);
  assert.equal(isDue({ ...base, used: 2, round: 5 }), false, '次数用完了就不再看间隔');
});

test('还没开始（轮次早于注入轮）不带', () => {
  assert.equal(isDue({ every: 1, times: 0, used: 0, startRound: 3, round: 2 }), false);
});

test('人话描述：给界面和日志用', () => {
  assert.equal(describeCadence({ every: 1, times: 0 }), '每轮都带，不限次数');
  assert.equal(describeCadence({ every: 1, times: 2 }), '每轮都带，共 2 次');
  assert.equal(describeCadence({ every: 3, times: 0 }), '每 3 轮带一次，不限次数');
  assert.equal(describeCadence({ every: 3, times: 4 }), '每 3 轮带一次，共 4 次');
});
