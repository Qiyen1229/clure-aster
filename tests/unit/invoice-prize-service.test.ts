import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/schema';
import { buildDefaultCategories } from '@/db/seed/categories';
import { addAccount } from '@/db/repo/accounts';
import { addTransaction, deleteTransactions } from '@/db/repo/ledger';
import { checkPeriod, claimPrize } from '@/services/invoicePrize';
import type { PrizeDraw } from '@/domain/invoice-prize';

const draw: PrizeDraw = { period: '2026-07', label: '', special: '89996565', grand: '91098182', firsts: ['54348835', '44991397', '06595111'], extraSixth: [] };

describe('統一發票對獎服務', () => {
  let accId = '';
  const exp = (no: string, date: string) => addTransaction({
    type: 'expense', accountId: accId, categoryId: 'exp-food-lunch', amountMinor: 15000, currency: 'TWD', date, ts: Date.parse(`${date}T12:00:00`), invoiceNo: no,
  });
  beforeEach(async () => {
    await db.delete(); await db.open();
    await db.categories.bulkAdd(buildDefaultCategories());
    accId = (await addAccount({ name: 'A', icon: '', color: '', type: 'bank', currency: 'TWD', initialBalanceMinor: 0, includeInNetWorth: true, isLiability: false })).id;
  });

  it('只對該期、帶發票號碼的支出；其他期與沒號碼的不算', async () => {
    await exp('AB44991397', '2026-08-03'); // 頭獎
    await exp('CD12348835', '2026-07-20'); // 三獎
    await exp('EF00000000', '2026-07-21'); // 沒中
    await exp('GH44991397', '2026-09-03'); // 下一期：不算
    await addTransaction({ type: 'expense', accountId: accId, categoryId: 'exp-food-lunch', amountMinor: 100, currency: 'TWD', date: '2026-07-22', ts: 1 }); // 沒有發票號碼
    const r = await checkPeriod(draw);
    expect(r.checked).toBe(3);
    expect(r.winners.map((w) => w.hit!.name)).toEqual(['頭獎', '三獎']);
    expect(r.totalMinor).toBe(210_000 * 100);
  });
  it('已刪除的帳目不對；同一張發票號碼只算一次', async () => {
    const t = await exp('AB44991397', '2026-08-03');
    await exp('AB44991397', '2026-08-04');
    expect((await checkPeriod(draw)).checked).toBe(1);
    await deleteTransactions([t.id]);
    expect((await checkPeriod(draw)).checked).toBe(1); // 另一筆仍在
  });
  it('記入中獎收入：金額正確、帳戶餘額增加、記在領獎當天，之後視為已記入且不能重複', async () => {
    await exp('AB44991397', '2026-08-03');
    let r = await checkPeriod(draw);
    const before = (await db.accounts.get(accId))!.balanceMinor;
    const tx = await claimPrize(r.winners[0]);
    expect(tx.type).toBe('income');
    expect(tx.categoryId).toBe('inc-lottery');
    expect(tx.invoiceNo).toBe('AB44991397');
    expect((await db.accounts.get(accId))!.balanceMinor).toBe(before + 200_000 * 100);
    r = await checkPeriod(draw);
    expect(r.winners[0].claimed).toBe(true);
    expect(r.unclaimedMinor).toBe(0);
    expect(r.checked).toBe(1); // 中獎收入不會被當成發票再對一次
    await expect(claimPrize(r.winners[0])).rejects.toThrow('已經記過');
  });
  it('沒中獎的發票不能記入', async () => {
    await exp('EF00000000', '2026-07-21');
    const r = await checkPeriod(draw);
    await expect(claimPrize(r.entries[0])).rejects.toThrow('沒有中獎');
  });

  it('並發呼叫 claimPrize 兩次只記一筆收入（T9 競態防護）', async () => {
    await exp('AB44991397', '2026-08-03');
    const r = await checkPeriod(draw);
    const entry1 = { ...r.winners[0] };
    const entry2 = { ...r.winners[0] };

    const results = await Promise.allSettled([claimPrize(entry1), claimPrize(entry2)]);
    const successes = results.filter((x) => x.status === 'fulfilled');
    const failures = results.filter((x) => x.status === 'rejected');

    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);

    const prizeIncomes = await db.transactions.where('invoiceNo').equals('AB44991397').filter((t) => t.type === 'income').toArray();
    expect(prizeIncomes.length).toBe(1);
  });
});
