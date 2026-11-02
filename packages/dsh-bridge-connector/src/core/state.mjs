// 连接器的运行期状态落盘。
// 为什么需要：注入开关原先只从 cordis.patch.yml 读，DSH 一重启就回落成配置里的 false，
// 用户明明在面板上开着的状态就这么没了——界面说的和实际跑的不一致。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_FILE = path.join(os.homedir(), '.dsh-bridge', 'state.json');

export function createStateStore({ file = DEFAULT_FILE } = {}) {
  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      // 读不出来 ≠ 关着：只有明确的布尔值才算数，其余一律当「没记录」让调用方回落。
      return { injection: typeof parsed.injection === 'boolean' ? parsed.injection : null };
    } catch {
      return { injection: null };
    }
  }

  function save(patch = {}) {
    const next = {};
    if (typeof patch.injection === 'boolean') next.injection = patch.injection;
    if (Object.keys(next).length === 0) return;
    try {
      const current = load();
      const merged = { ...current, ...next };
      const clean = {};
      if (typeof merged.injection === 'boolean') clean.injection = merged.injection;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(clean, null, 2), 'utf8');
    } catch {
      /* 落盘失败不影响本次会话，下次重启回落到配置 */
    }
  }

  return { load, save };
}
