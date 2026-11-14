# 操作纪律（给未来的 agent 看）

这个包把 Obsidian 暴露成一条本地门。门后面有两个「真相源」，混着用会撞版本。

## 一、改笔记只能走一扇门，不许混

Obsidian 改的是**编辑器缓冲**，落盘由它自己决定（实测写完到磁盘同步有**几秒延迟**，3 秒后才稳）。

所以：

- **要走 Obsidian 门，就全走**：读写都用 `obsidian.*` op（`note.read` 也走 vault 缓存，它是当前的）。
- **要走文件本体，就全走**：直接用文件系统工具读写，别在中间插一次 `editor.*`。
- **绝对不要**：先用 `editor.replace` 改，紧接着用文件系统工具读同一行来判断「改成功没有」。你会读到还没落盘的旧内容，然后误判成失败、再改一遍，最后撞出一版乱码。

要确认改动有没有生效，问 Obsidian 自己（`obsidian.editor.state` 的 `lineCount`、或者隔几秒再 `note.read`），不要用文件系统去验。

## 二、AI 有自己的光标，别借主人的

- `obsidian.editor.cursor` / `obsidian.editor.aiCursor`：动的是 **AI 自己的光标**（位置 + 选区），存在插件内存里，不显示。
- `obsidian.editor.insert` / `obsidian.editor.replace`：以 AI 光标为准，走 CM6 的 `dispatch({changes})`，**不发 selection**，所以不会搬动用户的光标。
- `obsidian.editor.state`：返回的是**用户的**那篇和光标，用来知道「主人在看什么」，不是拿来当自己的操作锚点。

换文件时 AI 光标从那一篇行首重来，不会继承上一篇的位置。

## 三、MCP 工具的参数 schema 要写全

`obsidian_editor_replace` 的 `from` / `to` 曾经只写了 `type: 'object'` 没有 `properties`，结果部分 MCP 客户端会当成空对象传，参数在客户端就被吞了——表现是「明明给了坐标却报没有选中内容」。

**教训**：任何对象类型参数，`properties` 必须写全，`required` 也要写。否则问题出在客户端，看服务端日志会一脸问号。

## 四、写位置越界不报错，是夹到边界

`offsetOfPos` 会把越界的行/列夹到文档边界。所以「改完没反应」有可能是行号本来就超出范围——先确认那篇有多少行（`editor.state` 的 `lineCount`）。

## 五、当前笔记上下文是「坐标」，不是「正文」

从面板发消息时会带当前笔记的坐标（路径/篇幅/光标最后位置/所在小节/选区/标记/另外开着几篇），**不带正文**。要内容自己去读，读到的才是最新的。

同一会话同一篇的整篇坐标只带一次；光标那一行每轮都带。
