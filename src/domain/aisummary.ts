/**
 * 給 AI 看的「去識別化收支摘要」（純函式）。
 * 只包含統計數字與使用者自訂的分類名稱：不含備註、商家、帳戶名稱、標籤、單筆帳目與日期明細。
 * 金額一律轉成「主幣別的整數元」（例如 TWD 12,345），讓模型好讀、也減少 token。
 */
import type { Category, Installment, RecurringRule } from '@/db/types';
import type { PeriodSummary } from './summary';
import { accountingMonth, addDays, eachDay, type DateKey, type Range } from './period';
import { timesPerYear } from './recurrence';

export interface SumTx { date: DateKey; type: 'expense' | 'income'; categoryId: string; amount: number }
export interface SumBudget { name: string; limit: number; spent: number }
export interface SumGoal { name: string; target: number; saved: number; deadline?: string }

export interface SummaryInput {
  today: DateKey;
  currency: string;
  /** 主幣別的小數位數（TWD 2、JPY 0）：minor → 整數元 */
  decimals: number;
  monthStartDay: number;
  txs: SumTx[];
  cats: Pick<Category, 'id' | 'name' | 'parentId' | 'kind'>[];
  fixed: { subscriptions: number; installments: number; loans: number; otherRecurring: number };
  budgets: SumBudget[];
  goals: SumGoal[];
  netWorth?: number;
}

export interface AiMonth {
  label: string;
  expense: number;
  income: number;
  /** 進行中的月份（還沒結束，不要拿來算平均） */
  partial?: boolean;
  daysElapsed?: number;
  byCategory: Record<string, number>;
}

export interface AiSummary {
  currency: string;
  today: DateKey;
  months: AiMonth[];
  /** 已完整結束的月份平均（沒有完整月份時為 0） */
  avgExpense: number;
  avgIncome: number;
  completedMonths: number;
  fixedMonthly: { total: number; subscriptions: number; installments: number; loans: number; otherRecurring: number };
  budgets: SumBudget[];
  goals: SumGoal[];
  netWorth?: number;
  nextMonth: { label: string; days: number };
}

const major = (minor: number, decimals: number) => Math.round(minor / 10 ** decimals);
const TOP_CATEGORIES = 10;

/** 記帳月的標籤用「起始日所在的年月」 */
const monthLabel = (r: Range) => r.start.slice(0, 7);

/** 本期往前的 N 個完整記帳月（由舊到新）＋本期 */
export function monthRanges(today: DateKey, startDay: number, back: number): Range[] {
  const cur = accountingMonth(today, startDay);
  const out: Range[] = [cur];
  let cursor = cur.start;
  for (let i = 0; i < back; i++) {
    const r = accountingMonth(addDays(cursor, -1), startDay);
    out.unshift(r);
    cursor = r.start;
  }
  return out;
}

export function buildFinanceSummary(input: SummaryInput, back = 6): AiSummary {
  const { today, decimals } = input;
  const root = new Map(input.cats.map((c) => [c.id, c.parentId || c.id]));
  const name = new Map(input.cats.map((c) => [c.id, c.name]));
  const ranges = monthRanges(today, input.monthStartDay, back);
  const months: AiMonth[] = ranges.map((r) => {
    const partial = r.end >= today;
    const by = new Map<string, number>();
    let expense = 0, income = 0;
    for (const t of input.txs) {
      if (t.date < r.start || t.date > r.end) continue;
      if (t.type === 'income') { income += t.amount; continue; }
      expense += t.amount;
      const n = name.get(root.get(t.categoryId) ?? t.categoryId) ?? '其他';
      by.set(n, (by.get(n) ?? 0) + t.amount);
    }
    const sorted = [...by.entries()].sort((a, b) => b[1] - a[1]);
    const byCategory: Record<string, number> = {};
    let rest = 0;
    sorted.forEach(([n, v], i) => { if (i < TOP_CATEGORIES) byCategory[n] = major(v, decimals); else rest += v; });
    if (rest) byCategory['其餘分類'] = major(rest, decimals);
    return {
      label: monthLabel(r), expense: major(expense, decimals), income: major(income, decimals), byCategory,
      ...(partial ? { partial: true, daysElapsed: eachDay({ start: r.start, end: today }).length } : {}),
    };
  });
  // 還沒有任何資料的最舊月份不送（省 token，也避免誤導平均）
  const trimmed = months.filter((m, i) => m.expense || m.income || i >= months.length - 1);
  const done = trimmed.filter((m) => !m.partial && (m.expense > 0 || m.income > 0));
  const avg = (k: 'expense' | 'income') => (done.length ? Math.round(done.reduce((a, m) => a + m[k], 0) / done.length) : 0);
  const f = input.fixed;
  const fixedTotal = f.subscriptions + f.installments + f.loans + f.otherRecurring;
  const next = accountingMonth(addDays(ranges[ranges.length - 1].end, 1), input.monthStartDay);
  return {
    currency: input.currency, today, months: trimmed, avgExpense: avg('expense'), avgIncome: avg('income'), completedMonths: done.length,
    fixedMonthly: {
      total: major(fixedTotal, decimals), subscriptions: major(f.subscriptions, decimals), installments: major(f.installments, decimals),
      loans: major(f.loans, decimals), otherRecurring: major(f.otherRecurring, decimals),
    },
    budgets: input.budgets.map((b) => ({ name: b.name, limit: major(b.limit, decimals), spent: major(b.spent, decimals) })),
    goals: input.goals.map((g) => ({ name: g.name, target: major(g.target, decimals), saved: major(g.saved, decimals), ...(g.deadline ? { deadline: g.deadline } : {}) })),
    ...(input.netWorth !== undefined ? { netWorth: major(input.netWorth, decimals) } : {}),
    nextMonth: { label: monthLabel(next), days: eachDay(next).length },
  };
}

/** 每月固定支出：週期／訂閱（只算支出）換算成月；分期與貸款取下一期金額 */
export function monthlyFixed(rules: Pick<RecurringRule, 'active' | 'template' | 'rule' | 'kind'>[], installments: Pick<Installment, 'status' | 'schedule'>[],
  loanPayments: number[], today: DateKey): SummaryInput['fixed'] {
  let subscriptions = 0, otherRecurring = 0;
  for (const r of rules) {
    if (!r.active || r.template.type !== 'expense') continue;
    const monthly = ((r.template.baseAmountMinor ?? r.template.amountMinor ?? 0) * timesPerYear(r.rule)) / 12;
    if (r.kind === 'subscription') subscriptions += monthly; else otherRecurring += monthly;
  }
  let inst = 0;
  for (const i of installments) {
    if (i.status !== 'active') continue;
    const next = i.schedule.find((s) => !s.transactionId && s.date >= today);
    if (next) inst += next.principalMinor + next.interestMinor + next.feeMinor;
  }
  return { subscriptions: Math.round(subscriptions), otherRecurring: Math.round(otherRecurring), installments: inst, loans: loanPayments.reduce((a, b) => a + b, 0) };
}

/** 日常預算 = （總預算 − 每月固定支出）÷ 天數。總預算不足以支付固定支出時為 0 */
export function dailyAllowance(total: number, fixedTotal: number, days: number): number {
  if (!(days > 0)) return 0;
  return Math.max(0, Math.floor((total - fixedTotal) / days));
}

/** 週報／月報 → 給 AI 的精簡 JSON（只有分類層級的統計，沒有任何單筆帳目） */
export function periodToAi(sum: PeriodSummary, cats: Map<string, Category>, label: string, currency: string, decimals: number) {
  const m = (v: number) => major(v, decimals);
  return {
    currency, period: label,
    expense: m(sum.expense), income: m(sum.income), prevExpense: m(sum.prevExpense), prevIncome: m(sum.prevIncome),
    changePct: sum.changePct === null ? null : Math.round(sum.changePct), count: sum.count,
    noSpendDays: sum.noSpendDays, elapsedDays: sum.elapsedDays, dailyAvg: m(sum.dailyAvg),
    categories: sum.categories.slice(0, 10).map((c) => ({ name: cats.get(c.id)?.name ?? '其他', amount: m(c.amount), prev: m(c.prev) })),
    biggestSingle: sum.biggest ? { category: cats.get(sum.biggest.categoryId)?.name ?? '其他', amount: m(sum.biggest.baseAmountMinor) } : null,
  };
}

export interface PlanBudgetItem { name: string; categoryId: string; amountMinor: number }

/** AI 預算建議 → 要建立的預算（分類名稱對回 id；已經有月預算的分類略過；總預算只在還沒有時建立） */
export function planToBudgetInputs(plan: { total: number; categories: { name: string; amount: number }[] }, cats: Pick<Category, 'id' | 'name' | 'parentId' | 'kind'>[],
  existing: { categoryId: string; periodType: string; projectId: string; active: 0 | 1 }[], decimals: number): { items: PlanBudgetItem[]; skipped: string[] } {
  const minor = (v: number) => Math.round(v * 10 ** decimals);
  const have = new Set(existing.filter((b) => b.active && b.periodType === 'month' && !b.projectId).map((b) => b.categoryId));
  const items: PlanBudgetItem[] = [];
  const skipped: string[] = [];
  if (!have.has('')) items.push({ name: '每月總預算', categoryId: '', amountMinor: minor(plan.total) });
  else skipped.push('總預算');
  for (const c of plan.categories) {
    const cat = cats.find((x) => x.kind === 'expense' && x.name === c.name && !x.parentId) ?? cats.find((x) => x.kind === 'expense' && x.name === c.name);
    if (!cat) { skipped.push(c.name); continue; }
    if (have.has(cat.id)) { skipped.push(c.name); continue; }
    items.push({ name: `${cat.name}預算`, categoryId: cat.id, amountMinor: minor(c.amount) });
  }
  return { items, skipped };
}

/** 穩定的簡單雜湊（快取鍵用，不是安全用途） */
export function hashJson(obj: unknown): string {
  const s = JSON.stringify(obj);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const mj = (minor: number, decimals: number) => Math.round(minor / 10 ** decimals);

/** 專案（例如旅行）的去識別化摘要：預算、花費、分類佔比、每日花費；不含備註與商家 */
export function projectToAi(input: {
  name: string; currency: string; decimals: number; start: DateKey; end?: DateKey; today: DateKey; budgetMinor?: number;
  expense: number; income: number; byCat: Map<string, number>; byDay: Map<string, number>; cats: Pick<Category, 'id' | 'name' | 'parentId'>[];
}) {
  const root = new Map(input.cats.map((c) => [c.id, c.parentId || c.id]));
  const name = new Map(input.cats.map((c) => [c.id, c.name]));
  const by = new Map<string, number>();
  for (const [id, v] of input.byCat) { const n = name.get(root.get(id) ?? id) ?? '其他'; by.set(n, (by.get(n) ?? 0) + v); }
  const last = input.end && input.end < input.today ? input.end : input.today;
  const days = Math.max(1, eachDay({ start: input.start, end: last < input.start ? input.start : last }).length);
  const maxDay = [...input.byDay.values()].reduce((a, b) => Math.max(a, b), 0);
  const d = input.decimals;
  return {
    subjectType: '專案', name: input.name, currency: input.currency, start: input.start, end: input.end ?? null, days,
    budget: input.budgetMinor ? mj(input.budgetMinor, d) : null, expense: mj(input.expense, d), income: mj(input.income, d),
    budgetUsedPct: input.budgetMinor ? Math.round((input.expense / input.budgetMinor) * 100) : null,
    dailyAvg: mj(input.expense / days, d), maxDay: mj(maxDay, d), spendDays: input.byDay.size,
    byCategory: Object.fromEntries([...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n, v]) => [n, mj(v, d)])),
  };
}

/** 帳戶的去識別化摘要：餘額、近 3 個月收支、主要分類；不含備註與商家 */
export function accountToAi(input: {
  name: string; typeLabel: string; currency: string; decimals: number; balanceMinor: number; isDebt: boolean; creditLimitMinor?: number;
  today: DateKey; txs: { date: DateKey; type: 'expense' | 'income'; categoryId: string; amountMinor: number }[]; cats: Pick<Category, 'id' | 'name' | 'parentId'>[];
}) {
  const d = input.decimals;
  const root = new Map(input.cats.map((c) => [c.id, c.parentId || c.id]));
  const name = new Map(input.cats.map((c) => [c.id, c.name]));
  const ranges = monthRanges(input.today, 1, 2);
  const months = ranges.map((r) => {
    let expense = 0, income = 0;
    for (const t of input.txs) if (t.date >= r.start && t.date <= r.end) { if (t.type === 'income') income += t.amountMinor; else expense += t.amountMinor; }
    return { label: r.start.slice(0, 7), expense: mj(expense, d), income: mj(income, d), ...(r.end >= input.today ? { partial: true } : {}) };
  });
  const by = new Map<string, number>();
  for (const t of input.txs) if (t.type === 'expense') { const n = name.get(root.get(t.categoryId) ?? t.categoryId) ?? '其他'; by.set(n, (by.get(n) ?? 0) + t.amountMinor); }
  return {
    subjectType: '帳戶', name: input.name, type: input.typeLabel, currency: input.currency,
    [input.isDebt ? 'owed' : 'balance']: mj(input.isDebt ? -input.balanceMinor : input.balanceMinor, d),
    ...(input.creditLimitMinor ? { creditLimit: mj(input.creditLimitMinor, d), creditUsedPct: Math.round((-input.balanceMinor / input.creditLimitMinor) * 100) } : {}),
    months, topExpenseCategories: Object.fromEntries([...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, v]) => [n, mj(v, d)])), txCount: input.txs.length,
  };
}
