/**
 * 中文一句話解析：日期（純函式）
 * 今天／昨天／前天、3 天前、上週五、10/25、10月25日、25號（未來的日期往前推一年／一個月）。
 * 未來的說法（排程用）：明天、後天、大後天、3 天後、下週二、下個月 5 號、月底（這個月／下個月）。
 */
import { addDays, addMonths, daysInMonth, fromDateKey, pad2, type DateKey } from './period';
import { parseCnNumber, toHalfWidth } from './nlp-amount';

const WEEKDAY: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 0 };
const cnInt = (s: string) => parseCnNumber(s) ?? NaN;
/** 週一為一週開始時，某天所在週的週一 */
export const mondayOf = (d: DateKey) => addDays(d, -((fromDateKey(d).getDay() + 6) % 7));

function ymd(y: number, m: number, d: number): DateKey | null {
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= daysInMonth(y, m - 1))) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** 沒寫年份的日期：比今天晚就當成去年 */
function pastMonthDay(today: DateKey, m: number, d: number): DateKey | null {
  const y = Number(today.slice(0, 4));
  const k = ymd(y, m, d);
  if (!k) return null;
  return k > today ? ymd(y - 1, m, d) : k;
}

/** 某個月（取該月 1 號當參考）的第 d 天；超過該月天數就取月底 */
function monthDay(ref: DateKey, d: number): DateKey | null {
  const y = Number(ref.slice(0, 4)), m = Number(ref.slice(5, 7));
  if (d < 1 || d > 31) return null;
  return ymd(y, m, Math.min(d, daysInMonth(y, m - 1)));
}
const monthEnd = (ref: DateKey): DateKey => monthDay(ref, 31)!;

interface DateRule { re: RegExp; fn: (m: RegExpMatchArray, today: DateKey) => DateKey | null }
const DATE_RULES: DateRule[] = [
  { re: /(\d{4})\s*[/\-.年]\s*(\d{1,2})\s*[/\-.月]\s*(\d{1,2})\s*[日號号]?/, fn: (m) => ymd(+m[1], +m[2], +m[3]) },
  { re: /(?:明|下)年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日號号]?/, fn: (m, t) => ymd(Number(t.slice(0, 4)) + 1, +m[1], +m[2]) },
  { re: /後年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日號号]?/, fn: (m, t) => ymd(Number(t.slice(0, 4)) + 2, +m[1], +m[2]) },
  { re: /(?:去|上)年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日號号]?/, fn: (m, t) => ymd(Number(t.slice(0, 4)) - 1, +m[1], +m[2]) },
  { re: /前年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日號号]?/, fn: (m, t) => ymd(Number(t.slice(0, 4)) - 2, +m[1], +m[2]) },
  { re: /(\d{1,2})\s*月\s*(\d{1,2})\s*[日號号]?/, fn: (m, t) => pastMonthDay(t, +m[1], +m[2]) },
  { re: /([一二三四五六七八九十]{1,3})月([一二三四五六七八九十]{1,3})[日號号]/, fn: (m, t) => pastMonthDay(t, cnInt(m[1]), cnInt(m[2])) },
  { re: /(?<![\d.$])(\d{1,2})\/(\d{1,2})(?![\d/])/, fn: (m, t) => pastMonthDay(t, +m[1], +m[2]) },
  // 未來的說法（單次排程）：要放在「N 號」「N 天前」這些規則前面，否則會被當成過去
  { re: /大[後后]天/, fn: (_, t) => addDays(t, 3) },
  { re: /(?<!大)[後后]天/, fn: (_, t) => addDays(t, 2) },
  { re: /(\d{1,2}|[一二兩三四五六七八九十]{1,3})\s*天[後后]/, fn: (m, t) => addDays(t, cnInt(m[1])) },
  { re: /(\d{1,2}|[一二兩三四五六七八九十]{1,3})\s*(?:個)?(?:週|周|星期|禮拜)[後后]/, fn: (m, t) => addDays(t, 7 * cnInt(m[1])) },
  { re: /下\s*個?\s*月\s*(\d{1,2})\s*[號号日]/, fn: (m, t) => monthDay(addMonths(`${t.slice(0, 8)}01`, 1), +m[1]) },
  { re: /下\s*個?\s*月\s*(?:底|末)/, fn: (_, t) => monthEnd(addMonths(`${t.slice(0, 8)}01`, 1)) },
  { re: /下\s*個?\s*月(?!\d|[號号日底末])/, fn: (_, t) => monthDay(addMonths(`${t.slice(0, 8)}01`, 1), Number(t.slice(8, 10))) },
  { re: /上\s*個?\s*月(?!\d|[號号日底末])/, fn: (_, t) => monthDay(addMonths(`${t.slice(0, 8)}01`, -1), Number(t.slice(8, 10))) },
  { re: /(?:這|本)\s*個?\s*月\s*(?:底|末)|月底|月末/, fn: (_, t) => monthEnd(t) },
  { re: /大前天/, fn: (_, t) => addDays(t, -3) },
  { re: /前天/, fn: (_, t) => addDays(t, -2) },
  { re: /昨天|昨日|昨晚|昨夜/, fn: (_, t) => addDays(t, -1) },
  { re: /今天|今日|今晚|今早|剛剛|剛才/, fn: (_, t) => t },
  { re: /明天/, fn: (_, t) => addDays(t, 1) },
  { re: /(\d{1,2}|[一二兩三四五六七八九十]{1,3})\s*天前/, fn: (m, t) => addDays(t, -cnInt(m[1])) },
  {
    re: /(上上|上|這|这|本|下)?\s*(?:個)?(?:週|周|星期|禮拜|礼拜)([一二三四五六日天1-7])/,
    fn: (m, t) => {
      const wd = WEEKDAY[m[2]];
      const idx = (wd + 6) % 7; // 週一 = 0
      const mon = mondayOf(t);
      const shift = { 上上: -14, 上: -7, 這: 0, 这: 0, 本: 0, 下: 7 }[m[1] ?? ''] ?? null;
      if (shift !== null) return addDays(mon, shift + idx);
      const d = addDays(mon, idx);
      return d > t ? addDays(d, -7) : d;
    },
  },
  {
    re: /(?<![\d月/])(\d{1,2})\s*[號号日](?![\d元塊])/,
    fn: (m, t) => {
      const d = +m[1];
      const k = ymd(Number(t.slice(0, 4)), Number(t.slice(5, 7)), d);
      if (k && k <= t) return k;
      const prev = addMonths(t.slice(0, 8) + '01', -1);
      return monthDay(prev, d);
    },
  },
];

/** 取出文字中的日期，並把日期字樣從文字中移除 */
export function extractDate(text: string, today: DateKey): { date?: DateKey; rest: string } {
  const s = toHalfWidth(text);
  for (const r of DATE_RULES) {
    const m = s.match(r.re);
    if (!m) continue;
    const d = r.fn(m, today);
    if (!d) continue;
    return { date: d, rest: (s.slice(0, m.index) + ' ' + s.slice(m.index! + m[0].length)).trim() };
  }
  return { rest: s };
}

const PERIOD_OFFSET: Record<string, (h: number) => number> = {
  凌晨: (h) => (h === 12 ? 0 : h), 清晨: (h) => h, 早上: (h) => h, 早晨: (h) => h, 上午: (h) => h, 早: (h) => h,
  中午: (h) => (h < 11 ? h + 12 : h), 下午: (h) => (h < 12 ? h + 12 : h), 傍晚: (h) => (h < 12 ? h + 12 : h), 晚上: (h) => (h < 12 ? h + 12 : h === 12 ? 0 : h), 晚: (h) => (h < 12 ? h + 12 : h),
};
const hhmm = (h: number, m: number) => (h >= 0 && h <= 24 && m >= 0 && m < 60 ? `${pad2(h === 24 ? 0 : h)}:${pad2(m)}` : null);

/**
 * 取出文字中的時間（排程用），並把時間字樣從文字中移除。
 * 只認明確的說法，避免把品項裡的「點」當成時間：15:30、下午三點半、晚上 8 點、3 點 10 分、早上七點整。
 * 單獨的「3 點」（沒有上午下午、沒有半或分）不算。
 */
export function extractClock(text: string): { time?: string; rest: string } {
  const s = toHalfWidth(text);
  const cut = (m: RegExpMatchArray) => (s.slice(0, m.index) + ' ' + s.slice(m.index! + m[0].length)).trim();
  let m = s.match(/(?<![\d:])([01]?\d|2[0-4]):([0-5]\d)(?![\d:])/);
  if (m) { const t = hhmm(+m[1], +m[2]); if (t) return { time: t, rest: cut(m) }; }
  m = s.match(/(凌晨|清晨|早上|早晨|上午|中午|下午|傍晚|晚上|早|晚)?\s*(\d{1,2}|[一二兩三四五六七八九十]{1,3})\s*[點点時时]\s*(半|整|(\d{1,2}|[一二三四五六七八九十]{1,3})\s*分?)?/);
  if (m) {
    const h0 = cnInt(m[2]);
    const minute = m[3] === '半' ? 30 : m[3] && m[3] !== '整' ? cnInt(m[4] ?? '') : 0;
    const explicit = !!m[1] || !!m[3];
    if (explicit && Number.isFinite(h0) && Number.isFinite(minute)) {
      const t = hhmm(m[1] ? PERIOD_OFFSET[m[1]](h0) : h0, minute);
      if (t) return { time: t, rest: cut(m) };
    }
  }
  return { rest: s };
}
