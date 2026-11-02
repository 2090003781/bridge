// Bridge · 笔记写入（创建 / 追加 / 改属性 / 改名 / 删除）
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDriver } = require('../src/lib/driver.js');

function fakeApp(options = {}) {
  const store = new Map(Object.entries(options.existing || {}));
  const fmStore = {};
  const calls = [];
  const files = new Map();

  function fileFor(path) {
    if (!files.has(path)) files.set(path, { path, stat: { size: (store.get(path) || '').length } });
    return files.get(path);
  }
  for (const p of store.keys()) fileFor(p);

  // 目录树：真实的 Obsidian 不会替你建父目录，所以 fake 也得严格，
  // 否则单测会替实现补上它缺的那一步（「单测绿、线上红」就是这么来的）。
  const folders = new Set();
  const dirOf = (p) => {
    const i = p.lastIndexOf('/');
    return i > 0 ? p.slice(0, i) : '';
  };

  const vault = {
    getAbstractFileByPath: (p) =>
      store.has(p) ? fileFor(p) : folders.has(p) ? { path: p, children: [] } : null,
    createFolder: async (p) => {
      if (folders.has(p)) throw new Error('folder already exists');
      folders.add(p);
      calls.push(['createFolder', p]);
      return { path: p, children: [] };
    },
    create: async (p, data) => {
      if (store.has(p)) throw new Error('already exists');
      const dir = dirOf(p);
      if (dir && !folders.has(dir)) {
        const err = new Error('Parent folder "' + dir + '" does not exist');
        err.code = 'ENOENT';
        throw err;
      }
      store.set(p, data);
      calls.push(['create', p, data]);
      return fileFor(p);
    },
    append: async (f, data) => {
      store.set(f.path, (store.get(f.path) || '') + data);
      calls.push(['append', f.path, data]);
    },
    read: async (f) => store.get(f.path) || '',
    cachedRead: async (f) => store.get(f.path) || '',
  };

  const fileManager = {
    processFrontMatter: async (f, fn) => {
      calls.push(['processFrontMatter', f.path]);
      const fm = { ...(fmStore[f.path] || {}) };
      fn(fm);
      fmStore[f.path] = fm;
    },
    renameFile: async (f, to) => {
      calls.push(['renameFile', f.path, to]);
    },
    trashFile: async (f) => {
      calls.push(['trashFile', f.path]);
    },
  };

  const metadataCache = {
    getBacklinksForFile: () => ({
      data: new Map([
        ['日志/某天.md', [{}, {}]],
        ['项目/另一篇.md', [{}]],
      ]),
    }),
  };

  return { app: { vault, fileManager, metadataCache, commands: {} }, store, fmStore, calls };
}

test('note.create 创建笔记（没写扩展名默认 .md）', async () => {
  const { app, store } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.note.create', { path: 'tmp/新笔记', content: '正文' });

  assert.equal(res.ok, true);
  assert.equal(res.data.created, true);
  assert.equal(res.data.path, 'tmp/新笔记.md');
  assert.equal(store.get('tmp/新笔记.md'), '正文');
});

test('note.create 已存在时拒绝覆盖', async () => {
  const { app } = fakeApp({ existing: { 'tmp/已有.md': '原内容' } });
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.note.create', { path: 'tmp/已有.md', content: '新内容' });

  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'file-exists');
});

test('note.create 拒绝跳出库的路径', async () => {
  const { app } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.note.create', { path: '../外面.md', content: 'x' });

  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'bad-args');
});

test('note.append 追加到文末，不动原文', async () => {
  const { app, store } = fakeApp({ existing: { 'tmp/a.md': '原内容\n' } });
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.note.append', { path: 'tmp/a.md', text: '追加段' });

  assert.equal(res.ok, true);
  assert.equal(store.get('tmp/a.md'), '原内容\n追加段');
});

test('note.property 改 frontmatter：set 与 del 同时生效', async () => {
  const { app, fmStore } = fakeApp({ existing: { 'tmp/a.md': '正文' } });
  fmStore['tmp/a.md'] = { tags: ['旧'], status: 'draft' };
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.note.property', {
    path: 'tmp/a.md',
    set: { status: 'done', priority: 3 },
    del: ['tags'],
  });

  assert.equal(res.ok, true);
  assert.equal(res.data.changed, true);
  assert.deepEqual(fmStore['tmp/a.md'], { status: 'done', priority: 3 });
});

test('note.property 没给 set/del 时报 bad-args', async () => {
  const { app } = fakeApp({ existing: { 'tmp/a.md': '正文' } });
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.note.property', { path: 'tmp/a.md' });

  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'bad-args');
});

test('note.rename 默认只预演：返回引用清单，不动文件', async () => {
  const { app, calls } = fakeApp({ existing: { 'tmp/旧名.md': '正文' } });
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.note.rename', { path: 'tmp/旧名.md', to: 'tmp/新名.md' });

  assert.equal(res.ok, true);
  assert.equal(res.data.dryRun, true);
  assert.equal(res.data.affected, 2);
  assert.equal(res.data.references.find((r) => r.path === '日志/某天.md').count, 2);
  assert.equal(calls.some((c) => c[0] === 'renameFile'), false);
});

test('note.rename dryRun=false 时才真的改名', async () => {
  const { app, calls } = fakeApp({ existing: { 'tmp/旧名.md': '正文' } });
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.note.rename', {
    path: 'tmp/旧名.md',
    to: 'tmp/新名.md',
    dryRun: false,
  });

  assert.equal(res.ok, true);
  assert.equal(res.data.renamed, true);
  assert.deepEqual(calls.find((c) => c[0] === 'renameFile'), ['renameFile', 'tmp/旧名.md', 'tmp/新名.md']);
});

test('note.delete 归 trust 且必须 confirm', async () => {
  const { app, calls } = fakeApp({ existing: { 'tmp/a.md': '正文' } });
  const driver = createDriver({ obsidian: app });

  const denied = await driver.call('obsidian.note.delete', { path: 'tmp/a.md' });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'bad-args');

  const done = await driver.call('obsidian.note.delete', { path: 'tmp/a.md', confirm: true });
  assert.equal(done.ok, true);
  assert.ok(calls.some((c) => c[0] === 'trashFile'));
});

test('note.delete 的操作档位是 trust', async () => {
  const { app } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const entry = driver.list().ops.find((o) => o.id === 'obsidian.note.delete');
  assert.equal(entry.tier, 'trust');
});
test('note.rename 返回的 from 是改名前的路径（Obsidian 会就地改 TFile.path）', async () => {
  const { app, calls } = fakeApp({ existing: { 'tmp/旧名.md': '正文' } });
  app.fileManager.renameFile = async (f, to) => {
    calls.push(['renameFile', f.path, to]);
    f.path = to; // 模拟 Obsidian 的就地修改
  };
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.note.rename', {
    path: 'tmp/旧名.md',
    to: 'tmp/新名.md',
    dryRun: false,
  });

  assert.equal(res.ok, true);
  assert.equal(res.data.from, 'tmp/旧名.md');
  assert.equal(res.data.to, 'tmp/新名.md');
});


test('note.create 自动建父目录（真实 Obsidian 不替你建）', async () => {
  const { app, store, calls } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.note.create', {
    path: '项目/子目录/新笔记.md',
    content: '正文',
  });

  assert.equal(res.ok, true, JSON.stringify(res.error || {}));
  assert.equal(store.get('项目/子目录/新笔记.md'), '正文');
  const made = calls.filter((c) => c[0] === 'createFolder').map((c) => c[1]);
  assert.deepEqual(made, ['项目', '项目/子目录']);
});


test('note.property 拒绝原型污染键', async () => {
  const { app } = fakeApp({ existing: { 'tmp/a.md': '正文' } });
  const driver = createDriver({ obsidian: app });
  // 必须用 JSON.parse 才能造出真正的 __proto__ 自有属性
  const set = JSON.parse('{"__proto__":{"polluted":true}}');
  const res = await driver.call('obsidian.note.property', { path: 'tmp/a.md', set });

  assert.equal(res.ok, false, '危险键必须拒掉');
  assert.equal(res.error.code, 'bad-args');
  assert.equal({}.polluted, undefined, '不许污染原型');
});
