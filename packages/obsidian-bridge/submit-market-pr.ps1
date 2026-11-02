# 提交 DSH 插件市场 PR（分支已经推好，只差这一步）
# 前提：仓库 https://github.com/2090003781/dsh-bridge-connector 创建满 1 天（2026-11-01 16:21 之后）
# 代理：本机现在是直连，不再写死代理环境变量（之前那个 127.0.0.1:17891 已经关了）
$ErrorActionPreference = "Stop"
$gh = "C:\Users\20900\Tools\gh\bin\gh.exe"

$body = @"
Adds `dsh-bridge-connector`, a loopback HTTP/SSE service that lets an Obsidian plugin drive DSH sessions and inject vault notes into the system prompt.

**What it does**
- Lists / creates DSH sessions and sends a prompt to one.
- Injects up to 10 vault notes into a system-prompt section (`bridge:context`, order 250); the section is re-assembled every turn and is not written into chat history.
- Per-entry budget of 512 KB, and a runtime on/off switch that survives restarts.

**Install**: prebuilt tarball attached to the release (the `tarball:` field), so there is no build step.

**Prerequisite**: it is a companion to a plugin that runs inside Obsidian — the connector alone has nothing to talk to. The description says so.

**Checks**: `dsh.bundle` is declared (`{"patch":"./cordis.patch.yml"}`), the repo carries the `dsh-plugin` topic, unit tests are 36/36 (`node --test`), and installing from the published tarball URL was verified in a clean directory.
"@

& $gh pr create `
  --repo awesome-dsh-plugin/awesome-dsh-plugin `
  --base main `
  --head 2090003781:add-dsh-bridge-connector `
  --title "Add dsh-bridge-connector" `
  --body $body
