/**
 * 期間計算：本地日期鍵、記帳月（自訂起算日）、週（自訂起始日）、月曆網格。
 * 所有日期鍵皆為本地時區的 'YYYY-MM-DD' 字串，可直接字串比較大小。
 */

export type DateKey = string;

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function toDateKey(d: Date): DateKey {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function fromDateKey(key: DateKey): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function todayKey(): DateKey {
  return toDateKey(new Date());
}

export function addDays(key: DateKey, n: number): DateKey {
  const d = fromDateKey(key);
  d.setDate(d.getDate() + n);
  return toDateKey(d);
}

export function daysInMonth(year: number, month0: number): number {
  return new Date(year, month0 + 1, 0).getDate();
}

/** 加 n 個月，日期超過該月天數時夾到月底（1/31 + 1 月 = 2/28 或 2/29） */
export function addMonths(key: DateKey, n: number): DateKey {
  const d = fromDateKey(key);
  const day = d.getDate();
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  target.setDate(Math.min(day, daysInMonth(target.getFullYear(), target.getMonth())));
  return toDateKey(target);
}

export interface Range {
  start: DateKey; // 含
  end: DateKey; // 含
}

/** 某年某月以 startDay 起算的記帳月：例 startDay=5 → 10/05 ~ 11/04 */
function cycleStart(year: number, month0: number, startDay: number): DateKey {
  const day = Math.min(startDay, daysInMonth(year, month0));
  return toDateKey(new Date(year, month0, day));
}

/** 取得包含 key 的記帳月區間 */
export function accountingMonth(key: DateKey, startDay = 1): Range {
  const d = fromDateKey(key);
  let y = d.getFullYear();
  let m = d.getMonth();
  let start = cycleStart(y, m, startDay);
  if (key < start) {
    m -= 1;
    if (m < 0) { m = 11; y -= 1; }
    start = cycleStart(y, m, startDay);
  }
  const nm = m === 11 ? 0 : m + 1;
  const ny = m === 11 ? y + 1 : y;
  const end = addDays(cycleStart(ny, nm, startDay), -1);
  return { start, end };
}

/** 包含 key 的週（weekStart：0=週日、1=週一） */
export function weekRange(key: DateKey, weekStart = 0): Range {
  const d = fromDateKey(key);
  const diff = (d.getDay() - weekStart + 7) % 7;
  const start = addDays(key, -diff);
  return { start, end: addDays(start, 6) };
}

export function yearRange(key: DateKey): Range {
  const y = key.slice(0, 4);
  return { start: `${y}-01-01`, end: `${y}-12-31` };
}

export type PeriodUnit = 'day' | 'week' | 'month' | 'year';

export function periodRange(key: DateKey, unit: PeriodUnit, opts: { monthStartDay?: number; weekStart?: number } = {}): Range {
  switch (unit) {
    case 'day': return { start: key, end: key };
    case 'week': return weekRange(key, opts.weekStart ?? 0);
    case 'month': return accountingMonth(key, opts.monthStartDay ?? 1);
    case 'year': return yearRange(key);
  }
}

/** 往前／往後移動一個期間，回傳新期間內的代表日 */
export function shiftPeriod(key: DateKey, unit: PeriodUnit, n: number): DateKey {
  switch (unit) {
    case 'day': return addDays(key, n);
    case 'week': return addDays(key, 7 * n);
    case 'month': return addMonths(key, n);
    case 'year': return addMonths(key, 12 * n);
  }
}

export interface CalendarCell {
  key: DateKey;
  day: number;
  inMonth: boolean;
  weekday: number;
}

/** 自然月月曆網格，固定 6 列 × 7 欄（42 格），含上下月補位 */
export function monthGrid(year: number, month0: number, weekStart = 0): CalendarCell[] {
  const first = new Date(year, month0, 1);
  const lead = (first.getDay() - weekStart + 7) % 7;
  const startKey = addDays(toDateKey(first), -lead);
  const cells: CalendarCell[] = [];
  for (let i = 0; i < 42; i++) {
    const key = addDays(startKey, i);
    const d = fromDateKey(key);
    cells.push({ key, day: d.getDate(), inMonth: d.getMonth() === month0, weekday: d.getDay() });
  }
  return cells;
}

/** 列出區間內所有日期鍵 */
export function eachDay(range: Range): DateKey[] {
  const out: DateKey[] = [];
  for (let k = range.start; k <= range.end; k = addDays(k, 1)) out.push(k);
  return out;
}
