// Bridge · 编辑器实时读写 + 工作区控制
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDriver } = require('../src/lib/driver.js');

function fakeApp(options = {}) {
  const calls = [];
  const state = {
    text: options.text || '第一行\n第二行\n第三行',
    cursor: { line: 1, ch: 0 },
    selection: null,
  };
  const editor = {
    getCursor: () => ({ ...state.cursor }),
    setCursor: (pos) => {
      state.cursor = typeof pos === 'object' ? { line: pos.line, ch: pos.ch || 0 } : { line: pos, ch: 0 };
      calls.push(['setCursor', state.cursor]);
    },
    getSelection: () => (state.selection ? state.text.slice(state.selection.from, state.selection.to) : ''),
    replaceSelection: (text) => {
      calls.push(['replaceSelection', text]);
      if (state.selection) {
        const from = state.selection.from;
        const to = state.selection.to;
        state.text = state.text.slice(0, from) + text + state.text.slice(to);
        state.selection = null;
      } else {
        state.text += text;
      }
      return null;
    },
    setSelection: (from, to) => {
      state.selection = typeof from === 'object' ? { from: from.offset ?? 0, to: to.offset ?? 0 } : { from, to };
      calls.push(['setSelection', from, to]);
    },
    listSelections: () => (state.selection ? [{ anchor: { line: 0, ch: state.selection.from }, head: { line: 0, ch: state.selection.to } }] : []),
    lineCount: () => state.text.split('\n').length,
    getLine: (n) => state.text.split('\n')[n] ?? '',
    lastLine: () => state.text.split('\n').length - 1,
    scrollIntoView: (range, center) => calls.push(['scrollIntoView', range, center]),
    getValue: () => state.text,
  };
  const file = { path: '项目/测试.md' };
  const view = { editor, file, getMode: () => 'source', getViewType: () => 'markdown' };
  const activeLeaf = { id: 'leaf-1', view };
  const otherLeaf = {
    id: 'leaf-2',
    view: { file: { path: '其他.md' }, getMode: () => 'preview', getViewType: () => 'markdown' },
  };
  const opened = [];
  const workspace = {
    activeLeaf,
    getActiveFile: () => file,
    getActiveViewOfType: () => view,
    iterateAllLeaves: (cb) => {
      cb(activeLeaf);
      cb(otherLeaf);
    },
    getLeaf: (kind) => {
      calls.push(['getLeaf', kind]);
      return {
        openFile: async (f, opt) => {
          opened.push({ path: f.path, opt });
          calls.push(['openFile', f.path, opt]);
        },
      };
    },
    revealLeaf: (leaf) => calls.push(['revealLeaf', leaf]),
  };
  const vault = {
    getAbstractFileByPath: (path) => (path === '项目/测试.md' ? file : null),
  };
  return { app: { workspace, vault, commands: {} }, calls, state, editor, opened };
}

test('editor.state 无活跃编辑器时给 available:false', async () => {
  const { app } = fakeApp();
  app.workspace.activeLeaf = null;
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.editor.state', {});

  assert.equal(res.ok, true);
  assert.equal(res.data.available, false);
});

test('editor.state 读活跃编辑器：路径/光标/选区/行数', async () => {
  const { app, state } = fakeApp();
  state.selection = { from: 0, to: 3 };
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.editor.state', {});

  assert.equal(res.data.available, true);
  assert.equal(res.data.path, '项目/测试.md');
  assert.equal(res.data.mode, 'source');
  assert.deepEqual(res.data.cursor, { line: 1, ch: 0 });
  assert.equal(res.data.selection.text, '第一行');
  assert.equal(res.data.lineCount, 3);
});

test('editor.insert 在光标处插入文本', async () => {
  const { app, calls } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.editor.insert', { text: '插入的内容' });

  assert.equal(res.ok, true);
  assert.equal(res.data.inserted, true);
  assert.deepEqual(calls.find((c) => c[0] === 'replaceSelection'), ['replaceSelection', '插入的内容']);
});

test('editor.insert 缺 text 报 bad-args', async () => {
  const { app } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.editor.insert', {});
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'bad-args');
});

test('editor.replace 先设置范围再替换', async () => {
  const { app, calls } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.editor.replace', {
    text: '新内容',
    from: { line: 0, ch: 0 },
    to: { line: 0, ch: 3 },
  });

  assert.equal(res.ok, true);
  assert.ok(calls.some((c) => c[0] === 'setSelection'));
  assert.ok(calls.some((c) => c[0] === 'replaceSelection' && c[1] === '新内容'));
});

test('editor.cursor 设置光标并滚动到位置', async () => {
  const { app, calls } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.editor.cursor', { line: 2, ch: 1 });

  assert.equal(res.ok, true);
  assert.deepEqual(res.data.cursor, { line: 2, ch: 1 });
  assert.ok(calls.some((c) => c[0] === 'setCursor'));
  assert.ok(calls.some((c) => c[0] === 'scrollIntoView'));
});

test('workspace.state 列出所有 leaf 与活跃文件', async () => {
  const { app } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.workspace.state', {});

  assert.equal(res.ok, true);
  assert.equal(res.data.activePath, '项目/测试.md');
  assert.equal(res.data.leaves.length, 2);
  assert.equal(res.data.leaves[0].active, true);
  assert.equal(res.data.leaves[1].path, '其他.md');
  assert.equal(res.data.leaves[1].mode, 'preview');
});

test('workspace.open 打开指定笔记', async () => {
  const { app, opened } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.workspace.open', { path: '项目/测试.md', mode: 'preview' });

  assert.equal(res.ok, true);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].path, '项目/测试.md');
});

test('workspace.open 找不到文件时报 file-not-found', async () => {
  const { app } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.workspace.open', { path: '不存在.md' });

  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'file-not-found');
});