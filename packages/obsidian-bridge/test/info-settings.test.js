// Bridge · 服务信息文件 + 设置归一化
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createInfoStore } = require('../src/lib/info.js');
const { normalizeSettings, DEFAULTS, reconcileInjection } = require('../src/lib/settings.js');

test('服务信息文件：写入后能读回，目录自动建', () => {
  const dir = path.join(os.tmpdir(), `bridge-info-${process.pid}-${Date.now()}`);
  const store = createInfoStore({ dir });

  store.write({ port: 8811, token: 'abc', vault: '辞玖' });
  const back = store.read();

  assert.equal(back.port, 8811);
  assert.equal(back.token, 'abc');
  assert.equal(back.vault, '辞玖');
  assert.equal(typeof back.updatedAt, 'string');

  store.clear();
  assert.equal(store.read(), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('服务信息文件：不存在时读回 null', () => {
  const dir = path.join(os.tmpdir(), `bridge-info-missing-${Date.now()}`);
  const store = createInfoStore({ dir });
  assert.equal(store.read(), null);
});

test('设置归一化：空输入给安全默认值', () => {
  const s = normalizeSettings(undefined);
  assert.equal(s.enabled, true);
  assert.equal(s.host, '127.0.0.1');
  assert.equal(s.port, 8811);
  assert.equal(s.defaultLevel, 'read');
  assert.equal(s.token, '');
});

test('设置归一化：非法端口回默认，非法档位回 read', () => {
  const s = normalizeSettings({ port: 99999, defaultLevel: 'admin' });
  assert.equal(s.port, DEFAULTS.port);
  assert.equal(s.defaultLevel, DEFAULTS.defaultLevel);
});

test('设置归一化：只接受回环地址', () => {
  const s = normalizeSettings({ host: '0.0.0.0' });
  assert.equal(s.host, '127.0.0.1');
});

test('设置归一化：合法自定义值原样保留', () => {
  const s = normalizeSettings({ port: 8899, defaultLevel: 'read', token: 'keep-me', enabled: false });
  assert.equal(s.port, 8899);
  assert.equal(s.defaultLevel, 'read');
  assert.equal(s.token, 'keep-me');
  assert.equal(s.enabled, false);
});
test('设置归一化：注入默认关闭', () => {
  const s = normalizeSettings(undefined);
  assert.equal(s.injectionEnabled, false);
  assert.equal(normalizeSettings({ injectionEnabled: true }).injectionEnabled, true);
});


test('默认档位是 read，不是 write', () => {
  assert.equal(DEFAULTS.defaultLevel, 'read');
  assert.equal(normalizeSettings({}).defaultLevel, 'read');
  assert.equal(
    normalizeSettings({ defaultLevel: 'write' }).defaultLevel,
    'write',
    '显式配置要尊重，不能被默认值覆盖'
  );
});


// ── 注入开关只有一个真相源：连接器 ──────────────────────────────────────
test('注入对齐：远端为准，本地只当缓存', () => {
  assert.deepEqual(reconcileInjection({ remote: true, local: false }), { value: true, changed: true });
  assert.deepEqual(reconcileInjection({ remote: false, local: true }), { value: false, changed: true });
  assert.deepEqual(reconcileInjection({ remote: true, local: true }), { value: true, changed: false });
});

test('注入对齐：远端读不到时不敢乱改本地', () => {
  assert.deepEqual(reconcileInjection({ remote: undefined, local: true }), {
    value: true,
    changed: false,
    unknown: true,
  });
  assert.deepEqual(reconcileInjection({ remote: null, local: false }), {
    value: false,
    changed: false,
    unknown: true,
  });
});


test('token 有效期默认永久，垃圾值也当永久', () => {
  assert.equal(DEFAULTS.tokenTtl, 0);
  assert.equal(normalizeSettings({}).tokenTtl, 0);
  assert.equal(normalizeSettings({ tokenTtl: -5 }).tokenTtl, 0);
  assert.equal(normalizeSettings({ tokenTtl: 'abc' }).tokenTtl, 0);
  assert.equal(normalizeSettings({ tokenTtl: 86400000 }).tokenTtl, 86400000);
});
