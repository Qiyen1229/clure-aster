/**
 * 現金流預測的資料來源：把資料庫裡的週期帳目、信用卡帳單、分期、貸款整理成未來的收支事件。
 *
 * - 可動用的錢：現金、銀行、電子支付、儲值帳戶（不含封存、信用卡、貸款、證券）
 * - 週期帳目：記在可動用帳戶的直接加減；記在信用卡的併入該卡的帳單，於繳款日從扣款帳戶扣
 * - 信用卡：已出帳未繳 → 本期繳款日；未出帳＋本期還會刷的週期／分期 → 下期繳款日；之後每期只算已知的週期與分期
 * - 貸款：有設定扣款帳戶的貸款，依攤還表每期扣款
 * - 卡費、貸款沒有設定扣款帳戶時，假設從餘額最多的同幣別帳戶扣，並標示「假設」
 */
import { db } from '@/db/schema';
import type { Account } from '@/db/types';
import { creditCycle } from '@/domain/creditcard';
import { periodTotal } from '@/domain/installment';
import { loanStatus } from '@/domain/loan';
import { convertMinor } from '@/domain/money';
import { addDays, todayKey, type DateKey } from '@/domain/period';
import { occurrences } from '@/domain/recurrence';
import { txEffect } from '@/domain/ledger';
import { dailyVariableSpend, forecast, type CashAccount, type CashEvent, type Forecast } from '@/domain/cashflow';
import { useSettings } from '@/stores/settings';
import { getRate } from './fx';

const LIQUID = new Set(['cash', 'bank', 'epay', 'stored']);
const SPEND_WINDOW = 90;

export interface CashflowData extends Forecast {
  accounts: CashAccount[];
  events: CashEvent[];
  dailySpend: number;
  hasIncome: boolean;
  base: string;
}

async function rateOrOne(from: string, to: string): Promise<number> {
  if (from === to) return 1;
  const r = await getRate(from, to).catch(() => null);
  return r ? r.toNumber() : 1;
}

export async function buildCashflow(days: number, includeSpend: boolean, today = todayKey()): Promise<CashflowData> {
  const base = useSettings.getState().baseCurrency;
  const end = addDays(today, days);
  const all = (await db.accounts.toArray()).filter((a) => !a.archived && !a.deletedAt);
  const liquid = all.filter((a) => LIQUID.has(a.type));
  const accounts: CashAccount[] = [];
  for (const a of liquid) {
    const r = await rateOrOne(a.currency, base);
    // 最小單位的小數位數可能不同（JPY 0 位、TWD 2 位）
    accounts.push({ id: a.id, name: a.name, currency: a.currency, balanceMinor: a.balanceMinor, toBase: convertMinor(1_000_000, a.currency, base, r) / 1_000_000 });
  }
  const liquidIds = new Set(liquid.map((a) => a.id));
  const byId = new Map(all.map((a) => [a.id, a]));
  /** 沒有指定扣款帳戶時：同幣別、餘額最多的可動用帳戶 */
  const payer = (currency: string, preferred?: string): { id: string; assumed: boolean } | null => {
    if (preferred && liquidIds.has(preferred)) return { id: preferred, assumed: false };
    const same = liquid.filter((a) => a.currency === currency).sort((a, b) => b.balanceMinor - a.balanceMinor);
    return same[0] ? { id: same[0].id, assumed: true } : null;
  };
  const events: CashEvent[] = [];
  /** 信用卡上未來的消費（週期、分期）：卡 id → [{date, amount}] */
  const cardCharges = new Map<string, { date: DateKey; amountMinor: number }[]>();
  const toAccountCurrency = async (amountMinor: number, from: string, acc: Account) =>
    from === acc.currency ? amountMinor : convertMinor(amountMinor, from, acc.currency, await rateOrOne(from, acc.currency));

  // 週期帳目（含待確認的日期）
  let hasIncome = false;
  for (const r of await db.recurring_rules.where('active').equals(1).toArray()) {
    if (r.deletedAt) continue;
    const t = r.template;
    const acc = t.accountId ? byId.get(t.accountId) : undefined;
    if (!acc || !t.amountMinor || (t.type !== 'expense' && t.type !== 'income')) continue;
    const dates = [...r.pendingDates, ...occurrences(r.rule, r.startDate, addDays(today, 1), end, 400).filter((d) => d >= r.nextDue)];
    const amt = await toAccountCurrency(t.amountMinor, t.currency ?? acc.currency, acc);
    if (t.type === 'income') hasIncome = true;
    for (const d of dates) {
      if (liquidIds.has(acc.id)) events.push({ date: d, accountId: acc.id, amountMinor: t.type === 'income' ? amt : -amt, label: r.name, kind: 'recurring' });
      else if (acc.type === 'credit' && t.type === 'expense') cardCharges.set(acc.id, [...(cardCharges.get(acc.id) ?? []), { date: d, amountMinor: amt }]);
    }
  }

  // 分期：還沒入帳的期數
  for (const inst of await db.installments.where('status').equals('active').toArray()) {
    const acc = byId.get(inst.accountId);
    if (!acc || inst.deletedAt) continue;
    for (const s of inst.schedule) {
      if (s.transactionId || s.date <= today || s.date > end) continue;
      const amt = await toAccountCurrency(periodTotal(s), inst.currency, acc);
      if (liquidIds.has(acc.id)) events.push({ date: s.date, accountId: acc.id, amountMinor: -amt, label: `${inst.name}（分期 ${s.no}/${inst.periods}）`, kind: 'installment' });
      else if (acc.type === 'credit') cardCharges.set(acc.id, [...(cardCharges.get(acc.id) ?? []), { date: s.date, amountMinor: amt }]);
    }
  }

  // 信用卡繳款
  for (const card of all.filter((a) => a.type === 'credit' && a.credit)) {
    const cr = card.credit!;
    const pay = payer(card.currency, cr.autoPayAccountId);
    if (!pay) continue;
    const owed = Math.max(0, -card.balanceMinor);
    const cyc = creditCycle(today, cr.statementDay, cr.dueDay);
    // 本期未出帳的淨消費
    const unbilledTxs = await db.transactions.where('[accountId+date]').between([card.id, cyc.current.start], [card.id, today], true, true).toArray();
    const unbilled = Math.min(owed, Math.max(0, unbilledTxs.filter((t) => !t.deletedAt).reduce((s, t) => s - txEffect(t), 0)));
    const billedUnpaid = owed - unbilled;
    const charges = cardCharges.get(card.id) ?? [];
    const push = (date: DateKey, amountMinor: number, label: string) => {
      if (amountMinor > 0 && date <= end) events.push({ date, accountId: pay.id, amountMinor: -amountMinor, label, kind: 'card', assumed: pay.assumed });
    };
    push(cyc.dueDate, billedUnpaid, `${card.name} 繳款`);
    // 之後的每一期：本期（未出帳＋這期還會刷的已知消費）、再下一期（只有已知的週期與分期）……
    let cStart = cyc.current.start;
    let cEnd = cyc.current.end;
    let carry = unbilled;
    for (let k = 0; k < 8; k++) {
      // 在結帳日當天算週期，「上一期」就是剛結帳的這期，繳款日跟著算出來
      const due = creditCycle(cEnd, cr.statementDay, cr.dueDay).dueDate;
      if (due > end) break;
      const inCycle = charges.filter((c) => c.date >= cStart && c.date <= cEnd).reduce((s, c) => s + c.amountMinor, 0);
      push(due, carry + inCycle, `${card.name} 繳款`);
      carry = 0;
      cStart = addDays(cEnd, 1);
      cEnd = creditCycle(cStart, cr.statementDay, cr.dueDay).current.end;
    }
  }

  // 貸款
  for (const loan of all.filter((a) => a.type === 'loan' && a.loan)) {
    const st = loanStatus(loan.loan!, loan.balanceMinor, today);
    if (!st || st.actualBalanceMinor <= 0) continue;
    const pay = payer(loan.currency, loan.loan!.payFromAccountId);
    if (!pay) continue;
    for (const s of st.schedule) {
      if (s.date <= today || s.date > end) continue;
      events.push({ date: s.date, accountId: pay.id, amountMinor: -(s.principalMinor + s.interestMinor), label: `${loan.name} 還款`, kind: 'loan', assumed: pay.assumed });
    }
  }

  const since = addDays(today, -SPEND_WINDOW);
  const recent = await db.transactions.where('date').between(since, today, true, false).toArray();
  const dailySpend = dailyVariableSpend(recent, SPEND_WINDOW);
  events.sort((a, b) => a.date.localeCompare(b.date) || a.amountMinor - b.amountMinor);
  const f = forecast({ today, days, accounts, events, dailySpendBase: includeSpend ? dailySpend : 0 });
  return { ...f, accounts, events, dailySpend, hasIncome, base };
}
