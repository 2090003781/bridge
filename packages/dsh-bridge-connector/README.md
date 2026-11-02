# dsh-bridge-connector

**Bridge 是一个插件的两头：一头插 Obsidian，一头插 DSH。**

| 这一头 | 那一头 |
|---|---|
| **本仓库**：跑在 DSH 进程里的插件，在 `127.0.0.1:8812` 起回环 HTTP/SSE 服务 | [**obsidian-bridge**](https://github.com/2090003781/bridge/tree/main/packages/obsidian-bridge)：跑在 Obsidian 进程里的插件，把命令/编辑器/工作区/库读写暴露成本机 HTTP（8811） |

两头都装才完整——只装一头没有对端。它让 Obsidian 面板能

- 列出会话、向某个会话发消息、新建会话
- 把库内笔记（最多 10 篇）挂进 DSH 的**系统提示词段** `bridge:context`，每轮重新组装、不进对话历史
- 读/切「注入」开关

它**不是** Obsidian 本人：笔记的读写由 Bridge 插件（Obsidian 内部，8811）完成，这个连接器只负责跟 DSH 对话。

> 配套的 Obsidian 插件在 [obsidian-bridge](https://github.com/2090003781/bridge/tree/main/packages/obsidian-bridge)（它是 Obsidian 插件，不是 DSH 插件，所以不在本仓库）。只装这个连接器没有可对话的对端。

## 安装

市场里点安装即可。手动装：

```sh
dsh plugin --profile web add https://github.com/2090003781/bridge/releases/latest/download/dsh-bridge-connector.tgz
```

> 没有发布到 npm（npm 现在要求发布时提供 2FA 验证码），所以走 GitHub Release 的预构建 tarball，安装时不需要构建。

装完重启 DSH。服务与 token 信息写在 `~/.dsh-bridge/connector.json`。

## 端点

除 `/health` 外都要 `x-bridge-token`（或 `Bearer`）。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/health` | 服务身份、订阅数、注入开关 |
| GET | `/sessions` | 会话清单 |
| GET | `/session?sessionId=` | 单个会话详情 |
| POST | `/task` | 向会话发一条消息 |
| POST | `/session` | 新建会话 |
| GET/POST | `/config` | 读/写注入开关 |
| GET | `/inject` | 当前注入列表 |
| POST | `/inject` | 注入一篇（≤512KB，最多 10 篇，同标题覆盖） |
| POST | `/inject/clear` | 清一篇（带 `id`）或全部 |
| GET | `/events` | SSE 事件流 |

## 配置

| 键 | 默认 | 说明 |
|---|---:|---|
| `port` | `8812` | 端口被占时自动向后找 5 个 |
| `host` | `127.0.0.1` | 只允许回环 |
| `injection` | `false` | 首次启动的默认值；之后以 `~/.dsh-bridge/state.json` 为准 |
| `injectionTtlMs` | `0` | 注入过期时间，`0` = 永不过期（只能手动清） |

## 行为说明

- 注入写进系统提示词段（order 250），**下一轮**生效，不写入对话历史
- 段是进程级的，所有会话共享（包括 QQ 那条线）
- 注入开关会落盘（`~/.dsh-bridge/state.json`），DSH 重启后保持上次状态
- **注入内容也会落盘**（`~/.dsh-bridge/injections.json`）：DSH 重启后自动读回，不用重新注。要清就手动删单篇或全部清
  - 注意：内容活过 DSH 重启，**但不会自动过期**——想让它只在一段时间内生效，把 `injectionTtlMs` 设成正数（毫秒）
- 注入内容有 512KB/篇 的预算：它在系统提示词里，每轮都要重发

## 测试

```sh
npm test
```

## License

MIT
