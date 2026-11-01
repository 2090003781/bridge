# Changelog

## 0.2.0 — 2026-10-31

**安全与正确性**
- 请求入口全部兜底：畸形请求行（如 `GET //`）回 400，不再把 Obsidian 渲染进程里的服务打挂
- 客户端身份只认 `x-bridge-client` 请求头：body 里写 `client` 不再能把 403 变成放行
- 业务错误映射到可分辨的状态码：400 / 401 / 403 / 404 / 409 / 501，真内部错误才是 500
- token 有生命周期：设置页可选 永久 / 30 天 / 7 天 / 1 天 / 1 小时；剩余不足一成时自动轮换并写 `info.json`，切换不重启服务
- 默认档位从 `write` 收到 `read`：没配过的调用方一上来只有只读
- 账本脱敏：`content` / `text` / `body` 这类参数只记长度
- `note.property` 拒绝 `__proto__` / `constructor` / `prototype` 键
- `note.query` 的时间参数不再静默返回全库：解析不出来就是 `bad-args`

**功能**
- 注入不再过期（一直挂着，只能手动删），开关收成单一真相源：以连接器为准，本地只当缓存
- 注入支持多篇（上限 10），单篇可删、可一键全清
- `note.create` 自动补建缺失的父目录（真实的 Obsidian 不会替你建）
- `note.append` 先验参数再查文件：缺 `text` 报 `bad-args`，不再误报「文件不存在」

**修复**
- `build.js` 的模块清单改成自动扫描 `src/lib/*.js`：手写清单漏过一个文件，导致 Obsidian 里运行期
  `MODULE_NOT_FOUND` 而单测全绿。现在 build 时自检，漏了直接报错退出
