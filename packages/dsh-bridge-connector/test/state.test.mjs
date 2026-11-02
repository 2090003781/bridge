// 连接器运行期状态（注入开关）落盘
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStateStore } from '../src/core/state.mjs';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-state-'));
  return path.join(dir, 'state.json');
}

test('没有状态文件时返回 null，交给调用方回落到配置', () => {
  const store = createStateStore({ file: tmpFile() });
  assert.deepEqual(store.load(), { injection: null });
});

test('保存后能读回来', () => {
  const file = tmpFile();
  const store = createStateStore({ file });
  store.save({ injection: true });
  assert.equal(createStateStore({ file }).load().injection, true);
  store.save({ injection: false });
  assert.equal(createStateStore({ file }).load().injection, false);
});

test('文件损坏时当没记录，不当成关着', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{broken', 'utf8');
  assert.equal(createStateStore({ file }).load().injection, null);
});

test('非布尔值不算数', () => {
  const file = tmpFile();
  const store = createStateStore({ file });
  store.save({ injection: 'yes' });
  assert.equal(createStateStore({ file }).load().injection, null);
});
