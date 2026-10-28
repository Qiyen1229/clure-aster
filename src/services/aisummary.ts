/**
 * 讀取資料庫，整理成給 AI 的去識別化收支摘要（見 domain/aisummary）。
 * 這個檔案只負責讀資料；哪些欄位會被送出由 domain 層決定並有單元測試。
 */
import { db } from '@/db/schema';
import { computeBudgets, goalSaved } from '@/db/repo/plan';
import { listStatTxs } from '@/db/repo/ledger';
import { buildFinanceSummary, monthlyFixed, monthRanges, type AiSummary, type SumTx } from '@/domain/aisummary';
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
  const [txRows, cats, rules, installments, accounts, budgets, goals, nw] = await Promise.all([
    listStatTxs(ranges[0].start, today),
    db.categories.toArray(), db.recurring_rules.toArray(), db.installments.toArray(), db.accounts.toArray(),
    computeBudgets(today), db.goals.toArray(), netWorthSeries(1).catch(() => []),
  ]);
  const txs: SumTx[] = txRows
    .filter((t) => countsInStats(t) && (t.type === 'expense' || t.type === 'income' || t.type === 'transfer_fee') && !t.categoryId.startsWith('sys-'))
    .map((t) => ({ date: t.date, type: t.type === 'income' ? 'income' : 'expense', categoryId: t.categoryId, amount: statAmount(t) }));
  const loanPayments = accounts.filter((a) => a.loan && !a.archived && a.currency === base)
    .map((a) => { const st = loanStatus(a.loan!, a.balanceMinor, today); return st?.next ? st.paymentMinor : 0; });
  const activeGoals = goals.filter((g) => g.status === 'active');
  const goalRows = await Promise.all(activeGoals.map(async (g) => ({ name: g.name, target: g.targetMinor, saved: await goalSaved(g), deadline: g.deadline })));
  const summary = buildFinanceSummary({
    today, currency: base, decimals, monthStartDay: s.monthStartDay, txs, cats,
    fixed: monthlyFixed(rules, installments, loanPayments, today),
    budgets: budgets.map((v) => ({ name: v.budget.name, limit: v.status.limit, spent: v.status.spent })),
    goals: goalRows, netWorth: nw.length ? nw[nw.length - 1].netWorth : undefined,
  });
  return { summary, decimals, categories: cats.filter((c) => c.kind === 'expense' && !c.archived && !c.system && !c.parentId).map((c) => c.name) };
}
