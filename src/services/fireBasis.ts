/**
 * 財務自由試算的「現況」：目前淨資產與近 12 個月收支（記帳不滿一年依實際天數換算成全年）。
 * 財務自由頁與對話裡的檢視卡共用同一份算法。
 */
import { db } from '@/db/schema';
import { totals } from '@/domain/ledger';
import { addDays, todayKey } from '@/domain/period';
import { netWorthSeries } from './networth';

export interface FireBasis { netWorth: number; expense: number; income: number; days: number }

export async function loadFireBasis(): Promise<FireBasis> {
  const since = addDays(todayKey(), -365);
  const txs = (await db.transactions.where('date').aboveOrEqual(since).toArray()).filter((t) => !t.deletedAt);
  const t = totals(txs);
  const nw = (await netWorthSeries(0)).at(-1)?.netWorth ?? 0;
  const first = txs.reduce((m, x) => (x.date < m ? x.date : m), todayKey());
  const days = Math.max(30, Math.round((Date.parse(todayKey()) - Date.parse(first)) / 86400000) + 1);
  const k = days < 365 ? 365 / days : 1;
  return { netWorth: nw, expense: Math.round(t.expense * k), income: Math.round(t.income * k), days: Math.min(days, 365) };
}
