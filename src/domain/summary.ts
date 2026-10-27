/**
 * 週報／月報（純函式）：這期花了多少、和上一期比、分類變化、最大一筆、無消費日，並整理成幾句白話重點。
 * 金額一律為主幣別最小單位（statAmount：分帳只算我的份額）。
 */
import type { Category, Transaction } from '@/db/types';
import { countsInStats, statAmount } from './ledger';
import { addDays, eachDay, type Range } from './period';
import { pctChange } from './reports';

export interface CategoryDelta { id: string; amount: number; prev: number; delta: number; topSubId?: string }

export interface PeriodSummary {
  range: Range;
  prevRange: Range;
  expense: number;
  income: number;
  prevExpense: number;
  prevIncome: number;
  /** 支出增減 %（上一期沒有支出時為 null） */
  changePct: number | null;
  count: number;
  /** 已經過去的天數中，完全沒有支出的天數 */
  noSpendDays: number;
  elapsedDays: number;
  dailyAvg: number;
  categories: CategoryDelta[];
  biggest?: Transaction;
  /** 白話重點（2～4 句） */
  insights: string[];
}

function byMain(txs: Transaction[], cats: Map<string, Category>) {
  const main = new Map<string, number>();
  const sub = new Map<string, Map<string, number>>();
  for (const t of txs) {
    if (!countsInStats(t) || t.type === 'income') continue;
    const c = cats.get(t.categoryId);
    const m = c?.parentId || t.categoryId;
    const v = statAmount(t);
    main.set(m, (main.get(m) ?? 0) + v);
    const s = sub.get(m) ?? new Map<string, number>();
    s.set(t.categoryId, (s.get(t.categoryId) ?? 0) + v);
    sub.set(m, s);
  }
  return { main, sub };
}

export function summarize(cur: Transaction[], prev: Transaction[], cats: Map<string, Category>, range: Range, prevRange: Range,
  today: string, fmt: (minor: number) => string, unitLabel: '週' | '月'): PeriodSummary {
  let expense = 0, income = 0, count = 0;
  let biggest: Transaction | undefined;
  const spendDays = new Set<string>();
  for (const t of cur) {
    if (!countsInStats(t)) continue;
    count++;
    const v = statAmount(t);
    if (t.type === 'income') { income += v; continue; }
    expense += v;
    spendDays.add(t.date);
    if (!biggest || v > statAmount(biggest)) biggest = t;
  }
  let prevExpense = 0, prevIncome = 0;
  for (const t of prev) {
    if (!countsInStats(t)) continue;
    if (t.type === 'income') prevIncome += statAmount(t); else prevExpense += statAmount(t);
  }
  const last = today < range.end ? addDays(today, -1) : range.end;
  const elapsed = last >= range.start ? eachDay({ start: range.start, end: last }) : [];
  const noSpendDays = elapsed.filter((d) => !spendDays.has(d)).length;
  const days = today < range.end ? Math.max(1, eachDay({ start: range.start, end: today }).length) : eachDay(range).length;

  const a = byMain(cur, cats);
  const b = byMain(prev, cats);
  const ids = new Set([...a.main.keys(), ...b.main.keys()]);
  const categories: CategoryDelta[] = [...ids].map((id) => {
    const amount = a.main.get(id) ?? 0;
    const p = b.main.get(id) ?? 0;
    const subs = [...(a.sub.get(id) ?? new Map()).entries()].sort((x, y) => y[1] - x[1]);
    return { id, amount, prev: p, delta: amount - p, topSubId: subs[0]?.[0] };
  }).sort((x, y) => y.amount - x.amount);

  const changePct = pctChange(expense, prevExpense);
  const name = (id?: string) => (id ? cats.get(id)?.name ?? '其他' : '其他');
  // 「前一週／前一個月」：通知標題是「上週花了…」，比較對象不能再叫「上週」
  const prevName = unitLabel === '週' ? '前一週' : '前一個月';
  const insights: string[] = [];
  if (expense === 0 && income === 0) insights.push(`這${unitLabel}還沒有任何記帳。`);
  else {
    if (changePct === null) insights.push(`這${unitLabel}支出 ${fmt(expense)}。`);
    else if (Math.abs(changePct) < 3) insights.push(`支出 ${fmt(expense)}，和${prevName}差不多。`);
    else if (changePct < 0) insights.push(`比${prevName}少花 ${Math.round(-changePct)}%（省下 ${fmt(prevExpense - expense)}）👏`);
    else insights.push(`比${prevName}多花 ${Math.round(changePct)}%（多了 ${fmt(expense - prevExpense)}）。`);
    const up = [...categories].filter((c) => c.delta > 0 && c.prev > 0).sort((x, y) => y.delta - x.delta)[0];
    const down = [...categories].filter((c) => c.delta < 0).sort((x, y) => x.delta - y.delta)[0];
    if (up && up.delta >= Math.max(expense * 0.05, 1)) {
      const sub = up.topSubId && up.topSubId !== up.id ? `，主要是「${name(up.topSubId)}」` : '';
      insights.push(`「${name(up.id)}」多了 ${fmt(up.delta)}${sub}。`);
    } else if (down && -down.delta >= Math.max(prevExpense * 0.05, 1)) insights.push(`「${name(down.id)}」少了 ${fmt(-down.delta)}。`);
    if (biggest) insights.push(`最大一筆：${biggest.note || name(biggest.categoryId)} ${fmt(statAmount(biggest))}。`);
    if (noSpendDays > 0) insights.push(`有 ${noSpendDays} 天完全沒花錢 🎉`);
    if (unitLabel === '月' && income > 0) insights.push(`儲蓄率 ${Math.round(((income - expense) / income) * 100)}%。`);
  }
  return {
    range, prevRange, expense, income, prevExpense, prevIncome, changePct, count, noSpendDays, elapsedDays: elapsed.length,
    dailyAvg: Math.round(expense / days), categories, biggest, insights: insights.slice(0, 4),
  };
}
