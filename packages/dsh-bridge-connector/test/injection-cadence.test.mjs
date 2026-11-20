// 注入节奏在 store 层：每 N 轮带一次、共 M 次、失败回滚
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInjectionStore } from '../src/core/injection.mjs';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inj-cadence-')), 'injections.json');

const withNote = (opts = {}) => {
  const store = createInjectionStore();
  store.markCurrent(store.add({ sessionId: 's1', content: '正文', title: 'A.md', ...opts }));
  return store;
};

test('每一轮都带（默认）：连着投递都带得上', () => {
  const store = withNote();
  for (let i = 0; i < 3; i += 1) {
    store.beginDelivery('s1');
    assert.equal(store.carryItems().length, 1, `第 ${i + 1} 轮该带`);
  }
});

test('每 3 轮带一次：第 1、4、7 轮带，其余不带', () => {
  const store = withNote({ every: 3 });
  const hits = [];
  for (let round = 1; round <= 7; round += 1) {
    store.beginDelivery('s1');
    hits.push(store.carryItems().length > 0);
  }
  assert.deepEqual(hits, [true, false, false, true, false, false, true]);
});

test('一共 2 次：带满两次之后 tick 就把它清掉', () => {
  const store = withNote({ times: 2 });
  store.beginDelivery('s1');
  assert.equal(store.carryItems().length, 1);
  store.tick('s1');
  assert.equal(store.currentItems().length, 1, '才用了一次，还在');

  store.beginDelivery('s1');
  assert.equal(store.carryItems().length, 1);
  store.tick('s1');
  assert.equal(store.currentItems().length, 0, '两次用满就该退场');
});

test('同一轮里提示词被组装两次，只记一次用量', () => {
  const store = withNote({ times: 5 });
  store.beginDelivery('s1');
  store.carryItems();
  store.carryItems();
  assert.equal(store.currentItems()[0].used, 1);
});

test('投递失败要回滚：轮次和已用次数都退回去', () => {
  const store = withNote({ times: 2 });
  store.beginDelivery('s1');
  assert.equal(store.carryItems().length, 1);
  store.rollbackDelivery('s1');
  assert.equal(store.currentItems()[0].used, 0);
  assert.equal(store.carryItems().length, 0, '回滚后这一轮就不该再有名单');

  // 回滚之后重新投递，仍然从第 1 轮算起
  store.beginDelivery('s1');
  assert.equal(store.carryItems().length, 1);
});

test('状态视图给得出还剩几次', () => {
  const store = withNote({ times: 3 });
  store.beginDelivery('s1');
  const view = store.currentItems()[0];
  assert.equal(view.times, 3);
  assert.equal(view.used, 1);
  assert.equal(view.remaining, 2);
  assert.equal(view.every, 1);
});

test('不限期时 remaining 是 0（表示不限），不是减出来的负数', () => {
  const store = withNote();
  store.beginDelivery('s1');
  const view = store.currentItems()[0];
  assert.equal(view.times, 0);
  assert.equal(view.remaining, 0);
});

test('轮次和用量都落盘：重启后节奏不重来', () => {
  const file = tmpFile();
  const store = createInjectionStore({ file });
  store.markCurrent(store.add({ sessionId: 's1', content: '正文', title: 'A.md', every: 2, times: 4 }));
  store.beginDelivery('s1'); // 第 1 轮：到期
  assert.equal(store.carryItems().length, 1);

  const back = createInjectionStore({ file });
  assert.equal(back.currentItems()[0].used, 1);
  // 重启后接着第 2 轮：every=2，不到期
  back.beginDelivery('s1');
  assert.equal(back.carryItems().length, 0);
  // 第 3 轮：到期
  back.beginDelivery('s1');
  assert.equal(back.carryItems().length, 1);
});
