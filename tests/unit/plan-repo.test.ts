import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/schema';
import { buildDefaultCategories } from '@/db/seed/categories';
import { addAccount } from '@/db/repo/accounts';
import { addTransaction } from '@/db/repo/ledger';
import {
  addDebts, addInstallment, computeBudgets, confirmPending, processInstallments, processRecurring, saveBudget, saveRecurring, settleDebt, findOrCreatePerson,
} from '@/db/repo/plan';
import { totals } from '@/domain/ledger';

const mkAcc = () => addAccount({ name: 'A', icon: '', color: '', type: 'bank', currency: 'TWD', initialBalanceMinor: 0, includeInNetWorth: true, isLiability: false });

describe('plan repo', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await db.categories.bulkAdd(buildDefaultCategories());
  });

  it('週期 auto：補齊到期期數，且不重複入帳', async () => {
    const a = await mkAcc();
    await saveRecurring({
      kind: 'subscription', name: 'Netflix', active: 1, mode: 'auto', remindDaysBefore: 1, startDate: '2026-07-12',
      rule: { freq: 'month', interval: 1 },
      template: { type: 'expense', accountId: a.id, categoryId: 'exp-subscription-video', amountMinor: 39000, currency: 'TWD' },
    });
    expect(await processRecurring('2026-10-10')).toEqual({ created: 3, pending: 0 }); // 7/12、8/12、9/12
    expect(await processRecurring('2026-10-10')).toEqual({ created: 0, pending: 0 });
    expect((await db.accounts.get(a.id))!.balanceMinor).toBe(-117000);
    const r = (await db.recurring_rules.toArray())[0];
    expect(r.nextDue).toBe('2026-10-12');
    expect(await processRecurring('2026-10-12')).toEqual({ created: 1, pending: 0 });
  });

  it('週期 confirm：放入待確認，確認後才入帳（可改金額）', async () => {
    const a = await mkAcc();
    const id = await saveRecurring({
      kind: 'normal', name: '房租', active: 1, mode: 'confirm', remindDaysBefore: 1, startDate: '2026-10-05',
      rule: { freq: 'month', interval: 1 },
      template: { type: 'expense', accountId: a.id, categoryId: 'exp-housing-rent', amountMinor: 1600000, currency: 'TWD' },
    });
    expect(await processRecurring('2026-10-10')).toEqual({ created: 0, pending: 1 });
    await confirmPending(id, '2026-10-05', 1650000);
    expect((await db.accounts.get(a.id))!.balanceMinor).toBe(-1650000);
    expect((await db.recurring_rules.get(id))!.pendingDates).toEqual([]);
  });

  it('分期：到期期數自動入帳，未來期數不入帳', async () => {
    const a = await mkAcc();
    const id = await addInstallment({ name: 'iPhone', accountId: a.id, categoryId: 'exp-shopping-digital', principalMinor: 3600000, currency: 'TWD', periods: 12, aprDec: '0', feeMinor: 0, feeMode: 'first', firstDate: '2026-08-15' });
    // addInstallment 內以今天為準處理，這裡改用固定日期重新驗證
    await db.transactions.clear();
    await db.accounts.update(a.id, { balanceMinor: 0 });
    await db.installments.update(id, { schedule: (await db.installments.get(id))!.schedule.map((s) => ({ ...s, transactionId: undefined })) });
    expect(await processInstallments('2026-10-10')).toBe(2); // 8/15、9/15 到期；10/15 尚未到
    expect((await db.accounts.get(a.id))!.balanceMinor).toBe(-600000);
    expect(await processInstallments('2026-10-10')).toBe(0); // 不重複入帳
    expect(await processInstallments('2026-10-15')).toBe(1);
  });

  it('預算：只計分類內支出，分帳只算我的份額', async () => {
    const a = await mkAcc();
    await saveBudget({ name: '飲食', periodType: 'month', startDate: '2026-10-01', amountMinor: 1000000, currency: 'TWD', categoryId: 'exp-food', projectId: '', rollover: false, alertPercents: [80], active: 1 });
    const base = { accountId: a.id, currency: 'TWD', date: '2026-10-03', ts: 1 };
    await addTransaction({ ...base, type: 'expense', categoryId: 'exp-food-lunch', amountMinor: 30000, split: { myShareMinor: 10000, debtIds: [] } });
    await addTransaction({ ...base, type: 'expense', categoryId: 'exp-transport', amountMinor: 99900 });
    const [v] = await computeBudgets('2026-10-10');
    expect(v.status.spent).toBe(10000);
    expect(totals(await db.transactions.toArray()).expense).toBe(109900);
  });

  it('分帳結清：對方還款入帳且不計入收入', async () => {
    const a = await mkAcc();
    const p = await findOrCreatePerson('小明');
    const [id] = await addDebts([{ personId: p.id, direction: 'they_owe_me', amountMinor: 20000, currency: 'TWD', date: '2026-10-01', note: '晚餐' }]);
    await settleDebt(id, a.id);
    expect((await db.accounts.get(a.id))!.balanceMinor).toBe(20000);
    expect(totals(await db.transactions.toArray()).income).toBe(0);
    expect((await db.debts.get(id))!.settled).toBe(1);
  });
});
