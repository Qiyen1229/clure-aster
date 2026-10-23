/**
 * 金額工具：所有貨幣金額以「該幣別 ISO 4217 最小單位的整數」儲存（例：TWD 100 元 = 10000）。
 * 嚴禁對金額直接做浮點運算；需要乘除（匯率、比例）時一律走 decimal.js 再四捨五入回整數。
 */
import Decimal from 'decimal.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export interface CurrencyInfo {
  code: string;
  /** ISO 4217 小數位數（最小單位指數） */
  exp: number;
  symbol: string;
  name: string;
}

export const CURRENCIES: Record<string, CurrencyInfo> = {
  TWD: { code: 'TWD', exp: 2, symbol: '$', name: '新台幣' },
  USD: { code: 'USD', exp: 2, symbol: 'US$', name: '美元' },
  JPY: { code: 'JPY', exp: 0, symbol: '¥', name: '日圓' },
  EUR: { code: 'EUR', exp: 2, symbol: '€', name: '歐元' },
  CNY: { code: 'CNY', exp: 2, symbol: 'CN¥', name: '人民幣' },
  HKD: { code: 'HKD', exp: 2, symbol: 'HK$', name: '港幣' },
  KRW: { code: 'KRW', exp: 0, symbol: '₩', name: '韓元' },
  GBP: { code: 'GBP', exp: 2, symbol: '£', name: '英鎊' },
  AUD: { code: 'AUD', exp: 2, symbol: 'A$', name: '澳幣' },
  CAD: { code: 'CAD', exp: 2, symbol: 'C$', name: '加幣' },
  SGD: { code: 'SGD', exp: 2, symbol: 'S$', name: '新加坡幣' },
  THB: { code: 'THB', exp: 2, symbol: '฿', name: '泰銖' },
  VND: { code: 'VND', exp: 0, symbol: '₫', name: '越南盾' },
  MYR: { code: 'MYR', exp: 2, symbol: 'RM', name: '馬幣' },
  CHF: { code: 'CHF', exp: 2, symbol: 'CHF', name: '瑞士法郎' },
  NZD: { code: 'NZD', exp: 2, symbol: 'NZ$', name: '紐幣' },
};

export function currencyInfo(code: string): CurrencyInfo {
  return CURRENCIES[code] ?? { code, exp: 2, symbol: code, name: code };
}

function assertSafe(n: number): number {
  if (!Number.isSafeInteger(n)) throw new RangeError(`金額超出安全範圍：${n}`);
  return n;
}

/** 十進位字串／Decimal → 最小單位整數（四捨五入） */
export function toMinor(value: Decimal.Value, currency: string): number {
  const { exp } = currencyInfo(currency);
  const d = new Decimal(value).mul(Decimal.pow(10, exp)).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return assertSafe(d.toNumber());
}

/** 最小單位整數 → Decimal（主單位） */
export function fromMinor(minor: number, currency: string): Decimal {
  return new Decimal(minor).div(Decimal.pow(10, currencyInfo(currency).exp));
}

/** 整數加總（每一步都檢查安全整數） */
export function sumMinor(values: Iterable<number>): number {
  let total = 0;
  for (const v of values) total = assertSafe(total + v);
  return total;
}

/**
 * 跨幣別換算：minor(from) × rate → minor(to)。
 * rate 的意義：1 單位 from = rate 單位 to。
 */
export function convertMinor(minor: number, from: string, to: string, rate: Decimal.Value): number {
  if (from === to) return minor;
  return toMinor(fromMinor(minor, from).mul(rate), to);
}

/**
 * 將總額依權重拆分且總和保證等於原值（最大餘數法）。
 * 用於分期、AA 拆帳等需要「每份四捨五入但總和不能差 1 元」的場景。
 */
export function allocate(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const wSum = weights.reduce((a, b) => a + b, 0);
  if (wSum <= 0) throw new RangeError('權重總和必須大於 0');
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const raw = weights.map((w) => new Decimal(abs).mul(w).div(wSum));
  const floors = raw.map((r) => r.floor().toNumber());
  let remainder = abs - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r.minus(r.floor()).toNumber() }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] += 1;
    remainder -= 1;
  }
  return floors.map((v) => v * sign);
}

export type DecimalsMode = 'auto' | 0 | 1 | 2;

export interface FormatOptions {
  /** 'auto'：整數金額不顯示小數，有零頭才顯示到幣別精度 */
  decimals?: DecimalsMode;
  thousands?: boolean;
  symbol?: boolean;
  /** 'always' 顯示 +/-；'negative' 只顯示負號 */
  sign?: 'always' | 'negative' | 'never';
  /** 顯示 1.2萬 / 3.4億 這類縮寫 */
  compact?: boolean;
}

/** 格式化金額，例：formatMoney(123456, 'TWD') → "$1,234.56" */
export function formatMoney(minor: number, currency: string, opts: FormatOptions = {}): string {
  const { decimals = 'auto', thousands = true, symbol = true, sign = 'negative', compact = false } = opts;
  const info = currencyInfo(currency);
  const value = fromMinor(Math.abs(minor), currency);
  let body: string;
  if (compact && value.gte(10000)) {
    const [div, unit] = value.gte(1e8) ? [1e8, '億'] : [1e4, '萬'];
    body = value.div(div).toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toString() + unit;
  } else {
    let dp: number;
    if (decimals === 'auto') dp = value.isInteger() ? 0 : info.exp;
    else dp = Math.min(decimals, info.exp);
    const fixed = value.toFixed(dp, Decimal.ROUND_HALF_UP);
    body = thousands ? addThousands(fixed) : fixed;
  }
  const s = minor < 0 ? (sign === 'never' ? '' : '-') : minor > 0 && sign === 'always' ? '+' : '';
  return `${s}${symbol ? info.symbol : ''}${body}`;
}

export function addThousands(fixed: string): string {
  const [int, frac] = fixed.split('.');
  const withSep = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac !== undefined ? `${withSep}.${frac}` : withSep;
}
