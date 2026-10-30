/**
 * 報表分析（純函式）：分類佔比（主／子）、每日／每月趨勢、星期幾與時段分佈、各項指標。
 * 輸入為已過濾、計入統計的帳目；金額一律使用 statAmount（主幣別、分帳只算我的份額）。
 */
import type { Category, Transaction } from '@/db/types';
import { countsInStats, statAmount } from './ledger';
import { eachDay, type Range } from './period';

export interface Analysis {
  expense: number;
  income: number;
  net: number;
  count: number;
  savingRate: number | null; // %
  ratio: number | null; // 支出 ÷ 收入 %
  dailyAvg: number;
  maxTx?: Transaction;
  byMain: Map<string, number>; // kind 由呼叫端決定
  bySub: Map<string, Map<string, number>>; // main -> sub -> amount
  byDay: Map<string, { expense: number; income: number }>;
  byMonth: Map<string, { expense: number; income: number }>;
  byWeekday: number[]; // 0=日，各星期的花費金額
  byHour: number[]; // 0–23，各時段的花費金額
  weekdayCount: number[]; // 各星期的消費「次數」（筆數）
  hourCount: number[]; // 各時段的消費「次數」（筆數）
  topWeekday: number; // 消費次數最多的星期（次數相同時取金額較大者）
  topHour: number; // 消費次數最多的時段（次數相同時取金額較大者）
  topNotes: { note: string; amount: number; count: number }[];
}

export function analyze(txs: Transaction[], cats: Map<string, Category>, range: Range, kind: 'expense' | 'income' = 'expense', today?: string): Analysis {
  const byMain = new Map<string, number>();
  const bySub = new Map<string, Map<string, number>>();
  const byDay = new Map<string, { expense: number; income: number }>();
  const byMonth = new Map<string, { expense: number; income: number }>();
  const byWeekday = Array(7).fill(0);
  const byHour = Array(24).fill(0);
  const weekdayCount: number[] = Array(7).fill(0);
  const hourCount: number[] = Array(24).fill(0);
  const notes = new Map<string, { amount: number; count: number }>();
  let expense = 0, income = 0, count = 0;
  let maxTx: Transaction | undefined;

  for (const t of txs) {
    if (!countsInStats(t)) continue;
    const v = statAmount(t);
    const isInc = t.type === 'income';
    count++;
    if (isInc) income += v; else expense += v;
    const d = byDay.get(t.date) ?? { expense: 0, income: 0 };
    const m = byMonth.get(t.date.slice(0, 7)) ?? { expense: 0, income: 0 };
    if (isInc) { d.income += v; m.income += v; } else { d.expense += v; m.expense += v; }
    byDay.set(t.date, d);
    byMonth.set(t.date.slice(0, 7), m);
    if ((kind === 'income') !== isInc) continue;
    const c = cats.get(t.categoryId);
    const main = c?.parentId || t.categoryId;
    byMain.set(main, (byMain.get(main) ?? 0) + v);
    const subs = bySub.get(main) ?? new Map<string, number>();
    subs.set(t.categoryId, (subs.get(t.categoryId) ?? 0) + v);
    bySub.set(main, subs);
    if (!isInc) {
      const dt = new Date(t.ts);
      const wd = new Date(`${t.date}T00:00:00`).getDay();
      byWeekday[wd] += v;
      byHour[dt.getHours()] += v;
      weekdayCount[wd]++;
      hourCount[dt.getHours()]++;
      if (!maxTx || v > statAmount(maxTx)) maxTx = t;
      const key = t.note.trim() || c?.name || '';
      if (key) {
        const n = notes.get(key) ?? { amount: 0, count: 0 };
        n.amount += v; n.count++;
        notes.set(key, n);
      }
    }
  }
  const end = today && today < range.end ? today : range.end;
  const days = end >= range.start ? eachDay({ start: range.start, end }).length : 1;
  // 「最常」＝次數最多；次數相同時看金額
  const argmaxBy = (counts: number[], amounts: number[]) => counts.reduce((best, v, i) => (v > counts[best] || (v === counts[best] && amounts[i] > amounts[best]) ? i : best), 0);
  return {
    expense, income, net: income - expense, count,
    savingRate: income > 0 ? ((income - expense) / income) * 100 : null,
    ratio: income > 0 ? (expense / income) * 100 : null,
    dailyAvg: Math.round(expense / Math.max(1, days)),
    maxTx, byMain, bySub, byDay, byMonth, byWeekday, byHour, weekdayCount, hourCount,
    topWeekday: argmaxBy(weekdayCount, byWeekday), topHour: argmaxBy(hourCount, byHour),
    topNotes: [...notes].map(([note, x]) => ({ note, ...x })).sort((a, b) => b.amount - a.amount).slice(0, 5),
  };
}

/** 增減百分比；前期為 0 回傳 null */
export function pctChange(cur: number, prev: number): number | null {
  if (!prev) return null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}
