// DSH 的工作区注册表：按它分组才跟 DSH 界面一致（不然按 cwd 会把没注册的目录也当工作区）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkspaceIndex } from '../src/core/workspace-index.mjs';

function writeStore(rows, archived = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-'));
  const file = path.join(dir, 'workspace.json');
  const data = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: rows.map((r) => r.workspaceId), archivedSessionIds: archived },
    tables: { workspaces: rows },
  };
  fs.writeFileSync(file, JSON.stringify(data), 'utf8');
  return file;
}

test('按注册表把会话映射到工作区', () => {
  const file = writeStore([
    { workspaceId: 'w1', path: 'D:\\RAG', title: 'RAG', sessionIds: ['s1', 's2'] },
    { workspaceId: 'w2', path: 'D:\\AI', title: 'AI', sessionIds: ['s3'] },
  ]);
  const lookup = createWorkspaceIndex({ file });
  assert.deepEqual(lookup('s1').workspace, { workspaceId: 'w1', title: 'RAG', path: 'D:\\RAG' });
  assert.deepEqual(lookup('s3').workspace, { workspaceId: 'w2', title: 'AI', path: 'D:\\AI' });
  assert.equal(lookup('nope').workspace, null, '没注册的会话归未分组');
});

test('归档会话能被识别（DSH 界面不显示它们）', () => {
  const file = writeStore(
    [{ workspaceId: 'w1', path: 'D:\\RAG', title: 'RAG', sessionIds: ['s1', 's2'] }],
    ['s2']
  );
  const lookup = createWorkspaceIndex({ file });
  assert.equal(lookup('s1').archived, false);
  assert.equal(lookup('s2').archived, true);
});

test('文件不存在或格式不对时全部当未分组，不抛错', () => {
  const lookup = createWorkspaceIndex({ file: path.join(os.tmpdir(), 'nope-' + Date.now() + '.json') });
  assert.equal(lookup('s1').workspace, null);
  assert.equal(lookup('s1').archived, false);
});

test('版本不是 workspace 时也不乱猜', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-'));
  const file = path.join(dir, 'workspace.json');
  fs.writeFileSync(file, JSON.stringify({ unit: { name: 'something-else', version: 9 }, tables: {} }), 'utf8');
  const lookup = createWorkspaceIndex({ file });
  assert.equal(lookup('s1').workspace, null);
});
