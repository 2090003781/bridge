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
  // 假的 CM6 EditorView：只实现 driver 用到的那几个成员。
  // 原来的测试只覆盖 Obsidian 的 Editor，但写入现在走 view.dispatch，
  // 所以这里要造一个能真的改文本的假 view（改完 doc 也随之更新）。
  const makeDoc = (text) => {
    const rows = text.split('\n');
    const starts = [];
    let off = 0;
    for (const row of rows) {
      starts.push(off);
      off += row.length + 1;
    }
    return {
      length: text.length,
      lines: rows.length,
      line: (n) => {
        const i = Math.min(Math.max(1, n), rows.length) - 1;
        return { number: i + 1, from: starts[i], to: starts[i] + rows[i].length };
      },
      lineAt: (pos) => {
        let i = 0;
        while (i + 1 < starts.length && starts[i + 1] <= pos) i += 1;
        return { number: i + 1, from: starts[i], to: starts[i] + rows[i].length };
      },
    };
  };
  const cm = {
    state: { doc: makeDoc(state.text) },
    dispatch: ({ changes }) => {
      calls.push(['dispatch', changes]);
      state.text = state.text.slice(0, changes.from) + changes.insert + state.text.slice(changes.to);
      cm.state = { doc: makeDoc(state.text) };
    },
  };
  editor.cm = cm;
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
    getLeavesOfType: (type) => (type === 'markdown' ? [activeLeaf, otherLeaf] : []),
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

test('editor.state 焦点不在编辑器里时，仍然给出屏幕上那篇', async () => {
  // 行为变了：以前返回 available:false，现在按「屏幕上那篇」找——
  // 主人在 Bridge 面板打字时焦点不在编辑器上，但笔记还开着。
  const { app } = fakeApp();
  app.workspace.activeLeaf = null;
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.editor.state', {});

  assert.equal(res.ok, true, '要成功，实际错误：' + JSON.stringify(res.error));
  assert.equal(res.data.available, true);
  assert.equal(res.data.path, '项目/测试.md');
  assert.equal(res.data.focused, false);
});

test('editor.state 一篇 Markdown 都没开着才 available:false', async () => {
  const { app } = fakeApp();
  app.workspace.activeLeaf = null;
  app.workspace.getLeavesOfType = () => [];
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.editor.state', {});
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
  assert.equal(res.data.focused, true);
});

test('editor.insert 插在 AI 自己的光标处，不动你的光标', async () => {
  const { app, calls, state } = fakeApp();
  const driver = createDriver({ obsidian: app });

  // AI 把光标设到第 1 行第 3 列（"第一行" 的末尾）
  await driver.call('obsidian.editor.cursor', { path: '项目/测试.md', line: 0, ch: 3 });
  const res = await driver.call('obsidian.editor.insert', { text: 'X' });

  assert.equal(res.ok, true, '要成功，实际错误：' + JSON.stringify(res.error));
  assert.equal(res.data.inserted, true);
  assert.equal(res.data.mode, 'ai-cursor');
  assert.ok(state.text.startsWith('第一行X'), '内容应插在 AI 光标处，实际：' + state.text);
  // 关键：全程没有把用户的光标搬走，也没有借用用户的 replaceSelection
  assert.equal(calls.some((c) => c[0] === 'setCursor'), false, '不许移动用户光标');
  assert.equal(calls.some((c) => c[0] === 'replaceSelection'), false, '不许用用户选区插入');
  // AI 自己的光标跟着往后走
  assert.deepEqual(res.data.aiCursor.head, { line: 0, ch: 4 });
});

test('editor.insert position=end 追加到文末', async () => {
  const { app, state } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.editor.insert', { text: '尾部', position: 'end' });

  assert.equal(res.ok, true, '要成功，实际错误：' + JSON.stringify(res.error));
  assert.ok(state.text.endsWith('尾部'), '实际：' + state.text);
});

test('editor.insert 缺 text 报 bad-args', async () => {
  const { app } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.editor.insert', {});
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'bad-args');
});

test('editor.replace 替换 AI 自己选中的范围', async () => {
  const { app, calls, state } = fakeApp();
  const driver = createDriver({ obsidian: app });

  // 让 AI 选中第 1 行的 "第一行"
  await driver.call('obsidian.editor.aiCursor', {
    path: '项目/测试.md',
    select: { from: { line: 0, ch: 0 }, to: { line: 0, ch: 3 } },
  });
  const res = await driver.call('obsidian.editor.replace', { text: '新内容' });

  assert.equal(res.ok, true, '要成功，实际错误：' + JSON.stringify(res.error));
  assert.ok(state.text.startsWith('新内容\n'), '实际：' + state.text);
  assert.equal(calls.some((c) => c[0] === 'setSelection'), false, '不许动用户选区');
  assert.equal(calls.some((c) => c[0] === 'replaceSelection'), false, '不许用用户选区');
});

test('editor.replace AI 没选中内容时报 empty-selection', async () => {
  const { app } = fakeApp();
  const driver = createDriver({ obsidian: app });
  await driver.call('obsidian.editor.aiCursor', {
    path: '项目/测试.md',
    line: 0,
    ch: 0,
  });
  const res = await driver.call('obsidian.editor.replace', { text: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'empty-selection');
});

test('editor.cursor 只移动 AI 的光标，不碰你的', async () => {
  const { app, calls, state } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const before = { ...state.cursor };

  const res = await driver.call('obsidian.editor.cursor', { path: '项目/测试.md', line: 2, ch: 1 });

  assert.equal(res.ok, true, '要成功，实际错误：' + JSON.stringify(res.error));
  assert.deepEqual(res.data.aiCursor.head, { line: 2, ch: 1 });
  assert.deepEqual(state.cursor, before, '用户的光标不该被移动');
  assert.equal(calls.some((c) => c[0] === 'setCursor'), false);
  assert.equal(calls.some((c) => c[0] === 'scrollIntoView'), false);
});

test('editor.aiCursor 能读、能选、能收起', async () => {
  const { app } = fakeApp();
  const driver = createDriver({ obsidian: app });

  await driver.call('obsidian.editor.aiCursor', { path: '项目/测试.md', line: 1, ch: 2 });
  let res = await driver.call('obsidian.editor.aiCursor', { path: '项目/测试.md' });
  assert.deepEqual(res.data.aiCursor.head, { line: 1, ch: 2 });
  assert.equal(res.data.selection.empty, true);

  await driver.call('obsidian.editor.aiCursor', {
    path: '项目/测试.md',
    select: { from: { line: 5, ch: 0 }, to: { line: 1, ch: 0 } },
  });
  res = await driver.call('obsidian.editor.aiCursor', { path: '项目/测试.md' });
  // 反向选要摆正
  assert.deepEqual(res.data.selection.from, { line: 1, ch: 0 });
  assert.deepEqual(res.data.selection.to, { line: 5, ch: 0 });
  assert.equal(res.data.selection.empty, false);

  await driver.call('obsidian.editor.aiCursor', { path: '项目/测试.md', collapse: true });
  res = await driver.call('obsidian.editor.aiCursor', { path: '项目/测试.md' });
  assert.equal(res.data.selection.empty, true);
});

test('workspace.state 列出所有 leaf 与活跃文件', async () => {
  const { app } = fakeApp();
  const driver = createDriver({ obsidian: app });
  const res = await driver.call('obsidian.workspace.state', {});

  assert.equal(res.ok, true, '要成功，实际错误：' + JSON.stringify(res.error));
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

  assert.equal(res.ok, true, '要成功，实际错误：' + JSON.stringify(res.error));
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