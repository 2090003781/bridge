// 注入的节奏：每几轮带一次、一共带几次。
//
// 注入的正文每轮都会跟着系统提示词重发，所以两件事决定它吃多少上下文：
//   every —— 每几轮带一次（1 = 每次都带）
//   times —— 一共带几次（0 = 不限期，直到手动清除）
// 「第几轮」由会话的投递计数决定：注入那一刻的下一轮算第一轮。

const LIMIT = 99;

export function normalizeEvery(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(LIMIT, Math.floor(n));
}

export function normalizeTimes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(LIMIT, Math.floor(n));
}

/** 这一轮该不该把它带上 */
export function isDue({ every = 1, times = 0, used = 0, startRound = 0, round = 0 } = {}) {
  if (normalizeTimes(times) > 0 && Number(used) >= normalizeTimes(times)) return false;
  const since = Number(round) - Number(startRound);
  if (!Number.isFinite(since) || since < 0) return false;
  return since % normalizeEvery(every) === 0;
}

/** 「每 3 轮带一次，共 4 次」这种人话，界面和日志共用 */
export function describeCadence({ every = 1, times = 0 } = {}) {
  const e = normalizeEvery(every);
  const t = normalizeTimes(times);
  const everyText = e === 1 ? '每轮都带' : '每 ' + e + ' 轮带一次';
  const timesText = t === 0 ? '不限次数' : '共 ' + t + ' 次';
  return everyText + '，' + timesText;
}
