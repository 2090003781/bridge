// Bridge · 笔记只读（正文 / 元数据 / 反链）
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDriver } = require('../src/lib/driver.js');

function fakeApp() {
  const notePath = '项目/测试.md';
  const noteText = '---\ntags: [桥, 测试]\n---\n\n# 标题\n\n引用 [[其他]]\n';
  const file = { path: notePath, basename: '测试', extension: 'md' };
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (p === notePath ? file : null),
      cachedRead: async () => noteText,
      read: async () => noteText,
      getMarkdownFiles: () => [file],
    },
    metadataCache: {
      getFileCache: () => ({
        frontmatter: { tags: ['桥', '测试'] },
        tags: [{ tag: '#桥', position: {} }, { tag: '#测试', position: {} }],
        links: [{ link: '其他', original: '[[其他]]', position: {} }],
        embeds: [{ link: '图片.png', original: '![[图片.png]]' }],
        headings: [{ heading: '标题', level: 1, position: { start: { line: 4, ch: 0 } } }],
      }),
      getBacklinksForFile: () => ({
        data: {
          '日志/某天.md': [{ position: {} }, { position: {} }],
          '项目/另一篇.md': [{ position: {} }],
        },
      }),
    },
  };
  return { app, notePath, noteText };
}

test('note.read 按路径读正文', async () => {
  const { app, noteText } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.note.read', { path: '项目/测试.md' });

  assert.equal(res.ok, true);
  assert.equal(res.data.text, noteText);
  assert.equal(res.data.length, noteText.length);
});

test('note.read 支持 maxChars 截断', async () => {
  const { app } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.note.read', { path: '项目/测试.md', maxChars: 5 });

  assert.equal(res.ok, true);
  assert.equal(res.data.text.length, 5);
  assert.equal(res.data.truncated, true);
});

test('note.read 文件不存在报 file-not-found', async () => {
  const { app } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.note.read', { path: '不存在.md' });

  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'file-not-found');
});

test('note.meta 返回 frontmatter / 标签 / 出链 / 嵌入 / 标题 / 反链来源', async () => {
  const { app } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.note.meta', { path: '项目/测试.md' });

  assert.equal(res.ok, true);
  assert.deepEqual(res.data.frontmatter, { tags: ['桥', '测试'] });
  assert.deepEqual(res.data.tags, ['#桥', '#测试']);
  assert.equal(res.data.links[0].link, '其他');
  assert.equal(res.data.embeds[0], '图片.png');
  assert.equal(res.data.headings[0].heading, '标题');
  assert.deepEqual(res.data.backlinks.sort(), ['日志/某天.md', '项目/另一篇.md'].sort());
});

test('note.backlinks 返回来源与次数', async () => {
  const { app } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.note.backlinks', { path: '项目/测试.md' });

  assert.equal(res.ok, true);
  assert.equal(res.data.backlinkCount, 2);
  const day = res.data.backlinks.find((b) => b.path === '日志/某天.md');
  assert.equal(day.count, 2);
});

test('note.meta 无缓存时给空结构而不是报错', async () => {
  const { app } = fakeApp();
  app.metadataCache.getFileCache = () => null;
  app.metadataCache.getBacklinksForFile = () => ({ data: {} });
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.note.meta', { path: '项目/测试.md' });

  assert.equal(res.ok, true);
  assert.deepEqual(res.data.tags, []);
  assert.deepEqual(res.data.links, []);
  assert.deepEqual(res.data.backlinks, []);
});
test('note.backlinks 兼容 Map 形态的反链数据', async () => {
  const { app } = fakeApp();
  app.metadataCache.getBacklinksForFile = () => ({
    data: new Map([
      ['日志/某天.md', [{}, {}]],
      ['项目/另一篇.md', [{}]],
    ]),
  });
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.note.backlinks', { path: '项目/测试.md' });

  assert.equal(res.ok, true);
  assert.equal(res.data.backlinkCount, 2);
  assert.equal(res.data.backlinks.find((b) => b.path === '日志/某天.md').count, 2);
});

test('note.meta 兼容 Map 形态的反链数据', async () => {
  const { app } = fakeApp();
  app.metadataCache.getBacklinksForFile = () => ({
    data: new Map([['日志/某天.md', [{}]]]),
  });
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.note.meta', { path: '项目/测试.md' });

  assert.equal(res.ok, true);
  assert.deepEqual(res.data.backlinks, ['日志/某天.md']);
});
