/**
 * 預計扣款（純函式，全部在本機推算，不使用 AI、不連網）。
 *
 * 來源是異常偵測找到的「看起來是固定扣款、但還沒登記」的項目（每週／每月／每年、金額穩定）。
 * 推算下一次扣款日：每月用「同一天」（不是 +30 天，避免越推越偏），每年同月同日，每週 +7 天。
 * 預計日已到（今天或之前）、而且還沒超過寬限天數 → 變成收件匣的待確認項目；
 * 使用者記帳後最近一筆帳目的日期會往後移，這一項就自然消失，不會重複出現。
 */
import { addDays, addMonths, type DateKey } from './period';
import type { Finding, SubPeriod } from './anomaly';

export interface ForecastItem {
  /** 穩定的 id（同一個項目、同一個預計日永遠一樣）：用來「略過」這一次 */
  id: string;
  name: string;
  amountMinor: number;
  currency: string;
  accountId: string;
  categoryId: string;
  /** 預計扣款日 */
  dueDate: DateKey;
  /** 已經過了幾天（0 = 今天） */
  lateDays: number;
  period: SubPeriod;
  kind: 'subscription' | 'normal';
  /** 來源偵測結果（「登記成週期」用） */
  finding: Finding;
}

/** 超過這麼多天還沒記就不再提示（可能已改用別的方式付、或已經不扣了） */
export const GRACE_DAYS: Record<SubPeriod, number> = { week: 3, month: 10, year: 14 };

export function nextChargeDate(last: DateKey, period: SubPeriod): DateKey {
  return period === 'week' ? addDays(last, 7) : period === 'month' ? addMonths(last, 1) : addMonths(last, 12);
}

const daysBetween = (a: DateKey, b: DateKey) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/** 從偵測結果挑出「今天該扣了」的項目。skipped：使用者已略過的 id */
export function forecastCharges(findings: readonly Finding[], today: DateKey, skipped: ReadonlySet<string> = new Set()): ForecastItem[] {
  const out: ForecastItem[] = [];
  for (const f of findings) {
    const s = f.subscription;
    if (f.kind !== 'subscription' || !s) continue;
    const dueDate = nextChargeDate(f.date, s.period);
    const lateDays = daysBetween(dueDate, today);
    if (lateDays < 0 || lateDays > GRACE_DAYS[s.period]) continue;
    const id = `charge:${f.id}:${dueDate}`;
    if (skipped.has(id)) continue;
    out.push({
      id, name: s.name, amountMinor: s.amountMinor, currency: s.currency, accountId: s.accountId, categoryId: s.categoryId,
      dueDate, lateDays, period: s.period, kind: s.kind, finding: f,
    });
  }
  return out.sort((a, b) => (a.dueDate === b.dueDate ? b.amountMinor - a.amountMinor : a.dueDate < b.dueDate ? -1 : 1));
}
