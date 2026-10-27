/**
 * 中文一句話解析（純函式）：一句話／語音記帳、收件匣（簡訊、Siri）與「用問的查帳」共用。
 * - 金額：1,234、1.5、NT$120、一百五、兩千三、5萬2、1.5萬、3k；避開 7-11、85度C、2杯、3號 這類非金額數字
 * - 日期：今天／昨天／前天／大前天、3 天前、上週五、週三、10/25、10月25日、25號（未來的日期往前推一年／一個月）
 * - 一句話多筆：「早餐 60 午餐 120」拆成兩筆；只出現一次的日期與帳戶套用到每一筆
 */
import { addDays, addMonths, daysInMonth, fromDateKey, pad2, toDateKey, type DateKey } from './period';

// ───────────── 數字 ─────────────

const CN_DIGIT: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 兩: 2, 貳: 2, 三: 3, 參: 3, 四: 4, 肆: 4, 五: 5, 伍: 5,
  六: 6, 陸: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9,
};
const CN_UNIT: Record<string, number> = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000, k: 1000, K: 1000 };
const CN_BIG: [string, number][] = [['億', 1e8], ['萬', 1e4], ['万', 1e4]];

/** 全形數字與符號轉半形 */
export function toHalfWidth(s: string): string {
  return s.replace(/[０-９Ａ-Ｚａ-ｚ＄．／－：％]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, ' ');
}

/** 「萬」以下的一節：兩千三 → 2300、一百零五 → 105、3千2 → 3200、十五 → 15 */
function cnSection(s: string): number | null {
  if (!s) return 0;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  let total = 0;
  let cur: number | null = null;
  let lastUnit = 1;
  let zero = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (/[\d.]/.test(c)) {
      let j = i;
      while (j < s.length && /[\d.]/.test(s[j])) j++;
      cur = Number(s.slice(i, j));
      if (!Number.isFinite(cur)) return null;
      i = j - 1;
    } else if (c in CN_DIGIT) {
      if (CN_DIGIT[c] === 0) { zero = true; continue; }
      cur = CN_DIGIT[c];
    } else if (c in CN_UNIT) {
      total += (cur ?? 1) * CN_UNIT[c];
      lastUnit = CN_UNIT[c];
      cur = null;
      zero = false;
    } else return null;
  }
  // 「兩千三」的三代表三百：結尾的數字沿用上一個單位的下一位
  if (cur !== null) total += !zero && lastUnit >= 100 ? cur * (lastUnit / 10) : cur;
  return total;
}

/** 中文、阿拉伯或混合寫法的數字；無法解析回傳 null */
export function parseCnNumber(raw: string): number | null {
  const s = toHalfWidth(raw).replace(/[,\s]/g, '');
  if (!s) return null;
  for (const [ch, big] of CN_BIG) {
    const i = s.indexOf(ch);
    if (i < 0) continue;
    const head = parseCnNumber(s.slice(0, i) || '1');
    const tailRaw = s.slice(i + 1);
    if (head === null) return null;
    // 「5萬2」＝ 52000：萬後面只有一個數字時代表千位
    const tail = /^[\d一二兩三四五六七八九]$/.test(tailRaw) ? (cnSection(tailRaw) ?? 0) * (big / 10) : parseCnNumber(tailRaw || '0');
    return tail === null ? null : head * big + tail;
  }
  return cnSection(s);
}

// ───────────── 金額 ─────────────

export interface AmountHit {
  value: number;
  index: number;
  length: number;
  /** 有 NT$、元、塊 等標記，可信度較高 */
  marked: boolean;
  currency?: string;
  /** 英文字詞後面隔一個空白的數字（「Uber 230」）：整句沒有其他金額時才採用 */
  weak?: boolean;
}

const CN_NUM_CHARS = '零〇一二兩三四五六七八九十百千萬万壹貳參肆伍陸柒捌玖拾佰仟';
const AMOUNT_RE = new RegExp(
  `(NT\\$|NTD|TWD|US\\$|USD|HK\\$|JPY|\\$|新台幣|新臺幣|台幣|臺幣)?\\s*` +
  `((?:\\d[\\d,]*(?:\\.\\d+)?(?:\\s*[萬万千kK](?![a-zA-Z])\\d?)?)|(?:[${CN_NUM_CHARS}]+))` +
  `\\s*(元|塊錢|塊|圓|块|dollars?)?`,
  'g',
);
/** 數字後面接這些字代表數量、時間或店名，不是金額 */
const NOT_AMOUNT_AFTER = /^[杯個份張瓶罐包盒碗件次人位隻台支顆片條本號樓點時分秒歲年月日天週周%折度嵐樣種隻碼吋]/;
const NOT_AMOUNT_BEFORE = /[A-Za-z\-/#_.:]$/;
/** 「週3」「第2」「下午3」的數字不是金額 */
const NOT_AMOUNT_AFTER_WORD = /(週|周|星期|禮拜|礼拜|第|早上|下午|晚上|中午)$/;
/** 中文數字後面可以接的字（「一百五用現金」）；其他中文字代表是詞的一部分（「五十嵐」「十分」） */
const CN_OK_AFTER = /^($|[\s,，、。;；!！?？)）]|[用刷付給在從到買花去搭吃喝的])/;
const CURRENCY_WORDS: [RegExp, string][] = [
  [/美金|美元|US\$|USD/i, 'USD'], [/日幣|日圓|日元|円|JPY/i, 'JPY'], [/港幣|港元|HK\$|HKD/i, 'HKD'],
  [/歐元|EUR/i, 'EUR'], [/人民幣|RMB|CNY/i, 'CNY'], [/韓元|韓幣|KRW/i, 'KRW'], [/英鎊|GBP/i, 'GBP'],
  [/泰銖|THB/i, 'THB'], [/新加坡幣|新幣|SGD/i, 'SGD'], [/澳幣|AUD/i, 'AUD'],
];
const CURRENCY_AFTER = /^(美金|美元|日幣|日圓|日元|円|港幣|港元|歐元|人民幣|韓元|韓幣|英鎊|泰銖|新加坡幣|新幣|澳幣)/;
/** 會被誤認為金額的店名 */
const PROTECTED = /7\s*-?\s*11|7\s*-?\s*eleven|85\s*度\s*c|50\s*嵐|五十嵐|21\s*世紀|101|3\s*m(?![a-z])/gi;

export function detectCurrency(text: string): string | undefined {
  return CURRENCY_WORDS.find(([re]) => re.test(text))?.[1];
}

/** 找出文字中的所有金額（依出現位置排序） */
export function findAmounts(text: string): AmountHit[] {
  const s = toHalfWidth(text).replace(PROTECTED, (m) => '＿'.repeat(m.length));
  const out: AmountHit[] = [];
  for (const m of s.matchAll(AMOUNT_RE)) {
    const [whole, prefix, num, suffix] = m;
    const start = m.index! + whole.indexOf(num);
    const before = s.slice(0, start).trimEnd();
    const after = s.slice(m.index! + whole.length);
    const isCn = !/\d/.test(num);
    // 英文字母緊貼數字（A4、MRT3）不是金額；中間有空白（「Uber 230」「Netflix 390」）先當作「弱」金額，整句沒有其他金額時才採用
    const glued = !prefix && NOT_AMOUNT_BEFORE.test(s.slice(0, start)) && !/\d$/.test(before);
    const weak = !prefix && !glued && NOT_AMOUNT_BEFORE.test(before) && !/\d$/.test(before) && /[A-Za-z]$/.test(before);
    if (glued || (!prefix && NOT_AMOUNT_BEFORE.test(before) && !/\d$/.test(before) && !weak)) continue;
    if (!prefix && NOT_AMOUNT_AFTER_WORD.test(before)) continue;
    // 「1200 日圓」：後面接幣別，不是「日」
    const curAfter = !suffix ? after.trimStart().match(CURRENCY_AFTER)?.[0] : undefined;
    if (!suffix && !curAfter && NOT_AMOUNT_AFTER.test(after.trimStart())) continue;
    if (!suffix && /^[A-Za-z/\-:]/.test(after)) continue;
    if (isCn) {
      if (/第$/.test(before)) continue;
      const hasUnit = /[十百千萬万拾佰仟]/.test(num);
      if (!suffix && !(hasUnit && CN_OK_AFTER.test(after))) continue;
    }
    const value = parseCnNumber(num);
    if (value === null || !(value > 0) || value > 1e12) continue;
    out.push({
      weak, value, index: m.index!, length: whole.length, marked: !!(prefix || suffix || curAfter),
      currency: prefix ? detectCurrency(prefix) : curAfter ? detectCurrency(curAfter) : undefined,
    });
  }
  const strong = out.filter((h) => !h.weak);
  return strong.length ? strong : out;
}

// ───────────── 日期 ─────────────

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

// ───────────── 帳戶、分類 ─────────────

export interface NlpAccount { id: string; name: string; type?: string }
export interface NlpCategory { id: string; name: string; kind: 'expense' | 'income'; parentId: string }

const ACCOUNT_SUFFIX = /(銀行|帳戶|账户|戶頭|信用卡|金融卡|簽帳卡|卡片|卡|錢包|帳號)$/;

/** 帳戶的比對詞：完整名稱、去掉「銀行／卡／帳戶」的名稱（至少 2 個字） */
function accountTerms(a: NlpAccount): string[] {
  const n = a.name.trim();
  const short = n.replace(ACCOUNT_SUFFIX, '').trim();
  const terms = [n];
  if (short.length >= 2 && short !== n) terms.push(short);
  // 「台新 Richart」「國泰 CUBE 卡」：每個詞也可以單獨稱呼
  for (const w of short.split(/\s+/)) if (w.length >= 2 && w !== short && !ACCOUNT_SUFFIX.test(w)) terms.push(w);
  if (a.type === 'cash') terms.push('現金');
  return terms.map((x) => x.toLowerCase());
}

export interface AccountHit { id: string; index: number; term: string }

/** 依出現位置找出提到的帳戶（同一段文字只算最長的那個詞） */
export function findAccounts(text: string, accounts: NlpAccount[]): AccountHit[] {
  const lower = text.toLowerCase();
  const hits: AccountHit[] = [];
  for (const a of accounts) {
    for (const term of accountTerms(a)) {
      const i = lower.indexOf(term);
      if (i >= 0) hits.push({ id: a.id, index: i, term });
    }
  }
  // 「信用卡」這種泛稱：只有一張信用卡時才對應
  const credits = accounts.filter((a) => a.type === 'credit');
  if (credits.length === 1 && /信用卡|刷卡/.test(text) && !hits.some((h) => h.id === credits[0].id)) {
    hits.push({ id: credits[0].id, index: text.search(/信用卡|刷卡/), term: '' });
  }
  hits.sort((a, b) => a.index - b.index || b.term.length - a.term.length);
  const out: AccountHit[] = [];
  for (const h of hits) {
    const prev = out[out.length - 1];
    if (out.some((o) => o.id === h.id)) continue;
    if (prev && h.index < prev.index + prev.term.length) continue; // 被較長的詞涵蓋
    out.push(h);
  }
  return out;
}

/**
 * 常見說法 → 分類名稱。使用者的分類可以自己改，所以只在「真的有這個名稱的分類」時才採用，不會憑空捏造。
 * generic：說的就是分類本身（「手搖飲」「晚餐」），認出來後從備註拿掉；
 * 其他是具體的東西或店名（「珍奶」「Uber」「星巴克」），只用來判斷分類，仍然留在備註。
 */
interface Synonym { names: string[]; kind: 'expense' | 'income'; generic: string[]; specific?: string[] }
const SYNONYMS: Synonym[] = [
  { names: ['飲料', '飲品'], kind: 'expense', generic: ['手搖飲', '手搖', '飲料', '飲品', '飲料店'],
    specific: ['珍奶', '珍珠奶茶', '奶茶', '紅茶', '綠茶', '青茶', '烏龍茶', '果汁', '汽水', '可樂', '咖啡', '拿鐵', '美式', '星巴克', '路易莎', '冰沙', '五十嵐', '50嵐', '清心', '可不可', '迷客夏', '麥香'] },
  { names: ['早餐'], kind: 'expense', generic: ['早餐', '早點', '早飯'], specific: ['蛋餅', '飯糰', '吐司', '燒餅', '豆漿', '蘿蔔糕'] },
  { names: ['午餐'], kind: 'expense', generic: ['午餐', '午飯', '中餐'], specific: ['便當', '自助餐'] },
  { names: ['晚餐'], kind: 'expense', generic: ['晚餐', '晚飯'] },
  { names: ['宵夜', '晚餐'], kind: 'expense', generic: ['宵夜', '消夜'] },
  { names: ['點心'], kind: 'expense', generic: ['點心', '零食', '甜點', '下午茶'], specific: ['蛋糕', '餅乾', '冰淇淋', '甜甜圈'] },
  { names: ['食材'], kind: 'expense', generic: ['食材', '買菜', '菜錢'] },
  { names: ['聚餐'], kind: 'expense', generic: ['聚餐', '聚會', '吃飯聚'] },
  { names: ['計程車'], kind: 'expense', generic: ['計程車', '小黃', '叫車'], specific: ['uber', '55688'] },
  { names: ['捷運公車'], kind: 'expense', generic: ['捷運', '公車', '搭車'], specific: ['悠遊卡'] },
  { names: ['高鐵火車'], kind: 'expense', generic: ['高鐵', '台鐵', '火車', '客運'] },
  { names: ['加油'], kind: 'expense', generic: ['加油', '油錢', '汽油'] },
  { names: ['停車'], kind: 'expense', generic: ['停車', '停車費'] },
  { names: ['水電瓦斯'], kind: 'expense', generic: ['水電', '電費', '水費', '瓦斯', '瓦斯費'] },
  { names: ['網路電信'], kind: 'expense', generic: ['網路費', '電信費', '手機費', '電話費', '網路'] },
  { names: ['房租'], kind: 'expense', generic: ['房租', '租金'] },
  { names: ['日用品'], kind: 'expense', generic: ['日用品', '衛生紙', '洗衣精'] },
  { names: ['電影'], kind: 'expense', generic: ['電影', '看電影'] },
  { names: ['運動健身'], kind: 'expense', generic: ['健身房', '健身', '運動'] },
  { names: ['門診'], kind: 'expense', generic: ['看醫生', '掛號', '門診', '診所'] },
  { names: ['藥品'], kind: 'expense', generic: ['藥局', '買藥', '藥品'] },
  { names: ['牙科'], kind: 'expense', generic: ['牙醫', '洗牙', '牙科'] },
  { names: ['美髮'], kind: 'expense', generic: ['剪髮', '理髮', '美髮', '染髮'] },
  { names: ['影音串流'], kind: 'expense', generic: [], specific: ['netflix', 'disney', 'youtube premium', 'hbo'] },
  { names: ['音樂串流'], kind: 'expense', generic: [], specific: ['spotify', 'kkbox', 'apple music'] },
  { names: ['紅白包'], kind: 'expense', generic: ['紅包', '白包', '禮金', '包紅包'] },
  { names: ['請客'], kind: 'expense', generic: ['請客'] },
  { names: ['禮物'], kind: 'expense', generic: ['禮物', '送禮'] },
  { names: ['獸醫'], kind: 'expense', generic: ['獸醫', '看獸醫'] },
  { names: ['薪資', '本薪'], kind: 'income', generic: ['薪水', '月薪', '薪資', '發薪'] },
  { names: ['獎金'], kind: 'income', generic: ['獎金', '年終'] },
  { names: ['兼職外快', '兼職'], kind: 'income', generic: ['兼職', '外快', '接案'] },
  { names: ['禮金紅包'], kind: 'income', generic: ['紅包', '禮金', '收紅包'] },
  { names: ['退款'], kind: 'income', generic: ['退款', '退費'] },
  { names: ['利息'], kind: 'income', generic: ['利息'] },
  { names: ['股利'], kind: 'income', generic: ['股利', '配息', '股息'] },
  { names: ['中獎'], kind: 'income', generic: ['中獎', '彩券'] },
];

export interface CategoryMatch {
  category: NlpCategory;
  /** 文字裡認出分類的那個詞 */
  term: string;
  /** true：這個詞就是在說分類本身，備註不需要再寫一次 */
  generic: boolean;
}

/**
 * 找出文字提到的分類。
 * 1. 分類名稱本身（「早餐」「晚餐」「計程車」）；「其他」不算
 * 2. 常見說法（「手搖飲」→ 飲料、「小黃」→ 計程車）；只在使用者真的有這個名稱的分類時才採用
 * 取最長的詞；一樣長時優先子分類，再優先先出現的。
 */
export function matchCategory(text: string, cats: NlpCategory[], kind?: 'expense' | 'income'): CategoryMatch | undefined {
  const lower = text.toLowerCase();
  const cands: (CategoryMatch & { index: number })[] = [];
  const sub = (c: NlpCategory) => (c.parentId ? 1 : 0);
  const byName = (names: string[], k: 'expense' | 'income') => {
    for (const n of names) {
      const hits = cats.filter((c) => c.name === n && c.kind === k).sort((a, b) => sub(b) - sub(a));
      if (hits[0]) return hits[0];
    }
    return undefined;
  };
  for (const c of cats) {
    if (c.name === '其他' || c.name.length < 2 || (kind && c.kind !== kind)) continue;
    const i = lower.indexOf(c.name.toLowerCase());
    if (i >= 0) cands.push({ category: c, term: c.name, generic: true, index: i });
  }
  for (const syn of SYNONYMS) {
    if (kind && syn.kind !== kind) continue;
    const target = byName(syn.names, syn.kind);
    if (!target) continue;
    for (const [list, generic] of [[syn.generic, true], [syn.specific ?? [], false]] as const) {
      for (const w of list) {
        const i = lower.indexOf(w.toLowerCase());
        if (i >= 0) cands.push({ category: target, term: text.slice(i, i + w.length), generic, index: i });
      }
    }
  }
  cands.sort((a, b) => b.term.length - a.term.length || sub(b.category) - sub(a.category) || a.index - b.index);
  const best = cands[0];
  return best && { category: best.category, term: best.term, generic: best.generic };
}

/** 分類名稱出現在文字中：取最長的名稱（「其他」不算） */
export function findCategory(text: string, cats: NlpCategory[], kind?: 'expense' | 'income'): NlpCategory | undefined {
  return matchCategory(text, cats, kind)?.category;
}

// ───────────── 一句話記帳 ─────────────

export type EntryKind = 'expense' | 'income' | 'transfer';

export interface DraftEntry {
  kind: EntryKind;
  amount: number;
  currency?: string;
  date: DateKey;
  /** 有沒有在文字中寫到日期（沒寫就是今天） */
  dateGiven: boolean;
  accountId?: string;
  toAccountId?: string;
  categoryId?: string;
  note: string;
  raw: string;
}

export interface ParseContext {
  today: DateKey;
  accounts: NlpAccount[];
  categories: NlpCategory[];
}

const INCOME_RE = /薪水|薪資|月薪|領薪|發薪|收入|進帳|入帳|收到|領到|拿到|賺了|賺到|獎金|年終|收紅包|紅包收入|退款|退費|退稅|利息|股利|中獎|報帳|還我|還錢給我/;
const TRANSFER_RE = /轉帳|轉到|轉入|轉進|轉給|存到|存入|存進|提款|提領|領錢|領現/;
const CASH_OUT_RE = /提款|提領|領錢|領現/;
/** 備註裡不需要保留的贅字 */
const FILLER_RE = /(花了|花掉|總共|一共|大概|付了|付款|消費了?|買了|用掉|共計|金額|元整|我|了)/g;
const VERB_BEFORE_ACCOUNT = /(用|刷|拿|以|從|由|透過|轉到|轉入|轉進|轉給|存到|存入|存進|付)\s*$/;
/** 逗號後面接三位數字是千分位（1,234），不是分隔 */
const SEPARATORS = /,(?!\d{3}(?:\D|$))|[，、;；。\n]|還有|然後|另外|以及/;

interface Segment { text: string; amount?: AmountHit }

/** 依金額把文字切成多筆：每個金額結束一筆，金額後面的文字併到最後一筆 */
function segment(text: string): Segment[] {
  const chunks = text.split(SEPARATORS).map((x) => x.trim()).filter(Boolean);
  const out: Segment[] = [];
  const orphans: string[] = [];
  for (const chunk of chunks) {
    const amounts = findAmounts(chunk);
    if (!amounts.length) {
      // 沒有金額的片段（「昨天」「都刷玉山卡」）：先接在前一筆，等一下再看是否套用到全部
      if (out.length) out[out.length - 1].text += ` ${chunk}`;
      else orphans.push(chunk);
      continue;
    }
    // 有標記的金額優先：「咖啡 2 杯 NT$120」只算 120；同一段有多個無標記金額時才拆成多筆
    const marked = amounts.filter((a) => a.marked);
    const list = marked.length && marked.length < amounts.length ? marked : amounts;
    let from = 0;
    list.forEach((a, i) => {
      const end = a.index + a.length;
      const isLast = i === list.length - 1;
      out.push({ text: chunk.slice(from, isLast ? chunk.length : end), amount: { ...a, index: a.index - from } });
      from = end;
    });
  }
  if (orphans.length) {
    const head = `${orphans.join(' ')} `;
    if (out.length) out[0] = { text: head + out[0].text, amount: out[0].amount && { ...out[0].amount, index: out[0].amount.index + head.length } };
    else out.push({ text: orphans.join(' ') });
  }
  return out;
}

function cleanNote(s: string): string {
  return s.replace(FILLER_RE, ' ').replace(/[$＄]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[的在跟和與]\s*|\s*[的在跟和與]$/g, '');
}

/** 「吃科學麵」「喝了咖啡」的動詞不是備註的一部分；整段只剩動詞或標點就當作沒有備註 */
const LEAD_VERB = /^(?:吃|喝|買|點|叫|訂|去|看|搭|坐|刷|付)\s*(?=\S{2,})/;
const ONLY_NOISE = /^[\s吃喝買點叫訂去看搭坐刷付的在了跟和與、,，。.\-—_/\\]*$/;

/**
 * 認出分類之後整理備註：分類本身說過了就不用再寫（「晚餐 320」→ 沒有備註；「早餐科學麵」→「科學麵」），
 * 收入的「領到／收到」只是在說明類型，也拿掉。具體的東西或店名（Uber、珍奶）仍然保留。
 */
function tidyNote(note: string, match: CategoryMatch | undefined, kind: EntryKind): string {
  let n = note;
  if (match?.generic) n = n.replace(match.term, ' ');
  if (kind === 'income') n = n.replace(new RegExp(INCOME_RE.source, 'g'), ' ').replace(/領到|領了|領|收到|收了|拿到|賺到|賺了|入帳|進帳/g, ' ');
  n = cleanNote(n).replace(LEAD_VERB, '').trim();
  return ONLY_NOISE.test(n) ? '' : n;
}

/** 把一句話解析成一筆或多筆帳 */
export function parseEntries(input: string, ctx: ParseContext): DraftEntry[] {
  const text = toHalfWidth(input).trim();
  if (!text) return [];
  const segs = segment(text);
  const drafts: DraftEntry[] = [];
  const allAccounts = findAccounts(text, ctx.accounts);
  const globalCurrency = detectCurrency(text);
  const datesFound: DateKey[] = [];

  for (const seg of segs) {
    if (!seg.amount) continue;
    // 1. 金額：先挖掉，避免日期規則把金額當成「25 號」
    const a = seg.amount;
    let rest = `${seg.text.slice(0, a.index)} ${seg.text.slice(a.index + a.length)}`;
    // 2. 日期
    const dt = extractDate(rest, ctx.today);
    rest = dt.rest;
    if (dt.date) datesFound.push(dt.date);
    // 3. 帳戶（連同前面的「用／刷／從」一起拿掉）
    const accs = findAccounts(rest, ctx.accounts);
    for (const h of [...accs].sort((x, y) => y.index - x.index)) {
      if (!h.term) continue;
      const before = rest.slice(0, h.index).replace(VERB_BEFORE_ACCOUNT, '');
      // 「刷玉山卡」比對到「玉山」時，後面的「卡」一起拿掉
      rest = `${before} ${rest.slice(h.index + h.term.length).replace(/^(信用卡|金融卡|卡|銀行|帳戶)/, '')}`;
    }
    rest = rest.replace(/刷卡|信用卡/g, ' ');
    // 4. 類型
    let kind: EntryKind = INCOME_RE.test(seg.text) ? 'income' : 'expense';
    let accountId = accs[0]?.id;
    let toAccountId: string | undefined;
    if (TRANSFER_RE.test(seg.text)) {
      const cash = ctx.accounts.find((x) => x.type === 'cash');
      if (accs.length >= 2) { kind = 'transfer'; accountId = accs[0].id; toAccountId = accs[1].id; }
      else if (CASH_OUT_RE.test(seg.text) && cash && accs[0]?.id !== cash.id) { kind = 'transfer'; toAccountId = cash.id; }
    }
    const currency = a.currency ?? detectCurrency(seg.text) ?? globalCurrency;
    for (const [re] of CURRENCY_WORDS) rest = rest.replace(re, ' ');
    const rawNote = cleanNote(rest.replace(TRANSFER_RE, kind === 'transfer' ? ' ' : '$&'));
    const match = kind === 'transfer' ? undefined : matchCategory(rawNote || seg.text, ctx.categories, kind);
    const cat = match?.category;
    const note = kind === 'transfer' ? rawNote : tidyNote(rawNote, match, kind);
    drafts.push({
      kind, amount: a.value, currency, date: dt.date ?? ctx.today, dateGiven: !!dt.date,
      accountId, toAccountId, categoryId: cat?.id, note, raw: seg.text.trim(),
    });
  }

  // 只寫一次的日期、帳戶套用到沒寫的那幾筆（「昨天 早餐 60 午餐 120 都刷玉山」）
  const distinctDates = [...new Set(datesFound)];
  // 帳戶只在「都／全部」或整句沒有逗號分隔時才套用到每一筆（「午餐 150 刷玉山卡，全聯 356」的全聯另外判斷）
  const oneChunk = text.split(SEPARATORS).filter((x) => x.trim()).length <= 1;
  const sharedAccount = allAccounts.length === 1 && (oneChunk || /都|全部|一起|統一/.test(text)) ? allAccounts[0].id : undefined;
  for (const d of drafts) {
    if (!d.dateGiven && distinctDates.length === 1) { d.date = distinctDates[0]; d.dateGiven = true; }
    if (!d.accountId && sharedAccount && d.kind !== 'transfer') d.accountId = sharedAccount;
  }
  return drafts;
}

/** 方便顯示：今天／昨天／10/25 */
export function shortDate(d: DateKey, today: DateKey): string {
  if (d === today) return '今天';
  if (d === addDays(today, -1)) return '昨天';
  if (d === addDays(today, -2)) return '前天';
  const x = fromDateKey(d);
  return d.slice(0, 4) === today.slice(0, 4) ? `${x.getMonth() + 1}/${x.getDate()}` : toDateKey(x).replace(/-/g, '/');
}
