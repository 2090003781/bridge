# Bridge 路线图

> 当前插件版本 **0.2.0**。下面标题里的 v0.1.x 是**功能批次的阶段编号**，不是插件版本号。


> 判断标准：**DSH 现在做不到、做完能干什么**。每条都标了操作 id 和档位，做完就能直接调。

## ✅ 已完成（v0.1.0）

| 能力 | 操作 | 档位 | 状态 |
|---|---|---|---|
| 列命令面板全部命令（88 条） | `obsidian.command.list` | read | ✅ |
| 执行命令面板里任意命令 | `obsidian.command.execute` | write | ✅ |
| 健康 / 操作目录 | `core.health` | read | ✅ |
'| 编辑器状态（光标/选区/行数） | `obsidian.editor.state` | read | ✅ |
| 光标处插入 / 文末追加 | `obsidian.editor.insert` | write | ✅ |
| 替换选区 / 按范围替换 | `obsidian.editor.replace` | write | ✅ |
| 光标定位 + 滚动 | `obsidian.editor.cursor` | write | ✅ |
| 工作区快照（标签/活跃文件） | `obsidian.workspace.state` | read | ✅ |
'| 打开笔记（新标签/分屏/模式） | `obsidian.workspace.open` | write | ✅ |
| 标签激活 / 关闭 / 循环 | `obsidian.workspace.tab` | write | ✅ |
| 打开侧栏视图（复用已开） | `obsidian.workspace.view` | write | ✅ |
| 布局导出 / 应用 | `obsidian.workspace.layout` | write | ✅ |'
'| 读正文（走 Obsidian 缓存） | `obsidian.note.read` | read | ✅ |
| 元数据（frontmatter/标签/出链/标题） | `obsidian.note.meta` | read | ✅ |
'| 反链（含未解析引用，带次数） | `obsidian.note.backlinks` | read | ✅ |
| 新建笔记（拒绝覆盖） | `obsidian.note.create` | write | ✅ |
| 文末追加 | `obsidian.note.append` | write | ✅ |
| 改 frontmatter 属性 | `obsidian.note.property` | write | ✅ |
| 改名/移动（默认 dry-run，自动修链接） | `obsidian.note.rename` | write | ✅ |
| 删除（回收站，需确认） | `obsidian.note.delete` | trust | ✅ |'
| 三档权限（按调用方记档） | — | — | ✅ |''
| 审计账本（一行一次调用） | — | — | ✅ |
| 设置页（端口/token/档位/状态） | — | — | ✅ |
| DSH MCP 工具 | `obsidian_health / ops / commands / exec` | — | ✅ |

## ✅ 第一批 · 编辑器实时读写（v0.1.1 完成 4/5）

| # | 能力 | 现在做不到 | 做完能干什么 | 操作 / 工具 | 档位 |
|---|---|---|---|---|---|
| 1 | 编辑器状态 | 不知道你光标在哪、选中了什么 | 读活跃笔记、光标、选区、选中文字 | `obsidian.editor.state` | read |
| 2 | 插入文本 | 只能整篇写盘，抢 Obsidian 的编辑 | 在光标处插入生成内容（保留撤销栈） | `obsidian.editor.insert` | write |
| 3 | 替换选区 | 同上 | 选中一段 → 改写那段 | `obsidian.editor.replace` | write |
| 4 | 光标/滚动 | 不能定位 | 跳到指定行/位置、滚动到引用处 | `obsidian.editor.cursor` | write |
| 5 | 按范围读 | 只能读选区 | 读某个行号范围内正文 | `obsidian.editor.range` | read |

## ✅ 第二批 · 工作区控制（全部完成）

| # | 能力 | 现在做不到 | 做完能干什么 | 操作 | 档位 |
|---|---|---|---|---|---|
| 6 | 工作区快照 | 不知道你开了哪些标签、怎么分屏 | 读所有 leaf、活跃文件、模式、布局 | `obsidian.workspace.state` | read |
| 7 | 打开笔记 | 不能把笔记推到你眼前 | 打开文件、新标签、分屏、指定源码/阅读模式 | `obsidian.workspace.open` | write |
| 8 | 标签控制 | 不能整理 | 激活/关闭/移动标签 | `obsidian.workspace.tab` | write |
| 9 | 切视图 | 不能开图谱/反链/大纲 | 打开指定侧栏视图 | `obsidian.workspace.view` | write |
| 10 | 布局存取 | 不能保存/恢复工作区 | 保存、加载命名布局 | `obsidian.workspace.layout` | write |

## ✅ 第三批 · 元数据与笔记写入（11/12/14-18 完成，13 全库搜索待做）

| # | 能力 | 现在做不到 | 做完能干什么 | 操作 | 档位 |
|---|---|---|---|---|---|
| 11 | 笔记元数据 | 磁盘扫出来的和 Obsidian 解析的可能不一致 | frontmatter / 标签 / 出链 / 反链 / 未解析链接（走 metadataCache） | `obsidian.note.meta` | read |
| 12 | 反链查询 | 只能扫文本猜 | Obsidian 官方反链（含未解析） | `obsidian.note.backlinks` | read |
| 13 | 全库搜索 | 只能靠磁盘扫描 | 文件名 + 正文多关键字 AND（走 Obsidian 文件缓存，约 1s/全库） | `obsidian.search` | read |
| 14 | 新建笔记 | 写盘后 Obsidian 要刷新 | 走 vault.create，实时出现在列表里 | `obsidian.note.create` | write |
| 15 | 尾部追加 / 按小节改 | 整篇覆盖风险大 | append / 按标题小节 patch（对齐 brain.section） | `obsidian.note.append` / `note.patch` | write |
| 16 | 改属性 | 手写 YAML 容易坏 | processFrontMatter 改属性，类型安全 | `obsidian.note.property` | write |
| 17 | 重命名 / 移动 | 磁盘改名会断链 | fileManager 改名，**自动更新全库引用** | `obsidian.note.rename` / `note.move` | write |
| 18 | 删除 | 直接删危险 | 走系统回收站（可恢复） | `obsidian.note.delete` | trust |

## ❌ 已取消 · 事件流（2026-10-25 辞宝：不进 DSH）

不采集「你在看什么/改什么」，不推送，不注入上下文。整批不做。

## ✅ 第五批 · 反向通道（Obsidian ↔ DSH 直连面板，已完成）

| # | 能力 | 现在做不到 | 做完能干什么 | 形态 |
|---|---|---|---|---|
| 23 | 选区交给 DSH | 只能复制粘贴到聊天框 | 侧栏面板直接对话（已绑定会话） | BridgeChatView |
| 24 | 面板 ↔ 会话双向 | 只能单次发任务 | 发消息 / 流式接收回复（SSE） | dsh-bridge-connector |
| 25 | 结果回写 | 回复要手动搬 | DSH 用 `obsidian.editor.insert` 自己写回（已是允许操作） | MCP 工具 |
| 26 | **上下文注入** | 只能在聊天里复述笔记内容 | 面板一点，把当前笔记/选区注入下一轮模型上下文 | `POST /inject` + `agent/pre-step` |

## ⏸ 暂不开放 · 借力其他插件（2026-10-25 辞宝：先不开放）

Dataview / Templater / Smart Connections / Excalidraw 这些先不接。
桥只用自己的操作目录，不依赖别的插件的内部 API，升级/重载不会把桥带崩。
以后要开，按「只读 → 写入 → trust 白名单」逐档放。

## 第七批 · Bridge 平台化（收口）

| # | 事项 | 说明 |
|---|---|---|
| 31 | 危险命令黑名单 | 删库/退出类命令归 trust，其余 write |
| 32 | 权限策略 | 首次安装 read，主人在设置页一键放开（现在默认 write） |
| 33 | 插件自检 `/selfcheck` | 服务/权限/账本/Obsidian API 可达性一次体检 |
| 35 | 端口冲突回退 | 8811 被占时自动换 8812…，info 文件同步 |
| 36 | 多库支持 | 同时开多个 vault 时按库名区分（info 文件带 vault） |
| 37 | 日志查看器 | 设置页直接看最近调用，不用去翻 JSONL |
| 38 | 一键更新 | deploy.ps1 已能打包部署，加版本对比与回滚 |

## 建议顺序

1. **第三批**（元数据与笔记写入）——先只读（元数据/反链/搜索），确认数据一致再开写入
2. **第二批剩余**（工作区 tab / view / layout）
3. **第五批**（反向通道：选区一键交给 DSH、结果写回光标）
4. **第七批**（收口：危险命令黑名单、自检、端口回退、多库）

事件流、借力插件已按辞宝决定取消/暂缓。

## 现在的边界（v0.1.0 明确不做）

- 不接管进程监管、笔记索引、转录（不属于本插件职责）
- 不与枢阁（8790 / 8848）产生任何联系：不连服务、不共享数据、不同步事件
- 不做跨库同步