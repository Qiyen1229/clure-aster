/**
 * 市場狀態：盤前／盤中／已收盤／休市。以交易所時區判斷（Asia/Taipei、America/New_York、Asia/Hong_Kong）。
 * 台股休市日：內建清單（離線備援）＋ 啟動時從證交所 OpenAPI 取得的最新行事曆（addTwHolidays）；美股假日以規則計算。
 */
import type { Market } from '@/db/types';

export type MarketState = 'pre' | 'open' | 'closed' | 'holiday';

export const MARKET_STATE_LABEL: Record<MarketState, string> = { pre: '盤前', open: '盤中', closed: '已收盤', holiday: '休市' };

/** 台股休市日（2025–2026，含補假；週末不需列入）。資料來源：臺灣證券交易所公告，若與實際不同請修正。 */
export const TW_HOLIDAYS = new Set<string>([
  // 2025
  '2025-01-01', '2025-01-23', '2025-01-24', '2025-01-27', '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31',
  '2025-02-28', '2025-04-03', '2025-04-04', '2025-05-01', '2025-05-30', '2025-09-29', '2025-10-06', '2025-10-10',
  '2025-10-24', '2025-12-25',
  // 2026
  '2026-01-01', '2026-02-12', '2026-02-13', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20',
  '2026-02-27', '2026-04-03', '2026-04-06', '2026-05-01', '2026-06-19', '2026-09-25', '2026-09-28', '2026-10-09',
  '2026-10-26', '2026-12-25',
]);

/** 加入從證交所取得的休市日（YYYY-MM-DD） */
export function addTwHolidays(dates: Iterable<string>): void {
  for (const d of dates) if (/^\d{4}-\d{2}-\d{2}$/.test(d)) TW_HOLIDAYS.add(d);
}

/**
 * 解析證交所 OpenAPI「市場開休市日期」（/v1/holidaySchedule/holidaySchedule）。
 * 日期為民國年 yyyMMdd；「開始交易」「最後交易」那幾天照常交易，不算休市。
 */
export function parseTwseHolidays(rows: { Name?: string; Date?: string; Description?: string }[]): string[] {
  const out: string[] = [];
  for (const r of rows ?? []) {
    const m = /^(\d{3})(\d{2})(\d{2})$/.exec(String(r.Date ?? '').trim());
    if (!m) continue;
    const text = `${r.Name ?? ''}${r.Description ?? ''}`;
    if (/開始交易|最後交易|照常交易/.test(text) && !/無交易/.test(text)) continue;
    out.push(`${Number(m[1]) + 1911}-${m[2]}-${m[3]}`);
  }
  return out;
}

interface ZonedParts { date: string; minutes: number; weekday: number }

export function zonedParts(now: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const hour = Number(get('hour')) % 24;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: hour * 60 + Number(get('minute')), weekday: wd };
}

/** 復活節（Gregorian，Anonymous algorithm） */
function easter(y: number): Date {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(y, month - 1, day));
}

const key = (d: Date) => d.toISOString().slice(0, 10);
function nthWeekday(y: number, m0: number, wd: number, n: number): string {
  const d = new Date(Date.UTC(y, m0, 1));
  const shift = (wd - d.getUTCDay() + 7) % 7;
  d.setUTCDate(1 + shift + (n - 1) * 7);
  return key(d);
}
function lastWeekday(y: number, m0: number, wd: number): string {
  const d = new Date(Date.UTC(y, m0 + 1, 0));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - wd + 7) % 7));
  return key(d);
}
function observed(y: number, m0: number, day: number): string {
  const d = new Date(Date.UTC(y, m0, day));
  if (d.getUTCDay() === 6) d.setUTCDate(day - 1);
  if (d.getUTCDay() === 0) d.setUTCDate(day + 1);
  return key(d);
}

export function usHolidays(y: number): Set<string> {
  const gf = easter(y);
  gf.setUTCDate(gf.getUTCDate() - 2);
  return new Set([
    observed(y, 0, 1), nthWeekday(y, 0, 1, 3), nthWeekday(y, 1, 1, 3), key(gf), lastWeekday(y, 4, 1),
    observed(y, 5, 19), observed(y, 6, 4), nthWeekday(y, 8, 1, 1), nthWeekday(y, 10, 4, 4), observed(y, 11, 25),
  ]);
}

const SESSIONS: Record<'TW' | 'US' | 'HK', { tz: string; pre: number; open: number; close: number }> = {
  TW: { tz: 'Asia/Taipei', pre: 8 * 60 + 30, open: 9 * 60, close: 13 * 60 + 30 },
  US: { tz: 'America/New_York', pre: 4 * 60, open: 9 * 60 + 30, close: 16 * 60 },
  HK: { tz: 'Asia/Hong_Kong', pre: 9 * 60, open: 9 * 60 + 30, close: 16 * 60 },
};

export function marketGroup(m: Market): 'TW' | 'US' | 'HK' {
  return m === 'US' ? 'US' : m === 'HK' ? 'HK' : 'TW';
}

export function marketState(m: Market, now = new Date()): MarketState {
  const g = marketGroup(m);
  const s = SESSIONS[g];
  const p = zonedParts(now, s.tz);
  if (p.weekday === 0 || p.weekday === 6) return 'holiday';
  if (g === 'TW' && TW_HOLIDAYS.has(p.date)) return 'holiday';
  if (g === 'US' && usHolidays(Number(p.date.slice(0, 4))).has(p.date)) return 'holiday';
  if (p.minutes < s.pre) return 'closed';
  if (p.minutes < s.open) return 'pre';
  if (p.minutes < s.close) return 'open';
  return 'closed';
}

/** 交易所當地日期（用於每日快照與「今日」判斷） */
export function exchangeDate(m: Market, now = new Date()): string {
  return zonedParts(now, SESSIONS[marketGroup(m)].tz).date;
}
