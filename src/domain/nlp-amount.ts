/**
 * 中文一句話解析：數字與金額（純函式）
 * 全形轉半形、中文數字（一百五、兩千三、5萬2）、金額辨識（避開 7-11、85度C、2杯 這類非金額數字）、幣別。
 */
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
export const CURRENCY_WORDS: [RegExp, string][] = [
  [/美金|美元|US\$|USD/i, 'USD'], [/日幣|日圓|日元|円|JPY/i, 'JPY'], [/港幣|港元|HK\$|HKD/i, 'HKD'],
  [/歐元|EUR/i, 'EUR'], [/人民幣|RMB|CNY/i, 'CNY'], [/韓元|韓幣|KRW/i, 'KRW'], [/英鎊|GBP/i, 'GBP'],
  [/泰銖|THB/i, 'THB'], [/新加坡幣|新幣|SGD/i, 'SGD'], [/澳幣|AUD/i, 'AUD'],
];
const CURRENCY_AFTER = /^(美金|美元|日幣|日圓|日元|円|港幣|港元|歐元|人民幣|韓元|韓幣|英鎊|泰銖|新加坡幣|新幣|澳幣)/;
/** 會被誤認為金額的店名 */
const PROTECTED = new RegExp([
  '7\\s*-?\\s*11', '7\\s*-?\\s*eleven', '85\\s*度\\s*c', '50\\s*嵐', '五十嵐', '21\\s*世紀', '101', '3\\s*m(?![a-z])',
  // 簡訊裡的電話、帳號、會員編號、網址不是金額（例如「電話 0912345678」不可以變成 $912,345,678）
  'https?:\\/\\/\\S+', '(?<![\\d.,])\\d{9,}(?![\\d])', '(?<![\\d.,])0\\d{1,2}[- ]\\d{3,4}[- ]\\d{3,4}(?![\\d])',
].join('|'), 'gi');

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

