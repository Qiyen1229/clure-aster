/**
 * 用問的查帳（純函式）：把「上個月吃飯花多少」「這週咖啡喝了幾次」「今年最大一筆」解析成查詢條件。
 * - 時間：今天／昨天／這週／上週／這個月／上個月／今年／去年／最近 N 天（週、個月）／10月／2025年3月；沒寫預設本月
 * - 類型：收入（薪水、賺、領到）或支出（預設）
 * - 分類：分類名稱或常見說法（吃飯 → 飲食、搭車 → 交通…）；帳戶：帳戶名稱
 * - 問法：多少（加總）、幾次（筆數）、平均（每筆／每天）、最大一筆、花最多的分類、最常去哪
 * - 其他剩下的字當成關鍵字比對備註與商家（「全聯」「咖啡」）
 */
import { findAccounts, findCategory, parseCnNumber, toHalfWidth, type NlpAccount, type NlpCategory } from './nlp';
import { accountingMonth, addDays, addMonths, daysInMonth, pad2, weekRange, yearRange, type DateKey, type Range } from './period';

export type Metric = 'sum' | 'count' | 'avg' | 'avgDaily' | 'max' | 'topCategory' | 'topMerchant';

export interface NlQuery {
  range: Range;
  rangeLabel: string;
  /** 前一個相同長度的期間（比較用） */
  prevRange: Range;
  prevLabel: string;
  kind: 'expense' | 'income';
  categoryIds: string[];
  categoryLabel?: string;
  accountIds: string[];
  keyword?: string;
  metric: Metric;
}

export interface QueryContext {
  today: DateKey;
  weekStart: number;
  monthStartDay: number;
  accounts: NlpAccount[];
  categories: NlpCategory[];
}

const QUESTION_RE = /多少|幾次|幾筆|幾天|幾趟|最多|最少|最大|最貴|最高|哪|平均|總共|一共|花了|花在|賺了|收入|支出|開銷|花費|累計/;

/** 常見說法 → 分類名稱（只有分類存在時才會用） */
const SYNONYMS: [RegExp, string[]][] = [
  [/吃飯|吃的|餐費|伙食|外食|吃東西|三餐/, ['飲食']],
  [/早餐|早飯/, ['早餐']], [/午餐|午飯|中餐/, ['午餐']], [/晚餐|晚飯/, ['晚餐']],
  [/手搖|飲料|喝的/, ['飲料']], [/零食|點心|甜點/, ['點心']], [/買菜|食材/, ['食材']],
  [/搭車|車資|通勤|交通費?/, ['交通']], [/坐計程車|小黃|uber/i, ['計程車']], [/加油|油錢/, ['加油']], [/停車/, ['停車']],
  [/衣服|服飾|穿的/, ['服飾']], [/房租|租金/, ['房租']], [/水電|電費|水費|瓦斯/, ['水電瓦斯']], [/電信|手機費|網路費/, ['網路電信']],
  [/看病|看醫生|醫藥|醫療/, ['醫療']], [/娛樂|玩樂|玩/, ['娛樂']], [/旅遊|旅行|出國/, ['旅遊']], [/網購|蝦皮|momo/i, ['網購']],
  [/保險/, ['保險']], [/寵物|貓|狗/, ['寵物']], [/孝親|給爸媽|給家裡/, ['孝親']], [/學費|上課|課程/, ['教育']],
  [/訂閱|串流/, ['訂閱']], [/日用品/, ['日用品']], [/薪水|薪資|月薪/, ['薪資']], [/獎金|年終/, ['獎金']], [/股利|配息/, ['股利']],
];

const INCOME_RE = /收入|賺|領到|領了|進帳|入帳|薪水|薪資|獎金|股利|配息|利息收入/;
/** 問句裡不是關鍵字的字 */
const STOP_RE = /都花到哪裡?|花到哪裡?|花在哪裡?|去哪裡?|在哪裡?|哪裡|哪家|哪間|哪|我|你|的|了|在|跟|和|與|共|總共|一共|多少錢?|幾次|幾筆|幾天|幾趟|次數|筆數|錢|花費?|花掉|花在|開銷|支出|收入|賺了?|領了?|吃了?|喝了?|買了?|去了?|搭了?|用了?|付了?|嗎|呢|啊|吧|平均|每天|一天|每日|每筆|一筆|最大|最貴|最高|最多|最少|最常|哪裡|哪家|哪間|哪一類|哪個分類|哪一個|哪個|哪些|什麼|都|是|有|到|上|囉|喔|[?？!！,，。.、\s]/g;

const fmtMD = (d: DateKey) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;

interface RangeHit { range: Range; label: string; prev: Range; prevLabel: string; match: string }

function monthOf(y: number, m: number): Range {
  return { start: `${y}-${pad2(m)}-01`, end: `${y}-${pad2(m)}-${pad2(daysInMonth(y, m - 1))}` };
}

function findRange(text: string, ctx: QueryContext): RangeHit {
  const t = ctx.today;
  const week = (k: DateKey) => weekRange(k, ctx.weekStart);
  const month = (k: DateKey) => accountingMonth(k, ctx.monthStartDay);
  const tryRe = (re: RegExp) => text.match(re);
  let m: RegExpMatchArray | null;
  const hit = (match: string, range: Range, label: string, prev: Range, prevLabel: string): RangeHit => ({ match, range, label, prev, prevLabel });

  if ((m = tryRe(/(最近|近|過去)\s*(\d+|[一二兩三四五六七八九十]+)\s*(天|日|週|周|個?禮拜|個?星期|個?月|年)/))) {
    const n = parseCnNumber(m[2]) ?? 1;
    const unit = m[3];
    const start = /天|日/.test(unit) ? addDays(t, -(n - 1)) : /週|周|禮拜|星期/.test(unit) ? addDays(t, -(7 * n - 1)) : /月/.test(unit) ? addDays(addMonths(t, -n), 1) : addDays(addMonths(t, -12 * n), 1);
    const len = Math.round((new Date(`${t}T00:00:00`).getTime() - new Date(`${start}T00:00:00`).getTime()) / 86400000) + 1;
    return hit(m[0], { start, end: t }, `最近 ${n} ${unit}`, { start: addDays(start, -len), end: addDays(start, -1) }, `再前 ${n} ${unit}`);
  }
  if ((m = tryRe(/(\d{4})\s*年\s*(\d{1,2})\s*月/))) {
    const r = monthOf(+m[1], +m[2]);
    return hit(m[0], r, `${m[1]} 年 ${+m[2]} 月`, monthOf(+m[2] === 1 ? +m[1] - 1 : +m[1], +m[2] === 1 ? 12 : +m[2] - 1), '前一個月');
  }
  if ((m = tryRe(/(?<![\d年])(\d{1,2}|[一二三四五六七八九十]{1,3})\s*月(?!\s*\d|[一二三四五六七八九十]+[日號])/))) {
    const mm = parseCnNumber(m[1]) ?? 0;
    if (mm >= 1 && mm <= 12) {
      let y = Number(t.slice(0, 4));
      if (`${y}-${pad2(mm)}-01` > t) y -= 1;
      return hit(m[0], monthOf(y, mm), `${mm} 月`, monthOf(mm === 1 ? y - 1 : y, mm === 1 ? 12 : mm - 1), `${mm === 1 ? 12 : mm - 1} 月`);
    }
  }
  const rules: [RegExp, () => [Range, string, Range, string]][] = [
    [/今天|今日/, () => [{ start: t, end: t }, '今天', { start: addDays(t, -1), end: addDays(t, -1) }, '昨天']],
    [/昨天|昨日/, () => [{ start: addDays(t, -1), end: addDays(t, -1) }, '昨天', { start: addDays(t, -2), end: addDays(t, -2) }, '前天']],
    [/前天/, () => [{ start: addDays(t, -2), end: addDays(t, -2) }, '前天', { start: addDays(t, -3), end: addDays(t, -3) }, '大前天']],
    [/上上(個)?(週|周|禮拜|星期)/, () => { const r = week(addDays(t, -14)); return [r, '上上週', week(addDays(r.start, -1)), '再前一週']; }],
    [/上(個)?(週|周|禮拜|星期)/, () => { const r = week(addDays(t, -7)); return [r, '上週', week(addDays(r.start, -1)), '上上週']; }],
    [/(這|本|这)(個)?(週|周|禮拜|星期)/, () => { const r = week(t); return [r, '這週', week(addDays(r.start, -1)), '上週']; }],
    [/上上(個)?月/, () => { const r = month(addMonths(month(t).start, -2)); return [r, '上上個月', month(addDays(r.start, -1)), '再前一個月']; }],
    [/上(個)?月/, () => { const r = month(addDays(month(t).start, -1)); return [r, '上個月', month(addDays(r.start, -1)), '上上個月']; }],
    [/(這|本|这)(個)?月/, () => { const r = month(t); return [r, '這個月', month(addDays(r.start, -1)), '上個月']; }],
    [/前年/, () => { const y = Number(t.slice(0, 4)) - 2; return [yearRange(`${y}-01-01`), `${y} 年`, yearRange(`${y - 1}-01-01`), `${y - 1} 年`]; }],
    [/去年/, () => { const y = Number(t.slice(0, 4)) - 1; return [yearRange(`${y}-01-01`), '去年', yearRange(`${y - 1}-01-01`), '前年']; }],
    [/今年|本年|這一年/, () => { const y = Number(t.slice(0, 4)); return [{ start: `${y}-01-01`, end: t }, '今年', yearRange(`${y - 1}-01-01`), '去年']; }],
  ];
  for (const [re, fn] of rules) {
    const mm = text.match(re);
    if (mm) { const [r, l, p, pl] = fn(); return hit(mm[0], r, l, p, pl); }
  }
  const r = month(t);
  return hit('', r, '這個月', month(addDays(r.start, -1)), '上個月');
}

function findMetric(text: string): Metric {
  if (/花最多|花在哪|都花到|哪一類|哪個分類|什麼最多|錢都去哪|花在什麼/.test(text)) return 'topCategory';
  if (/哪裡|哪家|哪間|在哪|最常去/.test(text)) return 'topMerchant';
  if (/最大|最貴|最高|最多的一筆|最大筆/.test(text)) return 'max';
  if (/平均/.test(text)) return /每天|一天|每日/.test(text) ? 'avgDaily' : 'avg';
  if (/每天|一天|每日/.test(text) && /多少/.test(text)) return 'avgDaily';
  if (/幾次|幾筆|幾趟|多少次|多少筆|次數|筆數|幾天/.test(text)) return 'count';
  return 'sum';
}

/** 是不是一個問句；不是的話用一般搜尋 */
export function isQuestion(text: string): boolean {
  const s = toHalfWidth(text);
  return QUESTION_RE.test(s) || /今天|昨天|這週|上週|這個月|上個月|今年|去年|最近/.test(s) && s.length > 3;
}

export function parseQuery(input: string, ctx: QueryContext): NlQuery | null {
  const text = toHalfWidth(input).trim();
  if (!text || !isQuestion(text)) return null;
  const r = findRange(text, ctx);
  let rest = r.match ? text.replace(r.match, ' ') : text;
  const metric = findMetric(rest);

  // 帳戶
  const accHits = findAccounts(rest, ctx.accounts);
  for (const h of accHits) if (h.term) rest = rest.replace(new RegExp(h.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ');

  // 分類：常見說法 → 分類名稱，否則直接比對分類名稱
  let cats: NlpCategory[] = [];
  let catLabel: string | undefined;
  for (const [re, names] of SYNONYMS) {
    const mm = rest.match(re);
    if (!mm) continue;
    const found = ctx.categories.filter((c) => names.includes(c.name));
    if (!found.length) continue;
    // 同名時優先主分類（「其他」不會出現在這裡）
    const main = found.filter((c) => !c.parentId);
    cats = main.length ? main : found;
    catLabel = cats[0].name;
    rest = rest.replace(mm[0], ' ');
    break;
  }
  if (!cats.length) {
    const c = findCategory(rest, ctx.categories);
    if (c) { cats = [c]; catLabel = c.name; rest = rest.replace(c.name, ' '); }
  }
  const kind: 'expense' | 'income' = cats[0]?.kind ?? (INCOME_RE.test(text) ? 'income' : 'expense');
  const keyword = rest.replace(STOP_RE, ' ').replace(/\s+/g, ' ').trim();
  return {
    range: r.range, rangeLabel: r.label, prevRange: r.prev, prevLabel: r.prevLabel, kind,
    categoryIds: cats.map((c) => c.id), categoryLabel: catLabel, accountIds: accHits.map((h) => h.id),
    keyword: keyword.length >= 1 && /[\p{L}\p{N}]/u.test(keyword) ? keyword : undefined, metric,
  };
}

export const rangeText = (r: Range) => (r.start === r.end ? fmtMD(r.start) : `${fmtMD(r.start)}～${fmtMD(r.end)}`);
