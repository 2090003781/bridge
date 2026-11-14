# 发布到 DSH 插件市场

仓库已经是一个 monorepo：`2090003781/bridge`，两个包在 `packages/` 下。

## 市场条目（现在应该是这个）

文件：`data/plugins/2090003781__bridge--packages-dsh-bridge-connector.yml`

```yaml
url: https://github.com/2090003781/bridge/tree/main/packages/dsh-bridge-connector
name: 2090003781/bridge#dsh-bridge-connector
category: remote
tarball: https://github.com/2090003781/bridge/releases/latest/download/dsh-bridge-connector.tgz
description:
  en: Loopback HTTP/SSE service that lets an Obsidian plugin drive DSH sessions and tells the model where you are reading (path, size, cursor line, heading, selection — coordinates only, the note body stays on disk); gives the agent its own separate cursor inside the editor; the companion plugin must be running in Obsidian.
  zh: 让 Obsidian 插件驱动 DSH 会话、并把「你在读哪一篇、光标在哪」这类坐标交给模型的回环 HTTP/SSE 服务（只给坐标，正文留在磁盘上，需要时自己去读）；AI 在编辑器里有自己独立的光标；需要在 Obsidian 内配套运行插件。
```

> monorepo 的规则：`url` 指到子目录，`name` 用 `owner/repo#子包名`，文件名把路径里的 `/` 换成 `-`。
> 根目录或子包声明 `dsh.bundle` 都算合规——我们是子包里有。

## 下载量是怎么统计的（2026-11-14 查证）

市场**不数 GitHub Release 资产的下载次数**。`data/downloads.json` 里的数字来自 npm：

- `scripts/probe-npm.mjs` 先判定哪些条目真的发布到了 npm，写进 `data/npm-map.json`
- `scripts/probe-downloads.mjs` 只对这批条目查 `api.npmjs.org/downloads/point/<起>:<止>/<包名>`，取**最近 30 天**的下载量
- 只有 `github:` 装法的条目（我们就是）没有 npm 包，因此永远不会有下载量——脚本注释里明说是 coverage gap，不是探测失败，也不会编一个数

所以想让市场显示使用量，唯一的办法是把 `dsh-bridge-connector` 发到 npm。

## 历史

- 2026-11-01：第一版条目合并（当时是两个独立仓库，指向 `2090003781/dsh-bridge-connector`）
- 2026-11-02：合成 monorepo `2090003781/bridge`，旧的两个仓库删除，条目改指向子目录

## 流程

1. 改代码、跑测试（`packages/*/node --test`）
2. 两端版本号一起升，发 Release，资产名**不带版本号**：
   - `obsidian-bridge.zip`（Obsidian 插件安装包）
   - `dsh-bridge-connector.tgz`（市场用的预构建包）
3. `latest/download/` 只解析 `latest`、文件名照字面取——资产名带版本号会让链接在下次发版后 404
4. 条目内容变了才需要改 PR；`tarball` 指向 `latest`，发版不用动条目

## 网络

这台机器访问 GitHub 必须走代理 `127.0.0.1:17891`（VPN 开着时）。
`git` 已经配了 `http.https://github.com.proxy`；`gh` 是 Go 程序不读系统代理，要设 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量。
