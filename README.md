# Bridge

**一个插件的两头：一头插 Obsidian，一头插 DSH。**

把 Obsidian 的内部能力交给 DSH 和 agent 用，并把库内笔记作为实时上下文喂给模型。

| 目录 | 是什么 | 跑在哪 |
|---|---|---|
| [`packages/obsidian-bridge`](packages/obsidian-bridge) | Obsidian 插件：把命令面板 / 编辑器 / 工作区 / 库读写暴露成本机 HTTP（8811） | Obsidian 进程里 |
| [`packages/dsh-bridge-connector`](packages/dsh-bridge-connector) | DSH 插件：让 Obsidian 面板驱动 DSH 会话、把笔记注入系统提示词（8812） | DSH 进程里 |

两头都装才完整——只装一头没有对端。Obsidian 那一头**不自管启停**：Obsidian 开着它就在，由 DSH 那一头观察。

## 装法

**Obsidian 侧**：把 [release](https://github.com/2090003781/bridge/releases) 里的 `obsidian-bridge-<版本>.zip` 解压到
`你的库/.obsidian/plugins/obsidian-bridge/`，在第三方插件里启用。

**DSH 侧**：

```sh
dsh plugin --profile web add https://github.com/2090003781/bridge/releases/latest/download/dsh-bridge-connector.tgz
```

装完重启 DSH。

## 注入是怎么工作的

注入的是**路径**，不是快照：

- Obsidian 面板点注入 → 只把 `path` + `absPath` 发给 DSH 侧
- DSH 侧每轮组装系统提示词时按 `mtime + size` 读磁盘最新内容（没变就不读）
- 所以笔记改了，下一轮注入就跟着变；**未保存的改动不会被注入**（读的是磁盘）
- 注入记录落盘在 `~/.dsh-bridge/injections.json`，DSH 重启后自动恢复
- 单篇预算 512KB，超了截断

## 版本

两端版本号一致：**0.3.0**。升级时先更 DSH 侧（`dsh-bridge-connector`），再更 Obsidian 侧。

## 测试

```powershell
cd packages/obsidian-bridge && node --test      # 128 项
cd packages/dsh-bridge-connector && node --test # 49 项
```

还有真库自检（需要 Obsidian 开着）：`node packages/obsidian-bridge/scripts/self-check.mjs`，44 项。

## License

MIT
