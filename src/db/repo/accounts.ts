/**
 * 帳戶存取層。餘額只能透過帳目變動或「餘額調整」修改；
 * 修改期初餘額時同步平移快取餘額，確保一致。
 */
import { db, uid } from '../schema';
import type { Account, AccountType } from '../types';
import { creditCycle } from '@/domain/creditcard';
import { todayKey } from '@/domain/period';
import { txEffect } from '@/domain/ledger';

export const ACCOUNT_TYPES: { type: AccountType; label: string; icon: string; liability: boolean }[] = [
  { type: 'cash', label: '現金', icon: '💵', liability: false },
  { type: 'bank', label: '銀行', icon: '🏦', liability: false },
  { type: 'epay', label: '電子支付', icon: '📲', liability: false },
  { type: 'credit', label: '信用卡', icon: '💳', liability: true },
  { type: 'stored', label: '儲值卡', icon: '🎫', liability: false },
  { type: 'brokerage', label: '證券戶', icon: '📈', liability: false },
  { type: 'loan', label: '借貸', icon: '🤝', liability: true },
  { type: 'other', label: '其他', icon: '🗂️', liability: false },
];

export const accountTypeInfo = (t: AccountType) => ACCOUNT_TYPES.find((a) => a.type === t)!;

export type AccountInput = Omit<Account, 'id' | 'createdAt' | 'updatedAt' | 'balanceMinor' | 'sort' | 'archived'> & {
  sort?: number;
  archived?: 0 | 1;
};

export async function addAccount(input: AccountInput): Promise<Account> {
  const count = await db.accounts.count();
  const now = Date.now();
  const row: Account = {
    ...input,
    id: uid(),
    balanceMinor: input.initialBalanceMinor,
    sort: input.sort ?? count,
    archived: input.archived ?? 0,
    createdAt: now,
    updatedAt: now,
  };
  await db.accounts.add(row);
  return row;
}

export async function updateAccount(id: string, patch: Partial<AccountInput>): Promise<void> {
  await db.transaction('rw', db.accounts, async () => {
    const acc = await db.accounts.get(id);
    if (!acc) throw new Error('帳戶不存在');
    const next: Partial<Account> = { ...patch, updatedAt: Date.now() };
    if (patch.initialBalanceMinor !== undefined) {
      next.balanceMinor = acc.balanceMinor + (patch.initialBalanceMinor - acc.initialBalanceMinor);
    }
    await db.accounts.update(id, next);
  });
}

/** 有帳目的帳戶只能封存；沒有任何帳目才可真正刪除 */
export async function deleteOrArchiveAccount(id: string): Promise<'deleted' | 'archived'> {
  const used =
    (await db.transactions.where('accountId').equals(id).count()) +
    (await db.transfers.where('fromAccountId').equals(id).count()) +
    (await db.transfers.where('toAccountId').equals(id).count());
  if (used > 0) {
    await db.accounts.update(id, { archived: 1, updatedAt: Date.now() });
    return 'archived';
  }
  await db.accounts.delete(id);
  return 'deleted';
}

export async function reorderAccounts(idsInOrder: string[]): Promise<void> {
  await db.transaction('rw', db.accounts, async () => {
    for (let i = 0; i < idsInOrder.length; i++) await db.accounts.update(idsInOrder[i], { sort: i });
  });
}

/** 由帳目全量重算餘額（資料健康檢查用），回傳有差異的帳戶 */
export async function recomputeBalances(apply = true): Promise<{ id: string; name: string; cached: number; actual: number }[]> {
  const accounts = await db.accounts.toArray();
  const sums = new Map<string, number>(accounts.map((a) => [a.id, a.initialBalanceMinor]));
  await db.transactions.each((t) => {
    if (t.deletedAt) return;
    sums.set(t.accountId, (sums.get(t.accountId) ?? 0) + txEffect(t));
  });
  await db.transfers.each((tr) => {
    if (tr.deletedAt) return;
    sums.set(tr.fromAccountId, (sums.get(tr.fromAccountId) ?? 0) - tr.fromAmountMinor);
    sums.set(tr.toAccountId, (sums.get(tr.toAccountId) ?? 0) + tr.toAmountMinor);
  });
  const diffs = accounts
    .filter((a) => sums.get(a.id) !== a.balanceMinor)
    .map((a) => ({ id: a.id, name: a.name, cached: a.balanceMinor, actual: sums.get(a.id)! }));
  if (apply && diffs.length) {
    await db.transaction('rw', db.accounts, async () => {
      for (const d of diffs) await db.accounts.update(d.id, { balanceMinor: d.actual });
    });
  }
  return diffs;
}

/** 信用卡本期應繳：上一個結帳日（含）之前的帳單週期內的淨消費 */
export async function creditCardStatement(acc: Account, today = todayKey()) {
  if (!acc.credit) return null;
  const cycle = creditCycle(today, acc.credit.statementDay, acc.credit.dueDay);
  const txs = await db.transactions.where('[accountId+date]')
    .between([acc.id, cycle.lastStatement.start], [acc.id, cycle.lastStatement.end], true, true).toArray();
  let spent = 0;
  for (const t of txs) if (!t.deletedAt) spent -= txEffect(t);
  const unbilledTxs = await db.transactions.where('[accountId+date]')
    .between([acc.id, cycle.current.start], [acc.id, cycle.current.end], true, true).toArray();
  let unbilled = 0;
  for (const t of unbilledTxs) if (!t.deletedAt) unbilled -= txEffect(t);
  return { cycle, statementMinor: spent, unbilledMinor: unbilled };
}

/** 這張卡上「尚未入帳」的分期本金（銀行會圈存在信用額度內） */
export async function installmentReserved(accountId: string): Promise<number> {
  const list = await db.installments.where('accountId').equals(accountId).filter((i) => i.status === 'active').toArray();
  return list.reduce((sum, i) => sum + i.schedule.filter((s) => !s.transactionId).reduce((a, s) => a + s.principalMinor, 0), 0);
}
