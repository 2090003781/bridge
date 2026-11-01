'use strict';
// Bridge · 操作注册表
// 每个操作 = 一个入口：id / tier（read|write|trust）/ summary / run(ctx)
// run 只通过注入的 obsidian（真实 app 或 fake）碰 Obsidian，便于脱离 Obsidian 测试。

function opError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function activeEditor(obsidian) {
  const ws = obsidian && obsidian.workspace;
  if (!ws) return null;
  const leaf = ws.activeLeaf;
  const view = leaf && leaf.view;
  if (!view || !view.editor) return null;
  return { view, editor: view.editor, file: view.file || null };
}

function requireEditor(ctx) {
  const active = activeEditor(ctx.obsidian);
  if (!active) throw opError('no-active-editor', '没有打开的 Markdown 编辑器（先在 Obsidian 里打开一篇笔记）');
  return active;
}

const OPS = [
  {
    id: 'core.health',
    tier: 'read',
    summary: 'Bridge 自身健康信息（版本 / 运行时长 / Obsidian 是否在）',
    run(ctx) {
      return {
        service: 'obsidian-bridge',
        version: '0.1.0',
        now: new Date().toISOString(),
        obsidian: Boolean(ctx.obsidian && ctx.obsidian.commands),
        commandCount: ctx.obsidian && ctx.obsidian.commands ? (ctx.obsidian.commands.listCommands() || []).length : 0,
      };
    },
  },
  {
    id: 'obsidian.command.list',
    tier: 'read',
    summary: '列出 Obsidian 命令面板里的全部命令（id / 名称 / 快捷键）',
    run(ctx) {
      const list = ctx.obsidian.commands.listCommands() || [];
      return {
        commands: list.map((c) => ({
          id: c.id,
          name: c.name,
          hotkeys: Array.isArray(c.hotkeys) ? c.hotkeys : [],
        })),
      };
    },
  },
  {
    id: 'obsidian.command.execute',
    tier: 'write',
    summary: '执行命令面板里的任意命令（按 id）；返回是否真的执行了',
    run(ctx) {
      const id = String((ctx.args && ctx.args.id) || '').trim();
      if (!id) throw opError('bad-args', '缺少参数 id');
      const commands = ctx.obsidian.commands;
      let found = null;
      if (typeof commands.findCommand === 'function') {
        found = commands.findCommand(id);
        if (!found) return { executed: false, reason: 'command-not-found', id };
      }
      const executed = commands.executeCommandById(id) === true;
      return {
        executed,
        reason: executed ? null : 'not-runnable',
        id,
        name: found ? found.name : null,
      };
    },
  },
  {
    id: 'obsidian.editor.state',
    tier: 'read',
    summary: '当前活跃编辑器的状态：路径 / 光标 / 选区 / 行数',
    run(ctx) {
      const active = activeEditor(ctx.obsidian);
      if (!active) return { available: false, reason: 'no-active-editor' };
      const ed = active.editor;
      const cursor = typeof ed.getCursor === 'function' ? ed.getCursor() : null;
      const selected = typeof ed.getSelection === 'function' ? ed.getSelection() : '';
      let from = null;
      let to = null;
      if (selected && typeof ed.listSelections === 'function') {
        const first = ed.listSelections()[0];
        if (first) {
          from = first.anchor || null;
          to = first.head || null;
        }
      }
      return {
        available: true,
        path: active.file ? active.file.path : null,
        mode: active.view.getMode ? active.view.getMode() : null,
        cursor,
        selection: selected
          ? { text: selected.length > 2000 ? `${selected.slice(0, 2000)}…` : selected, length: selected.length, from, to }
          : null,
        lineCount: typeof ed.lineCount === 'function' ? ed.lineCount() : null,
      };
    },
  },
  {
    id: 'obsidian.editor.insert',
    tier: 'write',
    summary: '在光标处插入文本（position=end 则追加到文末）；保留撤销栈',
    run(ctx) {
      const active = requireEditor(ctx);
      const text = ctx.args && ctx.args.text;
      if (typeof text !== 'string' || text.length === 0) throw opError('bad-args', '缺少 text');
      const ed = active.editor;
      const position = ctx.args.position === 'end' ? 'end' : 'cursor';

      if (position === 'end' && typeof ed.setCursor === 'function' && typeof ed.getLine === 'function') {
        const last = typeof ed.lastLine === 'function' ? ed.lastLine() : Math.max(0, (ed.lineCount() || 1) - 1);
        ed.setCursor({ line: last, ch: String(ed.getLine(last) || '').length });
      }

      if (typeof ed.replaceSelection === 'function') {
        ed.replaceSelection(text);
      } else if (typeof ed.setValue === 'function' && typeof ed.getValue === 'function') {
        ed.setValue(`${ed.getValue()}${text}`);
      } else {
        throw opError('unsupported', '当前编辑器不支持插入');
      }

      return {
        inserted: true,
        position,
        cursor: typeof ed.getCursor === 'function' ? ed.getCursor() : null,
      };
    },
  },
  {
    id: 'obsidian.editor.replace',
    tier: 'write',
    summary: '替换选中内容；给了 from/to 就先选中那个范围再替换',
    run(ctx) {
      const active = requireEditor(ctx);
      const text = ctx.args && ctx.args.text;
      if (typeof text !== 'string') throw opError('bad-args', '缺少 text');
      const ed = active.editor;
      const from = ctx.args.from;
      const to = ctx.args.to;
      const hadRange = Boolean(from && to && typeof ed.setSelection === 'function');
      if (hadRange) ed.setSelection(from, to);
      if (typeof ed.replaceSelection !== 'function') throw opError('unsupported', '当前编辑器不支持替换');
      ed.replaceSelection(text);
      return { replaced: true, hadRange, target: hadRange ? { from, to } : 'selection' };
    },
  },
  {
    id: 'obsidian.editor.cursor',
    tier: 'write',
    summary: '把光标移到指定行/列，并滚动到可见位置',
    run(ctx) {
      const active = requireEditor(ctx);
      const line = Number(ctx.args && ctx.args.line);
      if (!Number.isInteger(line) || line < 0) throw opError('bad-args', '缺少合法的 line（0 起）');
      const ch = Number.isInteger(ctx.args.ch) && ctx.args.ch >= 0 ? ctx.args.ch : 0;
      const ed = active.editor;
      if (typeof ed.setCursor !== 'function') throw opError('unsupported', '当前编辑器不支持定位');
      ed.setCursor({ line, ch });
      if (typeof ed.scrollIntoView === 'function') {
        ed.scrollIntoView({ from: { line, ch }, to: { line, ch } }, true);
      }
      return { cursor: { line, ch } };
    },
  },
  {
    id: 'obsidian.workspace.state',
    tier: 'read',
    summary: '工作区快照：活跃文件 + 所有打开的标签（类型 / 路径 / 模式）',
    run(ctx) {
      const ws = ctx.obsidian.workspace;
      const leaves = [];
      if (ws && typeof ws.iterateAllLeaves === 'function') {
        ws.iterateAllLeaves((leaf) => {
          const view = (leaf && leaf.view) || {};
          leaves.push({
            id: leaf.id || null,
            type: view.getViewType ? view.getViewType() : null,
            path: view.file && view.file.path ? view.file.path : null,
            mode: view.getMode ? view.getMode() : null,
            active: leaf === ws.activeLeaf,
          });
        });
      }
      const activeFile = ws && ws.getActiveFile ? ws.getActiveFile() : null;
      return {
        activePath: activeFile && activeFile.path ? activeFile.path : null,
        leaves,
        count: leaves.length,
      };
    },
  },
  {
    id: 'obsidian.workspace.open',
    tier: 'write',
    summary: '在工作区打开一篇笔记（可新标签 / 分屏 / 指定源码或阅读模式）',
    async run(ctx) {
      const path = String((ctx.args && ctx.args.path) || '').trim();
      if (!path) throw opError('bad-args', '缺少 path');
      const vault = ctx.obsidian.vault;
      const file = vault && vault.getAbstractFileByPath ? vault.getAbstractFileByPath(path) : null;
      if (!file) throw opError('file-not-found', `找不到笔记：${path}`);
      const ws = ctx.obsidian.workspace;
      if (!ws || typeof ws.getLeaf !== 'function') throw opError('unsupported', '当前工作区不支持打开');

      const kind = ctx.args.split ? 'split' : ctx.args.newLeaf ? 'tab' : false;
      const leaf = ws.getLeaf(kind);
      const openOpts = ctx.args.mode ? { state: { mode: ctx.args.mode } } : undefined;
      await leaf.openFile(file, openOpts);
      if (typeof ws.revealLeaf === 'function' && ctx.args.reveal !== false) ws.revealLeaf(leaf);

      return { opened: true, path, mode: ctx.args.mode || null, newLeaf: Boolean(kind) };
    },
  },
  {
    id: 'obsidian.note.read',
    tier: 'read',
    summary: '按库内路径读正文（走 Obsidian 缓存读取；可 maxChars 截断）',
    async run(ctx) {
      const file = resolveFile(ctx, ctx.args && ctx.args.path);
      const text = await readText(ctx, file);
      const maxChars = Number.isInteger(ctx.args.maxChars) && ctx.args.maxChars > 0 ? ctx.args.maxChars : 0;
      const truncated = maxChars > 0 && text.length > maxChars;
      return {
        path: file.path,
        text: truncated ? text.slice(0, maxChars) : text,
        length: text.length,
        truncated,
      };
    },
  },
  {
    id: 'obsidian.note.meta',
    tier: 'read',
    summary: '笔记元数据：frontmatter / 标签 / 出链 / 嵌入 / 标题 / 反链来源（走 Obsidian 缓存）',
    run(ctx) {
      const file = resolveFile(ctx, ctx.args && ctx.args.path);
      const cache = fileCache(ctx, file);
      const tags = (Array.isArray(cache.tags) ? cache.tags : [])
        .map((t) => (t && t.tag) || null)
        .filter(Boolean);
      const links = (Array.isArray(cache.links) ? cache.links : []).map((l) => ({
        link: l.link,
        original: l.original,
      }));
      const embeds = (Array.isArray(cache.embeds) ? cache.embeds : []).map((e) => e.link);
      const headings = (Array.isArray(cache.headings) ? cache.headings : []).map((h) => ({
        heading: h.heading,
        level: h.level,
        line: h.position && h.position.start ? h.position.start.line : null,
      }));
      const backlinks = backlinkEntries(ctx, file).map(([p]) => p).sort();
      return {
        path: file.path,
        frontmatter: cache.frontmatter || null,
        tags,
        links,
        embeds,
        headings,
        backlinks,
        stat: {
          mtime: file.stat && file.stat.mtime ? file.stat.mtime : null,
          size: file.stat && file.stat.size ? file.stat.size : null,
        },
      };
    },
  },
  {
    id: 'obsidian.note.backlinks',
    tier: 'read',
    summary: '反链：谁引用了这一篇（含未解析引用），带次数与出链对照',
    run(ctx) {
      const file = resolveFile(ctx, ctx.args && ctx.args.path);
      const cache = fileCache(ctx, file);
      const outgoing = (Array.isArray(cache.links) ? cache.links : []).map((l) => l.link);
      const backlinks = backlinkEntries(ctx, file)
        .map(([path, refs]) => ({ path, count: Array.isArray(refs) ? refs.length : 0 }))
        .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
      return { path: file.path, outgoing, backlinks, backlinkCount: backlinks.length };
    },
  },

  {
    id: 'obsidian.note.create',
    tier: 'write',
    summary: '新建笔记（默认 .md；已存在则拒绝覆盖）',
    async run(ctx) {
      const path = normalizeNotePath(ctx.args && ctx.args.path);
      if (!path) throw opError('bad-args', '缺少合法的 path（不允许 .. 跳出库）');
      const vault = ctx.obsidian.vault;
      if (vault.getAbstractFileByPath(path)) throw opError('file-exists', `已存在：${path}`);
      const content = typeof ctx.args.content === 'string' ? ctx.args.content : '';
      await ensureParentFolders(vault, path);
      const file = await vault.create(path, content);
      return { created: true, path: file && file.path ? file.path : path, length: content.length };
    },
  },
  {
    id: 'obsidian.note.append',
    tier: 'write',
    summary: '在笔记末尾追加一段（不动原有内容）',
    async run(ctx) {
      // 先验参数再看文件：参数错了就该报参数错，不能因为路径也不存在而报成「文件不存在」。
      const text = typeof (ctx.args && ctx.args.text) === 'string' ? ctx.args.text : '';
      if (!text) throw opError('bad-args', '缺少 text');
      const file = resolveFile(ctx, ctx.args && ctx.args.path);
      const vault = ctx.obsidian.vault;
      if (typeof vault.append !== 'function') throw opError('unsupported', '当前库不支持追加');
      await vault.append(file, text);
      return { appended: true, path: file.path, added: text.length };
    },
  },
  {
    id: 'obsidian.note.property',
    tier: 'write',
    summary: '改 frontmatter 属性：set 合并 / del 删除（走 processFrontMatter，类型安全）',
    async run(ctx) {
      const file = resolveFile(ctx, ctx.args && ctx.args.path);
      const set = ctx.args.set && typeof ctx.args.set === 'object' ? ctx.args.set : {};
      const del = Array.isArray(ctx.args.del) ? ctx.args.del.map(String) : [];
      if (!Object.keys(set).length && del.length === 0) throw opError('bad-args', '至少要给 set 或 del');
      // frontmatter 的键来自调用方，__proto__ 这类键写进去会改原型而不是加属性。
      const dangerous = Object.keys(set).filter((key) => PROTOTYPE_KEYS.has(key));
      const dangerousDel = del.filter((key) => PROTOTYPE_KEYS.has(key));
      if (dangerous.length || dangerousDel.length) throw opError('bad-args', `不接受的属性名：${[...dangerous, ...dangerousDel].join(', ')}`);
      const fm = ctx.obsidian.fileManager;
      if (!fm || typeof fm.processFrontMatter !== 'function') throw opError('unsupported', '当前库不支持改属性');
      const before = {};
      const after = {};
      await fm.processFrontMatter(file, (data) => {
        for (const key of Object.keys(set)) {
          before[key] = data[key];
          data[key] = set[key];
          after[key] = data[key];
        }
        for (const key of del) {
          before[key] = data[key];
          delete data[key];
        }
      });
      return { path: file.path, changed: true, set, del, before, after };
    },
  },
  {
    id: 'obsidian.note.rename',
    tier: 'write',
    summary: '改名/移动笔记；默认 dryRun 只报会影响哪些引用，dryRun=false 才真改（Obsidian 自动修链接）',
    async run(ctx) {
      const file = resolveFile(ctx, ctx.args && ctx.args.path);
      const to = normalizeNotePath(ctx.args && ctx.args.to);
      if (!to) throw opError('bad-args', '缺少合法的 to（不允许 .. 跳出库）');
      const references = backlinkEntries(ctx, file).map(([p, refs]) => ({
        path: p,
        count: Array.isArray(refs) ? refs.length : 0,
      }));
      const affected = references.length;
      if (ctx.args.dryRun !== false) {
        return { dryRun: true, from: file.path, to, affected, references };
      }
      const fm = ctx.obsidian.fileManager;
      if (!fm || typeof fm.renameFile !== 'function') throw opError('unsupported', '当前库不支持改名');
      const from = file.path; // Obsidian 会在 renameFile 里就地改 file.path，先记下来
      await fm.renameFile(file, to);
      return { dryRun: false, renamed: true, from, to, affected };
    },
  },
  {
    id: 'obsidian.note.delete',
    tier: 'trust',
    summary: '删除笔记（走系统回收站，可恢复；必须 confirm:true）',
    async run(ctx) {
      if (ctx.args.confirm !== true) throw opError('bad-args', '删除需要 confirm:true');
      const file = resolveFile(ctx, ctx.args && ctx.args.path);
      const fm = ctx.obsidian.fileManager;
      if (fm && typeof fm.trashFile === 'function') {
        await fm.trashFile(file);
      } else if (ctx.obsidian.vault && typeof ctx.obsidian.vault.trash === 'function') {
        await ctx.obsidian.vault.trash(file, true);
      } else {
        throw opError('unsupported', '当前库不支持回收站删除');
      }
      return { deleted: true, path: file.path, recoverable: true };
    },
  },

  {
    id: 'obsidian.workspace.tab',
    tier: 'write',
    summary: '标签控制：activate/close 指定笔记的标签，next/previous 循环切换',
    run(ctx) {
      const ws = ctx.obsidian.workspace;
      const action = String((ctx.args && ctx.args.action) || 'activate');
      if (action === 'next' || action === 'previous' || action === 'prev') {
        const cmd = action === 'next' ? 'workspace:next-tab' : 'workspace:previous-tab';
        const executed = ctx.obsidian.commands.executeCommandById(cmd) === true;
        return { action, executed };
      }
      const path = String((ctx.args && ctx.args.path) || '').trim();
      if (!path) throw opError('bad-args', '缺少 path');
      const leaf = findLeafByPath(ws, path);
      if (!leaf) throw opError('leaf-not-found', `没有打开的标签：${path}`);
      if (action === 'activate') {
        if (typeof ws.setActiveLeaf !== 'function') throw opError('unsupported', '当前工作区不支持激活');
        ws.setActiveLeaf(leaf, { focus: ctx.args.focus !== false });
        if (typeof ws.revealLeaf === 'function') ws.revealLeaf(leaf);
        return { action, path, activated: true };
      }
      if (action === 'close') {
        if (typeof leaf.detach !== 'function') throw opError('unsupported', '当前工作区不支持关闭');
        leaf.detach();
        return { action, path, closed: true };
      }
      throw opError('bad-args', `不支持的 action：${action}（activate / close / next / previous）`);
    },
  },
  {
    id: 'obsidian.workspace.view',
    tier: 'write',
    summary: '打开侧栏视图（图谱/反链/大纲/搜索/标签等）；已开则复用',
    async run(ctx) {
      const type = String((ctx.args && ctx.args.type) || '').trim();
      if (!type) throw opError('bad-args', '缺少 type');
      const ws = ctx.obsidian.workspace;
      const existing = typeof ws.getLeavesOfType === 'function' ? ws.getLeavesOfType(type) : [];
      if (existing && existing.length) {
        if (typeof ws.revealLeaf === 'function') ws.revealLeaf(existing[0]);
        if (typeof ws.setActiveLeaf === 'function') ws.setActiveLeaf(existing[0], { focus: true });
        return { type, opened: true, reused: true };
      }
      const side = ctx.args.side === 'left' ? 'left' : 'right';
      const getLeaf = side === 'left' ? ws.getLeftLeaf : ws.getRightLeaf;
      if (typeof getLeaf !== 'function') throw opError('unsupported', '当前工作区不支持侧栏');
      const leaf = getLeaf.call(ws, false);
      if (!leaf || typeof leaf.setViewState !== 'function') throw opError('unsupported', '打不开侧栏视图');
      await leaf.setViewState({ type, active: true });
      if (typeof ws.revealLeaf === 'function') ws.revealLeaf(leaf);
      return { type, opened: true, reused: false, side };
    },
  },
  {
    id: 'obsidian.workspace.layout',
    tier: 'write',
    summary: '布局：get 导出当前布局 JSON；set 应用布局 JSON',
    async run(ctx) {
      const ws = ctx.obsidian.workspace;
      const action = String((ctx.args && ctx.args.action) || 'get');
      if (action === 'get') {
        if (typeof ws.getLayout !== 'function') throw opError('unsupported', '当前工作区不支持导出布局');
        return { layout: ws.getLayout() };
      }
      if (action === 'set') {
        const layout = ctx.args && ctx.args.layout;
        if (!layout || typeof layout !== 'object') throw opError('bad-args', '缺少 layout 对象');
        if (typeof ws.changeLayout !== 'function') throw opError('unsupported', '当前工作区不支持应用布局');
        await ws.changeLayout(layout);
        return { applied: true };
      }
      throw opError('bad-args', `不支持的 action：${action}（get / set）`);
    },
  },

  {
    id: 'obsidian.query',
    tier: 'read',
    summary: '全库结构化查询（目录 / 多标签 / 多属性 / 文件名关键字 / 时间范围），只返回索引信息，不含正文',
    run(ctx) {
      const args = ctx.args || {};
      const files = ctx.obsidian.vault.getMarkdownFiles() || [];
      const folder = normalizeFolder(args.folder);
      const tags = Array.isArray(args.tags) ? args.tags.map(normalizeTag).filter(Boolean) : [];
      const props = Array.isArray(args.props) ? args.props : [];
      const nameWords = Array.isArray(args.nameContains)
        ? args.nameContains.filter(Boolean).map(String)
        : args.nameContains
          ? [String(args.nameContains)]
          : [];
      const after = parseTimeArg(args.mtimeAfter, 'mtimeAfter');
      const before = parseTimeArg(args.mtimeBefore, 'mtimeBefore');
      const limit = clampInt(args.limit, 1, 500, 100);
      const include = new Set(Array.isArray(args.include) ? args.include : ['tags', 'frontmatter', 'headings']);
      const mc = ctx.obsidian.metadataCache;

      const matched = [];
      for (const file of files) {
        const p = String(file.path || '');
        if (folder && !(p === folder || p.startsWith(folder + '/'))) continue;
        const mtime = file.stat && file.stat.mtime ? file.stat.mtime : null;
        if (after !== null && (mtime === null || mtime < after)) continue;
        if (before !== null && (mtime === null || mtime > before)) continue;
        const name = file.basename || p.replace(/^.*\//, '').replace(/\.md$/i, '');
        if (nameWords.length && !nameWords.every((w) => name.includes(w))) continue;

        let cache = {};
        try {
          cache = (mc && mc.getFileCache && mc.getFileCache(file)) || {};
        } catch {
          cache = {};
        }

        if (tags.length) {
          const have = new Set((cache.tags || []).map((t) => normalizeTag(t && t.tag)).filter(Boolean));
          if (!tags.every((t) => have.has(t))) continue;
        }
        if (props.length) {
          const fm = cache.frontmatter || {};
          const ok = props.every((pr) => {
            const key = String((pr && pr.key) || '');
            if (!key || !(key in fm)) return false;
            if (pr.value === undefined) return true;
            return valueMatches(fm[key], pr.value);
          });
          if (!ok) continue;
        }
        matched.push({ file, cache, name, mtime });
      }

      const items = matched.slice(0, limit).map(({ file, cache, name, mtime }) => {
        const item = {
          path: file.path,
          name,
          mtime: mtime ? new Date(mtime).toISOString() : null,
          size: file.stat && file.stat.size ? file.stat.size : null,
        };
        if (include.has('tags')) item.tags = (cache.tags || []).map((t) => (t && t.tag) || '').filter(Boolean);
        if (include.has('frontmatter')) item.frontmatter = cache.frontmatter || null;
        if (include.has('headings')) {
          item.headings = (cache.headings || []).map((h) => ({ heading: h.heading, level: h.level }));
        }
        if (include.has('links')) item.links = (cache.links || []).map((l) => l.link);
        return item;
      });

      return { total: matched.length, returned: items.length, limit, items };
    },
  },
  {
    id: 'obsidian.search',
    tier: 'read',
    summary: '全库关键字搜索：文件名 + 正文（多关键字 AND），返回命中行片段，不返回整篇',
    async run(ctx) {
      const query = String((ctx.args && ctx.args.query) || '').trim();
      const words = query.split(/\s+/).filter(Boolean);
      if (words.length === 0) throw opError('bad-args', '缺少 query');
      const lowerWords = words.map((w) => w.toLowerCase());
      const scope = ctx.args.scope === 'name' ? 'name' : ctx.args.scope === 'content' ? 'content' : 'both';
      const folder = normalizeFolder(ctx.args.folder);
      const limit = clampInt(ctx.args.limit, 1, 200, 50);
      const contextChars = clampInt(ctx.args.contextChars, 20, 400, 80);
      const timeBudget = clampInt(ctx.args.timeBudgetMs, 500, 20000, 6000);

      const files = (ctx.obsidian.vault.getMarkdownFiles() || []).filter((f) => {
        if (!folder) return true;
        const p = String(f.path || '');
        return p === folder || p.startsWith(folder + '/');
      });

      const started = Date.now();
      const results = [];
      const CONCURRENCY = 8;

      for (let i = 0; i < files.length; i += CONCURRENCY) {
        if (Date.now() - started > timeBudget) break;
        const batch = files.slice(i, i + CONCURRENCY);
        const found = await Promise.all(
          batch.map(async (file) => {
            const name = file.basename || String(file.path || '').replace(/^.*\//, '').replace(/\.md$/i, '');
            const lowerName = name.toLowerCase();
            const nameHit = lowerWords.every((w) => lowerName.includes(w));
            if (scope === 'name') return nameHit ? { path: file.path, name, score: 2, matches: [] } : null;
            if (scope === 'both' && nameHit) return { path: file.path, name, score: 3, matches: [] };

            let text = '';
            try {
              text = await readText(ctx, file);
            } catch {
              return null;
            }
            const lower = text.toLowerCase();
            if (!lowerWords.every((w) => lower.includes(w))) return null;

            const matches = [];
            const lines = text.split('\n');
            for (let li = 0; li < lines.length && matches.length < 3; li += 1) {
              const line = lines[li];
              const low = line.toLowerCase();
              if (lowerWords.every((w) => low.includes(w))) {
                matches.push({ line: li + 1, snippet: line.trim().slice(0, contextChars) });
              }
            }
            if (matches.length === 0) {
              const idx = lower.indexOf(lowerWords[0]);
              const lineNo = text.slice(0, Math.max(0, idx)).split('\n').length;
              matches.push({
                line: lineNo,
                snippet: text.slice(Math.max(0, idx - 20), idx + contextChars).replace(/\s+/g, ' ').trim(),
              });
            }
            return { path: file.path, name, score: nameHit ? 3 : 1, matches };
          }),
        );
        for (const item of found) if (item) results.push(item);
        if (results.length >= limit * 3) break;
      }

      results.sort((a, b) => b.score - a.score || String(a.path).localeCompare(String(b.path)));
      const items = results.slice(0, limit);
      return {
        total: results.length,
        returned: items.length,
        limit,
        query: words,
        scope,
        elapsedMs: Date.now() - started,
        items,
      };
    },
  },
];


const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// 时间参数：给了但解析不出来就是参数错，不许悄悄当成“没给”而返回全库。
function parseTimeArg(value, name) {
  if (value === undefined || value === null || value === '') return null;
  const ms = Date.parse(String(value));
  if (!Number.isFinite(ms)) throw opError('bad-args', `${name} 不是合法时间：${value}`);
  return ms;
}

// 真实的 vault.create 不会替你建父目录，缺目录时直接抛 ENOENT。
// 所以建笔记前把缺的层级逐级补上；createFolder 撞已存在就跳过（并发下正常）。
async function ensureParentFolders(vault, path) {
  const parts = String(path).split('/').slice(0, -1);
  if (!parts.length) return;
  if (typeof vault.createFolder !== 'function') return;
  let cur = '';
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    if (vault.getAbstractFileByPath(cur)) continue;
    try {
      await vault.createFolder(cur);
    } catch (err) {
      if (!vault.getAbstractFileByPath(cur)) throw err;
    }
  }
}

function resolveFile(ctx, path) {
  const p = String(path || '').trim();
  if (!p) throw opError('bad-args', '缺少 path');
  const vault = ctx.obsidian && ctx.obsidian.vault;
  const file = vault && vault.getAbstractFileByPath ? vault.getAbstractFileByPath(p) : null;
  if (!file) throw opError('file-not-found', `找不到笔记：${p}`);
  return file;
}

async function readText(ctx, file) {
  const vault = ctx.obsidian && ctx.obsidian.vault;
  const reader = vault && (vault.cachedRead || vault.read);
  if (typeof reader !== 'function') return '';
  const text = await reader.call(vault, file);
  return typeof text === 'string' ? text : '';
}

function fileCache(ctx, file) {
  const mc = ctx.obsidian && ctx.obsidian.metadataCache;
  try {
    return (mc && mc.getFileCache && mc.getFileCache(file)) || {};
  } catch {
    return {};
  }
}

function backlinkEntries(ctx, file) {
  // Obsidian 不同版本返回 Record 或 Map，统一成 [path, refs][]。
  const mc = ctx.obsidian && ctx.obsidian.metadataCache;
  try {
    const res = mc && mc.getBacklinksForFile ? mc.getBacklinksForFile(file) : null;
    const data = res && res.data;
    if (!data) return [];
    if (typeof data.entries === 'function') {
      return Array.from(data.entries()).map(([p, refs]) => [p, Array.isArray(refs) ? refs : []]);
    }
    return Object.entries(data).map(([p, refs]) => [p, Array.isArray(refs) ? refs : []]);
  } catch {
    return [];
  }
}


function normalizeNotePath(raw) {
  let p = String(raw || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!p || p.includes('..') || p.startsWith('.')) return null;
  if (!/\.[a-z0-9]+$/i.test(p)) p += '.md';
  return p;
}


function findLeafByPath(ws, path) {
  let found = null;
  if (!ws || typeof ws.iterateAllLeaves !== 'function') return null;
  ws.iterateAllLeaves((leaf) => {
    if (found) return;
    const view = leaf && leaf.view;
    const p = view && view.file && view.file.path;
    if (p && p === path) found = leaf;
  });
  return found;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeFolder(value) {
  return String(value || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

function normalizeTag(value) {
  return String(value || '').trim().replace(/^#/, '').toLowerCase();
}

function valueMatches(actual, expected) {
  if (Array.isArray(actual)) return actual.some((x) => valueMatches(x, expected));
  if (actual === expected) return true;
  return String(actual).toLowerCase() === String(expected).toLowerCase();
}
function createRegistry(deps) {
  const byId = new Map(OPS.map((op) => [op.id, op]));

  return {
    list() {
      return OPS.map(({ id, tier, summary }) => ({ id, tier, summary }));
    },
    get(opId) {
      return byId.get(opId) || null;
    },
    async call(opId, args, callCtx = {}) {
      const op = byId.get(opId);
      if (!op) {
        return { ok: false, error: { code: 'unknown-op', message: `未知操作：${opId}` } };
      }
      try {
        const data = await op.run({ ...deps, args: args || {}, ...callCtx });
        return { ok: true, data: data === undefined ? null : data };
      } catch (err) {
        return {
          ok: false,
          error: { code: err.code || 'op-failed', message: String((err && err.message) || err) },
        };
      }
    },
  };
}

module.exports = { createRegistry, OPS };