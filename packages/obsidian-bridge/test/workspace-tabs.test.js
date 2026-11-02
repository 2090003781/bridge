// Bridge · 工作区（标签 / 视图 / 布局）
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDriver } = require('../src/lib/driver.js');

function fakeApp() {
  const calls = [];
  const leafNote = {
    id: 'leaf-a',
    view: { file: { path: '项目/甲.md' }, getViewType: () => 'markdown' },
    detach: () => calls.push(['detach', 'leaf-a']),
  };
  const leafOther = {
    id: 'leaf-b',
    view: { file: { path: '项目/乙.md' }, getViewType: () => 'markdown' },
    detach: () => calls.push(['detach', 'leaf-b']),
  };
  const sideLeaf = {
    id: 'leaf-side',
    setViewState: async (state) => calls.push(['setViewState', state]),
  };
  const existingSideLeaves = [];
  const workspace = {
    activeLeaf: leafNote,
    iterateAllLeaves: (cb) => {
      cb(leafNote);
      cb(leafOther);
    },
    setActiveLeaf: (leaf, opts) => calls.push(['setActiveLeaf', leaf.id, opts]),
    revealLeaf: (leaf) => calls.push(['revealLeaf', leaf.id]),
    getLeavesOfType: (type) => existingSideLeaves.filter((l) => l.type === type),
    getRightLeaf: () => sideLeaf,
    getLeftLeaf: () => sideLeaf,
    getLayout: () => ({ main: { id: 'main', children: [] }, left: null, right: null }),
    changeLayout: async (layout) => calls.push(['changeLayout', layout]),
  };
  return {
    app: { workspace, commands: { executeCommandById: () => true }, vault: {}, metadataCache: {} },
    calls,
    leafNote,
    leafOther,
    sideLeaf,
    existingSideLeaves,
  };
}

test('workspace.tab activate 激活指定笔记的标签', async () => {
  const { app, calls } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.workspace.tab', { action: 'activate', path: '项目/乙.md' });

  assert.equal(res.ok, true);
  assert.ok(calls.some((c) => c[0] === 'setActiveLeaf' && c[1] === 'leaf-b'));
  assert.ok(calls.some((c) => c[0] === 'revealLeaf' && c[1] === 'leaf-b'));
});

test('workspace.tab close 关闭指定标签', async () => {
  const { app, calls } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.workspace.tab', { action: 'close', path: '项目/乙.md' });

  assert.equal(res.ok, true);
  assert.ok(calls.some((c) => c[0] === 'detach' && c[1] === 'leaf-b'));
});

test('workspace.tab 找不到标签时报 leaf-not-found', async () => {
  const { app } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.workspace.tab', { action: 'activate', path: '不存在.md' });

  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'leaf-not-found');
});

test('workspace.tab next 走命令切换下一个标签', async () => {
  const { app } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.workspace.tab', { action: 'next' });

  assert.equal(res.ok, true);
  assert.equal(res.data.executed, true);
});

test('workspace.view 打开侧栏视图', async () => {
  const { app, calls } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.workspace.view', { type: 'graph' });

  assert.equal(res.ok, true);
  assert.equal(res.data.reused, false);
  assert.ok(calls.some((c) => c[0] === 'setViewState' && c[1].type === 'graph'));
});

test('workspace.view 已有视图时复用，不重复开', async () => {
  const { app, calls, sideLeaf } = fakeApp();
  sideLeaf.type = 'graph';
  app.workspace.getLeavesOfType = () => [sideLeaf];
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.workspace.view', { type: 'graph' });

  assert.equal(res.ok, true);
  assert.equal(res.data.reused, true);
  assert.equal(calls.some((c) => c[0] === 'setViewState'), false);
});

test('workspace.layout get 返回当前布局', async () => {
  const { app } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.workspace.layout', { action: 'get' });

  assert.equal(res.ok, true);
  assert.equal(res.data.layout.main.id, 'main');
});

test('workspace.layout set 应用布局', async () => {
  const { app, calls } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const layout = { main: { id: 'main', children: [] } };
  const res = await driver.call('obsidian.workspace.layout', { action: 'set', layout });

  assert.equal(res.ok, true);
  assert.ok(calls.some((c) => c[0] === 'changeLayout'));
});

test('workspace.layout set 缺布局时报 bad-args', async () => {
  const { app } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.workspace.layout', { action: 'set' });

  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'bad-args');
});