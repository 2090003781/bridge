# 发布到 DSH 插件市场

仓库已经是一个 monorepo：`Charliewhale/bridge`，两个包在 `packages/` 下。

## 市场条目（现在应该是这个）

文件：`data/plugins/Charliewhale__bridge--packages-dsh-bridge-connector.yml`

```yaml
url: https://github.com/Charliewhale/bridge/tree/main/packages/dsh-bridge-connector
name: Charliewhale/bridge#dsh-bridge-connector
category: remote
tarball: https://github.com/Charliewhale/bridge/releases/latest/download/dsh-bridge-connector.tgz
description:
  en: Loopback HTTP/SSE service that lets an Obsidian plugin drive DSH sessions and tells the model where you are reading (path, size, cursor line, heading, selection — coordinates only, the note body stays on disk); gives the agent its own separate cursor inside the editor; the companion plugin must be running in Obsidian.
  zh: 让 Obsidian 插件驱动 DSH 会话、并把「你在读哪一篇、光标在哪」这类坐标交给模型的回环 HTTP/SSE 服务（只给坐标，正文留在磁盘上，需要时自己去读）；AI 在编辑器里有自己独立的光标；需要在 Obsidian 内配套运行插件。
```

> monorepo 的规则：`url` 指到子目录，`name` 用 `owner/repo#子包名`，文件名把路径里的 `/` 换成 `-`。
> 根目录或子包声明 `dsh.bundle` 都算合规——我们是子包里有。

## 发到 npm（2026-11-17 起有了）

连接器已发布：`//registry.npmjs.org/dsh-bridge-connector`，用户 `charlie_cc`。

```sh
cd packages/dsh-bridge-connector
npm publish --access public
```

- 首次发布会先建一个 `0.0.0-stage` 占位版本，真实版本几分钟后才出现（npm 的处理流水线）
- 账号开了 auth-and-writes 双因素：普通 token 会被 EOTP 挡住；带「Bypass 2FA」的 granular token 能发，但**不能** `npm unpublish`（403），所以占位版本删不掉，留着无妨
- 包名跟着 monorepo 版本走；发版时两端一起升，npm 和 GitHub Release 才对得上

## 下载量是怎么统计的（2026-11-14 查证）

市场**不数 GitHub Release 资产的下载次数**。`data/downloads.json` 里的数字来自 npm：

- `scripts/probe-npm.mjs` 先判定哪些条目真的发布到了 npm，写进 `data/npm-map.json`
- `scripts/probe-downloads.mjs` 只对这批条目查 `api.npmjs.org/downloads/point/<起>:<止>/<包名>`，取**最近 30 天**的下载量
- 只有 `github:` 装法的条目（我们就是）没有 npm 包，因此永远不会有下载量——脚本注释里明说是 coverage gap，不是探测失败，也不会编一个数

所以想让市场显示使用量，唯一的办法是把 `dsh-bridge-connector` 发到 npm。

## 历史

- 2026-11-01：第一版条目合并（当时是两个独立仓库，指向 `Charliewhale/dsh-bridge-connector`）
- 2026-11-02：合成 monorepo `Charliewhale/bridge`，旧的两个仓库删除，条目改指向子目录
- 2026-11-20：GitHub 账号改名（`2090003781` → `Charliewhale`），仓库链接与 npm 的 repository 字段跟着改；旧名字仍会被 301 重定向，但新文档统一用新名

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
