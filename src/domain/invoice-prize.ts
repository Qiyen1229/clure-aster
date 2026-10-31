/**
 * 統一發票對獎（純函式）。
 * 每兩個月一期（1-2、3-4…），次期單月 25 號開獎。獎項：
 *   特別獎 1,000 萬、特獎 200 萬：8 碼全中；
 *   頭獎 20 萬：8 碼全中任一組頭獎號碼；
 *   二獎 4 萬～六獎 200：與頭獎號碼的末 7～3 碼相同（取最高的一個）；
 *   增開六獎 200：末 3 碼與增開六獎號碼相同（財政部有時才公布）。
 * 雲端發票專屬獎由財政部另外通知載具使用者，這裡不含。
 */
export type PrizeLevel = 'special' | 'grand' | 'first' | 'second' | 'third' | 'fourth' | 'fifth' | 'sixth' | 'extraSixth';

export const PRIZE_INFO: Record<PrizeLevel, { name: string; amount: number }> = {
  special: { name: '特別獎', amount: 10_000_000 },
  grand: { name: '特獎', amount: 2_000_000 },
  first: { name: '頭獎', amount: 200_000 },
  second: { name: '二獎', amount: 40_000 },
  third: { name: '三獎', amount: 10_000 },
  fourth: { name: '四獎', amount: 4_000 },
  fifth: { name: '五獎', amount: 1_000 },
  sixth: { name: '六獎', amount: 200 },
  extraSixth: { name: '增開六獎', amount: 200 },
};

/** 末 N 碼相同對應的獎項（頭獎號碼的 8 碼全中是頭獎） */
const BY_SUFFIX: Record<number, PrizeLevel> = { 7: 'second', 6: 'third', 5: 'fourth', 4: 'fifth', 3: 'sixth' };

export interface PrizeDraw {
  /** 該期第一個月，例如 2026-07 代表 115 年 07～08 月 */
  period: string;
  label: string;
  special: string;
  grand: string;
  firsts: string[];
  /** 增開六獎（末 3 碼）；RSS 沒有，由使用者補上 */
  extraSixth: string[];
}

export interface PrizeHit {
  level: PrizeLevel;
  name: string;
  amount: number;
  /** 對中的號碼（8 碼：特別獎／特獎／頭獎號碼；其他為對到的那組頭獎號碼） */
  against: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 日期（YYYY-MM-DD）所屬的發票期別，回傳第一個月 YYYY-MM */
export function periodOf(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return `${y}-${pad(m % 2 === 1 ? m : m - 1)}`;
}

export function periodLabel(period: string): string {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7));
  return `${y - 1911} 年 ${pad(m)}～${pad(m + 1)} 月`;
}

/** 該期的發票日期範圍（含） */
export function periodRange(period: string): { start: string; end: string } {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7));
  const lastDay = new Date(y, m + 1, 0).getDate(); // 第二個月的最後一天（m+1 為 1 起算，傳給 Date 剛好是下個月 0 號）
  return { start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m + 1)}-${pad(lastDay)}` };
}

const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 開獎日（第二個月的次月 25 號）與領獎期間（開獎次月 6 號起三個月，到第三個月 5 號） */
export function drawSchedule(period: string): { drawDate: string; claimFrom: string; claimTo: string } {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7));
  const end = m + 1; // 該期第二個月（1 起算）
  return {
    drawDate: iso(new Date(y, end, 25)), // 月份 end（0 起算）＝次月
    claimFrom: iso(new Date(y, end + 1, 6)),
    claimTo: iso(new Date(y, end + 4, 5)),
  };
}

const eightDigits = (s: string) => s.match(/\d{8}/g) ?? [];

/** 解析財政部「統一發票中獎號碼」RSS（invoice.etax.nat.gov.tw/invoice.xml） */
export function parsePrizeRss(xml: string): PrizeDraw[] {
  const out: PrizeDraw[] = [];
  for (const item of xml.split('<item>').slice(1)) {
    const title = item.match(/<title>(?:<!\[CDATA\[)?\s*([^<\]]+)/)?.[1] ?? '';
    const t = title.match(/(\d{2,3})\s*年\s*(\d{1,2})\s*~\s*(\d{1,2})\s*月/);
    if (!t) continue;
    const desc = (item.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '\n');
    const field = (name: string) => desc.match(new RegExp(`${name}[:：]\\s*([\\d、,，\\s]+)`))?.[1] ?? '';
    const special = eightDigits(field('特別獎'))[0];
    const grand = eightDigits(field('特獎'))[0];
    const firsts = eightDigits(field('頭獎'));
    if (!special || !grand || !firsts.length) continue;
    const period = `${Number(t[1]) + 1911}-${pad(Number(t[2]))}`;
    out.push({ period, label: periodLabel(period), special, grand, firsts, extraSixth: (field('增開六獎').match(/\d{3}/g) ?? []) });
  }
  return out.sort((a, b) => b.period.localeCompare(a.period));
}

/** 發票號碼取末 8 碼數字（接受 AB-12345678、AB12345678、12345678）；不足 8 碼回傳空字串 */
export function invoiceDigits(number: string): string {
  const d = number.replace(/\D/g, '');
  return d.length >= 8 ? d.slice(-8) : '';
}

const commonSuffix = (a: string, b: string) => {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
};

/** 這張發票中了什麼（取最高獎）；沒中回傳 null */
export function matchInvoice(number: string, draw: PrizeDraw, extraSixth: string[] = draw.extraSixth): PrizeHit | null {
  const d = invoiceDigits(number);
  if (!d) return null;
  const hit = (level: PrizeLevel, against: string): PrizeHit => ({ level, against, ...PRIZE_INFO[level] });
  if (d === draw.special) return hit('special', draw.special);
  if (d === draw.grand) return hit('grand', draw.grand);
  let best: PrizeHit | null = null;
  const take = (h: PrizeHit) => { if (!best || h.amount > best.amount) best = h; };
  for (const f of draw.firsts) {
    if (d === f) take(hit('first', f));
    else {
      const n = commonSuffix(d, f);
      if (n >= 3) take(hit(BY_SUFFIX[Math.min(n, 7)], f));
    }
  }
  if (extraSixth.some((e) => e.length === 3 && d.endsWith(e))) take(hit('extraSixth', d.slice(-3)));
  return best;
}
