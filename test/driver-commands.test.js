// Bridge · 命令能力（第一个切片）
// 接缝：driver.call(opId, args) 是对外唯一入口，内部只通过注入的 adapter 碰 Obsidian。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDriver } = require('../src/lib/driver.js');

function fakeObsidian(overrides = {}) {
  const commands = [
    { id: 'editor:toggle-bold', name: '加粗', hotkeys: [] },
    { id: 'workspace:split-vertical', name: '左右分屏', hotkeys: [] },
  ];
  return {
    commands: {
      listCommands: () => commands,
      findCommand: (id) => commands.find((c) => c.id === id) || null,
      executeCommandById: () => true,
      ...overrides.commands,
    },
  };
}

test('obsidian.command.list 返回命令清单，归只读档', async () => {
  const driver = createDriver({ obsidian: fakeObsidian() });

  const ops = driver.list().ops;
  const entry = ops.find((o) => o.id === 'obsidian.command.list');

  assert.ok(entry, '操作目录里应有 obsidian.command.list');
  assert.equal(entry.tier, 'read');

  const res = await driver.call('obsidian.command.list', {});
  assert.equal(res.ok, true);
  assert.deepEqual(
    res.data.commands.map((c) => c.id),
    ['editor:toggle-bold', 'workspace:split-vertical'],
  );
});

test('obsidian.command.execute 调 Obsidian 执行命令，归可写档', async () => {
  const calls = [];
  const driver = createDriver({
    obsidian: fakeObsidian({
      commands: {
        executeCommandById: (id) => {
          calls.push(id);
          return true;
        },
      },
    }),
  });

  const entry = driver.list().ops.find((o) => o.id === 'obsidian.command.execute');
  assert.equal(entry.tier, 'write');

  const res = await driver.call('obsidian.command.execute', { id: 'editor:toggle-bold' });

  assert.deepEqual(calls, ['editor:toggle-bold']);
  assert.equal(res.ok, true);
  assert.equal(res.data.executed, true);
  assert.equal(res.data.name, '加粗');
});