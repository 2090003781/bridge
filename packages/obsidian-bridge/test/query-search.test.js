// Bridge · 全库查询（元数据）与关键字搜索（含正文）
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDriver } = require('../src/lib/driver.js');

function fakeApp() {
  const files = [
    {
      path: '项目/甲.md', basename: '甲', stat: { mtime: Date.parse('2026-10-01'), size: 100 },
      fm: { status: '进行中', priority: 3, tags: ['项目'] },
      tags: ['#项目', '#ai'], headings: [{ heading: '目标', level: 1, position: { start: { line: 0 } } }],
      text: '这是甲项目的正文\n包含关键字 alpha\n第二行也有 beta\n',
    },
    {
      path: '项目/乙.md', basename: '乙', stat: { mtime: Date.parse('2026-10-20'), size: 200 },
      fm: { status: '完成', priority: 1 },
      tags: ['#项目'], headings: [], text: '乙项目正文\nalpha 出现在这里\n',
    },
    {
      path: '知识库/丙.md', basename: '丙', stat: { mtime: Date.parse('2026-09-01'), size: 50 },
      fm: { status: '进行中' },
      tags: ['#ai'], headings: [], text: '丙的正文\nbeta only\n',
    },
  ];
  const byPath = new Map(files.map((f) => [f.path, f]));
  const app = {
    vault: {
      getMarkdownFiles: () => files,
      cachedRead: async (file) => byPath.get(file.path)?.text || '',
      getAbstractFileByPath: (p) => byPath.get(p) || null,
    },
    metadataCache: {
      getFileCache: (file) => {
        const f = byPath.get(file.path);
        if (!f) return null;
        return {
          frontmatter: f.fm,
          tags: f.tags.map((t) => ({ tag: t })),
          headings: f.headings,
          links: [],
          embeds: [],
        };
      },
      getBacklinksForFile: () => ({ data: {} }),
    },
    commands: { listCommands: () => [], findCommand: () => null, executeCommandById: () => true },
  };
  return { app, files };
}

test('query：按目录过滤', async () => {
  const { app } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.query', { folder: '项目' });
  assert.equal(res.ok, true);
  assert.equal(res.data.total, 2);
  assert.deepEqual(res.data.items.map((i) => i.path).sort(), ['项目/乙.md', '项目/甲.md']);
});

test('query：多标签 AND', async () => {
  const { app } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.query', { tags: ['项目', 'ai'] });
  assert.equal(res.data.total, 1);
  assert.equal(res.data.items[0].path, '项目/甲.md');
});

test('query：多属性 AND', async () => {
  const { app } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.query', {
    props: [{ key: 'status', value: '进行中' }, { key: 'priority', value: 3 }],
  });
  assert.equal(res.data.total, 1);
  assert.equal(res.data.items[0].path, '项目/甲.md');
});

test('query：多关键字文件名 AND', async () => {
  const { app } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.query', { nameContains: ['甲'] });
  assert.equal(res.data.total, 1);
  assert.equal(res.data.items[0].name, '甲');
});

test('query：mtime 范围', async () => {
  const { app } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.query', { mtimeAfter: '2026-10-10' });
  assert.equal(res.data.total, 1);
  assert.equal(res.data.items[0].path, '项目/乙.md');
});

test('query：不返回正文', async () => {
  const { app } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.query', { folder: '项目' });
  const item = res.data.items[0];
  assert.equal(item.text, undefined);
  assert.ok(item.path);
  assert.ok(Array.isArray(item.tags));
});

test('query：limit 与字段裁剪', async () => {
  const { app } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.query', { limit: 1, include: ['tags'] });
  assert.equal(res.data.items.length, 1);
  assert.equal(res.data.items[0].frontmatter, undefined);
  assert.ok(Array.isArray(res.data.items[0].tags));
});

test('search：正文多关键字 AND 命中并给片段', async () => {
  const { app } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.search', { query: 'alpha beta' });
  assert.equal(res.ok, true);
  assert.equal(res.data.total, 1);
  assert.equal(res.data.items[0].path, '项目/甲.md');
  assert.ok(res.data.items[0].matches.length > 0);
  assert.equal(typeof res.data.items[0].matches[0].line, 'number');
});

test('search：文件名命中（scope=name）', async () => {
  const { app } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.search', { query: '丙', scope: 'name' });
  assert.equal(res.data.total, 1);
  assert.equal(res.data.items[0].path, '知识库/丙.md');
});

test('search：单关键字 alpha 命中两篇', async () => {
  const { app } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.search', { query: 'alpha' });
  assert.equal(res.data.total, 2);
});

test('search：空查询报 bad-args', async () => {
  const { app } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.search', { query: '   ' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'bad-args');
});

test('search：目录过滤', async () => {
  const { app } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.search', { query: 'beta', folder: '知识库' });
  assert.equal(res.data.total, 1);
  assert.equal(res.data.items[0].path, '知识库/丙.md');
});

test('query 的 mtimeAfter 传垃圾时报 bad-args，不静默返回全库', async () => {
  const { app } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.query', { mtimeAfter: 'garbage' });

  assert.equal(res.ok, false, '非法时间不该当成没传');
  assert.equal(res.error.code, 'bad-args');
});

test('query 的 mtimeBefore 传垃圾时也报 bad-args', async () => {
  const { app } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.query', { mtimeBefore: '2026-13-45' });

  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'bad-args');
});

test('query 合法时间范围照常过滤', async () => {
  const { app } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.query', { mtimeAfter: '2026-10-10' });

  assert.equal(res.ok, true);
  assert.deepEqual(res.data.items.map((x) => x.path), ['项目/乙.md']);
});
