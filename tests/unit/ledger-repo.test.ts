import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/schema';
import { buildDefaultCategories } from '@/db/seed/categories';
import { addAccount, recomputeBalances } from '@/db/repo/accounts';
import {
  addTransaction, addTransfer, batchUpdate, deleteTransactions, deleteTransfers, listLedger,
  restoreTransactions, restoreTransfers, updateTransaction,
} from '@/db/repo/ledger';
import { totals } from '@/domain/ledger';

const bal = async (id: string) => (await db.accounts.get(id))!.balanceMinor;
const acc = (name: string, initial = 0, currency = 'TWD') =>
  addAccount({ name, icon: '', color: '', type: 'bank', currency, initialBalanceMinor: initial, includeInNetWorth: true, isLiability: false });
const base = { currency: 'TWD', date: '2026-10-10', ts: Date.parse('2026-10-10T12:00:00') };

describe('ledger repo：帳目與餘額一致性', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await db.categories.bulkAdd(buildDefaultCategories());
    await db.exchange_rates.put({ base: 'USD', quote: 'TWD', rateDec: '32', source: 'manual', updatedAt: Date.now() });
  });

  it('新增／修改／刪除／復原支出', async () => {
    const a = await acc('A', 100000);
    const t = await addTransaction({ ...base, type: 'expense', accountId: a.id, categoryId: 'exp-food-lunch', amountMinor: 15000 });
    expect(await bal(a.id)).toBe(85000);
    await updateTransaction(t.id, { ...base, type: 'expense', accountId: a.id, categoryId: 'exp-food-lunch', amountMinor: 20000 });
    expect(await bal(a.id)).toBe(80000);
    await deleteTransactions([t.id]);
    expect(await bal(a.id)).toBe(100000);
    expect(await listLedger('2026-10-01', '2026-10-31')).toHaveLength(0);
    await restoreTransactions([t.id]);
    expect(await bal(a.id)).toBe(80000);
    expect(await recomputeBalances(false)).toEqual([]);
  });

  it('修改帳目換帳戶時兩邊餘額正確', async () => {
    const a = await acc('A', 0);
    const b = await acc('B', 0);
    const t = await addTransaction({ ...base, type: 'income', accountId: a.id, categoryId: 'inc-salary', amountMinor: 5000 });
    await updateTransaction(t.id, { ...base, type: 'income', accountId: b.id, categoryId: 'inc-salary', amountMinor: 5000 });
    expect([await bal(a.id), await bal(b.id)]).toEqual([0, 5000]);
  });

  it('外幣帳目換算帳戶幣別與主幣別', async () => {
    const a = await acc('TWD 帳戶', 0);
    const t = await addTransaction({ ...base, type: 'expense', accountId: a.id, categoryId: 'exp-food', amountMinor: 1050, currency: 'USD' });
    expect(t.accountAmountMinor).toBe(33600); // US$10.50 × 32 = 336
    expect(t.baseAmountMinor).toBe(33600);
    expect(await bal(a.id)).toBe(-33600);
  });

  it('轉帳含手續費、刪除與復原', async () => {
    const a = await acc('A', 100000);
    const b = await acc('B', 0);
    const tr = await addTransfer({ ...base, fromAccountId: a.id, toAccountId: b.id, fromAmountMinor: 50000, toAmountMinor: 50000, feeMinor: 1500 });
    expect([await bal(a.id), await bal(b.id)]).toEqual([48500, 50000]);
    const items = await listLedger('2026-10-01', '2026-10-31');
    expect(items).toHaveLength(1); // 手續費帳目不重複列出
    const stat = totals(await db.transactions.toArray());
    expect(stat.expense).toBe(1500); // 但手續費計入支出
    await deleteTransfers([tr.id]);
    expect([await bal(a.id), await bal(b.id)]).toEqual([100000, 0]);
    await restoreTransfers([tr.id]);
    expect([await bal(a.id), await bal(b.id)]).toEqual([48500, 50000]);
    expect(await recomputeBalances(false)).toEqual([]);
  });

  it('餘額調整不計入收支', async () => {
    const a = await acc('A', 1000);
    await addTransaction({ ...base, type: 'adjust', accountId: a.id, categoryId: 'sys-adjust', amountMinor: -300 });
    expect(await bal(a.id)).toBe(700);
    expect(totals(await db.transactions.toArray()).count).toBe(0);
  });

  it('批次改帳戶搬移餘額', async () => {
    const a = await acc('A', 0);
    const b = await acc('B', 0);
    const t1 = await addTransaction({ ...base, type: 'expense', accountId: a.id, categoryId: 'exp-food', amountMinor: 100 });
    const t2 = await addTransaction({ ...base, type: 'expense', accountId: a.id, categoryId: 'exp-food', amountMinor: 200 });
    await batchUpdate([t1.id, t2.id], { accountId: b.id, categoryId: 'exp-transport' });
    expect([await bal(a.id), await bal(b.id)]).toEqual([0, -300]);
    expect((await db.transactions.get(t1.id))!.categoryId).toBe('exp-transport');
  });
});
