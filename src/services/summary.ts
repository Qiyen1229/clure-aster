/**
 * 週報／月報：期間計算、讀取帳目並產生摘要、提醒時間。
 * 週的起始日跟隨「設定 → 一般 → 每週起始日」；月跟隨「記帳月起始日」。
 * 新的一週（月）開始那天早上 9 點提醒上一週（月）的摘要。
 */
import { db } from '@/db/schema';
import { listStatTxs } from '@/db/repo/ledger';
import { summarize, type PeriodSummary } from '@/domain/summary';
import { formatMoney } from '@/domain/money';
import { accountingMonth, addDays, todayKey, weekRange, type DateKey, type Range } from '@/domain/period';
import { useSettings } from '@/stores/settings';

export type SummaryUnit = 'week' | 'month';

export function summaryRange(unit: SummaryUnit, anchor: DateKey): { range: Range; prevRange: Range } {
  const s = useSettings.getState();
  const of = (d: DateKey) => (unit === 'week' ? weekRange(d, s.weekStart) : accountingMonth(d, s.monthStartDay));
  const range = of(anchor);
  return { range, prevRange: of(addDays(range.start, -1)) };
}

/** 最近一個已經結束的期間中的一天（「上週」「上個月」） */
export function lastCompleted(unit: SummaryUnit, today = todayKey()): DateKey {
  return addDays(summaryRange(unit, today).range.start, -1);
}

/** today 起 days 天內，新期間開始的日子（提醒上一期摘要的日子） */
export function periodStartsWithin(unit: SummaryUnit, today: DateKey, days: number): DateKey[] {
  const out: DateKey[] = [];
  let d = summaryRange(unit, today).range.start;
  for (let i = 0; i < 60 && out.length < 12; i++) {
    if (d >= today && d <= addDays(today, days)) out.push(d);
    d = addDays(summaryRange(unit, d).range.end, 1);
    if (d > addDays(today, days)) break;
  }
  return out;
}

export async function loadSummary(unit: SummaryUnit, anchor: DateKey, today = todayKey()): Promise<PeriodSummary> {
  const { range, prevRange } = summaryRange(unit, anchor);
  const [cur, prev, cats] = await Promise.all([listStatTxs(range.start, range.end), listStatTxs(prevRange.start, prevRange.end), db.categories.toArray()]);
  const base = useSettings.getState().baseCurrency;
  return summarize(cur, prev, new Map(cats.map((c) => [c.id, c])), range, prevRange, today, (v) => formatMoney(v, base, { decimals: 0 }), unit === 'week' ? '週' : '月');
}

export const summaryTitle = (unit: SummaryUnit, r: Range) =>
  unit === 'week' ? `${Number(r.start.slice(5, 7))}/${Number(r.start.slice(8))}～${Number(r.end.slice(5, 7))}/${Number(r.end.slice(8))}` : `${r.start.slice(0, 4)} 年 ${Number(r.start.slice(5, 7))} 月`;
