/**
 * 中文一句話解析：日期（純函式）
 * 今天／昨天／前天、3 天前、上週五、10/25、10月25日、25號（未來的日期往前推一年／一個月）。
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

interface DateRule { re: RegExp; fn: (m: RegExpMatchArray, today: DateKey) => DateKey | null }
const DATE_RULES: DateRule[] = [
  { re: /(\d{4})\s*[/\-.年]\s*(\d{1,2})\s*[/\-.月]\s*(\d{1,2})\s*[日號号]?/, fn: (m) => ymd(+m[1], +m[2], +m[3]) },
  { re: /(\d{1,2})\s*月\s*(\d{1,2})\s*[日號号]?/, fn: (m, t) => pastMonthDay(t, +m[1], +m[2]) },
  { re: /([一二三四五六七八九十]{1,3})月([一二三四五六七八九十]{1,3})[日號号]/, fn: (m, t) => pastMonthDay(t, cnInt(m[1]), cnInt(m[2])) },
  { re: /(?<![\d.$])(\d{1,2})\/(\d{1,2})(?![\d/])/, fn: (m, t) => pastMonthDay(t, +m[1], +m[2]) },
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
      return ymd(Number(prev.slice(0, 4)), Number(prev.slice(5, 7)), d);
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
