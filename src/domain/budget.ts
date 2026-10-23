/**
 * 預算期間、結轉與狀態計算。
 * 結轉規則：本期可用 = 本期額度 + 上期結餘（上期結餘可為負，代表超支會吃掉下期額度）。
 */
import { accountingMonth, addDays, eachDay, weekRange, type DateKey, type Range } from './period';

export interface BudgetLike {
  periodType: 'month' | 'week' | 'custom';
  customDays?: number;
  startDate: DateKey;
  amountMinor: number;
  rollover: boolean;
}

/** 包含 date 的預算期間 */
export function budgetPeriod(b: BudgetLike, date: DateKey, opts: { monthStartDay: number; weekStart: 0 | 1 }): Range {
  if (b.periodType === 'month') return accountingMonth(date, opts.monthStartDay);
  if (b.periodType === 'week') return weekRange(date, opts.weekStart);
  const len = Math.max(1, b.customDays ?? 30);
  const diff = Math.floor((Date.parse(date) - Date.parse(b.startDate)) / 86400000);
  const k = Math.floor(diff / len);
  const start = addDays(b.startDate, k * len);
  return { start, end: addDays(start, len - 1) };
}

/** 從 startDate 所在期間到 date 所在期間（含）的所有期間 */
export function periodsUntil(b: BudgetLike, date: DateKey, opts: { monthStartDay: number; weekStart: 0 | 1 }, max = 120): Range[] {
  const out: Range[] = [];
  let p = budgetPeriod(b, b.startDate <= date ? b.startDate : date, opts);
  while (out.length < max) {
    out.push(p);
    if (p.end >= date) break;
    p = budgetPeriod(b, addDays(p.end, 1), opts);
  }
  return out.slice(-max);
}

/** 依序計算各期結轉後的額度。spent[i] 對應 periods[i] */
export function rolloverChain(amountMinor: number, spent: number[], rollover: boolean): { limit: number; carryIn: number }[] {
  const out: { limit: number; carryIn: number }[] = [];
  let carry = 0;
  for (let i = 0; i < spent.length; i++) {
    const carryIn = rollover ? carry : 0;
    const limit = amountMinor + carryIn;
    out.push({ limit, carryIn });
    carry = limit - spent[i];
  }
  return out;
}

export interface BudgetStatus {
  limit: number;
  spent: number;
  remaining: number;
  pct: number;
  daysLeft: number;
  dailyAllowance: number;
  /** 依目前花費速度推估期末花費 */
  projected: number;
  /**
   * 今日額度（Moze 式動態每日可用）：今天開始前的剩餘預算 ÷ 剩餘天數（含今天），整天固定不變。
   * 今天少花，省下的錢明天自動平攤到之後每一天；今天超支，之後每日額度自動減少。
   */
  todayBudget: number;
  /** 今日還可以花 = 今日額度 − 今天已花（可為負，代表今天超支） */
  todayLeft: number;
  spentToday: number;
  level: 'ok' | 'warn' | 'over';
}

export function budgetStatus(limit: number, spent: number, period: Range, today: DateKey, warnPct = 80, spentToday = 0): BudgetStatus {
  const total = eachDay(period).length;
  const elapsed = today < period.start ? 0 : today > period.end ? total : eachDay({ start: period.start, end: today }).length;
  const daysLeft = Math.max(0, total - elapsed + (today >= period.start && today <= period.end ? 1 : 0));
  const remaining = limit - spent;
  const pct = limit > 0 ? (spent / limit) * 100 : spent > 0 ? 100 : 0;
  const projected = elapsed > 0 ? Math.round((spent / elapsed) * total) : spent;
  return {
    limit, spent, remaining, pct, daysLeft,
    dailyAllowance: daysLeft > 0 && remaining > 0 ? Math.floor(remaining / daysLeft) : 0,
    projected,
    ...todayAllowance(limit - (spent - spentToday), spentToday, daysLeft, today >= period.start && today <= period.end),
    level: spent > limit ? 'over' : pct >= warnPct ? 'warn' : 'ok',
  };
}

/** 今日額度：以「今天之前」的剩餘預算平均分到剩餘天數（含今天）；不在期間內則為 0 */
export function todayAllowance(remainingBeforeToday: number, spentToday: number, daysLeftInclToday: number, inPeriod = true) {
  if (!inPeriod || daysLeftInclToday <= 0) return { todayBudget: 0, todayLeft: 0, spentToday };
  const todayBudget = Math.max(0, Math.floor(remainingBeforeToday / daysLeftInclToday));
  return { todayBudget, todayLeft: todayBudget - spentToday, spentToday };
}
