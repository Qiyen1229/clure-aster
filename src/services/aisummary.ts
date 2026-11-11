/**
 * 讀取資料庫，整理成給 AI 的去識別化收支摘要（見 domain/aisummary）。
 * 這個檔案只負責讀資料；哪些欄位會被送出由 domain 層決定並有單元測試。
 */
import { db } from '@/db/schema';
import { computeBudgets, goalSaved, projectStats } from '@/db/repo/plan';
import { listStatTxs } from '@/db/repo/ledger';
import { buildFinanceSummary, monthlyFixed, monthRanges, type AiSummary, type SumTx } from '@/domain/aisummary';
import { durableStats, totalDailyBurn } from '@/domain/durable';
import { netByPerson } from '@/domain/debt';
import { loanStatus } from '@/domain/loan';
import { countsInStats, statAmount } from '@/domain/ledger';
import { todayKey } from '@/domain/period';
import { currencyInfo } from '@/domain/money';
import { useSettings } from '@/stores/settings';
import { netWorthSeries } from './networth';

export async function loadFinanceSummary(today = todayKey()): Promise<{ summary: AiSummary; decimals: number; categories: string[] }> {
  const s = useSettings.getState();
  const base = s.baseCurrency;
  const decimals = currencyInfo(base).exp;
  const ranges = monthRanges(today, s.monthStartDay, 6);
  const [txRows, cats, rules, installments, accounts, budgets, goals, nw, durables, debts, projects] = await Promise.all([
    listStatTxs(ranges[0].start, today),
    db.categories.toArray(), db.recurring_rules.toArray(), db.installments.toArray(), db.accounts.toArray(),
    computeBudgets(today), db.goals.toArray(), netWorthSeries(1).catch(() => []),
    db.durables.toArray().catch(() => []), db.debts.toArray().catch(() => []), db.projects.toArray().catch(() => []),
  ]);
  const txs: SumTx[] = txRows
    .filter((t) => countsInStats(t) && (t.type === 'expense' || t.type === 'income' || t.type === 'transfer_fee') && !t.categoryId.startsWith('sys-'))
    .map((t) => ({ date: t.date, type: t.type === 'income' ? 'income' : 'expense', categoryId: t.categoryId, amount: statAmount(t) }));
  const loanPayments = accounts.filter((a) => a.loan && !a.archived && a.currency === base)
    .map((a) => { const st = loanStatus(a.loan!, a.balanceMinor, today); return st?.next ? st.paymentMinor : 0; });
  const activeGoals = goals.filter((g) => g.status === 'active');
  const goalRows = await Promise.all(activeGoals.map(async (g) => ({ name: g.name, target: g.targetMinor, saved: await goalSaved(g), deadline: g.deadline })));

  const activeDurables = durables.filter((d) => !d.deletedAt && d.status === 'active');
  const durablesSummary = activeDurables.length ? {
    count: activeDurables.length,
    totalDailyBurn: Math.round(totalDailyBurn(activeDurables, today, base) / 10 ** decimals),
    items: activeDurables.slice(0, 5).map((d) => {
      const st = durableStats(d, today);
      return {
        name: d.name,
        cost: Math.round(d.costMinor / 10 ** decimals),
        days: st.days,
        perDay: Math.round(st.perDayMinor / 10 ** decimals),
      };
    }),
  } : undefined;

  const openDebts = debts.filter((d) => !d.deletedAt && !d.settled);
  const netMap = netByPerson(openDebts);
  let owedToMe = 0, iOweThem = 0;
  for (const byCur of netMap.values()) {
    const v = byCur.get(base) ?? 0;
    if (v > 0) owedToMe += v; else iOweThem += -v;
  }
  const debtsSummary = openDebts.length ? {
    theyOweMe: Math.round(owedToMe / 10 ** decimals),
    iOweThem: Math.round(iOweThem / 10 ** decimals),
    count: openDebts.length,
  } : undefined;

  const activeProjects = projects.filter((p) => !p.deletedAt && p.status === 'active');
  const projectItems = await Promise.all(activeProjects.slice(0, 5).map(async (p) => {
    const st = await projectStats(p);
    return {
      name: p.name,
      spent: Math.round(st.expense / 10 ** decimals),
      ...(p.budgetMinor ? { budget: Math.round(p.budgetMinor / 10 ** decimals) } : {}),
    };
  }));
  const projectsSummary = activeProjects.length ? {
    count: activeProjects.length,
    items: projectItems,
  } : undefined;

  const summary = buildFinanceSummary({
    today, currency: base, decimals, monthStartDay: s.monthStartDay, txs, cats,
    fixed: monthlyFixed(rules, installments.filter((i) => i.currency === base), loanPayments, today),
    budgets: budgets.map((v) => ({ name: v.budget.name, limit: v.status.limit, spent: v.status.spent })),
    goals: goalRows, netWorth: nw.length ? nw[nw.length - 1].netWorth : undefined,
    durables: durablesSummary, debts: debtsSummary, projects: projectsSummary,
  });
  return { summary, decimals, categories: cats.filter((c) => c.kind === 'expense' && !c.archived && !c.system && !c.parentId).map((c) => c.name) };
}
