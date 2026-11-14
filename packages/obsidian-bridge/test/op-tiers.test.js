// Bridge · 档位快照
// 目的：任何一个 op 的档位被悄悄放宽（比如 write→read 让人绕过闸门）都要立刻变红。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDriver } = require('../src/lib/driver.js');

function minimalApp() {
  return {
    vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null },
    metadataCache: {},
    commands: {},
    workspace: {},
  };
}

const EXPECTED_TIERS = {
  'core.health': 'read',
  'obsidian.command.list': 'read',
  'obsidian.command.execute': 'write',
  'obsidian.editor.state': 'read',
  'obsidian.editor.insert': 'write',
  'obsidian.editor.replace': 'write',
  'obsidian.editor.cursor': 'write',
  'obsidian.editor.aiCursor': 'write',
  'obsidian.workspace.state': 'read',
  'obsidian.workspace.open': 'write',
  'obsidian.workspace.tab': 'write',
  'obsidian.workspace.view': 'write',
  'obsidian.workspace.layout': 'write',
  'obsidian.note.read': 'read',
  'obsidian.note.meta': 'read',
  'obsidian.note.backlinks': 'read',
  'obsidian.note.create': 'write',
  'obsidian.note.append': 'write',
  'obsidian.note.property': 'write',
  'obsidian.note.rename': 'write',
  'obsidian.note.delete': 'trust',
  'obsidian.query': 'read',
  'obsidian.search': 'read',
};

test('每个 op 的档位与快照一致，新增 op 必须登记', () => {
  const driver = createDriver({ obsidian: minimalApp() });
  const actual = {};
  for (const op of driver.list().ops) actual[op.id] = op.tier;

  assert.deepEqual(Object.keys(actual).sort(), Object.keys(EXPECTED_TIERS).sort(), '有 op 没登记档位快照');
  for (const [id, tier] of Object.entries(EXPECTED_TIERS)) {
    assert.equal(actual[id], tier, `${id} 的档位变了`);
  }
});

test('只有真正破坏性的操作归 trust 档', () => {
  const driver = createDriver({ obsidian: minimalApp() });
  const trust = driver.list().ops.filter((op) => op.tier === 'trust').map((op) => op.id);
  assert.deepEqual(trust.sort(), ['obsidian.note.delete'], 'trust 档被放宽了');
});
