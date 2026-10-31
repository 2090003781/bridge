// Bridge 连接器 · 当前注入（进系统提示词段，可多篇）。
// 以前还留着一条「按会话排队、pre-step 取走」的老路：那个消费者早就删掉了，
// 队列只进不出，一直注入就等于内存一直涨。所以这里只留真正生效的那一条语义。

export function createInjectionStore({ ttlMs = 0, now = () => Date.now(), maxCurrent = 10 } = {}) {
  let seq = 0;
  let current = [];

  // ttlMs <= 0（或非有限值）= 永不过期：注入一直挂着，只能手动清。
  const expiring = Number.isFinite(ttlMs) && ttlMs > 0;
  const isAlive = (item) => !expiring || now() - item.at <= ttlMs;

  return {
    // 只产出一条记录；要不要生效由调用方 markCurrent 决定。
    add({ sessionId, content, title = null, kind = 'context' } = {}) {
      const sid = String(sessionId || '').trim();
      const text = String(content || '');
      if (!sid || !text.trim()) return null;
      seq += 1;
      return { id: `inj-${seq}`, sessionId: sid, content: text, title, kind, at: now() };
    },

    /** 记为「当前注入」：系统提示词段读它；可多篇，同标题覆盖，超出上限丢最旧。 */
    markCurrent(record) {
      if (!record) return current;
      const idx = current.findIndex((x) => x.title && record.title && x.title === record.title);
      if (idx >= 0) current[idx] = record;
      else current.push(record);
      if (current.length > maxCurrent) current = current.slice(-maxCurrent);
      return current;
    },

    currentItems() {
      if (!expiring) return current;
      current = current.filter(isAlive);
      return current;
    },

    clearCurrent(id) {
      if (id) current = current.filter((x) => x.id !== id);
      else current = [];
    },
  };
}

/** 把注入记录拼成一段文本，供系统提示词段使用。 */
export function renderInjection(records) {
  if (!Array.isArray(records) || records.length === 0) return '';
  const parts = records.map((r) => {
    const head = r.title ? `【${r.title}】` : '【注入】';
    return `${head}\n${r.content}`;
  });
  return [
    '[Bridge 注入] 下面是主人在 Obsidian 里的上下文（不是用户发言，按需使用）：',
    ...parts,
  ].join('\n\n');
}
