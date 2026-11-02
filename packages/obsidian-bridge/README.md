# Bridge · Obsidian 侧能力端

把 Obsidian **内部能力**（命令面板等）通过本地网桥暴露给 DSH 与其它 agent。

---

## 一个插件的两头

**Bridge 是一个插件的两头：一头插 Obsidian，一头插 DSH。**

| 这一头 | 那一头 |
|---|---|
| **本仓库**：跑在 Obsidian 进程里的插件，把命令面板 / 编辑器 / 工作区 / 库读写暴露成本机 HTTP（8811） | [**dsh-bridge-connector**](https://github.com/2090003781/bridge/tree/main/packages/dsh-bridge-connector)：跑在 DSH 进程里的插件，让 DSH 能跟 Obsidian 对话、把笔记注入系统提示词（8812） |

两头都装才完整——只装一头没有对端。这一头**不自管启停**：Obsidian 开着它就在，由 DSH 那头观察。

---


> **独立项目**：Bridge 与枢阁（8790 / 8848）没有任何依赖——不用它的服务、不共享数据、不读它的库。
> 两个插件（Obsidian 侧能力端 + DSH 侧连接器）自成一体，通过 DSH 会话通信。

DSH 走文件系统只能看见磁盘上的 Markdown，看不见 Obsidian 里的命令、工作区、编辑器和 UI。
Bridge 补的就是这一层：Obsidian 开着，Bridge 就在；agent 通过 MCP 工具就能在 Obsidian 里
执行本来执行不了的操作。

> **与枢阁完全独立**：不连它的服务、不共享数据、不读写它的库、不做任何事件同步。
> Bridge 只干 Obsidian 内部能力，也不接管进程监管、笔记索引、转录这类不属于它的职责。
>
> **两个插件是一个整体**：Obsidian 侧是能力端（跑在 Obsidian 进程里，提供 vault / 命令 / 编辑器 / 工作区），
> DSH 侧是生命主体（连接器、会话、注入、MCP 工具）。Obsidian 侧不自管 Bridge 启停——服务随 Obsidian 起落，
> 状态由 DSH 侧感知（`/health` 的 `obsidian` 字段 + 面板 meta）。

## 架构

```
Obsidian（渲染进程）
└─ 插件 obsidian-bridge（单文件 main.js）
   ├─ 操作注册表（read / write / trust 三档）
   ├─ 权限（按调用方记档，落 data.json）
   ├─ 审计账本（data/ledger.jsonl，一行一次调用）
   ├─ HTTP 服务 127.0.0.1:8811（除 /health 外都要 token）
   │    GET /health   GET /ops   POST /op
   └─ Obsidian 适配层（app.commands / app.workspace / ...）

DSH
└─ MCP client（stdio）→ scripts/mcp-bridge.js → HTTP → 插件
     工具：obsidian_health / obsidian_ops / obsidian_commands / obsidian_exec
```

服务信息写在 `~/.obsidian-bridge/info.json`（端口 / token / pid / 库名），MCP 桥按它找人，不硬编码端口。

## 当前能力（v0.1.0）

| 操作 | 档位 | 说明 |
|---|---|---|
| `core.health` | read | Bridge 自身健康信息 |
| `obsidian.command.list` | read | 列出命令面板全部命令（id / 名称 / 快捷键） |
| `obsidian.command.execute` | write | 执行任意命令，返回是否真的执行了 |
| `obsidian.editor.state` | read | 活跃编辑器：路径 / 光标 / 选区 / 行数 |
| `obsidian.editor.insert` | write | 光标处插入（`position=end` 追加到文末） |
| `obsidian.editor.replace` | write | 替换选区；带 `from/to` 可先选中再替换 |
| `obsidian.editor.cursor` | write | 定位光标并滚动到可见位置 |
| `obsidian.workspace.state` | read | 工作区快照：活跃文件 + 所有打开标签 |
| `obsidian.workspace.open` | write | 打开笔记（新标签 / 分屏 / 源码或阅读模式） |
| `obsidian.workspace.tab` | write | 标签 activate / close / next / previous |
| `obsidian.workspace.view` | write | 打开侧栏视图（图谱/反链/大纲等），已开则复用 |
| `obsidian.workspace.layout` | write | 布局 get（导出 JSON）/ set（应用 JSON） |
| `obsidian.note.read` | read | 按路径读正文（走 Obsidian 缓存，可 maxChars 截断） |
| `obsidian.note.meta` | read | frontmatter / 标签 / 出链 / 嵌入 / 标题 / 反链来源 |
| `obsidian.note.backlinks` | read | 反链（含未解析引用，带次数与出链对照） |
| `obsidian.query` | read | 全库结构化查询：目录 / 多标签 AND / 多属性 AND / 文件名多关键字 / 时间范围；只返回索引信息，不含正文 |
| `obsidian.search` | read | 全库关键字搜索：文件名 + 正文（多关键字 AND），返回命中行片段，不返回整篇 |
| `obsidian.note.create` | write | 新建笔记（默认 .md，已存在拒绝覆盖） |
| `obsidian.note.append` | write | 文末追加一段 |
| `obsidian.note.property` | write | 改 frontmatter（set / del） |
| `obsidian.note.rename` | write | 改名/移动，**默认 dry-run**；真改时由 Obsidian 自动修链接 |
| `obsidian.note.delete` | trust | 删除（走系统回收站，需 confirm:true） |

MCP 工具对应：`obsidian_health` / `obsidian_ops` / `obsidian_commands` / `obsidian_exec` / `obsidian_call`（通用）/ `obsidian_editor_*` / `obsidian_workspace_*`。

## 安装

```powershell
# 1. 打包（把 src/lib 内联成单文件 main.js——Obsidian 不认插件内的相对 require）
node packages/obsidian-bridge/scripts/build.js

# 2. 部署到库
powershell -File packages/obsidian-bridge/scripts/deploy.ps1 -Vault "D:\个人数据\辞玖"

# 3. 在 .obsidian/community-plugins.json 里启用 "obsidian-bridge"，重启 Obsidian
#    状态栏出现「Bridge :8811」即成功
```

DSH 侧配置（已追加到 `~/.dsh/profiles/web/cordis.patch.yml`）：

```yaml
- insert:
    - id: mcp-bridge
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: bridge
        transport: stdio
        command: 'C:\Program Files\nodejs\node.exe'
        args: ['D:/bridge/packages/obsidian-bridge/scripts/mcp-bridge.js']
        toolCallTimeoutMs: 60000
        failOnStartupError: false
```

## 权限与账本

- 三档累积释放：`read`（查）→ `write`（执行命令）→ `trust`（全开，留给后续 eval / 插件内部调用）
- 按调用方记档：`agent.dsh` / `agent.reasonix` / `local`……**默认档位是 `read`**（没配过的调用方一上来只有只读），可在设置页改
- 每次调用记一行 JSONL：`ts / client / op / tier / ok / ms / args`；账本写失败不阻断调用
- 设置页可看：运行状态、端口、token（复制/重置）、客户端档位、操作目录、账本路径

## 安全边界

- 只监听回环（`127.0.0.1`），设置里拒绝其它 host
- 除 `/health` 外一律 `x-bridge-token`（或 Bearer）校验，常量时间比较
- `command.execute` 是「命令面板里的一切」——包含改文件/删标签页这类命令，所以归 write 档并全额记账
- MCP 桥连不上时明确报 `offline`，不静默成功
- **状态码按错误种类分开**：参数错 400 / token 不对 401 `unauthorized` / token 过期 401 `token-expired` / 档位不足 403 / 文件不存在 404 / 已存在 409 / 不支持 501，真内部错误才是 500
- **token 有生命周期**：设置页可选 永久 / 30 天 / 7 天 / 1 天 / 1 小时；剩余寿命不足一成时**自动轮换**并写 `info.json`，调用方重读那个文件即可，不需要重启服务
- **账本不落正文**：`content` / `text` / `body` 这类参数只记长度（`<N 字>`）
- **请求入口全兜底**：畸形请求行（如 `GET //`）回 400 而不是把进程打挂

## 验证（2026-10-24 实测）

| 项 | 结果 |
|---|---|
| 单元测试（node --test） | 29 通过 / 0 失败 |
| 插件随 Obsidian 自动启动 | ✅ 状态栏 + `/health` 8811 |
| MCP 工具列命令 | ✅ 88 条 |
| 官方 MCP 工具执行命令 | ✅ `theme:toggle-light-dark` → 主题 light→dark→light 实测变化 |
| 编辑器插入（真实） | ✅ 打开 tmp/zz-bridge-e2e.md → 文末插入 → 磁盘 2.5s 落盘 |
| 编辑器替换（真实） | ✅ 按 {line,ch} 范围替换 → 磁盘内容确认 |
| 工作区打开（真实） | ✅ workspace.open 打开笔记并成为活跃文件 |
| 反链（真实库） | ✅ 原则细则区 3 条 / 用户画像 4 条；修掉 Map 返回形态导致的反链恒空 |
| 写入链路（真实） | ✅ 创建 → 追加 → 改属性（draft 删掉、status/priority 写入）→ dry-run → 真改名；磁盘逐项确认 |
| rename 返回值 | ✅ 修掉 Obsidian 就地改 TFile.path 导致 from 变成新路径的问题 |
| 删除（真实） | ✅ 垃圾文件 → trashFile → 磁盘消失 + **回收站可见**（原路径 tmp）；提权回 write 后 delete 被 403 |
| 工作区（真实） | ✅ 新标签打开 → 激活 → 关闭；outline 视图复用；layout get 返回完整结构 |
| 审计账本 | ✅ 每次调用一行，含 client/op/ok/ms |
| token 保护 | ✅ 无 token / 错 token 均 401 |
| 只读档拦截 | ✅ `obsidian.command.execute` 返回 403 且不碰 Obsidian |


## DSH 对话面板（v0.1.6）

侧栏里一个面板 = 一个 DSH 会话，像 QQ Bot 那样双向对话。

- 打开：命令面板「打开 Bridge 对话」，或左侧 ribbon 的消息图标
- 绑定：首次打开自动绑最近活跃的 DSH 会话；设置页可「解绑」重选
- 发消息：Enter 发送、Shift+Enter 换行；状态栏显示「思考中… / 执行：xx工具 / 就绪」
- 接收：会话的 assistant 文本通过 SSE 实时流进面板
- 面板里的 DSH **能执行 Bridge 全部允许的操作**（命令 / 编辑器 / 笔记 / 工作区），不只是回写光标

链路：

```
Obsidian 面板 --node:http--> dsh-bridge-connector(127.0.0.1:8812) --sessionController.prompt--> DSH 会话
DSH 会话 --session/event--> connector --SSE--> 面板
```

连接信息在 `~/.dsh-bridge/connector.json`（host / port / token），连接器插件源码在
`~/.dsh/profiles/web/plugins/dsh-bridge-connector/`，已追加到 `cordis.patch.yml`。

## 注入（v0.1.9）

面板右上角「注入当前笔记」：把当前笔记（**完整正文** + 路径 + 选区）送进 DSH 的**系统提示词段**
`bridge:context`（order 250）。

- 效果相当于「会话开始时注入」：系统提示词每轮都重新组装，注入内容从下一轮起就在上下文里，
  **不进对话历史**，不会越积越多
- 内容 = 当前注入列表（最多 10 篇，同标题覆盖），**不过期，一直挂着**，只能手动删（单篇 ×）或 `POST /inject/clear` 清；连接器 `injectionTtlMs` 显式给正数才恢复限时
- 注意：系统提示词段是进程级的，**所有会话共享**（包括 QQ 那条线），不是只对某个会话可见
- **只有一个真相源：连接器**：设置页和面板都只读连接器的状态、本地值当缓存；手动切换时先写连接器，失败就把开关拨回去（不会出现「界面写着开、实际没开」）。连接器把开关落盘到 `~/.dsh-bridge/state.json`，DSH 重启后保持上次状态；关着时 `/inject` 返回 409 `injection-disabled`
- **可自选笔记**：面板「注入笔记…」弹出模糊搜索，从全库 Markdown 里挑一篇注入；「注入当前笔记」仍按当前打开的笔记 + 选区
- 端点在连接器：`POST /inject { sessionId, content, title }`，清除用 `POST /inject/clear`

## 界面（v0.1.8）

Bridge 在 Obsidian 里有三处界面：

1. **侧栏主面板「Bridge」**（命令面板搜 Bridge，或点左侧消息图标）：上下分页
   - **上 1/3**：五个按钮，分上下两排 —— 上排：档位（点一下循环 read→write→trust）/ 注入 / 复制 token；下排：新建会话 / 操作记录
   - **注入面板**（点「注入」）：开关（与连接器双向同步）、当前注入状态、注入当前笔记 / 选择笔记… / 清除注入
   - **选择笔记**按库内文件树展开：默认展开当前文件所在目录链，其余文件夹收起；点笔记即注入
   - 打开面板**直接复用上次会话**，不弹任何选择；要新会话就点「新建会话」
   - **下 2/3**：对话区，顶部一行 meta（Bridge 端口 · 会话 · 注入开关状态）
2. **操作记录弹窗**（点「操作记录」）：两个页签
   - **操作账本**：谁在什么时候调了什么（客户端 / 操作 / 档位 / 成功失败 / 耗时 / 参数摘要），带统计、关键字过滤、只看失败
   - **运行日志**：启动 / 停止 / 端口异常；可清空
3. **设置页**（设置 → 社区插件 → Bridge）：服务状态 / 端口 / token / 默认档位 / 各客户端权限 / 操作目录 / 上次会话 / 注入开关 / 运行日志入口

> 独立的「Bridge 日志」视图和它对应的 ribbon 图标已删除，日志只从「操作记录」按钮进。

入口都一样：命令面板搜「Bridge」，或者左侧 ribbon 的消息图标（日志从面板里的「操作记录」进）。

账本在 `data/ledger.jsonl`（一行一次调用），运行日志在 `data/bridge.log`（超过 512KB 自动裁剪保留后半）。
## 自测

```powershell
node packages/obsidian-bridge/scripts/self-check.mjs   # 44 项，覆盖鉴权/权限/边界/读写回/注入/持久化/路径
node --test                                        # 128 项单元测试
```

自测按风险驱动组织（参考 awesome-qa-skills 的 risk-based / edge-case / negative-scenario 思路）：

- **鉴权**：无 token、错 token、超大 body、非法 JSON、未知 op、方法不允许
- **权限**：read 可用、write 可用、trust 在 write 档被 403
- **笔记**：创建（拒绝覆盖/路径穿越）→ 读 → 追加 → 改属性（磁盘验证）→ 元数据 → 反链 → 改名 dry-run/真改
- **编辑器/工作区**：打开笔记、读编辑器状态、文末插入并验证落盘、命令列表/未知命令、工作区快照
- **连接器**：health、会话列表、注入开关切换与清除（旧连接器会标 SKIP）
- **持久化**：账本、运行日志、permissions.json
- **路径自适应**：只监听回环、插件目录由 vault 推导、源码无硬编码盘符

## 查询与搜索

- `obsidian.query` 走 Obsidian 自己的 **metadataCache 索引**（frontmatter / 标签 / 标题 / 链接），不读正文，几千篇也是毫秒级
- `obsidian.search` 走 Obsidian 的**文件缓存**（cachedRead）扫正文，2462 篇全库约 1 秒；带 6 秒时间预算和 limit
- 两者都只返回索引/片段，不把整篇笔记塞进上下文；需要正文再按 path 调 `obsidian.note.read`

示例：

```json
{"op":"obsidian.query","args":{"folder":"项目","tags":["ai"],"props":[{"key":"status","value":"进行中"}],"limit":20}}
{"op":"obsidian.search","args":{"query":"唯稳律 三卷","scope":"both","limit":10}}
```

## 目录

```
packages/obsidian-bridge\
├─ src\main.js          插件入口（Obsidian 粘合层）
├─ src\lib\             纯逻辑（可脱离 Obsidian 测试）
├─ test\                node:test
├─ scripts\build.js     零依赖打包器 → dist\main.js
├─ scripts\deploy.ps1   部署到库
└─ scripts\mcp-bridge.js MCP stdio 桥
```

## 下一步

完整路线图（38 项，含每项的现在/做完/档位）见 [TODO.md](./TODO.md)。

近三期：元数据与笔记写入（走 Obsidian，自动修链接）→ 工作区剩余项 → 反向通道（选区一键交给 DSH）。
事件流与借力插件已按辞宝决定取消/暂缓。