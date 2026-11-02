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
  en: Loopback HTTP/SSE service that lets an Obsidian plugin drive DSH sessions and inject vault notes into the system prompt; needs the companion plugin running inside Obsidian.
  zh: 让 Obsidian 插件驱动 DSH 会话、并把库内笔记注入系统提示词的回环 HTTP/SSE 服务；需要 Obsidian 内配套运行的插件。
```

> monorepo 的规则：`url` 指到子目录，`name` 用 `owner/repo#子包名`，文件名把路径里的 `/` 换成 `-`。
> 根目录或子包声明 `dsh.bundle` 都算合规——我们是子包里有。

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
