// Bridge · 权限（三档 + 按客户端记档）
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPermissions } = require('../src/lib/permissions.js');

test('默认只读：write 操作被拒，read 通过', () => {
  const perms = createPermissions();
  assert.equal(perms.levelOf('agent.dsh'), 'read');
  assert.equal(perms.can('agent.dsh', 'read'), true);
  assert.equal(perms.can('agent.dsh', 'write'), false);
  assert.equal(perms.can('agent.dsh', 'trust'), false);
});

test('放到可写档后 write 通过、trust 仍被拒', () => {
  const perms = createPermissions();
  perms.setLevel('agent.dsh', 'write');
  assert.equal(perms.levelOf('agent.dsh'), 'write');
  assert.equal(perms.can('agent.dsh', 'write'), true);
  assert.equal(perms.can('agent.dsh', 'trust'), false);
});

test('放到相信档后全部通过', () => {
  const perms = createPermissions();
  perms.setLevel('agent.dsh', 'trust');
  assert.equal(perms.can('agent.dsh', 'trust'), true);
  assert.equal(perms.can('agent.dsh', 'write'), true);
  assert.equal(perms.can('agent.dsh', 'read'), true);
});

test('非法档位抛错，且原档位不受影响', () => {
  const perms = createPermissions();
  assert.throws(() => perms.setLevel('agent.dsh', 'admin'), /档位/);
  assert.equal(perms.levelOf('agent.dsh'), 'read');
});

test('改档后能持久化并恢复', () => {
  let saved;
  const p1 = createPermissions({ onSave: (s) => { saved = s; } });
  p1.setLevel('agent.dsh', 'write');
  const p2 = createPermissions({ state: saved });
  assert.equal(p2.levelOf('agent.dsh'), 'write');
  assert.equal(p2.can('agent.dsh', 'write'), true);
});

test('不同客户端互不影响', () => {
  const perms = createPermissions();
  perms.setLevel('agent.dsh', 'trust');
  assert.equal(perms.levelOf('agent.reasonix'), 'read');
  assert.equal(perms.can('agent.reasonix', 'write'), false);
});