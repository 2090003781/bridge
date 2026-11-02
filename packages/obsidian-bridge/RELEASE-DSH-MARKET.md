# 发布到 DSH 插件市场

两条真相：市场 = `dshmarket` 包，它的列表实时读 `awesome-dsh-plugin.com/plugins.json`，
那份数据来自 GitHub 仓库 **awesome-dsh-plugin/awesome-dsh-plugin**。
所以「进市场」= 向那个仓库提一个 PR，加一个 yml 文件。市场仓库本身不收插件条目。

## 已经准备好的（我这边做完了）

- `C:\Users\20900\.dsh\profiles\web\plugins\dsh-bridge-connector\` 已经是一个可发布的包：
  - `package.json` 带 **`dsh.bundle`**（市场最常见的被拒原因就是只写 `dsh.client`）
  - `cordis.patch.yml` 与包同级
  - `README.md` / `LICENSE`（MIT）
- 冒烟验证过：`npm pack` 产物 8 个文件、26.9KB；装进空目录后 `dsh.bundle` 与全部文件都在
- 单测 36/36 通过

## 需要你做的（我碰不到你的账号）

### 1. 把占位符换成你的 GitHub 用户名

`C:\Users\20900\.dsh\profiles\web\plugins\dsh-bridge-connector\package.json` 里三处 `REPLACE-ME`：

```json
"repository": { "type": "git", "url": "git+https://github.com/你的用户名/dsh-bridge-connector.git" }
"homepage": "https://github.com/你的用户名/dsh-bridge-connector#readme"
"bugs": { "url": "https://github.com/你的用户名/dsh-bridge-connector/issues" }
```

同一份 `REPLACE-ME` 也出现在 `README.md` 里（指向 Obsidian 侧仓库）。

### 2. 建 GitHub 仓库并推上去

仓库名建议 `dsh-bridge-connector`，**必须**加 topic `dsh-plugin`（CI 会查）。

```powershell
cd C:\Users\20900\.dsh\profiles\web\plugins\dsh-bridge-connector
git init
git add .
git commit -m "init: DSH 侧 Bridge 连接器"
git branch -M main
git remote add origin https://github.com/你的用户名/dsh-bridge-connector.git
git push -u origin main
```

推完去仓库页面 Settings 里加 topic：`dsh-plugin`。

### 3. 分发方式：GitHub Release 的 tarball（不走 npm）

原本打算发 npm，试过两个 token 都是 403：

```
403 Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.
```

npm 现在不允许「Bypass 2FA」的 token 直接发布包了（它自己的提示：
*npm tokens that bypass 2FA are being restricted for account changes and direct publishing*）。
**不走 npm 也完全能上架**，官方支持另一条路：把预构建 tarball 挂到 GitHub Release，市场条目里用 `tarball:` 指过去，
用户安装时下 tarball，同样免构建。

已经做好了：

- Release `v0.2.0`，资产名 **`dsh-bridge-connector.tgz`（故意不带版本号）**
- 实测下载可用：`https://github.com/2090003781/dsh-bridge-connector/releases/latest/download/dsh-bridge-connector.tgz` → HTTP 200 / 9970 字节

> 为什么不带版本号：`latest/download/` 只解析 `latest`，文件名是照字面取的。
> 资产名带版本号的话，这个链接发版当天有效，下次发版就 404，而且没人会发现。

**以后想发 npm**：给账号开 2FA（认证器），发布时用 `npm publish --otp=六位码`。不发也不影响上架。
### 4. 等仓库满 1 天，然后提 PR

仓库创建时间不足 1 天会被 CI 自动拒（只差这一条就等等，不算失败）。

Fork `https://github.com/awesome-dsh-plugin/awesome-dsh-plugin`，然后**新增一个文件**：

`data/plugins/<owner>__<repo>.yml` —— 例如 owner 是 `2090003781`，文件名就是 `2090003781__dsh-bridge-connector.yml`：

```yaml
url: https://github.com/2090003781/dsh-bridge-connector
name: 2090003781/dsh-bridge-connector
category: remote
description:
  en: Loopback bridge that lets an Obsidian plugin drive DSH sessions and inject vault notes into the system prompt.
  zh: 让 Obsidian 插件驱动 DSH 会话、并把库内笔记注入系统提示词的回环桥。
tarball: https://github.com/2090003781/dsh-bridge-connector/releases/latest/download/dsh-bridge-connector.tgz
```

- `category: remote` —— 它做的是「从另一个程序遥控 DSH」。分类选不准不会被打回，维护者会改
- `tarball` 那行只在你不发 npm 时需要；发 npm 就删掉
- **只加这一个文件**，不要手工改 README（那两个 README 是自动生成的）
- 描述里别写数字和夸张词，维护者会数

## 提 PR 之前再确认一遍

- [ ] `package.json` 里 `dsh.bundle.patch` 指向真实存在的 `cordis.patch.yml`
- [ ] 仓库有 `dsh-plugin` topic
- [ ] 仓库创建满 1 天
- [ ] `npm test` 全绿（36 项）
- [ ] 描述与实际行为一致（现在声称的是：会话列表/发消息/新建会话、笔记注入系统提示词、注入开关）

## 一个前情提示

只装这个连接器没有用——它是给 Obsidian 侧 Bridge 插件当对端的。
README 和市场描述里都写了这一点，评审时也照着说，别让人装完发现没有对端。

## PR 已经备好了（2026-10-31 16:50）

- fork 完成：https://github.com/2090003781/awesome-dsh-plugin
- 分支 `add-dsh-bridge-connector` 已推送，只加了一个文件：
  `data/plugins/2090003781__dsh-bridge-connector.yml`（663 字节，7 行）
- 明日（仓库满 1 天后）跑一条命令即可：

```powershell
D:\obsidian-bridge\submit-market-pr.ps1
```

脚本里已带代理环境变量和 PR 正文（英文，说明功能、前置条件、验证情况）。
本地 fork 副本在 `D:\tmp\awesome-dsh-plugin`，用完可以删。
